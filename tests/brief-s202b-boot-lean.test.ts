// brief-s202b — S202 boot-lean server bundle (bootstrap side).
// T1 session_state_manifest + BOOT_INDEX_MODE matrix, T4 prefetch-mode matrix
// + summary cap + PREFETCH_DELIVERED, T5 handoff item budget (boot + finalize
// validation), T6 masthead knob, T7 kernel-handshake drift, plus the
// brief-465-pattern round-trip fidelity check on the compact payload.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

import { fetchFile, pushFile, fileExists, listRepos } from "../src/github/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HANDOFF_ITEM_BUDGET_BYTES,
  PREFETCH_SUMMARY_CAP_BYTES,
  resolveBootIndexMode,
  resolveBootMastheadSvg,
  resolveBriefCompactMode,
  resolveFinalizeComposeMode,
  resolvePrefetchMode,
} from "../src/config.js";
import {
  buildSessionStateManifest,
  capSummaryBytes,
  findMissingKernelSections,
  parseKernelManifestHeader,
  truncateTitle60,
} from "../src/tools/bootstrap.js";
import { validateHandoff } from "../src/validation/handoff.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockListRepos = vi.mocked(listRepos);

let bootstrapHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") bootstrapHandler = handler as typeof bootstrapHandler;
  }),
} as unknown as McpServer;

import { registerBootstrap } from "../src/tools/bootstrap.js";

const LONG_ITEM = `Very long critical context item that keeps going: ${"detail ".repeat(45)}end`; // > 300 B

const HANDOFF = `# Handoff

## Meta
- Handoff Version: 33
- Session Count: 28
- Template Version: 2.29.0
- Status: Active

## Critical Context
1. Short fact one
2. ${LONG_ITEM}
3. Short fact three

## Where We Are
Current state of the project.

## Resumption Point
Resume here.

## Next Steps
1. Review the task queue backlog priority
2. Ship the thing

<!-- EOF: handoff.md -->`;

const DECISIONS = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | Foundational choice | arch | SETTLED | 1 |
| D-2 | Another decision | infra | SETTLED | 2 |

<!-- EOF: _INDEX.md -->`;

const LONG_RULE_TITLE =
  "cc_subprocess wrapper-success without token-count check is unsafe for background synthesis flows";

const STANDING_RULES = `# Standing Rules

## Active

### INS-1: Always verify — STANDING RULE [TIER:A]
**Standing procedure:** Verify everything before asserting.

### INS-2: ${LONG_RULE_TITLE} — STANDING RULE [TIER:B]
<!-- topics: synthesis, transport -->
**Standing procedure:** Check token counts on wrapper success.

### INS-3: Short B rule — STANDING RULE [TIER:B]
<!-- topics: finalize -->
**Standing procedure:** Do the finalize thing.

### INS-4: A C-tier rule — STANDING RULE [TIER:C]
<!-- topics: history -->
**Standing procedure:** Historical context only.

<!-- EOF: standing-rules.md -->`;

const BRIEF = `# Intelligence Brief — Test

> Last synthesized: S27 (2026-07-01)

## Project State
The project is healthy. Momentum is strong. Direction is clear. A fourth sentence.

## Risk Flags
- Watch the thing.

## Quality Audit
Docs current.

<!-- EOF: intelligence-brief.md -->`;

const TEMPLATE_PLAIN = `# PRISM Core Template v2.29.0
Template Version: 2.29.0
Rules here.

## Operating Posture
Be direct.

## Interaction Rules
Answer first.

<!-- EOF: core-template-mcp.md -->`;

const TEMPLATE_WITH_MANIFEST_OK = `# PRISM Core Template v3.0.0
Template Version: 3.0.0
Kernel-Manifest: ## Operating Posture, Interaction Rules, ## Module Triggers

## Operating Posture
Be direct.

## Interaction Rules
Answer first.

## Module Triggers
Load on demand.

