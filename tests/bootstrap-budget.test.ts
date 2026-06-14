// T-1: Bootstrap response size budget tests
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client and banner utils
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile, fileExists } from "../src/github/client.js";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../src/config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);

// Capture the registered tool handler
let bootstrapHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") {
      bootstrapHandler = handler as typeof bootstrapHandler;
    }
  }),
} as unknown as McpServer;

// Import and register
import { registerBootstrap } from "../src/tools/bootstrap.js";

beforeEach(() => {
  vi.clearAllMocks();
  registerBootstrap(mockServer);

  // Setup standard mocks — respond to .prism/ paths (D-67)
  mockFetchFile.mockImplementation(async (repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return {
        content: `# Handoff\n\n## Meta\n- Handoff Version: 33\n- Session Count: 28\n- Template Version: 2.10.0\n- Status: Active\n\n## Critical Context\n1. Item one\n2. Item two\n\n## Where We Are\nCurrent state.\n\n## Resumption Point\nResume here.\n\n## Next Steps\n1. Do thing A\n2. Do thing B\n\n<!-- EOF: handoff.md -->`,
        sha: "abc123",
        size: 350,
      };
    }
    if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
      return {
        content: "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->",
        sha: "def456",
        size: 120,
      };
    }
    if (path.includes("core-template-mcp.md")) {
      return {
        content: "# PRISM Core Template v2.10.0\nRules here.\n<!-- EOF: core-template-mcp.md -->",
        sha: "ghi789",
        size: 80,
      };
    }
    if (path === ".prism/intelligence-brief.md" || path === "intelligence-brief.md") {
      return {
        content: "# Intelligence Brief\n\n## Project State\nProject is healthy.\n\n## Risk Flags\nNone.\n\n## Quality Audit\nAll good.\n\n<!-- EOF: intelligence-brief.md -->",
        sha: "jkl012",
        size: 150,
      };
    }
    if (path === ".prism/insights.md" || path === "insights.md") {
      return {
        content: "# Insights\n\n## Active\n\n### INS-6: Test — STANDING RULE\n**Standing procedure:** Do the thing.\n\n<!-- EOF: insights.md -->",
        sha: "mno345",
        size: 120,
      };
    }
    throw new Error(`Not found: ${path}`);
  });

  // fileExists returns false so resolveDocPushPath returns the .prism/ path
  mockFileExists.mockResolvedValue(false);

  mockFetchFiles.mockResolvedValue(new Map());
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed123", size: 50 });
});

