/**
 * Integration tests for prism_finalize tool.
 * Tests audit, draft, and commit phases with mocked GitHub + Anthropic APIs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the GitHub client
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
}));

// Mock the AI synthesis modules
vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
}));

// Mock SYNTHESIS_ENABLED to true for draft phase tests
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  fetchFile,
  fetchFiles,
  pushFile,
  listDirectory,
  listCommits,
  getCommit,
  deleteFile,
} from "../src/github/client.js";
import { synthesize } from "../src/ai/client.js";
import { generateIntelligenceBrief } from "../src/ai/synthesize.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockGetCommit = vi.mocked(getCommit);
const mockDeleteFile = vi.mocked(deleteFile);
const mockSynthesize = vi.mocked(synthesize);
const mockGenerateIntelligenceBrief = vi.mocked(generateIntelligenceBrief);

/** Standard handoff content for tests */
const HANDOFF_CONTENT = `## Meta
- Handoff Version: 30
- Session Count: 25
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. PRISM MCP Server is the core infrastructure
2. 17 active projects managed
3. Server deployed on Railway

## Where We Are
Working on audit remediation.

<!-- EOF: handoff.md -->`;

/** Standard decision index for tests */
const DECISIONS_CONTENT = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | Three-tier intelligence | architecture | SETTLED | S1 |
| D-2 | MCP Architecture | architecture | SETTLED | S9 |
<!-- EOF: _INDEX.md -->`;

/** Helper: build a Map of living documents */
function buildDocMap(overrides?: Record<string, string>): Map<string, { content: string; sha: string; size: number }> {
  const defaults: Record<string, string> = {
    "handoff.md": HANDOFF_CONTENT,
    "decisions/_INDEX.md": DECISIONS_CONTENT,
    "session-log.md": "# Session Log\n<!-- EOF: session-log.md -->",
    "task-queue.md": "# Task Queue\n<!-- EOF: task-queue.md -->",
    "eliminated.md": "# Eliminated\n<!-- EOF: eliminated.md -->",
    "architecture.md": "# Architecture\n<!-- EOF: architecture.md -->",
    "glossary.md": "# Glossary\n<!-- EOF: glossary.md -->",
    "known-issues.md": "# Known Issues\n<!-- EOF: known-issues.md -->",
    "insights.md": "# Insights\n<!-- EOF: insights.md -->",
    "intelligence-brief.md": "# Intelligence Brief\n<!-- EOF: intelligence-brief.md -->",
  };

  const docs = { ...defaults, ...overrides };
  const map = new Map<string, { content: string; sha: string; size: number }>();
  for (const [path, content] of Object.entries(docs)) {
    map.set(path, { content, sha: `sha_${path}`, size: content.length });
  }
  return map;
}

/**
 * Configure mockFetchFile to respond to .prism/-prefixed paths using a docMap.
 * resolveDocPath() tries .prism/{docName} first, so mocks must handle those paths.
 */
function setupFetchFileMockFromDocMap(
  mockFetchFileFn: ReturnType<typeof vi.mocked<typeof fetchFile>>,
  docMap: Map<string, { content: string; sha: string; size: number }>,
): void {
  mockFetchFileFn.mockImplementation(async (_repo: string, path: string) => {
    // Strip .prism/ prefix to look up in docMap (keyed by bare names)
    const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
    const entry = docMap.get(docName);
    if (entry) {
      return { content: entry.content, sha: entry.sha, size: entry.size };
    }
    throw new Error(`Not found: ${path}`);
  });
}

/** Helper: invoke prism_finalize via McpServer internal handler. */
async function callFinalizeTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);

  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_finalize"];
  if (!tool) throw new Error("Tool not registered");

  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-finalize-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };

  const result = await tool.handler(args, mockExtra);
  return result as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Audit Phase ─────────────────────────────────────────────────────────────────

describe("prism_finalize audit phase", () => {
  it("fetches all living documents and returns structured inventory", async () => {
    const docMap = buildDocMap();
    setupFetchFileMockFromDocMap(mockFetchFile, docMap);
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.audit).toBeDefined();
    expect(data.audit.living_documents).toHaveLength(10);
    expect(data.project).toBe("test-project");
    expect(data.session_number).toBe(26);

    // All documents should be present
    const allExist = data.audit.living_documents.every((d: any) => d.exists);
    expect(allExist).toBe(true);
  });

  it("detects missing living documents", async () => {
    const docMap = buildDocMap();
    // Remove insights.md and intelligence-brief.md
    docMap.delete("insights.md");
    docMap.delete("intelligence-brief.md");
    setupFetchFileMockFromDocMap(mockFetchFile, docMap);
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    const missingDocs = data.audit.living_documents.filter((d: any) => !d.exists);
    expect(missingDocs.length).toBe(2);
    expect(missingDocs.map((d: any) => d.file)).toContain("insights.md");
    expect(missingDocs.map((d: any) => d.file)).toContain("intelligence-brief.md");
  });

  it("detects invalid EOF sentinels", async () => {
    const docMap = buildDocMap({
      "handoff.md": "# Handoff\nContent without EOF sentinel",
    });
    setupFetchFileMockFromDocMap(mockFetchFile, docMap);
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    const handoffAudit = data.audit.living_documents.find((d: any) => d.file === "handoff.md");
    expect(handoffAudit.eof_valid).toBe(false);
  });

  it("detects drift in critical context between handoff versions", async () => {
    const docMap = buildDocMap();
    const previousHandoffContent = `## Meta\n- Handoff Version: 29\n\n## Critical Context\n1. Old critical item that was removed\n2. 17 active projects managed\n\n<!-- EOF: handoff.md -->`;

    // Setup fetchFile to respond to .prism/ doc paths (via docMap) AND handoff-history path
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("handoff_v29")) {
        return { content: previousHandoffContent, sha: "old_sha", size: 200 };
      }
      const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
      const entry = docMap.get(docName);
      if (entry) {
        return { content: entry.content, sha: entry.sha, size: entry.size };
      }
      throw new Error(`Not found: ${path}`);
    });

    // Mock handoff history with a previous version that had different critical context
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v29_2026-04-01.md", path: "handoff-history/handoff_v29_2026-04-01.md", size: 500, sha: "old", type: "file" as const },
    ]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.audit.drift_detection.critical_context_changed).toBe(true);
    expect(data.audit.drift_detection.changed_items.length).toBeGreaterThan(0);
  });

  it("counts session work products from commit history", async () => {
    const docMap = buildDocMap();
    setupFetchFileMockFromDocMap(mockFetchFile, docMap);
    mockListDirectory.mockResolvedValue([]);

    // Mock commits: 3 session commits before a finalization marker
    mockListCommits.mockResolvedValue([
      { sha: "c3", message: "prism: update architecture", date: "2026-04-03", files: [] },
      { sha: "c2", message: "prism: checkpoint", date: "2026-04-02", files: [] },
      { sha: "c1", message: "prism: artifact design.md", date: "2026-04-01", files: [] },
      { sha: "c0", message: "prism: finalize session 25", date: "2026-03-31", files: [] },
    ]);

    mockGetCommit
      .mockResolvedValueOnce({ sha: "c3", message: "update", date: "2026-04-03", files: ["architecture.md"] })
      .mockResolvedValueOnce({ sha: "c2", message: "checkpoint", date: "2026-04-02", files: ["handoff.md", "session-log.md"] })
      .mockResolvedValueOnce({ sha: "c1", message: "artifact", date: "2026-04-01", files: ["artifacts/design.md"] });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.audit.session_work_products.commit_count).toBe(3);
    expect(data.audit.session_work_products.files_pushed_this_session).toContain("architecture.md");
    expect(data.audit.session_work_products.files_pushed_this_session).toContain("handoff.md");
  });
});

