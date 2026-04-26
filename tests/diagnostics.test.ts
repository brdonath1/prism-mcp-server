/**
 * Tests for diagnostic surfacing infrastructure (Phase 0b).
 *
 * Part 1: DiagnosticsCollector unit tests (add/warn/error/info/list/isEmpty/count).
 * Part 2: Integration tests verifying the diagnostics field appears in tool
 *         responses for bootstrap, push, finalize, and synthesize.
 */

// Set dummy env vars to prevent config.ts from calling process.exit(1)
// and to enable synthesis in test mode.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-key";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiagnosticsCollector, type Diagnostic } from "../src/utils/diagnostics.js";

// ── Part 1: DiagnosticsCollector unit tests ──────────────────────────────────

describe("DiagnosticsCollector", () => {
  it("starts empty", () => {
    const dc = new DiagnosticsCollector();
    expect(dc.isEmpty()).toBe(true);
    expect(dc.count()).toBe(0);
    expect(dc.list()).toEqual([]);
  });

  it("add() pushes a diagnostic", () => {
    const dc = new DiagnosticsCollector();
    dc.add({ level: "warn", code: "TEST_CODE", message: "hello" });
    expect(dc.count()).toBe(1);
    expect(dc.isEmpty()).toBe(false);
    const items = dc.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ level: "warn", code: "TEST_CODE", message: "hello" });
  });

  it("warn() creates a warn-level diagnostic", () => {
    const dc = new DiagnosticsCollector();
    dc.warn("W_CODE", "warn message", { key: "val" });
    const items = dc.list();
    expect(items[0].level).toBe("warn");
    expect(items[0].code).toBe("W_CODE");
    expect(items[0].message).toBe("warn message");
    expect(items[0].context).toEqual({ key: "val" });
  });

  it("error() creates an error-level diagnostic", () => {
    const dc = new DiagnosticsCollector();
    dc.error("E_CODE", "error message");
    const items = dc.list();
    expect(items[0].level).toBe("error");
    expect(items[0].code).toBe("E_CODE");
    expect(items[0].context).toBeUndefined();
  });

  it("info() creates an info-level diagnostic", () => {
    const dc = new DiagnosticsCollector();
    dc.info("I_CODE", "info message", { detail: 42 });
    const items = dc.list();
    expect(items[0].level).toBe("info");
    expect(items[0].code).toBe("I_CODE");
    expect(items[0].context).toEqual({ detail: 42 });
  });

  it("list() returns a defensive copy", () => {
    const dc = new DiagnosticsCollector();
    dc.warn("A", "first");
    const list1 = dc.list();
    dc.warn("B", "second");
    const list2 = dc.list();
    expect(list1).toHaveLength(1);
    expect(list2).toHaveLength(2);
    // Mutating the returned array does not affect the collector
    list2.push({ level: "info", code: "C", message: "injected" });
    expect(dc.count()).toBe(2);
  });

  it("count() tracks multiple entries", () => {
    const dc = new DiagnosticsCollector();
    dc.warn("A", "1");
    dc.error("B", "2");
    dc.info("C", "3");
    dc.add({ level: "warn", code: "D", message: "4" });
    expect(dc.count()).toBe(4);
    expect(dc.isEmpty()).toBe(false);
  });

  it("preserves insertion order", () => {
    const dc = new DiagnosticsCollector();
    dc.warn("FIRST", "1st");
    dc.error("SECOND", "2nd");
    dc.info("THIRD", "3rd");
    const codes = dc.list().map(d => d.code);
    expect(codes).toEqual(["FIRST", "SECOND", "THIRD"]);
  });
});

// ── Part 2: Integration tests — diagnostics field in tool responses ──────────

// Mock GitHub client for all tool integration tests
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  pushFiles: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

// Mock doc-resolver
vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
  resolveDocExists: vi.fn(),
  resolveDocFiles: vi.fn(),
}));

// Mock doc-guard
vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn().mockImplementation((_repo: string, path: string) =>
    Promise.resolve({ path, redirected: false }),
  ),
}));

// Mock AI client for synthesize tests
vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

// Mock AI client for finalize draft
vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

// Mock synthesis tracker
vi.mock("../src/ai/synthesis-tracker.js", () => ({
  recordSynthesisEvent: vi.fn(),
  getSynthesisHealth: vi.fn().mockReturnValue({ totalEvents: 0, failureRate: 0 }),
}));

// Mock logger to suppress output
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock cache
vi.mock("../src/utils/cache.js", () => ({
  templateCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    invalidate: vi.fn(),
  },
  MemoryCache: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    invalidate: vi.fn(),
    clear: vi.fn(),
  })),
}));

