/**
 * brief-459 (W3-S3, M-008) — ONE grammar for standing-rule sections: the
 * writer (prism_log_insight) provably emits what the parser
 * (extractStandingRules) provably consumes.
 *
 * Findings under test:
 *  - SRV-01(a): trailing decoration run is ORDER-INSENSITIVE — `[TIER:B] —
 *    STANDING RULE` (the order the writer itself minted for INS-316) must
 *    parse at Tier B, not silently default to A.
 *  - SRV-01(b): a rule section terminates at the first `#`/`##` heading or
 *    line-anchored EOF sentinel — the last rule before `## Formalized` must
 *    not swallow trailing file content into its procedure (S171 boot repro).
 *  - SRV-11: hyphenated topics (live INS-297 shape) parse whole.
 *  - SRV-13: a qualifying rule without a `**Standing procedure:**` marker
 *    gets a bounded body fallback + STANDING_RULE_EMPTY_PROCEDURE diagnostic
 *    instead of silent empty-procedure delivery.
 *  - Writer round-trip (brief-459 verification (a)/(b)): log_insight with
 *    standing_rule + [TIER:B] in trailing AND title-embedded variants parses
 *    back at Tier B with topics intact; an untagged mint parses back at the
 *    documented Tier A default (INS-328 repro).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn(),
}));

import {
  fetchFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";
import {
  extractStandingRules,
  parseTitleDecorations,
  EMPTY_PROCEDURE_FALLBACK_MAX_CHARS,
} from "../src/utils/standing-rules.js";
import { registerLogInsight } from "../src/tools/log-insight.js";
import { logger } from "../src/utils/logger.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// SRV-01(a) — order-insensitive trailing decoration run
// ---------------------------------------------------------------------------

// The INS-316 live shape (audit SRV-01 ground truth, hexdumped from the real
// prism registry): the writer appended " — STANDING RULE" AFTER the operator's
// title-embedded tag, minting tag-then-suffix order.
const INS_316_HEADER =
  "### INS-316: Session-log archival inversion — do not re-add archived entries to live until config fix lands [TIER:B] — STANDING RULE";

function section(headerLine: string, body = "**Standing procedure:** Do the thing."): string {
  return `${headerLine}\n\n${body}\n`;
}

describe("brief-459 / SRV-01(a): tag-then-suffix decoration order parses", () => {
  it("INS-316 repro: `[TIER:B] — STANDING RULE` parses at Tier B in registry source", () => {
    const rules = extractStandingRules(section(INS_316_HEADER), "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-316");
    expect(rules[0].tier).toBe("B");
  });

  it("INS-316 repro: the full decoration run is stripped from the visible title", () => {
    const rules = extractStandingRules(section(INS_316_HEADER), "registry");
    expect(rules[0].title).toBe(
      "Session-log archival inversion — do not re-add archived entries to live until config fix lands",
    );
  });

  it("tag-then-suffix QUALIFIES in insights source (run contains the suffix)", () => {
    const rules = extractStandingRules(
      section("### INS-920: Insights-side rule [TIER:B] — STANDING RULE"),
      "insights",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("B");
    expect(rules[0].title).toBe("Insights-side rule");
  });

  it("census shape: a registry mixing BOTH decoration orders counts tiers correctly", () => {
    const doc = [
      section("### INS-1: Suffix-then-tag — STANDING RULE [TIER:B]"),
      section("### INS-2: Tag-then-suffix [TIER:B] — STANDING RULE"),
      section("### INS-3: Untagged rule — STANDING RULE"),
      section("### INS-4: Tagged C — STANDING RULE [TIER:C]"),
      section("### INS-5: Bare trailing tag [TIER:C]"),
    ].join("\n");
    const rules = extractStandingRules(doc, "registry");
    const counts = { A: 0, B: 0, C: 0 };
    for (const r of rules) counts[r.tier]++;
    expect(rules).toHaveLength(5);
    expect(counts).toEqual({ A: 1, B: 2, C: 2 });
  });

  it("malformed trailing tag emits STANDING_RULE_TIER_TAG_UNPARSED and defaults to A (no silent path)", () => {
    const rules = extractStandingRules(
      section("### INS-940: Misformed tag rule [TIER:] — STANDING RULE"),
      "registry",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STANDING_RULE_TIER_TAG_UNPARSED"),
      expect.objectContaining({ id: "INS-940" }),
    );
  });

  it("a mid-title tag followed by more words does NOT warn (INS-900 class stays quiet)", () => {
    const rules = extractStandingRules(
      section("### INS-941: Docs quote [TIER:B] mid-title here — STANDING RULE"),
      "registry",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    const unparsedCalls = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("STANDING_RULE_TIER_TAG_UNPARSED"),
    );
    expect(unparsedCalls).toHaveLength(0);
  });
});

describe("brief-459 / SRV-01(a): parseTitleDecorations (the shared grammar helper)", () => {
  it("extracts tier + clean title from suffix-then-tag order", () => {
    const d = parseTitleDecorations("My rule — STANDING RULE [TIER:B]");
    expect(d.cleanTitle).toBe("My rule");
    expect(d.tier).toBe("B");
    expect(d.hasStandingRuleSuffix).toBe(true);
  });

  it("extracts tier + clean title from tag-then-suffix order", () => {
    const d = parseTitleDecorations("My rule [TIER:B] — STANDING RULE");
    expect(d.cleanTitle).toBe("My rule");
    expect(d.tier).toBe("B");
    expect(d.hasStandingRuleSuffix).toBe(true);
  });

  it("bare trailing tag: tier without suffix", () => {
    const d = parseTitleDecorations("My rule [TIER:C]");
    expect(d.cleanTitle).toBe("My rule");
    expect(d.tier).toBe("C");
    expect(d.hasStandingRuleSuffix).toBe(false);
  });

  it("undecorated title: no tier, no suffix, title unchanged", () => {
    const d = parseTitleDecorations("Just a plain title");
    expect(d.cleanTitle).toBe("Just a plain title");
    expect(d.tier).toBeNull();
    expect(d.hasStandingRuleSuffix).toBe(false);
  });

  it("backticked mid-title literal is NOT treated as a trailing tag (INS-179 class)", () => {
    const d = parseTitleDecorations(
      "Regex must be checked — `[^[]` swallows the space before `[TIER:X]` — STANDING RULE [TIER:C]",
    );
    expect(d.tier).toBe("C");
    expect(d.cleanTitle).toBe(
      "Regex must be checked — `[^[]` swallows the space before `[TIER:X]`",
    );
  });
});

// ---------------------------------------------------------------------------
// SRV-01(b) — section terminator: no bleed past #/## headings or EOF sentinel
// ---------------------------------------------------------------------------

describe("brief-459 / SRV-01(b): procedure terminates before trailing file content", () => {
  // The S171 boot repro: the FINAL rule precedes `## Formalized` and the EOF
  // sentinel — exactly the shape every log_insight-written registry has.
  const S171_REGISTRY = [
    "# Standing Rules — prism",
    "",
    "## Active",
    "",
    "### INS-328: Transient-401 pane recovery — verify remote state before daemon restarts [TIER:B] — STANDING RULE",
    "- Category: operations — **STANDING RULE**",
    "- Discovered: Session 171",
    "- Description: Pane identity can change during recovery attempts.",
    "- **Standing procedure:** 1. Check remote state. 2. Nudge the idle pane to retry push+PR.",
    "",
    "## Formalized",
    "",
    "<!-- EOF: standing-rules.md -->",
    "",
  ].join("\n");

  it("S171 repro: final rule's procedure excludes `## Formalized` and the EOF sentinel", () => {
    const rules = extractStandingRules(S171_REGISTRY, "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-328");
    expect(rules[0].tier).toBe("B");
    expect(rules[0].procedure).toBe(
      "1. Check remote state. 2. Nudge the idle pane to retry push+PR.",
    );
    expect(rules[0].procedure).not.toContain("## Formalized");
    expect(rules[0].procedure).not.toContain("<!-- EOF:");
  });

  it("a final rule directly before the EOF sentinel (no ## heading) is also clean", () => {
    const doc = [
      "### INS-950: Last rule — STANDING RULE [TIER:B]",
      "- **Standing procedure:** Step one.",
      "",
      "<!-- EOF: standing-rules.md -->",
    ].join("\n");
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].procedure).toBe("Step one.");
  });

  it("a top-level `# ` heading also terminates the section", () => {
    const doc = [
      "### INS-951: Rule before H1 — STANDING RULE",
      "- **Standing procedure:** Only this.",
      "",
      "# Appendix",
      "Appendix content.",
    ].join("\n");
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].procedure).toBe("Only this.");
    expect(rules[0].procedure).not.toContain("Appendix");
  });

  it("mid-file rules bounded by the next ### header are unchanged", () => {
    const doc = [
      section("### INS-952: First — STANDING RULE", "- **Standing procedure:** First steps."),
      section("### INS-953: Second — STANDING RULE", "- **Standing procedure:** Second steps."),
    ].join("\n");
    const rules = extractStandingRules(doc, "registry");
    expect(rules.map((r) => r.procedure)).toEqual(["First steps.", "Second steps."]);
  });

  it("topics comments in trailing file content do NOT attach to the last rule", () => {
    const doc = [
      "### INS-954: Last rule — STANDING RULE [TIER:B]",
      "- **Standing procedure:** Steps.",
      "",
      "## Formalized",
      "",
      "<!-- topics: stray, comment -->",
      "",
      "<!-- EOF: standing-rules.md -->",
    ].join("\n");
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].topics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SRV-11 — hyphen-safe topics parsing
// ---------------------------------------------------------------------------

describe("brief-459 / SRV-11: topics survive hyphenated tokens", () => {
  it("INS-297 live shape: six topics including `trigger-lock` all parse", () => {
    const doc = section(
      "### INS-297: Trigger daemon liveness — STANDING RULE [TIER:B]",
      "<!-- topics: trigger, daemon, liveness, launchctl, cli, trigger-lock -->\n- **Standing procedure:** Steps.",
    );
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].topics).toEqual([
      "trigger",
      "daemon",
      "liveness",
      "launchctl",
      "cli",
      "trigger-lock",
    ]);
  });

  it("hyphen + underscore mix parses whole (audit synthetic case)", () => {
    const doc = section(
      "### INS-955: Synthetic — STANDING RULE [TIER:B]",
      "<!-- topics: ci-workflow, mcp_server -->\n- **Standing procedure:** Steps.",
    );
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].topics).toEqual(["ci-workflow", "mcp_server"]);
  });

  it("a topics comment yielding ZERO topics emits a diagnostic instead of failing silently", () => {
    const doc = section(
      "### INS-956: Empty topics — STANDING RULE [TIER:B]",
      "<!-- topics: -->\n- **Standing procedure:** Steps.",
    );
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].topics).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STANDING_RULE_TOPICS_EMPTY"),
      expect.objectContaining({ id: "INS-956" }),
    );
  });
});

// ---------------------------------------------------------------------------
// SRV-13 — empty-procedure handling
// ---------------------------------------------------------------------------

describe("brief-459 / SRV-13: missing **Standing procedure:** marker", () => {
  it("falls back to a bounded slice of the section body and emits STANDING_RULE_EMPTY_PROCEDURE", () => {
    const doc = section(
      "### INS-304: Guess-instead-of-verify cascade — STANDING RULE [TIER:A]",
      "- Category: gotcha — **STANDING RULE**\n- Discovered: Session 152\n- Description: Root-cause your guesses before acting on them.",
    );
    const rules = extractStandingRules(doc, "insights");
    expect(rules).toHaveLength(1);
    expect(rules[0].procedure).not.toBe("");
    expect(rules[0].procedure).toContain("Root-cause your guesses before acting on them.");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STANDING_RULE_EMPTY_PROCEDURE"),
      expect.objectContaining({ id: "INS-304" }),
    );
  });

  it("the fallback is bounded at EMPTY_PROCEDURE_FALLBACK_MAX_CHARS", () => {
    const hugeBody = "- Description: " + "x".repeat(EMPTY_PROCEDURE_FALLBACK_MAX_CHARS * 3);
    const doc = section("### INS-957: Huge unmarked rule — STANDING RULE", hugeBody);
    const rules = extractStandingRules(doc, "insights");
    expect(rules[0].procedure.length).toBeLessThanOrEqual(
      EMPTY_PROCEDURE_FALLBACK_MAX_CHARS + 1, // +1 for the truncation ellipsis
    );
  });

  it("the fallback excludes the topics metadata comment", () => {
    const doc = section(
      "### INS-958: Unmarked with topics — STANDING RULE [TIER:B]",
      "<!-- topics: auth, trigger-lock -->\n- Description: Body text here.",
    );
    const rules = extractStandingRules(doc, "registry");
    expect(rules[0].procedure).toContain("Body text here.");
    expect(rules[0].procedure).not.toContain("topics:");
  });

  it("a rule WITH the marker keeps exact procedure extraction (no fallback)", () => {
    const doc = section(
      "### INS-959: Marked rule — STANDING RULE",
      "- Description: Context.\n- **Standing procedure:** Exactly these steps.",
    );
    const rules = extractStandingRules(doc, "insights");
    expect(rules[0].procedure).toBe("Exactly these steps.");
  });
});

// ---------------------------------------------------------------------------
// Writer round-trip — verification (a) and (b)
// ---------------------------------------------------------------------------

const EMPTY_STANDING_RULES = `# Standing Rules — test-project

> Standing-rule registry (D-240 R2-B).

## Active

## Formalized

<!-- EOF: standing-rules.md -->
`;

function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

function setupRegistry(standingRules: string = EMPTY_STANDING_RULES) {
  mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
    if (docName === "standing-rules.md") {
      return { path: ".prism/standing-rules.md", content: standingRules, sha: "sr-sha", legacy: false };
    }
    throw new Error(`Not found: ${docName}`);
  });
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/standing-rules.md") {
      return { content: standingRules, sha: "sr-sha", size: standingRules.length };
    }
    throw new Error(`Unexpected fetchFile: ${path}`);
  });
  mockResolveDocPushPath.mockImplementation(async (_slug: string, docName: string) => `.prism/${docName}`);
  mockGuardPushPath.mockImplementation(async (_slug: string, path: string) => ({
    path,
    redirected: false,
  }));
  mockGetHeadSha.mockResolvedValue("head-before");
  mockCreateAtomicCommit.mockResolvedValue({
    success: true,
    sha: "atomic-sha",
    files_committed: 1,
  } as never);
}

/** The registry content written by the captured atomic commit. */
function writtenRegistry(): string {
  const calls = mockCreateAtomicCommit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const files = calls[0][1] as Array<{ path: string; content: string }>;
  const file = files.find((f) => f.path === ".prism/standing-rules.md");
  expect(file).toBeDefined();
  return file!.content;
}

