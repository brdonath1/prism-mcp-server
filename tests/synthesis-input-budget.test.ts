/**
 * Tests for the synthesis input bound (brief-445 / R3-dur / D-240 Phase B).
 *
 * Part A — unit tests on src/ai/input-budget.ts:
 *   - <=120K hard ceiling fires on oversized inputs; result fed to the model
 *     is <=120K estimated tokens (verification #1)
 *   - normal-case NO-OP: inputs under target AND in the target..ceiling gray
 *     zone pass through byte-for-byte unchanged (verification #1 + author note)
 *   - determinism: same input → identical trimmed prompt across runs
 *     (verification #1)
 *   - priority: highest-signal docs (handoff / decisions/_INDEX / insights)
 *     survive; lowest-signal docs are trimmed first (verification #2)
 *   - recency: the retained portion of chronological docs is the most-recent
 *     end (session-log newest-first head; insights newest-last tail)
 *   - unconditional hard bound on pathological doc sets (defensive stub pass)
 *
 * Part B — pipeline tests through generateIntelligenceBrief /
 * generatePendingDocUpdates with the same mocked boundaries as
 * tests/pending-doc-updates.test.ts:
 *   - the userContent actually handed to synthesize() honors the ceiling
 *   - pre/post token counts are emitted via logger + SynthesisOutcome
 *     (verification #3, log-only)
 *   - failure outcomes pass the error string through unchanged so the
 *     SYNTHESIS_TIMEOUT / SYNTHESIS_RETRY classifier in
 *     src/tools/synthesize.ts (untouched by brief-445) keys on the same
 *     input as before (verification #3)
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/github/client.js", () => ({
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocFiles: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/ai/synthesis-tracker.js", () => ({
  recordSynthesisEvent: vi.fn(),
  getRecentSuccessful: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  SYNTHESIS_CHARS_PER_TOKEN,
  SYNTHESIS_INPUT_MAX_TOKENS,
  SYNTHESIS_INPUT_TARGET_TOKENS,
} from "../src/config.js";
import {
  boundSynthesisInput,
  estimateSynthesisTokens,
  TRIM_DOC_FLOOR_TOKENS,
  type SynthesisDocEntry,
} from "../src/ai/input-budget.js";
import { buildSynthesisUserMessage } from "../src/ai/prompts.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
} from "../src/ai/synthesize.js";
import { synthesize } from "../src/ai/client.js";
import { pushFile } from "../src/github/client.js";
import { resolveDocFiles, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { logger } from "../src/utils/logger.js";

const mockSynthesize = vi.mocked(synthesize);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockLoggerInfo = vi.mocked(logger.info);

// ---------------------------------------------------------------------------
// Fixture helpers — all deterministic (no Date.now / Math.random).
// ---------------------------------------------------------------------------

/** Repeatable filler text of an exact character length. */
function filler(chars: number): string {
  const seed = "the quick brown fox jumps over the lazy dog and keeps going. ";
  return seed.repeat(Math.ceil(chars / seed.length)).slice(0, chars);
}

function entry(content: string): SynthesisDocEntry {
  return { content, size: content.length };
}

/** Reverse-chronological session log — newest session FIRST (matches
 *  SESSION_LOG_ARCHIVE_CONFIG mostRecentAt: "top" in finalize.ts). */
function makeSessionLog(sessions: number, charsPerSession: number): string {
  const parts: string[] = ["# Session Log — Test Project", ""];
  for (let s = sessions; s >= 1; s--) {
    parts.push(`### Session ${s}`);
    parts.push(filler(charsPerSession));
    parts.push("");
  }
  parts.push("<!-- EOF: session-log.md -->");
  return parts.join("\n");
}

/** Chronological insights — newest entry LAST (matches
 *  INSIGHTS_ARCHIVE_CONFIG mostRecentAt: "bottom" in finalize.ts). */