// Mock banner
vi.mock("../src/utils/banner.js", () => ({
  generateCstTimestamp: vi.fn().mockReturnValue("2026-04-25 10:00:00"),
  renderBannerText: vi.fn().mockReturnValue("banner text"),
  renderBannerHtml: vi.fn().mockReturnValue("<div>banner</div>"),
  parseResumptionForBanner: vi.fn().mockReturnValue("resume point"),
  escapeHtml: vi.fn().mockImplementation((s: string) => s),
  stripMarkdown: vi.fn().mockImplementation((s: string) => s),
  formatResumptionHtml: vi.fn().mockReturnValue("resume"),
  toolIcon: vi.fn().mockReturnValue("✓"),
}));

// Mock tool-registry
vi.mock("../src/tool-registry.js", () => ({
  getExpectedToolSurface: vi.fn().mockReturnValue([]),
  POST_BOOT_TOOL_SEARCHES: [],
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
  pushFile,
  fileExists,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import {
  resolveDocPath,
  resolveDocPushPath,
  resolveDocExists,
  resolveDocFiles,
} from "../src/utils/doc-resolver.js";
import { generateIntelligenceBrief } from "../src/ai/synthesize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockResolveDocExists = vi.mocked(resolveDocExists);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockGenerateIntelligenceBrief = vi.mocked(generateIntelligenceBrief);

/** Helper: register a tool, extract its handler, and call it. */
async function callTool(
  registerFn: (server: McpServer) => void,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFn(server);

  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);

  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: `test-${toolName}-1`,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };

  const result = await tool.handler(args, mockExtra);
  return result as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

// ── Bootstrap diagnostics ────────────────────────────────────────────────────

describe("bootstrap diagnostics integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockGetHeadSha.mockResolvedValue("HEAD_SHA");
  });

  it("returns empty diagnostics[] on clean bootstrap", async () => {
    const { registerBootstrap } = await import("../src/tools/bootstrap.js");

    // Handoff present and small
    const handoffContent =
      "# Handoff\n\n## Meta\n- Handoff Version: 5\n- Session Count: 10\n- Template Version: 4.0.0\n- Status: Active\n\n## Critical Context\n1. Item one\n\n## Where We Are\nDoing things.\n\n## Resumption Point\nContinue.\n\n## Next Steps\n1. Next step.\n\n<!-- EOF: handoff.md -->\n";
    mockResolveDocPath.mockImplementation(async (_repo, path) => {
      if (path === "handoff.md") {
        return { content: handoffContent, sha: "sha1", path: ".prism/handoff.md", legacy: false, size: handoffContent.length };
      }
      if (path === "decisions/_INDEX.md") {
        const indexContent = "# Decisions\n\n| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|--------|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->\n";
        return { content: indexContent, sha: "sha2", path: ".prism/decisions/_INDEX.md", legacy: false, size: indexContent.length };
      }
      if (path === "intelligence-brief.md") {
        const briefContent = "# Intelligence Brief\nLast synthesized: S10 (2026-04-25)\n## Project State\nOK\n## Risk Flags\nNone\n## Quality Audit\nGood\n<!-- EOF: intelligence-brief.md -->\n";
        return { content: briefContent, sha: "sha3", path: ".prism/intelligence-brief.md", legacy: false, size: briefContent.length };
      }
      if (path === "insights.md") {
        return { content: "# Insights\n<!-- EOF: insights.md -->\n", sha: "sha4", path: ".prism/insights.md", legacy: false, size: 30 };
      }
      throw new Error("Not found");
    });

    // Boot-test push succeeds
    mockResolveDocPushPath.mockResolvedValue(".prism/boot-test.md");
    mockPushFile.mockResolvedValue({ success: true, sha: "push-sha", size: 100 } as any);

    const result = await callTool(registerBootstrap, "prism_bootstrap", {
      project_slug: "test-project",
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.diagnostics).toEqual([]);
  });

  it("surfaces BOOT_TEST_FAILED when boot-test push fails", async () => {
    const { registerBootstrap } = await import("../src/tools/bootstrap.js");

    const handoffContent =
      "# Handoff\n\n## Meta\n- Handoff Version: 5\n- Session Count: 10\n- Template Version: 4.0.0\n- Status: Active\n\n## Critical Context\n1. Item one\n\n## Where We Are\nDoing things.\n\n## Resumption Point\nContinue.\n\n## Next Steps\n1. Next step.\n\n<!-- EOF: handoff.md -->\n";
    mockResolveDocPath.mockImplementation(async (_repo, path) => {
      if (path === "handoff.md") {
        return { content: handoffContent, sha: "sha1", path: ".prism/handoff.md", legacy: false, size: handoffContent.length };
      }
      if (path === "decisions/_INDEX.md") {
        throw new Error("Not found");
      }
      if (path === "intelligence-brief.md") {
        throw new Error("Not found");
      }
      if (path === "insights.md") {
        throw new Error("Not found");
      }
      throw new Error("Not found");
    });
    mockResolveDocPushPath.mockResolvedValue(".prism/boot-test.md");
    // Boot-test push fails
    mockPushFile.mockRejectedValue(new Error("Network error"));

    const result = await callTool(registerBootstrap, "prism_bootstrap", {
      project_slug: "test-project",
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const bootTestDiag = data.diagnostics.find((d: Diagnostic) => d.code === "BOOT_TEST_FAILED");
    expect(bootTestDiag).toBeDefined();
    expect(bootTestDiag.level).toBe("warn");
    expect(bootTestDiag.message).toContain("Boot-test push failed");
  });
});

// ── Push diagnostics ─────────────────────────────────────────────────────────

describe("push diagnostics integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockGetHeadSha.mockResolvedValue("HEAD_BEFORE");
  });

  it("returns empty diagnostics[] on clean push", async () => {
    const { registerPush } = await import("../src/tools/push.js");

    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "commit-sha",
      files_committed: 1,
    });

    const result = await callTool(registerPush, "prism_push", {
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "# Handoff\nContent\n<!-- EOF: handoff.md -->",
          message: "prism: update handoff",
        },
      ],
      skip_validation: true,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics).toEqual([]);
    expect(data.all_succeeded).toBe(true);
  });

  it("surfaces VALIDATION_WARNING when validation fails", async () => {
    const { registerPush } = await import("../src/tools/push.js");

    const result = await callTool(registerPush, "prism_push", {
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "",
          message: "prism: empty file",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const validationDiag = data.diagnostics.find((d: Diagnostic) => d.code === "VALIDATION_WARNING");
    expect(validationDiag).toBeDefined();
    expect(validationDiag.level).toBe("warn");
  });

  it("surfaces MUTATION_CONFLICT on atomic-commit retry (S64 Phase 1 Brief 1.5)", async () => {
    const { registerPush } = await import("../src/tools/push.js");

    // safeMutation owns the conflict-and-retry path: first atomic call fails,
    // second succeeds. The primitive emits MUTATION_CONFLICT on the way through.
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "Tree creation failed",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "atomic-retry-sha",
        files_committed: 1,
      });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");

    const result = await callTool(registerPush, "prism_push", {
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: true,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const conflictDiag = data.diagnostics.find((d: Diagnostic) => d.code === "MUTATION_CONFLICT");
    expect(conflictDiag).toBeDefined();
    expect(conflictDiag.level).toBe("warn");
  });
});