<!-- EOF: core-template-mcp.md -->`;

const TEMPLATE_WITH_MANIFEST_DRIFT = `# PRISM Core Template v3.0.0
Template Version: 3.0.0
Kernel-Manifest: ## Operating Posture, ## Rule 9, Module Triggers

## Operating Posture
Be direct.

<!-- EOF: core-template-mcp.md -->`;

/** Long task-queue so its summary exceeds the 1200B cap. */
function makeTaskQueue(): string {
  const headers = Array.from({ length: 25 }, (_, i) => `## Workstream ${i + 1} — a long descriptive section header for measurement`).join("\n\nitem\n\n");
  return `# Task Queue\n\n${"intro ".repeat(120)}\n\n${headers}\n\n<!-- EOF: task-queue.md -->`;
}

function setupMocks(opts: { template?: string; standingRules?: string | null } = {}) {
  const template = opts.template ?? TEMPLATE_PLAIN;
  const standingRules = opts.standingRules === undefined ? STANDING_RULES : opts.standingRules;
  const taskQueue = makeTaskQueue();

  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "sha-handoff", size: HANDOFF.length };
    if (path.endsWith("_INDEX.md")) return { content: DECISIONS, sha: "sha-decisions", size: DECISIONS.length };
    if (path.includes("core-template-mcp.md")) return { content: template, sha: "sha-template", size: template.length };
    if (path.endsWith("intelligence-brief.md")) return { content: BRIEF, sha: "sha-brief", size: BRIEF.length };
    if (path.endsWith("task-queue.md")) return { content: taskQueue, sha: "sha-queue", size: taskQueue.length };
    if (standingRules && path.endsWith("standing-rules.md")) {
      return { content: standingRules, sha: "sha-rules", size: standingRules.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFileExists.mockResolvedValue(false);
  mockListRepos.mockResolvedValue([]);
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed123", size: 50 });
}

async function boot(args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await bootstrapHandler({ project_slug: "prism", ...args });
  return JSON.parse(result.content[0].text);
}

const S202B_ENV_KEYS = [
  "BOOT_INDEX_MODE",
  "BRIEF_COMPACT_MODE",
  "PREFETCH_MODE",
  "BOOT_MASTHEAD_SVG",
  "FINALIZE_COMPOSE_MODE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of S202B_ENV_KEYS) savedEnv[key] = process.env[key];
  vi.clearAllMocks();
  // Fresh cache between tests would need resetModules; instead vary the
  // template cache key never matters here because templateCache caches by
  // path — clear it via a fresh registration + distinct content is not
  // needed since fetchFile is re-mocked per test and the cache TTL spans the
  // suite. Tests that change the TEMPLATE therefore reset modules below.
  registerBootstrap(mockServer);
  setupMocks();
});