function makeInsights(count: number, charsPerInsight: number): string {
  const parts: string[] = ["# Insights — Test Project", "", "## Active", ""];
  for (let i = 1; i <= count; i++) {
    parts.push(`### INS-${i}: insight number ${i}`);
    parts.push(filler(charsPerInsight));
    parts.push("");
  }
  parts.push("<!-- EOF: insights.md -->");
  return parts.join("\n");
}

/** Decision registry — rows appended at the bottom (newest LAST, matching
 *  prism_log_decision's insert-before-EOF behavior). */
function makeDecisionIndex(decisions: number): string {
  const parts: string[] = [
    "# Decision Registry",
    "",
    "| ID | Title | Domain | Status | Session |",
    "|----|-------|--------|--------|---------|",
  ];
  for (let d = 1; d <= decisions; d++) {
    parts.push(`| D-${d} | Decision number ${d} | core | SETTLED | S${d} |`);
  }
  parts.push("");
  parts.push("<!-- EOF: _INDEX.md -->");
  return parts.join("\n");
}

const HANDOFF_CONTENT = [
  "# Handoff — Test Project",
  "",
  "## Meta",
  "- Handoff Version: 12",
  "- Session Count: 99",
  "- Template Version: 9.1",
  "- Status: ACTIVE",
  "",
  "## Critical Context",
  "1. The synthesis input bound is under test.",
  "2. UNIQUE-HANDOFF-MARKER-7731 must survive any trim.",
  "",
  "## Where We Are",
  "Mid-flight on brief-445.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

/** Builder closure used by all Part A tests — the REAL prompt builder with
 *  fixed metadata, so the bound is measured on a real assembled message. */
function builderFor(docs: Map<string, SynthesisDocEntry>): string {
  return buildSynthesisUserMessage("test-project", 99, "06-04-26 12:00:00", docs);
}

/** Representative oversized fixture mirroring the pre-438 audit shape
 *  (brief-431 row R3: ~611KB / ~175K tokens, insights.md dominant). */
function makeOversizedDocs(): Map<string, SynthesisDocEntry> {
  return new Map<string, SynthesisDocEntry>([
    ["handoff.md", entry(HANDOFF_CONTENT)],
    ["decisions/_INDEX.md", entry(makeDecisionIndex(240))],
    ["session-log.md", entry(makeSessionLog(60, 2_000))],
    ["task-queue.md", entry(`# Task Queue\n\n## Up Next\n${filler(12_000)}\n<!-- EOF: task-queue.md -->`)],
    ["eliminated.md", entry(`# Eliminated\n${filler(15_000)}\n<!-- EOF: eliminated.md -->`)],
    ["architecture.md", entry(`# Architecture\n${filler(14_000)}\n<!-- EOF: architecture.md -->`)],
    ["glossary.md", entry(`# Glossary\n${filler(8_000)}\n<!-- EOF: glossary.md -->`)],
    ["known-issues.md", entry(`# Known Issues\n${filler(10_000)}\n<!-- EOF: known-issues.md -->`)],
    ["insights.md", entry(makeInsights(300, 1_330))],
    ["decisions/operations.md", entry(`# Operations Decisions\n${filler(6_000)}\n<!-- EOF: operations.md -->`)],
  ]);
}

/** Small healthy fixture — well under the 60K target. */
function makeNormalDocs(): Map<string, SynthesisDocEntry> {
  return new Map<string, SynthesisDocEntry>([
    ["handoff.md", entry(HANDOFF_CONTENT)],
    ["decisions/_INDEX.md", entry(makeDecisionIndex(40))],
    ["session-log.md", entry(makeSessionLog(10, 800))],
    ["insights.md", entry(makeInsights(20, 400))],
    ["architecture.md", entry(`# Architecture\n${filler(4_000)}\n<!-- EOF: architecture.md -->`)],
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDocPushPath.mockResolvedValue(".prism/intelligence-brief.md");
  mockPushFile.mockResolvedValue({
    success: true,
    sha: "abc123",
    size: 1024,
  } as never);
});

// ---------------------------------------------------------------------------
// Part A.0 — token estimation
// ---------------------------------------------------------------------------

describe("estimateSynthesisTokens", () => {
  it("uses the codebase-standard chars/3.5 proxy (matches bootstrap ME-5)", () => {
    expect(estimateSynthesisTokens("x".repeat(350))).toBe(100);
    expect(estimateSynthesisTokens("x".repeat(420_000))).toBe(120_000);
    expect(SYNTHESIS_CHARS_PER_TOKEN).toBe(3.5);
  });

  it("rounds rather than truncates", () => {
    // 6 chars / 3.5 = 1.714… → 2
    expect(estimateSynthesisTokens("abcdef")).toBe(2);
    expect(estimateSynthesisTokens("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part A.1 — NO-OP paths (verification #1, normal fixture + author note)
// ---------------------------------------------------------------------------

describe("boundSynthesisInput — NO-OP paths", () => {
  it("returns the input untouched when under the 60K target", () => {
    const docs = makeNormalDocs();
    const directMessage = builderFor(docs);
    expect(estimateSynthesisTokens(directMessage)).toBeLessThan(
      SYNTHESIS_INPUT_TARGET_TOKENS,
    );

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(false);
    expect(result.trimmed_docs).toEqual([]);
    expect(result.pre_trim_tokens).toBe(result.post_trim_tokens);
    // Same Map instance — zero-copy on the normal path.
    expect(result.docs).toBe(docs);
    // The assembled prompt is byte-for-byte what the builder produces unbounded.
    expect(builderFor(result.docs)).toBe(directMessage);
  });

  it("does NOT trim in the target..ceiling gray zone (only the ceiling triggers)", () => {
    // ~90K tokens — between the 60K target and the 120K ceiling.
    const docs = makeNormalDocs();
    docs.set("session-log.md", entry(makeSessionLog(150, 2_000)));
    const pre = estimateSynthesisTokens(builderFor(docs));
    expect(pre).toBeGreaterThan(SYNTHESIS_INPUT_TARGET_TOKENS);
    expect(pre).toBeLessThanOrEqual(SYNTHESIS_INPUT_MAX_TOKENS);

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(false);
    expect(result.docs).toBe(docs);
    expect(result.post_trim_tokens).toBe(pre);
  });

  it("does not mutate the caller's doc map or entries when trimming fires", () => {
    const docs = makeOversizedDocs();
    const originalInsights = docs.get("insights.md")?.content;
    const originalKeys = [...docs.keys()];

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(true);
    expect(docs.get("insights.md")?.content).toBe(originalInsights);
    expect([...docs.keys()]).toEqual(originalKeys);
    // The returned map is a fresh instance on the trim path.
    expect(result.docs).not.toBe(docs);
  });
});

// ---------------------------------------------------------------------------
// Part A.2 — the bound fires (verification #1, oversized fixture)
// ---------------------------------------------------------------------------

describe("boundSynthesisInput — ceiling enforcement", () => {
  it("trims a >120K-token input so the assembled prompt is <=120K tokens", () => {
    const docs = makeOversizedDocs();
    const pre = estimateSynthesisTokens(builderFor(docs));
    expect(pre).toBeGreaterThan(SYNTHESIS_INPUT_MAX_TOKENS); // fixture really is oversized

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(true);
    expect(result.pre_trim_tokens).toBe(pre);
    // The REAL assembled prompt honors the hard ceiling…
    const finalMessage = builderFor(result.docs);
    expect(estimateSynthesisTokens(finalMessage)).toBeLessThanOrEqual(
      SYNTHESIS_INPUT_MAX_TOKENS,
    );
    // …and the reported post-trim count matches that prompt.
    expect(result.post_trim_tokens).toBe(estimateSynthesisTokens(finalMessage));
    // Implementation pin: when the bound fires it trims to the TARGET (not
    // just under the ceiling) to restore durable headroom.
    expect(result.post_trim_tokens).toBeLessThanOrEqual(SYNTHESIS_INPUT_TARGET_TOKENS);
  });

  it("is deterministic — same input produces an identical trimmed prompt across runs", () => {
    const runA = boundSynthesisInput(makeOversizedDocs(), builderFor);
    const runB = boundSynthesisInput(makeOversizedDocs(), builderFor);

    expect(builderFor(runA.docs)).toBe(builderFor(runB.docs));
    expect(runA.pre_trim_tokens).toBe(runB.pre_trim_tokens);
    expect(runA.post_trim_tokens).toBe(runB.post_trim_tokens);
    expect(runA.trimmed_docs).toEqual(runB.trimmed_docs);
  });

  it("enforces the ceiling even on pathological doc sets (defensive stub pass)", () => {
    // 130 unknown docs pinned at the per-doc floor: pass 1 cannot reduce any
    // of them (reducible <= 0), so only the stub pass can honor the ceiling.
    const docs = new Map<string, SynthesisDocEntry>();
    for (let i = 0; i < 130; i++) {
      docs.set(`weird/doc-${String(i).padStart(3, "0")}.md`, entry(filler(3_500)));
    }
    const pre = estimateSynthesisTokens(builderFor(docs));
    expect(pre).toBeGreaterThan(SYNTHESIS_INPUT_MAX_TOKENS);

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(true);
    expect(estimateSynthesisTokens(builderFor(result.docs))).toBeLessThanOrEqual(
      SYNTHESIS_INPUT_MAX_TOKENS,
    );
  });
});

// ---------------------------------------------------------------------------
// Part A.3 — priority + recency (verification #2)
// ---------------------------------------------------------------------------

describe("boundSynthesisInput — signal preservation", () => {
  it("keeps handoff + decisions/_INDEX verbatim; trims lowest-signal docs first", () => {
    const docs = makeOversizedDocs();
    const result = boundSynthesisInput(docs, builderFor);
    const message = builderFor(result.docs);

    // Highest-signal docs survive byte-for-byte.
    expect(result.docs.get("handoff.md")?.content).toBe(HANDOFF_CONTENT);
    expect(result.docs.get("decisions/_INDEX.md")?.content).toBe(
      docs.get("decisions/_INDEX.md")?.content,
    );
    expect(message).toContain("UNIQUE-HANDOFF-MARKER-7731");
    expect(message).toContain("| D-240 |"); // recent decision row intact

    const trimmedPaths = result.trimmed_docs.map((t) => t.path);
    expect(trimmedPaths).not.toContain("handoff.md");
    expect(trimmedPaths).not.toContain("decisions/_INDEX.md");

    // Trim walk order = documented lowest-signal-first order.
    expect(trimmedPaths).toEqual([
      "decisions/operations.md",
      "eliminated.md",
      "glossary.md",
      "architecture.md",
      "session-log.md",
      "known-issues.md",
      "task-queue.md",
      "insights.md",
    ]);

    // Every trim is reported with sane pre/post counts, and every trimmed
    // doc retains a meaningful fraction of the per-doc floor — a regression
    // that gutted docs to a single line would fail here (metaswarm review).
    // The 0.4 band (not >= floor) is deliberate: kept content can land
    // somewhat below the floor after the embedded truncation notice and
    // line-boundary rounding, both documented in input-budget.ts.
    for (const t of result.trimmed_docs) {
      expect(t.post_tokens).toBeLessThan(t.pre_tokens);
      expect(t.post_tokens).toBeGreaterThanOrEqual(TRIM_DOC_FLOOR_TOKENS * 0.4);
    }
  });

  it("keeps the most-recent end of chronological docs and marks the cut", () => {
    const docs = makeOversizedDocs();
    const result = boundSynthesisInput(docs, builderFor);

    // session-log.md is newest-FIRST → head retention: newest sessions
    // survive, oldest are dropped.
    const sessionLog = result.docs.get("session-log.md")?.content ?? "";
    expect(sessionLog).toContain("### Session 60");
    expect(sessionLog).not.toContain("### Session 1\n");
    expect(sessionLog).toContain("[synthesis input bound — brief-445/R3-dur]");

    // insights.md is newest-LAST → tail retention: the most recent insights
    // survive, the oldest are dropped, and the title line is preserved.
    const insights = result.docs.get("insights.md")?.content ?? "";
    expect(insights).toContain("### INS-300:");
    expect(insights).not.toContain("### INS-1:");
    expect(insights.startsWith("# Insights — Test Project")).toBe(true);
    expect(insights).toContain("[synthesis input bound — brief-445/R3-dur]");
    // A meaningful QUANTITY of recent insights survives — not just the single
    // newest entry. With this fixture ~120 of 300 are retained; >=50 leaves
    // wide slack for parameter drift while decisively failing a regression
    // that kept only the newest item (metaswarm review).
    const retainedInsightHeaders = insights.match(/### INS-\d+:/g) ?? [];
    expect(retainedInsightHeaders.length).toBeGreaterThanOrEqual(50);
    expect(insights).toContain("### INS-250:");

    // Trimmed docs' header sizes reflect the trimmed content (honest headers).
    const message = builderFor(result.docs);
    const trimmedInsightsSize = result.docs.get("insights.md")?.size ?? 0;
    expect(message).toContain(`### FILE: insights.md (${trimmedInsightsSize} bytes)`);
    expect(trimmedInsightsSize).toBeLessThan(docs.get("insights.md")?.content.length ?? 0);
  });

  it("preserves the RECENT end when a high-signal doc is ITSELF the bloat source", () => {
    // The brief names "decisions accretion" as a growth vector this cap must
    // absorb. When decisions/_INDEX.md alone exceeds the ceiling, the bound
    // must trim IT — and the retained rows must be the most recent (highest
    // D-N, inserted before the EOF sentinel by prism_log_decision), not the
    // oldest. A retention-direction regression here would feed the model the
    // OLDEST decisions and silently defeat "recent decisions survive"
    // (metaswarm review — this exact mutation passed the prior suite).
    const docs = new Map<string, SynthesisDocEntry>([
      ["handoff.md", entry(HANDOFF_CONTENT)],
      ["decisions/_INDEX.md", entry(makeDecisionIndex(8_000))],
      ["insights.md", entry(makeInsights(10, 300))],
    ]);
    const pre = estimateSynthesisTokens(builderFor(docs));
    expect(pre).toBeGreaterThan(SYNTHESIS_INPUT_MAX_TOKENS);

    const result = boundSynthesisInput(docs, builderFor);

    expect(result.trimmed).toBe(true);
    expect(result.trimmed_docs.map((t) => t.path)).toContain("decisions/_INDEX.md");
    expect(estimateSynthesisTokens(builderFor(result.docs))).toBeLessThanOrEqual(
      SYNTHESIS_INPUT_MAX_TOKENS,
    );

    const index = result.docs.get("decisions/_INDEX.md")?.content ?? "";
    // Most recent decisions retained, oldest dropped, title line preserved.
    expect(index).toContain("| D-8000 |");
    expect(index).toContain("| D-7000 |");
    expect(index).not.toContain("| D-1 |");
    expect(index.startsWith("# Decision Registry")).toBe(true);
    expect(index).toContain("[synthesis input bound — brief-445/R3-dur]");
    // The highest-priority doc (handoff) is still untouched even when the
    // registry itself is the doc being cut.
    expect(result.docs.get("handoff.md")?.content).toBe(HANDOFF_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// Part B — pipeline integration (verification #1 + #3 through the real
// generate functions, mocked at the synthesize/pushFile/resolver boundaries)
// ---------------------------------------------------------------------------

/** Wire resolveDocFiles to return the living-doc map on the first shape of
 *  call (contains handoff.md) and the domain map otherwise. */
function wireResolver(
  living: Map<string, SynthesisDocEntry>,
  domains: Map<string, SynthesisDocEntry> = new Map(),
) {
  mockResolveDocFiles.mockImplementation(async (_slug: string, names: string[]) => {
    const source = names.includes("handoff.md") ? living : domains;
    // resolveDocFiles returns { content, sha, size } entries keyed by docName.
    const out = new Map<string, { content: string; sha: string; size: number }>();
    for (const [k, v] of source) {
      out.set(k, { content: v.content, sha: `sha-${k}`, size: v.size });
    }
    return out;
  });
}

const SUCCESS_RESULT = {
  success: true as const,
  content: "## Project State\nok\n<!-- EOF: intelligence-brief.md -->",
  input_tokens: 1000,
  output_tokens: 500,
  model: "test-model",
};

function findAssembledLog(message: string): Record<string, unknown> | undefined {
  const call = mockLoggerInfo.mock.calls.find((c) => c[0] === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("generateIntelligenceBrief — input bound integration", () => {
  it("oversized project: prompt handed to synthesize() is <=120K tokens; diagnostics emitted", async () => {
    // Living docs only (domain fetch returns empty) — keeps the fixture
    // identical to the representative Part A fixture minus operations.md.
    const living = makeOversizedDocs();
    living.delete("decisions/operations.md");
    wireResolver(living);
    mockSynthesize.mockResolvedValue(SUCCESS_RESULT);

    const outcome = await generateIntelligenceBrief("test-project", 99);

    expect(outcome.success).toBe(true);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    const userContent = mockSynthesize.mock.calls[0][1];
    expect(estimateSynthesisTokens(userContent)).toBeLessThanOrEqual(
      SYNTHESIS_INPUT_MAX_TOKENS,
    );
    // High-signal content still present in the real prompt.
    expect(userContent).toContain("UNIQUE-HANDOFF-MARKER-7731");

    // Observability — logger carries pre/post counts + per-doc trim detail.
    const logPayload = findAssembledLog("Synthesis input assembled");
    expect(logPayload).toBeDefined();
    expect(logPayload?.input_trimmed).toBe(true);
    expect(logPayload?.pre_trim_tokens).toBeGreaterThan(SYNTHESIS_INPUT_MAX_TOKENS);
    expect(logPayload?.post_trim_tokens).toBeLessThanOrEqual(SYNTHESIS_INPUT_MAX_TOKENS);
    expect(Array.isArray(logPayload?.trimmed_docs)).toBe(true);
    expect((logPayload?.trimmed_docs as unknown[]).length).toBeGreaterThan(0);

    // Observability — the outcome carries the same report.
    expect(outcome.input_budget?.trimmed).toBe(true);
    expect(outcome.input_budget?.pre_trim_tokens).toBe(logPayload?.pre_trim_tokens);
    expect(outcome.input_budget?.post_trim_tokens).toBe(logPayload?.post_trim_tokens);
  });

  it("normal project: prompt is unchanged (no trimming, no notices)", async () => {
    const living = makeNormalDocs();
    wireResolver(living);
    mockSynthesize.mockResolvedValue(SUCCESS_RESULT);

    const outcome = await generateIntelligenceBrief("test-project", 99);

    expect(outcome.success).toBe(true);
    const userContent = mockSynthesize.mock.calls[0][1];
    // Every doc's full content is embedded verbatim — nothing was trimmed.
    for (const [, doc] of living) {
      expect(userContent).toContain(doc.content);
    }
    expect(userContent).not.toContain("[synthesis input bound");

    const logPayload = findAssembledLog("Synthesis input assembled");
    expect(logPayload?.input_trimmed).toBe(false);
    expect(logPayload?.pre_trim_tokens).toBe(logPayload?.post_trim_tokens);
    expect(outcome.input_budget?.trimmed).toBe(false);
    expect(outcome.input_budget?.trimmed_docs).toEqual([]);
  });

  it("failure passthrough: timeout error string reaches the outcome unchanged (classifier input preserved)", async () => {
    wireResolver(makeNormalDocs());
    mockSynthesize.mockResolvedValue({
      success: false,
      error: "Request timeout of 240000ms exceeded",
      error_code: "TIMEOUT",
    });

    const outcome = await generateIntelligenceBrief("test-project", 99);

    expect(outcome.success).toBe(false);
    // The exact string src/tools/synthesize.ts's emitFailureDiagnostic keys
    // on ("timeout" substring → SYNTHESIS_TIMEOUT) is untouched.
    expect(outcome.error).toBe("Request timeout of 240000ms exceeded");
    // Budget report still attached for timeout forensics.
    expect(outcome.input_budget).toBeDefined();
    expect(outcome.input_budget?.trimmed).toBe(false);
  });
});

describe("generatePendingDocUpdates — input bound integration", () => {
  it("oversized project: PDU prompt is bounded the same way", async () => {
    const living = makeOversizedDocs();
    living.delete("decisions/operations.md");
    wireResolver(living);
    mockResolveDocPushPath.mockResolvedValue(".prism/pending-doc-updates.md");
    mockSynthesize.mockResolvedValue({
      ...SUCCESS_RESULT,
      content:
        "## architecture.md\nNo updates needed at this time.\n## glossary.md\nNo updates needed at this time.\n## insights.md\nNo updates needed at this time.\n## No Updates Needed\nok\n<!-- EOF: pending-doc-updates.md -->",
    });

    const outcome = await generatePendingDocUpdates("test-project", 99);

    expect(outcome.success).toBe(true);
    const userContent = mockSynthesize.mock.calls[0][1];
    expect(estimateSynthesisTokens(userContent)).toBeLessThanOrEqual(
      SYNTHESIS_INPUT_MAX_TOKENS,
    );
    expect(userContent).toContain("UNIQUE-HANDOFF-MARKER-7731");

    const logPayload = findAssembledLog("Pending doc-updates synthesis input assembled");
    expect(logPayload).toBeDefined();
    expect(logPayload?.input_trimmed).toBe(true);
    expect(logPayload?.post_trim_tokens).toBeLessThanOrEqual(SYNTHESIS_INPUT_MAX_TOKENS);
    expect(outcome.input_budget?.trimmed).toBe(true);
  });
});

// ── brief-459 / SRV-04: orientation-aware retention for session-log.md ──────
//
// The INS-316 inversion class lived on here: retention direction for
// session-log.md was hardcoded to HEAD (newest-first assumption) citing a
// config value brief-453 had already deleted. prism's real session-log is
// chronological (newest LAST) — a trim kept Sessions 1..N-head and silently
// dropped the NEWEST narrative from synthesis input.

describe("brief-459 / SRV-04: chronological session-log retention", () => {
  /** Chronological session log — newest session LAST (prism's real layout). */
  function makeChronologicalSessionLog(sessions: number, charsPerSession: number): string {
    const parts: string[] = ["# Session Log — Test Project", ""];
    for (let s = 1; s <= sessions; s++) {
      parts.push(`### Session ${s}`);
      parts.push(filler(charsPerSession));
      parts.push("");
    }
    parts.push("<!-- EOF: session-log.md -->");
    return parts.join("\n");
  }

  it("a trimmed CHRONOLOGICAL session-log retains the HIGHEST-numbered sessions", () => {
    const docs = makeOversizedDocs();
    docs.set("session-log.md", entry(makeChronologicalSessionLog(60, 2_000)));
    const result = boundSynthesisInput(docs, builderFor);
    expect(result.trimmed).toBe(true);

    const sessionLog = result.docs.get("session-log.md")?.content ?? "";
    expect(sessionLog).toContain("### Session 60");
    expect(sessionLog).not.toContain("### Session 1\n");
    expect(sessionLog).toContain("[synthesis input bound — brief-445/R3-dur]");
    // The title line stays anchored on tail retention.
    expect(sessionLog.startsWith("# Session Log — Test Project")).toBe(true);
  });

  it("a trimmed NEWEST-FIRST session-log still retains its leading (newest) sessions", () => {
    // Mirror assertion so orientation detection provably keys off entry
    // numbers, not the path name.
    const docs = makeOversizedDocs(); // makeSessionLog is newest-first
    const result = boundSynthesisInput(docs, builderFor);
    const sessionLog = result.docs.get("session-log.md")?.content ?? "";
    expect(sessionLog).toContain("### Session 60");
    expect(sessionLog).not.toContain("### Session 1\n");
  });
});