describe("T-1: bootstrap response size budget", () => {
  it("response JSON string length < 50,000 bytes", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const text = result.content[0].text;
    expect(text.length).toBeLessThan(50_000);
  });

  it("banner_text field is present and under 500 bytes", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.banner_text).toBeTruthy();
    expect(typeof parsed.banner_text).toBe("string");
    expect(new TextEncoder().encode(parsed.banner_text).length).toBeLessThan(500);
  });

  it("banner_data is absent when banner_text is present", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.banner_text).toBeTruthy();
    expect(parsed.banner_data).toBeUndefined();
  });

  it("component_sizes is absent from response", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.component_sizes).toBeUndefined();
  });

  it("context_estimate is present and valid", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.context_estimate).toBeDefined();
    expect(typeof parsed.context_estimate.bootstrap_tokens).toBe("number");
    expect(typeof parsed.context_estimate.total_boot_percent).toBe("number");
    expect(parsed.context_estimate.total_boot_percent).toBeGreaterThan(0);
    expect(parsed.context_estimate.total_boot_percent).toBeLessThan(50);
    expect(parsed.context_estimate.total_boot_tokens).toBe(
      parsed.context_estimate.bootstrap_tokens +
      parsed.context_estimate.platform_overhead_tokens +
      parsed.context_estimate.tool_schema_tokens
    );
    // context_window_tokens is exposed and equals the configured default.
    // D-253: import the constant rather than pinning a literal — production
    // sets DEFAULT_CONTEXT_WINDOW_TOKENS=200000 via Railway env, which must not
    // desync CI (the literal 500000 would fail under that override).
    expect(typeof parsed.context_estimate.context_window_tokens).toBe("number");
    expect(parsed.context_estimate.context_window_tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    // total_boot_percent is derived from context_window_tokens
    expect(parsed.context_estimate.total_boot_percent).toBe(
      Math.round((parsed.context_estimate.total_boot_tokens / parsed.context_estimate.context_window_tokens) * 1000) / 10
    );
  });

  it("estimate numerator covers the complete response payload (brief-433, D-253)", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    // Reconstruct the exact payload the numerator was measured from. D-253
    // restructured the tail: `measured` is the assembled response BEFORE the
    // three post-measurement attachments — context_estimate, response_bytes,
    // then diagnostics (diagnostics LAST so it captures any oversize entry).
    // Those three are the final keys in insertion order, so deleting them from
    // the parsed object leaves the measured payload byte-for-byte. Any field
    // added BEFORE measurement without flowing into the estimate breaks this
    // equality — guarding against regression to a hand-picked field subset.
    const measured = { ...parsed };
    delete measured.context_estimate;
    delete measured.response_bytes;
    delete measured.bytes_delivered; // SRV-28: now a post-measurement attachment (= responseBytes)
    delete measured.diagnostics;
    expect(parsed.context_estimate.bootstrap_tokens).toBe(
      Math.round(JSON.stringify(measured).length / 3.5)
    );
  });

  it("fields omitted by the old subset numerator now move the estimate (brief-433)", async () => {
    // Baseline run with the standard mock handoff
    const baseline = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const baselineTokens = JSON.parse(baseline.content[0].text).context_estimate.bootstrap_tokens;

    // Same handoff but with a much larger ## Critical Context section.
    // critical_context was NOT part of the pre-433 hand-picked numerator
    // subset, so under the old code the estimate would not change.
    const fatItems = Array.from({ length: 20 }, (_, i) =>
      `${i + 1}. Critical context item number ${i + 1} with enough descriptive text to visibly move the byte count`
    ).join("\n");
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/handoff.md" || path === "handoff.md") {
        return {
          content: `# Handoff\n\n## Meta\n- Handoff Version: 33\n- Session Count: 28\n- Template Version: 2.10.0\n- Status: Active\n\n## Critical Context\n${fatItems}\n\n## Where We Are\nCurrent state.\n\n## Resumption Point\nResume here.\n\n## Next Steps\n1. Do thing A\n2. Do thing B\n\n<!-- EOF: handoff.md -->`,
          sha: "abc123",
          size: 350,
        };
      }
      if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
        return {
          content: "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->",
          sha: "def456",
          size: 120,
        };
      }
      if (path.includes("core-template-mcp.md")) {
        return {
          content: "# PRISM Core Template v2.10.0\nRules here.\n<!-- EOF: core-template-mcp.md -->",
          sha: "ghi789",
          size: 80,
        };
      }
      if (path === ".prism/intelligence-brief.md" || path === "intelligence-brief.md") {
        return {
          content: "# Intelligence Brief\n\n## Project State\nProject is healthy.\n\n## Risk Flags\nNone.\n\n## Quality Audit\nAll good.\n\n<!-- EOF: intelligence-brief.md -->",
          sha: "jkl012",
          size: 150,
        };
      }
      if (path === ".prism/insights.md" || path === "insights.md") {
        return {
          content: "# Insights\n\n## Active\n\n### INS-6: Test — STANDING RULE\n**Standing procedure:** Do the thing.\n\n<!-- EOF: insights.md -->",
          sha: "mno345",
          size: 120,
        };
      }
      throw new Error(`Not found: ${path}`);
    });

    const fat = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const fatTokens = JSON.parse(fat.content[0].text).context_estimate.bootstrap_tokens;
    expect(fatTokens).toBeGreaterThan(baselineTokens);
  });

  it("standing_rules delivers Tier A bodies only (D-253 — Tier B+C indexed, not delivered)", async () => {
    // Fixture insights.md carries exactly one Tier A rule (INS-6). The D-253
    // contract is Tier-A-only delivery, so exactly that one arrives; with no
    // Tier C rules present the index is empty.
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.standing_rules.map((r: { id: string }) => r.id)).toEqual(["INS-6"]);
    expect(parsed.standing_rules_index).toEqual([]);
    expect(parsed.standing_rules_tier_c_index).toBeUndefined(); // SRV-109: deprecated alias removed
  });

  it("prefetched_documents is bounded only by the distinct PREFETCH_KEYWORDS targets (QW-4 cap removed, R7-b)", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    // "Begin next session" matches no prefetch keyword — nothing prefetched.
    // The structural bound is the distinct document count in the keyword map,
    // not the old hard cap of 2.
    const { PREFETCH_KEYWORDS } = await import("../src/config.js");
    const distinctDocs = new Set(Object.values(PREFETCH_KEYWORDS)).size;
    expect(parsed.prefetched_documents.length).toBeLessThanOrEqual(distinctDocs);
    expect(parsed.prefetched_documents.length).toBe(0);
  });

  it("response is compact JSON (no pretty-printing)", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const text = result.content[0].text;
    // Compact JSON should round-trip identically
    const roundTripped = JSON.stringify(JSON.parse(text));
    expect(text).toBe(roundTripped);
  });
});
