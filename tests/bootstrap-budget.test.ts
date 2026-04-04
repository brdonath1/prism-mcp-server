// T-1: Bootstrap response size budget tests
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client and banner utils
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile } from "../src/github/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);

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

  // Setup standard mocks
  mockFetchFile.mockImplementation(async (repo: string, path: string) => {
    if (path === "handoff.md") {
      return {
        content: `# Handoff\n\n## Meta\n- Handoff Version: 33\n- Session Count: 28\n- Template Version: 2.10.0\n- Status: Active\n\n## Critical Context\n1. Item one\n2. Item two\n\n## Where We Are\nCurrent state.\n\n## Resumption Point\nResume here.\n\n## Next Steps\n1. Do thing A\n2. Do thing B\n\n<!-- EOF: handoff.md -->`,
        sha: "abc123",
        size: 350,
      };
    }
    if (path === "decisions/_INDEX.md") {
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
    if (path === "intelligence-brief.md") {
      return {
        content: "# Intelligence Brief\n\n## Project State\nProject is healthy.\n\n## Risk Flags\nNone.\n\n## Quality Audit\nAll good.\n\n<!-- EOF: intelligence-brief.md -->",
        sha: "jkl012",
        size: 150,
      };
    }
    if (path === "insights.md") {
      return {
        content: "# Insights\n\n## Active\n\n### INS-6: Test — STANDING RULE\n**Standing procedure:** Do the thing.\n\n<!-- EOF: insights.md -->",
        sha: "mno345",
        size: 120,
      };
    }
    throw new Error(`Not found: ${path}`);
  });

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

  it("banner_html field is null", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.banner_html).toBeNull();
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
  });

  it("standing_rules array length < 10 entries", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.standing_rules.length).toBeLessThan(10);
  });

  it("prefetched_documents array length <= 2 entries", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.prefetched_documents.length).toBeLessThanOrEqual(2);
  });

  it("response is compact JSON (no pretty-printing)", async () => {
    const result = await bootstrapHandler({ project_slug: "prism", opening_message: "Begin next session" });
    const text = result.content[0].text;
    // Compact JSON should round-trip identically
    const roundTripped = JSON.stringify(JSON.parse(text));
    expect(text).toBe(roundTripped);
  });
});
