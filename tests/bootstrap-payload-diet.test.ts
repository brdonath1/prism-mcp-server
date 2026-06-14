// M-012 — server payload diet + instrumentation (brief-465, W3-S6).
// SRV-39 (oversize tripwire recalibration + attribution), SRV-68 (delivered
// attribution), SRV-28 (truthful bytes_delivered), SRV-85 (guardrails blend),
// SRV-109 (deprecated alias removal), plus the FIDELITY-GUARD bootstrap
// round-trip (field-complete on the trimmed payload).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile, fileExists } from "../src/github/client.js";
import {
  BOOTSTRAP_OVERSIZE_ERROR_BYTES,
  BOOTSTRAP_OVERSIZE_WARN_BYTES,
} from "../src/config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);

let bootstrapHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") bootstrapHandler = handler as typeof bootstrapHandler;
  }),
} as unknown as McpServer;

import { registerBootstrap } from "../src/tools/bootstrap.js";

const HANDOFF = `# Handoff\n\n## Meta\n- Handoff Version: 33\n- Session Count: 28\n- Template Version: 2.10.0\n- Status: Active\n\n## Critical Context\n1. Item one\n2. Item two\n\n## Where We Are\nCurrent state.\n\n## Resumption Point\nResume here.\n\n## Next Steps\n1. Do thing A\n2. Do thing B\n\n<!-- EOF: handoff.md -->`;

function makeDecisionsIndex(settledCount: number): string {
  const header = "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|";
  const rows: string[] = [];
  for (let i = 1; i <= settledCount; i++) {
    rows.push(`| D-${i} | Decision ${i} | arch | SETTLED | ${i} |`);
  }
  return `${header}\n${rows.join("\n")}\n\n<!-- EOF: _INDEX.md -->`;
}

function makeInsights(ruleCount: number, procChars = 900): string {
  const blocks: string[] = [];
  for (let i = 1; i <= ruleCount; i++) {
    blocks.push(
      `### INS-${i}: Rule ${i} — STANDING RULE\n**Standing procedure:** ${"step ".repeat(Math.ceil(procChars / 5))}`,
    );
  }
  return `# Insights\n\n## Active\n\n${blocks.join("\n\n")}\n\n<!-- EOF: insights.md -->`;
}

function setupMocks(opts: { decisionsIndex?: string; insights?: string } = {}) {
  const decisionsIndex =
    opts.decisionsIndex ??
    "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->";
  const insights =
    opts.insights ??
    "# Insights\n\n## Active\n\n### INS-6: Test — STANDING RULE\n**Standing procedure:** Do the thing.\n\n<!-- EOF: insights.md -->";

  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return { content: HANDOFF, sha: "abc123", size: HANDOFF.length };
    }
    if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
      return { content: decisionsIndex, sha: "def456", size: decisionsIndex.length };
    }
    if (path.includes("core-template-mcp.md")) {
      return { content: "# PRISM Core Template v2.10.0\nRules here.\n<!-- EOF: core-template-mcp.md -->", sha: "ghi789", size: 80 };
    }
    if (path === ".prism/intelligence-brief.md" || path === "intelligence-brief.md") {
      return { content: "# Intelligence Brief\n\n## Project State\nHealthy.\n\n## Risk Flags\nNone.\n\n## Quality Audit\nGood.\n\n<!-- EOF: intelligence-brief.md -->", sha: "jkl012", size: 100 };
    }
    if (path === ".prism/insights.md" || path === "insights.md") {
      return { content: insights, sha: "mno345", size: insights.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFileExists.mockResolvedValue(false);
  mockFetchFiles.mockResolvedValue(new Map());
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed123", size: 50 });
}

beforeEach(() => {
  vi.clearAllMocks();
  registerBootstrap(mockServer);
  setupMocks();
});

describe("M-012 SRV-109 — deprecated standing_rules_tier_c_index alias removed", () => {
  it("the alias field is absent from the bootstrap response", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.standing_rules_tier_c_index).toBeUndefined();
    // The replacement field stays — sessions read prism_load_rules off this.
    expect(parsed.standing_rules_index).toBeDefined();
  });
});

describe("M-012 SRV-28 — bytes_delivered is the true delivered size", () => {
  it("bytes_delivered equals response_bytes (the measured payload), not a source-content sum", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.bytes_delivered).toBe("number");
    expect(parsed.bytes_delivered).toBe(parsed.response_bytes);
  });
});