// ── Commit Phase ────────────────────────────────────────────────────────────────

describe("prism_finalize commit phase", () => {
  it("backs up handoff, validates, pushes all files, and verifies", async () => {
    // Mock: all fetchFile calls return valid content (backup fetch + verification fetches)
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "new_sha",
      size: HANDOFF_CONTENT.length,
    });

    // Mock: handoff history (empty for clean test)
    mockListDirectory.mockResolvedValue([]);

    // Mock: all pushes succeed
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });

    // Mock: synthesis succeeds
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 1000, output_tokens: 500 });

    const validHandoff = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Server deployed on Railway

## Where We Are
Completed audit remediation.

<!-- EOF: handoff.md -->`;

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: validHandoff },
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.session_number).toBe(26);
    expect(data.handoff_version).toBe(31);
    expect(data.backup_created).toContain("handoff-history/handoff_v30");
    expect(data.confirmation).toContain("Session 26 finalized");
    expect(mockPushFile).toHaveBeenCalled();
  });

  it("rejects commit when validation fails — pushes nothing", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: "" }, // Empty content — fails validation
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.confirmation).toContain("FAILED");
    expect(data.results[0].validation_errors.length).toBeGreaterThan(0);
  });

  it("prunes handoff history to keep only last 3 versions", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: 100,
    });

    // 5 old handoff backups — should prune the 2 oldest
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v30_2026-04-03.md", path: "handoff-history/handoff_v30_2026-04-03.md", size: 100, sha: "a", type: "file" as const },
      { name: "handoff_v29_2026-04-02.md", path: "handoff-history/handoff_v29_2026-04-02.md", size: 100, sha: "b", type: "file" as const },
      { name: "handoff_v28_2026-04-01.md", path: "handoff-history/handoff_v28_2026-04-01.md", size: 100, sha: "c", type: "file" as const },
      { name: "handoff_v27_2026-03-31.md", path: "handoff-history/handoff_v27_2026-03-31.md", size: 100, sha: "d", type: "file" as const },
      { name: "handoff_v26_2026-03-30.md", path: "handoff-history/handoff_v26_2026-03-30.md", size: 100, sha: "e", type: "file" as const },
    ]);

    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockDeleteFile.mockResolvedValue(true);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: "# Handoff\n<!-- EOF: handoff.md -->" },
      ],
    });

    const data = parseResult(result);
    // Should have deleted the 2 oldest (v27 and v26)
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
  });

  it("includes synthesis status in response", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "new_sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 500, output_tokens: 200 });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });

    const data = parseResult(result);
    expect(data).toHaveProperty("synthesis");
    expect(data.synthesis).toHaveProperty("triggered");
    expect(data.synthesis).toHaveProperty("success");
  });
});

// ── Draft Phase ─────────────────────────────────────────────────────────────────

describe("prism_finalize draft phase", () => {
  it("returns drafts when synthesis succeeds", async () => {
    const docMap = buildDocMap();
    mockFetchFiles.mockResolvedValue(docMap);
    mockListCommits.mockResolvedValue([]);

    mockSynthesize.mockResolvedValue({
      content: '{"handoff": {"content": "draft handoff"}, "session_log": {"content": "draft log"}}',
      input_tokens: 5000,
      output_tokens: 2000,
      model: "claude-opus-4-6",
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "draft",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.drafts).toBeDefined();
    expect(data.input_tokens).toBe(5000);
    expect(data.output_tokens).toBe(2000);
    expect(data.review_instructions).toContain("Review each draft");
  });

  it("handles synthesis failure gracefully", async () => {
    const docMap = buildDocMap();
    mockFetchFiles.mockResolvedValue(docMap);
    mockListCommits.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue(null);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "draft",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect(data.error).toBeDefined();
    expect(data.fallback).toContain("manually");
  });

  it("returns raw content when JSON parsing fails", async () => {
    const docMap = buildDocMap();
    mockFetchFiles.mockResolvedValue(docMap);
    mockListCommits.mockResolvedValue([]);

    mockSynthesize.mockResolvedValue({
      content: "Here are my thoughts about the finalization:\n\nThe handoff should be updated...",
      input_tokens: 3000,
      output_tokens: 1000,
      model: "claude-opus-4-6",
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "draft",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.raw_content).toBeDefined();
    expect(data.parse_warning).toContain("Could not parse");
  });
});