afterEach(() => {
  for (const key of S202B_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─── env resolver defaults (unknown values fall back, never crash) ──────────

describe("brief-s202b env resolvers", () => {
  it("defaults: full / dedup / opening_only / svg-on / files", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveBootIndexMode(env)).toBe("full");
    expect(resolveBriefCompactMode(env)).toBe("dedup");
    expect(resolvePrefetchMode(env)).toBe("opening_only");
    expect(resolveBootMastheadSvg(env)).toBe(true);
    expect(resolveFinalizeComposeMode(env)).toBe("files");
  });

  it("explicit values select the alternate branch; unknown values fall back to the default", () => {
    expect(resolveBootIndexMode({ BOOT_INDEX_MODE: "compact" } as NodeJS.ProcessEnv)).toBe("compact");
    expect(resolveBootIndexMode({ BOOT_INDEX_MODE: "bogus" } as NodeJS.ProcessEnv)).toBe("full");
    expect(resolveBriefCompactMode({ BRIEF_COMPACT_MODE: "legacy" } as NodeJS.ProcessEnv)).toBe("legacy");
    expect(resolveBriefCompactMode({ BRIEF_COMPACT_MODE: "??" } as NodeJS.ProcessEnv)).toBe("dedup");
    expect(resolvePrefetchMode({ PREFETCH_MODE: "legacy" } as NodeJS.ProcessEnv)).toBe("legacy");
    expect(resolvePrefetchMode({ PREFETCH_MODE: "nope" } as NodeJS.ProcessEnv)).toBe("opening_only");
    expect(resolveBootMastheadSvg({ BOOT_MASTHEAD_SVG: "off" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveBootMastheadSvg({ BOOT_MASTHEAD_SVG: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveBootMastheadSvg({ BOOT_MASTHEAD_SVG: "weird" } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveFinalizeComposeMode({ FINALIZE_COMPOSE_MODE: "legacy" } as NodeJS.ProcessEnv)).toBe("legacy");
    expect(resolveFinalizeComposeMode({ FINALIZE_COMPOSE_MODE: "x" } as NodeJS.ProcessEnv)).toBe("files");
  });
});

// ─── T1: manifest shape + BOOT_INDEX_MODE matrix ─────────────────────────────

describe("brief-s202b T1 — session_state_manifest + BOOT_INDEX_MODE", () => {
  it("truncateTitle60 caps at 60 chars + ellipsis and passes short titles through", () => {
    expect(truncateTitle60("short title")).toBe("short title");
    const long = "x".repeat(100);
    const capped = truncateTitle60(long);
    expect(capped.endsWith("…")).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(61);
    expect(truncateTitle60("y".repeat(60))).toBe("y".repeat(60)); // exactly 60 → untouched
  });

  it("full mode (default): legacy standing_rules_index present AND manifest present (additive release)", async () => {
    delete process.env.BOOT_INDEX_MODE;
    const parsed = await boot();
    expect(parsed.standing_rules_index).toBeDefined();
    expect(Array.isArray(parsed.standing_rules_index)).toBe(true);
    expect(parsed.session_state_manifest).toBeDefined();
  });

  it("compact mode: legacy index OMITTED (absent, not null), manifest present, response byte-smaller", async () => {
    delete process.env.BOOT_INDEX_MODE;
    const fullParsed = await boot();
    const fullBytes = fullParsed.response_bytes as number;

    process.env.BOOT_INDEX_MODE = "compact";
    const parsed = await boot();
    expect("standing_rules_index" in parsed).toBe(false);
    expect(parsed.session_state_manifest).toBeDefined();
    expect(parsed.response_bytes).toBeLessThan(fullBytes);
  });

  it("manifest shape: docs rows carry {path, sha, bytes}; rules carry total/tier_counts/compact index; brief carries synthesized_session + delivered sections", async () => {
    const parsed = await boot();
    const manifest = parsed.session_state_manifest;

    // docs — every boot-fetched doc appears with sha + true byte size.
    const paths = manifest.docs.map((d: { path: string }) => d.path);
    expect(paths).toContain(".prism/handoff.md");
    expect(paths).toContain(".prism/decisions/_INDEX.md");
    expect(paths).toContain(".prism/intelligence-brief.md");
    expect(paths).toContain(".prism/standing-rules.md");
    const handoffRow = manifest.docs.find((d: { path: string }) => d.path === ".prism/handoff.md");
    expect(handoffRow.sha).toBe("sha-handoff");
    expect(handoffRow.bytes).toBeGreaterThan(0);

    // rules — totals + tier counts + compact index ({id, t, topics, title60}).
    expect(manifest.rules.total).toBe(4);
    expect(manifest.rules.tier_counts).toEqual({ A: 1, B: 2, C: 1 });
    expect(manifest.rules.index).toHaveLength(3); // B ∪ C only — Tier A bodies ship whole
    const ins2 = manifest.rules.index.find((r: { id: string }) => r.id === "INS-2");
    expect(ins2.t).toBe("B");
    expect(ins2.topics).toEqual(["synthesis", "transport"]);
    expect(ins2.title60.endsWith("…")).toBe(true);
    expect(ins2.title60.length).toBeLessThanOrEqual(61);

    // brief — synthesized session + spec sections present in the DELIVERY.
    expect(manifest.brief.synthesized_session).toBe(27);
    expect(manifest.brief.sections).toContain("## Risk Flags");
    expect(manifest.brief.sections).toContain("## Quality Audit");
  });

  it("buildSessionStateManifest is pure: empty inputs produce an empty-but-shaped manifest", () => {
    const manifest = buildSessionStateManifest({
      docs: [],
      allRules: [],
      indexedRules: [],
      briefSynthesizedSession: null,
      deliveredBrief: null,
    });
    expect(manifest).toEqual({
      docs: [],
      rules: { total: 0, tier_counts: { A: 0, B: 0, C: 0 }, index: [] },
      brief: { synthesized_session: null, sections: [] },
    });
  });

  it("round-trip fidelity (brief-465 pattern): the compact payload stays field-complete for resumption", async () => {
    process.env.BOOT_INDEX_MODE = "compact";
    const parsed = await boot();

    // Handoff-derived resumption spine — Meta-derived scalars + sections.
    expect(parsed.handoff_version).toBe(33);
    expect(parsed.session_count).toBe(28);
    expect(parsed.template_version).toBe("2.29.0");
    expect(parsed.critical_context.length).toBe(3);
    expect(parsed.current_state).toContain("Current state of the project.");
    expect(parsed.resumption_point).toContain("Resume here.");
    expect(parsed.next_steps.length).toBe(2);
    // Decisions + guardrails still delivered.
    expect(parsed.recent_decisions.length).toBeGreaterThan(0);
    expect(parsed.guardrails.length).toBeGreaterThan(0);
    // Rules: Tier-A bodies still ship whole; index reachable via the manifest.
    expect(parsed.standing_rules.some((r: { id: string }) => r.id === "INS-1")).toBe(true);
    expect(parsed.session_state_manifest.rules.index.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining(["INS-2", "INS-3", "INS-4"]),
    );
    // Every rule reachable by topic yesterday is reachable today (P-1
    // mitigation): topics are carried whole in the manifest index.
    expect(
      parsed.session_state_manifest.rules.index.flatMap((r: { topics: string[] }) => r.topics),
    ).toEqual(expect.arrayContaining(["synthesis", "transport", "finalize", "history"]));
    // Brief + behavioral rules unaffected by index mode.
    expect(parsed.intelligence_brief).toContain("## Risk Flags");
    expect(parsed.behavioral_rules).toContain("PRISM Core Template");
  });
});

// ─── T4: prefetch-mode matrix + summary cap + telemetry ─────────────────────

describe("brief-s202b T4 — PREFETCH_MODE matrix + summary cap + PREFETCH_DELIVERED", () => {
  it("opening_only (default): next_steps keywords do NOT trigger prefetch", async () => {
    delete process.env.PREFETCH_MODE;
    // Handoff next_steps contain "task", "queue", "backlog", "priority" —
    // legacy triggers. No opening message → opening_only must fetch nothing
    // keyword-driven.
    const parsed = await boot();
    const files = (parsed.prefetched_documents as Array<{ file: string }>).map(d => d.file);
    expect(files).not.toContain(".prism/task-queue.md");
  });

  it("legacy: next_steps keywords DO trigger prefetch (rollback restores today's behavior)", async () => {
    process.env.PREFETCH_MODE = "legacy";
    const parsed = await boot();
    const files = (parsed.prefetched_documents as Array<{ file: string }>).map(d => d.file);
    expect(files).toContain(".prism/task-queue.md");
  });

  it("opening_only: opening-message keywords still trigger, and each summary is capped at PREFETCH_SUMMARY_CAP_BYTES", async () => {
    delete process.env.PREFETCH_MODE;
    const parsed = await boot({ opening_message: "let's review the task queue" });
    const entry = (parsed.prefetched_documents as Array<{ file: string; summary: string }>).find(
      d => d.file === ".prism/task-queue.md",
    );
    expect(entry).toBeDefined();
    const bytes = new TextEncoder().encode(entry!.summary).length;
    expect(bytes).toBeLessThanOrEqual(PREFETCH_SUMMARY_CAP_BYTES);
    expect(entry!.summary.endsWith("…")).toBe(true); // the fixture summary measures over the cap
  });

  it("legacy: summaries are NOT capped (byte-identical rollback)", async () => {
    process.env.PREFETCH_MODE = "legacy";
    const parsed = await boot({ opening_message: "let's review the task queue" });
    const entry = (parsed.prefetched_documents as Array<{ file: string; summary: string }>).find(
      d => d.file === ".prism/task-queue.md",
    );
    expect(entry).toBeDefined();
    expect(new TextEncoder().encode(entry!.summary).length).toBeGreaterThan(PREFETCH_SUMMARY_CAP_BYTES);
  });

  it("PREFETCH_DELIVERED info diagnostic names delivered files (hit-rate telemetry)", async () => {
    const parsed = await boot({ opening_message: "review the task queue" });
    const diag = (parsed.diagnostics as Array<{ code: string; context?: { files?: string[]; mode?: string } }>).find(
      d => d.code === "PREFETCH_DELIVERED",
    );
    expect(diag).toBeDefined();
    expect(diag!.context!.files).toContain(".prism/task-queue.md");
    expect(diag!.context!.mode).toBe("opening_only");
  });

  it("no PREFETCH_DELIVERED diagnostic when nothing was prefetched", async () => {
    const parsed = await boot();
    const diag = (parsed.diagnostics as Array<{ code: string }>).find(d => d.code === "PREFETCH_DELIVERED");
    expect(diag).toBeUndefined();
  });

  it("capSummaryBytes: under-cap strings pass through; over-cap strings are UTF-8-safely bounded", () => {
    expect(capSummaryBytes("short", 1200)).toBe("short");
    const capped = capSummaryBytes("é".repeat(2000), 1200); // 2-byte chars
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(1200);
    expect(capped.endsWith("…")).toBe(true);
  });
});

// ─── T5: handoff item budget (boot parse + finalize validation, warn-only) ──

describe("brief-s202b T5 — HANDOFF_ITEM_OVERSIZE (warn-only)", () => {
  it("boot: an over-300B Critical Context item emits the warn diagnostic and never blocks the boot", async () => {
    const parsed = await boot();
    expect(parsed.error).toBeUndefined();
    const diag = (parsed.diagnostics as Array<{ code: string; level: string; context?: { items?: Array<{ index: number; bytes: number }> } }>).find(
      d => d.code === "HANDOFF_ITEM_OVERSIZE",
    );
    expect(diag).toBeDefined();
    expect(diag!.level).toBe("warn");
    expect(diag!.context!.items!.some(i => i.index === 2 && i.bytes > HANDOFF_ITEM_BUDGET_BYTES)).toBe(true);
  });

  it("finalize validation: the same budget is a validateHandoff WARNING, never an error", () => {
    const result = validateHandoff(HANDOFF);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(w => w.includes("HANDOFF_ITEM_OVERSIZE"))).toBe(true);
  });

  it("compliant items produce no item-budget warning", () => {
    const lean = HANDOFF.replace(LONG_ITEM, "A lean second fact");
    const result = validateHandoff(lean);
    expect(result.warnings.some(w => w.includes("HANDOFF_ITEM_OVERSIZE"))).toBe(false);
  });
});

// ─── T6: masthead knob ───────────────────────────────────────────────────────

describe("brief-s202b T6 — BOOT_MASTHEAD_SVG knob", () => {
  it("default on: boot_masthead_svg is a rendered SVG string", async () => {
    delete process.env.BOOT_MASTHEAD_SVG;
    const parsed = await boot();
    expect(typeof parsed.boot_masthead_svg).toBe("string");
    expect(parsed.boot_masthead_svg).toContain("<svg");
  });

  it("off: boot_masthead_svg ships null and banner_text is unaffected", async () => {
    process.env.BOOT_MASTHEAD_SVG = "off";
    const parsed = await boot();
    expect(parsed.boot_masthead_svg).toBeNull();
    expect(typeof parsed.banner_text).toBe("string");
    expect(parsed.banner_text.length).toBeGreaterThan(0);
  });
});

// ─── T7: kernel handshake ────────────────────────────────────────────────────

describe("brief-s202b T7 — Kernel-Manifest handshake (KERNEL_SPLIT_DRIFT)", () => {
  it("parseKernelManifestHeader: absent header → null; present → trimmed entry list", () => {
    expect(parseKernelManifestHeader(TEMPLATE_PLAIN)).toBeNull();
    expect(parseKernelManifestHeader(TEMPLATE_WITH_MANIFEST_OK)).toEqual([
      "## Operating Posture",
      "Interaction Rules",
      "## Module Triggers",
    ]);
  });

  it("findMissingKernelSections tolerates entries with or without the ## marker, case-insensitively", () => {
    expect(findMissingKernelSections(TEMPLATE_WITH_MANIFEST_OK, ["## Operating Posture", "interaction rules"])).toEqual([]);
    expect(findMissingKernelSections(TEMPLATE_WITH_MANIFEST_OK, ["## Rule 9"])).toEqual(["## Rule 9"]);
  });

  // The template cache is keyed by path with a 5-minute TTL, so the manifest
  // integration cases run through freshly-reset modules to control which
  // template content the handler sees.
  async function bootWithTemplate(template: string): Promise<Record<string, any>> {
    vi.resetModules();
    const { registerBootstrap: freshRegister } = await import("../src/tools/bootstrap.js");
    let handler: typeof bootstrapHandler;
    const freshServer = {
      tool: vi.fn((name: string, _d: string, _s: unknown, h: unknown) => {
        if (name === "prism_bootstrap") handler = h as typeof bootstrapHandler;
      }),
    } as unknown as McpServer;
    const github = await import("../src/github/client.js");
    vi.mocked(github.pushFile).mockResolvedValue({ success: true, sha: "p", size: 1 });
    vi.mocked(github.fileExists).mockResolvedValue(false);
    vi.mocked(github.listRepos).mockResolvedValue([]);
    vi.mocked(github.fetchFile).mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "sha-handoff", size: HANDOFF.length };
      if (path.endsWith("_INDEX.md")) return { content: DECISIONS, sha: "sha-decisions", size: DECISIONS.length };
      if (path.includes("core-template-mcp.md")) return { content: template, sha: "sha-t", size: template.length };
      throw new Error(`Not found: ${path}`);
    });
    freshRegister(freshServer);
    const result = await handler!({ project_slug: "prism" });
    return JSON.parse(result.content[0].text);
  }

  it("manifest header present + a listed section missing → KERNEL_SPLIT_DRIFT warn naming the sections", async () => {
    const parsed = await bootWithTemplate(TEMPLATE_WITH_MANIFEST_DRIFT);
    const diag = (parsed.diagnostics as Array<{ code: string; level: string; context?: { missing_sections?: string[] } }>).find(
      d => d.code === "KERNEL_SPLIT_DRIFT",
    );
    expect(diag).toBeDefined();
    expect(diag!.level).toBe("warn");
    expect(diag!.context!.missing_sections).toEqual(["## Rule 9", "Module Triggers"]);
  });

  it("manifest header present + all sections delivered → no diagnostic", async () => {
    const parsed = await bootWithTemplate(TEMPLATE_WITH_MANIFEST_OK);
    const diag = (parsed.diagnostics as Array<{ code: string }>).find(d => d.code === "KERNEL_SPLIT_DRIFT");
    expect(diag).toBeUndefined();
  });

  it("pre-kernel template (no header) → no diagnostic", async () => {
    const parsed = await bootWithTemplate(TEMPLATE_PLAIN);
    const diag = (parsed.diagnostics as Array<{ code: string }>).find(d => d.code === "KERNEL_SPLIT_DRIFT");
    expect(diag).toBeUndefined();
  });
});