async function logStandingRule(args: Record<string, unknown>) {
  const { server, handlers } = createServerStub();
  registerLogInsight(server as any);
  return handlers.prism_log_insight({
    project_slug: "test-project",
    category: "operations",
    description: "Round-trip test entry.",
    session: 171,
    standing_rule: true,
    procedure: "1. Do the steps. 2. Verify.",
    ...args,
  });
}

describe("brief-459 verification (a): writer→parser round-trip at Tier B", () => {
  it("title-embedded variant: title ending `[TIER:B]` round-trips at Tier B with topics intact", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-501",
      title: "Transient-401 recovery — verify remote state first [TIER:B]",
      topics: ["auth", "trigger-lock"],
    });
    expect(result.isError).toBeUndefined();

    const content = writtenRegistry();
    const rules = extractStandingRules(content, "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-501");
    expect(rules[0].tier).toBe("B");
    expect(rules[0].topics).toEqual(["auth", "trigger-lock"]);
    expect(rules[0].title).toBe("Transient-401 recovery — verify remote state first");
  });

  it("trailing variant: title already ending `— STANDING RULE [TIER:B]` normalizes to ONE canonical run", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-502",
      title: "Rule with full trailing run — STANDING RULE [TIER:B]",
    });
    expect(result.isError).toBeUndefined();

    const content = writtenRegistry();
    const headerLine = content
      .split("\n")
      .find((l) => l.startsWith("### INS-502:"));
    expect(headerLine).toBe(
      "### INS-502: Rule with full trailing run — STANDING RULE [TIER:B]",
    );
    const rules = extractStandingRules(content, "registry");
    expect(rules[0].tier).toBe("B");
  });

  it("tag-then-suffix variant (the exact INS-316 minting shape) normalizes to canonical and parses at B", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-503",
      title: "Archival inversion guard [TIER:B] — STANDING RULE",
    });
    expect(result.isError).toBeUndefined();

    const content = writtenRegistry();
    const headerLine = content.split("\n").find((l) => l.startsWith("### INS-503:"));
    expect(headerLine).toBe("### INS-503: Archival inversion guard — STANDING RULE [TIER:B]");
    const rules = extractStandingRules(content, "registry");
    expect(rules[0].tier).toBe("B");
  });

  it("explicit tier parameter composes the canonical header", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-504",
      title: "Clean title rule",
      tier: "B",
    });
    expect(result.isError).toBeUndefined();

    const content = writtenRegistry();
    const headerLine = content.split("\n").find((l) => l.startsWith("### INS-504:"));
    expect(headerLine).toBe("### INS-504: Clean title rule — STANDING RULE [TIER:B]");
  });

  it("explicit tier parameter overrides a title-embedded tag", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-505",
      title: "Operator tagged C [TIER:C]",
      tier: "B",
    });
    expect(result.isError).toBeUndefined();

    const rules = extractStandingRules(writtenRegistry(), "registry");
    expect(rules[0].tier).toBe("B");
    expect(rules[0].title).toBe("Operator tagged C");
  });

  it("the written registry file's final rule has a bleed-free procedure (full-file round trip)", async () => {
    setupRegistry();
    await logStandingRule({
      id: "INS-506",
      title: "File-tail rule [TIER:B]",
    });
    const content = writtenRegistry();
    const rules = extractStandingRules(content, "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].procedure).toBe("1. Do the steps. 2. Verify.");
    expect(rules[0].procedure).not.toContain("## Formalized");
    expect(rules[0].procedure).not.toContain("<!-- EOF:");
  });
});

describe("brief-459 verification (b): untagged-mint default is explicit (INS-328 repro)", () => {
  it("a standing rule minted without any tier parses back at the documented Tier A default", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-507",
      title: "Untagged operational rule",
    });
    expect(result.isError).toBeUndefined();

    const content = writtenRegistry();
    const headerLine = content.split("\n").find((l) => l.startsWith("### INS-507:"));
    expect(headerLine).toBe("### INS-507: Untagged operational rule — STANDING RULE");
    const rules = extractStandingRules(content, "registry");
    expect(rules[0].tier).toBe("A");
  });
});

describe("brief-459 writer input validation", () => {
  it("rejects tier without standing_rule: true", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-508",
      title: "Not a rule",
      standing_rule: false,
      procedure: undefined,
      tier: "B",
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("standing_rule");
  });

  it("rejects topics without standing_rule: true", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-509",
      title: "Not a rule",
      standing_rule: false,
      procedure: undefined,
      topics: ["auth"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("standing_rule");
  });

  it("rejects topics entries containing characters outside [A-Za-z0-9_-]", async () => {
    setupRegistry();
    const result = await logStandingRule({
      id: "INS-510",
      title: "Bad topics rule",
      topics: ["auth", "has,comma"],
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toContain("topic");
  });
});