describe("M-012 SRV-85 — guardrails blend foundational + most-recent SETTLED", () => {
  it("surfaces both the earliest and the most-recent settled decisions, capped at 20", async () => {
    setupMocks({ decisionsIndex: makeDecisionsIndex(30) });
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    const ids = parsed.guardrails.map((g: { id: string }) => g.id);
    expect(parsed.guardrails.length).toBe(20);
    // Foundational (earliest) present:
    expect(ids).toContain("D-1");
    // Most-recent present — the exact regression the position-blind slice missed:
    expect(ids).toContain("D-30");
    // A mid-era settled decision is neither foundational nor recent → excluded
    // (old first-20 code WOULD have shipped D-15 and dropped D-30).
    expect(ids).not.toContain("D-15");
  });

  it("ships all settled decisions unchanged when under the cap", async () => {
    setupMocks({ decisionsIndex: makeDecisionsIndex(3) });
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.guardrails.map((g: { id: string }) => g.id).sort()).toEqual(["D-1", "D-2", "D-3"]);
  });
});

describe("M-012 SRV-39 — oversize tripwire recalibration + attribution", () => {
  it("does NOT fire BOOTSTRAP_OVERSIZE at a steady-state-sized payload over the OLD 100KB limit", async () => {
    // ~115KB of Tier A bodies — over the retired 100KB error literal, under the
    // recalibrated 160KB warn. Proves the ambient-noise fix.
    setupMocks({ insights: makeInsights(120) });
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.response_bytes).toBeGreaterThan(100_000);
    expect(parsed.response_bytes).toBeLessThan(BOOTSTRAP_OVERSIZE_WARN_BYTES);
    const oversize = parsed.diagnostics.find((d: { code: string }) => d.code === "BOOTSTRAP_OVERSIZE");
    expect(oversize).toBeUndefined();
  });

  it("fires an error-level BOOTSTRAP_OVERSIZE with per-section attribution past the error threshold", async () => {
    // Enough Tier A bodies to exceed the 200KB error threshold.
    setupMocks({ insights: makeInsights(260) });
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.response_bytes).toBeGreaterThan(BOOTSTRAP_OVERSIZE_ERROR_BYTES);
    const oversize = parsed.diagnostics.find((d: { code: string }) => d.code === "BOOTSTRAP_OVERSIZE");
    expect(oversize).toBeDefined();
    expect(oversize.level).toBe("error");
    // SRV-39/68: the diagnostic names WHICH sections drove the size.
    expect(Array.isArray(oversize.context.top_sections)).toBe(true);
    expect(oversize.context.top_sections.length).toBeGreaterThan(0);
    expect(oversize.context.top_sections[0]).toHaveProperty("field");
    expect(oversize.context.top_sections[0]).toHaveProperty("bytes");
    // standing_rules dominates this fixture — it should be the largest section.
    expect(oversize.context.top_sections[0].field).toBe("standing_rules");
  });
});

describe("M-012 FIDELITY GUARD — bootstrap round-trip is field-complete on the trimmed payload", () => {
  it("every required section is present (byte-smaller from the alias drop, field-complete)", async () => {
    setupMocks({ decisionsIndex: makeDecisionsIndex(12), insights: makeInsights(4) });
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);

    // Meta-derived fields (## Meta) survive:
    expect(parsed.handoff_version).toBe(33);
    expect(parsed.session_count).toBe(28);
    expect(parsed.template_version).toBe("2.10.0");
    // ## Where We Are / Critical Context / Resumption / Next Steps:
    expect(parsed.current_state).toBeTruthy();
    expect(parsed.critical_context).toBeTruthy();
    expect(parsed.resumption_point).toBeTruthy();
    expect(Array.isArray(parsed.next_steps)).toBe(true);
    // Decisions surfaces:
    expect(parsed.recent_decisions.length).toBeGreaterThan(0);
    expect(parsed.guardrails.length).toBeGreaterThan(0);
    // Standing-rules index (the load-by-topic contract) — required, NOT dropped:
    expect(parsed.standing_rules_index).toBeDefined();
    expect(parsed.standing_rules).toBeDefined();
    // Behavioral template + banner:
    expect(parsed.behavioral_rules).toBeTruthy();
    expect(parsed.banner_text).toBeTruthy();
    // The trim: the deprecated alias is gone (byte-smaller) ...
    expect(parsed.standing_rules_tier_c_index).toBeUndefined();
    // ... and the payload still self-reports its true size.
    expect(parsed.response_bytes).toBe(parsed.bytes_delivered);
  });
});