// ── Finalize diagnostics ─────────────────────────────────────────────────────

describe("finalize diagnostics integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockGetHeadSha.mockResolvedValue("HEAD_BEFORE");
  });

  it("returns diagnostics[] on clean commit", async () => {
    const { registerFinalize } = await import("../src/tools/finalize.js");

    // Set up mocks for commit phase
    mockResolveDocPath.mockImplementation(async (_repo, path) => {
      if (path === "handoff.md") {
        return {
          content: "# Handoff\n## Meta\n- Handoff Version: 5\n<!-- EOF: handoff.md -->\n",
          sha: "sha1",
          path: ".prism/handoff.md",
          legacy: false,
          size: 60,
        };
      }
      throw new Error("Not found");
    });
    mockResolveDocPushPath.mockResolvedValue(".prism/handoff.md");
    mockPushFile.mockResolvedValue({ success: true, sha: "push-sha", size: 60 } as any);
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "commit-sha",
      files_committed: 1,
    });
    // Mock listDirectory for handoff-history
    const { listDirectory } = await import("../src/github/client.js");
    vi.mocked(listDirectory).mockResolvedValue([]);

    const result = await callTool(registerFinalize, "prism_finalize", {
      project_slug: "test-project",
      action: "commit",
      session_number: 11,
      handoff_version: 6,
      files: [
        {
          path: "handoff.md",
          content: "# Handoff\n## Meta\n- Handoff Version: 6\n<!-- EOF: handoff.md -->\n",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(Array.isArray(data.diagnostics)).toBe(true);
    // Clean commit should have no diagnostics (all_succeeded=true, synthesis=background or skipped)
  });

  it("surfaces PARTIAL_COMMIT when some files fail", async () => {
    const { registerFinalize } = await import("../src/tools/finalize.js");

    mockResolveDocPath.mockImplementation(async (_repo, path) => {
      if (path === "handoff.md") {
        return {
          content: "# Handoff\n## Meta\n- Handoff Version: 5\n<!-- EOF: handoff.md -->\n",
          sha: "sha1",
          path: ".prism/handoff.md",
          legacy: false,
          size: 60,
        };
      }
      throw new Error("Not found");
    });
    mockResolveDocPushPath.mockResolvedValue(".prism/handoff.md");
    // Atomic fails, HEAD unchanged, sequential pushFile also fails
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "Tree creation failed",
    });
    mockGetHeadSha.mockResolvedValue("HEAD_BEFORE");
    mockPushFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/handoff.md") {
        return { success: false, sha: "", size: 0, error: "Push failed" } as any;
      }
      return { success: true, sha: "sha", size: 50 } as any;
    });
    const { listDirectory } = await import("../src/github/client.js");
    vi.mocked(listDirectory).mockResolvedValue([]);

    const result = await callTool(registerFinalize, "prism_finalize", {
      project_slug: "test-project",
      action: "commit",
      session_number: 11,
      handoff_version: 6,
      files: [
        {
          path: "handoff.md",
          content: "# Handoff\n## Meta\n- Handoff Version: 6\n<!-- EOF: handoff.md -->\n",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const partialDiag = data.diagnostics.find((d: Diagnostic) => d.code === "PARTIAL_COMMIT");
    expect(partialDiag).toBeDefined();
    expect(partialDiag.level).toBe("error");
    expect(partialDiag.message).toContain("failed to push");
  });

  it("surfaces diagnostics[] on audit action", async () => {
    const { registerFinalize } = await import("../src/tools/finalize.js");

    // Mock resolveDocFiles for audit phase
    mockResolveDocFiles.mockResolvedValue(new Map([
      ["handoff.md", { content: "# Handoff\n## Meta\n- Handoff Version: 5\n- Session Count: 10\n<!-- EOF: handoff.md -->\n", size: 80, sha: "sha1" }],
    ]));
    const { listDirectory, listCommits } = await import("../src/github/client.js");
    vi.mocked(listDirectory).mockResolvedValue([]);
    vi.mocked(listCommits).mockResolvedValue([]);
    // Mock fetchFile for rules
    mockFetchFile.mockRejectedValue(new Error("Not found"));

    const result = await callTool(registerFinalize, "prism_finalize", {
      project_slug: "test-project",
      action: "audit",
      session_number: 11,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(Array.isArray(data.diagnostics)).toBe(true);
  });
});

// ── Synthesize diagnostics ───────────────────────────────────────────────────

describe("synthesize diagnostics integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty diagnostics[] on successful status check", async () => {
    const { registerSynthesize } = await import("../src/tools/synthesize.js");

    mockResolveDocPath.mockResolvedValue({
      content: "# Intelligence Brief\nLast synthesized: S10 (2026-04-25)\n<!-- EOF: intelligence-brief.md -->\n",
      sha: "sha1",
      path: ".prism/intelligence-brief.md",
      legacy: false,
      size: 80,
    });

    const result = await callTool(registerSynthesize, "prism_synthesize", {
      project_slug: "test-project",
      mode: "status",
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics).toEqual([]);
    expect(data.exists).toBe(true);
  });

  it("surfaces SYNTHESIS_TIMEOUT when generation times out", async () => {
    const { registerSynthesize } = await import("../src/tools/synthesize.js");

    mockGenerateIntelligenceBrief.mockResolvedValue({
      success: false,
      error: "Synthesis API call timed out after 50000ms",
    });

    const result = await callTool(registerSynthesize, "prism_synthesize", {
      project_slug: "test-project",
      mode: "generate",
      session_number: 11,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const timeoutDiag = data.diagnostics.find((d: Diagnostic) => d.code === "SYNTHESIS_TIMEOUT");
    expect(timeoutDiag).toBeDefined();
    expect(timeoutDiag.level).toBe("error");
    expect(timeoutDiag.message).toContain("timed out");
  });

  it("surfaces SYNTHESIS_RETRY when generation fails for non-timeout reasons", async () => {
    const { registerSynthesize } = await import("../src/tools/synthesize.js");

    mockGenerateIntelligenceBrief.mockResolvedValue({
      success: false,
      error: "API rate limit exceeded",
    });

    const result = await callTool(registerSynthesize, "prism_synthesize", {
      project_slug: "test-project",
      mode: "generate",
      session_number: 11,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    const retryDiag = data.diagnostics.find((d: Diagnostic) => d.code === "SYNTHESIS_RETRY");
    expect(retryDiag).toBeDefined();
    expect(retryDiag.level).toBe("error");
  });

  it("returns clean diagnostics on successful generation", async () => {
    const { registerSynthesize } = await import("../src/tools/synthesize.js");

    mockGenerateIntelligenceBrief.mockResolvedValue({
      success: true,
      bytes_written: 5000,
      input_tokens: 1000,
      output_tokens: 500,
    });

    const result = await callTool(registerSynthesize, "prism_synthesize", {
      project_slug: "test-project",
      mode: "generate",
      session_number: 11,
    });

    const data = parseResult(result);
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics).toEqual([]);
    expect(data.success).toBe(true);
  });
});
