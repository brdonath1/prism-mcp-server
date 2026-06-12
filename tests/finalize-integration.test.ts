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
  pushFiles: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  createAtomicCommit: vi.fn(),
  getDefaultBranch: vi.fn(),
  getHeadSha: vi.fn(),
}));

// Mock the AI synthesis modules
vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
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
  pushFiles,
  listDirectory,
  listCommits,
  getCommit,
  deleteFile,
  createAtomicCommit,
} from "../src/github/client.js";
import { synthesize } from "../src/ai/client.js";
import { generateIntelligenceBrief } from "../src/ai/synthesize.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockPushFiles = vi.mocked(pushFiles);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockGetCommit = vi.mocked(getCommit);
const mockDeleteFile = vi.mocked(deleteFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
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

  it("returns currency_warnings array with one entry per narrative doc (D-156 §3.7)", async () => {
    const docMap = buildDocMap({
      "architecture.md": "# Architecture\n\n> Updated: S20\n\nBody.\n\n<!-- EOF: architecture.md -->",
      "glossary.md": "# Glossary\n\n> Updated: S25\n\nDefinitions.\n\n<!-- EOF: glossary.md -->",
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
    expect(Array.isArray(data.audit.currency_warnings)).toBe(true);
    expect(data.audit.currency_warnings).toHaveLength(2);
    const paths = data.audit.currency_warnings.map((w: any) => w.path).sort();
    expect(paths).toEqual(["architecture.md", "glossary.md"]);

    const archWarning = data.audit.currency_warnings.find((w: any) => w.path === "architecture.md");
    expect(archWarning.last_modified_session).toBe(20);
    expect(archWarning.current_session).toBe(26);
    expect(archWarning.sessions_since_last_modified).toBe(6);
  });

  it("fires currency_warnings.acknowledgment_required when threshold + arch decisions met", async () => {
    const archBody = "# Architecture\n\n> Updated: S40\n\nNeeds refresh.\n\n<!-- EOF: architecture.md -->";
    const indexBody = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-300 | Routing layer | architecture | SETTLED | 55 |
| D-301 | Caching layer | architecture | SETTLED | 60 |
| D-302 | Synthesis routing | architecture | SETTLED | 65 |
<!-- EOF: _INDEX.md -->`;
    const docMap = buildDocMap({
      "architecture.md": archBody,
      "decisions/_INDEX.md": indexBody,
    });
    setupFetchFileMockFromDocMap(mockFetchFile, docMap);
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 67,
    });

    const data = parseResult(result);
    const archWarning = data.audit.currency_warnings.find((w: any) => w.path === "architecture.md");
    expect(archWarning.last_modified_session).toBe(40);
    expect(archWarning.sessions_since_last_modified).toBe(27);
    expect(archWarning.pending_arch_decisions_count).toBe(3);
    expect(archWarning.pending_arch_decision_ids).toEqual(["D-300", "D-301", "D-302"]);
    expect(archWarning.acknowledgment_required).toBe(true);
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

    // Mock: atomic commit succeeds
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 2 });

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
    // brief-460 / S170 post-mortem: the backup rides a safeMutation atomic
    // commit (shared with the prune), not a separate pushFile commit.
    const backupCommit = mockCreateAtomicCommit.mock.calls.find((c) =>
      (c[1] as Array<{ path: string }>).some((f) => f.path.includes("handoff-history/handoff_v30")),
    );
    expect(backupCommit).toBeDefined();
    const backupPushCalls = mockPushFile.mock.calls.filter(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("handoff-history/"),
    );
    expect(backupPushCalls).toHaveLength(0);
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

  it("prunes handoff history to keep only last 3 versions via a single atomic commit (S62 Brief 1)", async () => {
    // S62 Phase 1 Brief 1, Change 5: prune step migrated to safeMutation +
    // createAtomicCommit with `deletes`. The legacy parallel `deleteFile`
    // loop is gone — a single atomic commit removes the over-retention
    // versions, eliminating the HEAD-racing 409s identified in KI-23.
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
    // safeMutation issues at least 2 atomic commits in this scenario:
    //   - one for the prune step (deletes only)
    //   - one for the main commit step (the handoff write)
    // Both should land successfully.
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
    // Capture the prune commit so we can assert its `deletes` payload.
    const pruneCalls: Array<{ files: unknown; message: string; deletes?: string[] }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, message, deletes) => {
      pruneCalls.push({ files, message, deletes: deletes ?? [] });
      return { success: true, sha: "atomic_sha", files_committed: 1 };
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: "# Handoff\n<!-- EOF: handoff.md -->" },
      ],
    });

    // The prune commit must include the 2 oldest paths in its deletes array.
    const pruneCommit = pruneCalls.find((c) =>
      (c.deletes ?? []).some((p) => p.includes("handoff_v27"))
    );
    expect(pruneCommit).toBeDefined();
    expect(pruneCommit!.deletes).toEqual(
      expect.arrayContaining([
        "handoff-history/handoff_v27_2026-03-31.md",
        "handoff-history/handoff_v26_2026-03-30.md",
      ]),
    );
    expect(pruneCommit!.deletes).toHaveLength(2);
    // Newer entries (v30, v29, v28) MUST NOT be in the deletes list.
    expect(pruneCommit!.deletes).not.toContain(
      "handoff-history/handoff_v30_2026-04-03.md",
    );
  });

  it("includes synthesis status in response (D-78: fire-and-forget)", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "new_sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
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
    expect(data).toHaveProperty("synthesis_outcome");
    expect(data.synthesis_outcome).toBe("background");
    expect(data).toHaveProperty("synthesis_banner_html");
    expect(data.synthesis_banner_html).toBeNull();
    expect(data).toHaveProperty("synthesis_status_hint");
    expect(data.synthesis_status_hint).toContain("background");
  });
});

// ── Null-safe HEAD comparison (S62 Phase 1 Brief 1, Change 7) ─────────────────

describe("prism_finalize commit phase null-safe HEAD comparison", () => {
  // S62 Brief 1 changes the default `headChanged = true` so `getHeadSha`
  // returning undefined no longer routes to the partial-state-prone fallback.
  // Both null-pre-atomic and null-post-atomic cases must:
  //   1. Refuse to fall back to sequential pushFile.
  //   2. Emit HEAD_SHA_UNKNOWN diagnostic with the right phase context.
  it("null pre-atomic HEAD: refuses fallback, emits HEAD_SHA_UNKNOWN(pre-atomic-snapshot)", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([]);
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "createTree failed",
    });
    // Pre-atomic returns undefined.
    const { getHeadSha } = await import("../src/github/client.js");
    vi.mocked(getHeadSha).mockResolvedValue(undefined);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "glossary.md", content: "# Glossary\nT\n<!-- EOF: glossary.md -->" },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    // Must NOT fall back to sequential pushFile on the COMMIT step.
    // (pushFile may still be called for the auto-backup step — separate path.)
    const commitFallbackCalls = mockPushFile.mock.calls.filter(
      (call) => !(call[1] as string).includes("handoff-history/handoff_v"),
    );
    expect(commitFallbackCalls).toHaveLength(0);

    const diagnostics = data.diagnostics as Array<{ code: string; context?: { phase?: string } }>;
    const headDiag = diagnostics.find(
      (d) => d.code === "HEAD_SHA_UNKNOWN" && d.context?.phase === "pre-atomic-snapshot",
    );
    expect(headDiag).toBeDefined();
  });

  it("null post-atomic HEAD: refuses fallback, emits HEAD_SHA_UNKNOWN(post-atomic-check)", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([]);
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "createTree failed",
    });
    const { getHeadSha } = await import("../src/github/client.js");
    vi.mocked(getHeadSha)
      .mockResolvedValueOnce("HEAD_BEFORE")
      .mockResolvedValueOnce(undefined);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "glossary.md", content: "# Glossary\nT\n<!-- EOF: glossary.md -->" },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    const commitFallbackCalls = mockPushFile.mock.calls.filter(
      (call) => !(call[1] as string).includes("handoff-history/handoff_v"),
    );
    expect(commitFallbackCalls).toHaveLength(0);

    const diagnostics = data.diagnostics as Array<{ code: string; context?: { phase?: string } }>;
    const headDiag = diagnostics.find(
      (d) => d.code === "HEAD_SHA_UNKNOWN" && d.context?.phase === "post-atomic-check",
    );
    expect(headDiag).toBeDefined();
  });
});

// ── Background Synthesis on Finalization (D-78, FINDING-5) ─────────────────────

describe("prism_finalize background synthesis (D-78, FINDING-5)", () => {
  /** Helper: setup common mocks for a successful commit. */
  function setupHappyPathMocks(): void {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "new_sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
  }

  it("Test 1: commit returns immediately without waiting for synthesis", async () => {
    setupHappyPathMocks();
    // Synthesis takes 5 seconds — commit response must return well before that.
    mockGenerateIntelligenceBrief.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 5000)),
    );

    const start = Date.now();
    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });
    const elapsedMs = Date.now() - start;

    // Commit response must return in well under the 5s synthesis mock.
    expect(elapsedMs).toBeLessThan(1000);

    const data = parseResult(result);
    expect(data.synthesis_outcome).toBe("background");
    expect(data.synthesis_banner_html).toBeNull();
  });

  it("Test 2: synthesis still runs after commit returns", async () => {
    setupHappyPathMocks();
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 800, output_tokens: 300 });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 42,
      handoff_version: 7,
      files: [
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });

    // Flush microtasks so the background .then() has a chance to execute.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockGenerateIntelligenceBrief).toHaveBeenCalledWith("test-project", 42);
  });

  it("Test 3: synthesis failure does not affect commit response", async () => {
    setupHappyPathMocks();
    mockGenerateIntelligenceBrief.mockRejectedValue(new Error("Anthropic API unavailable"));

    // Spy on logger.error to verify the background failure is logged.
    const loggerModule = await import("../src/utils/logger.js");
    const loggerErrorSpy = vi.spyOn(loggerModule.logger, "error");

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      files: [
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    // Commit response cannot observe the eventual synthesis outcome — always "background".
    expect(data.synthesis_outcome).toBe("background");

    // Flush microtasks so the background .catch() handler runs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      "background synthesis failed",
      expect.objectContaining({ projectSlug: "test-project", sessionNumber: 26 }),
    );

    loggerErrorSpy.mockRestore();
  });

  it("Test 4: skip_synthesis: true path unchanged — synthesis not invoked", async () => {
    setupHappyPathMocks();

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.synthesis_outcome).toBe("skipped");
    expect(mockGenerateIntelligenceBrief).not.toHaveBeenCalled();
  });

  it("Test 5: full finalize cycle returns synthesis_outcome: background", async () => {
    setupHappyPathMocks();
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 800, output_tokens: 300 });

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
    expect(data.all_succeeded).toBe(true);
    expect(data.synthesis_outcome).toBe("background");
    expect(data.synthesis_status_hint).toMatch(/background/i);
    expect(mockGenerateIntelligenceBrief).toHaveBeenCalledOnce();
  });
});

// ── Draft Phase ─────────────────────────────────────────────────────────────────

describe("prism_finalize draft phase", () => {
  it("returns drafts when synthesis succeeds", async () => {
    const docMap = buildDocMap();
    mockFetchFiles.mockResolvedValue(docMap);
    mockListCommits.mockResolvedValue([]);

    mockSynthesize.mockResolvedValue({
      success: true,
      content: '{"handoff": {"content": "draft handoff"}, "session_log": {"content": "draft log"}}',
      input_tokens: 5000,
      output_tokens: 2000,
      model: "claude-opus-4-7",
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

    // Phase 3b: draft phase (CS-1) passes thinking: true. Flipped after the
    // benchmark in briefs/results/phase-3b-benchmark.md confirmed safety.
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    const draftCallArgs = mockSynthesize.mock.calls[0];
    // synthesize(systemPrompt, userContent, maxTokens, timeoutMs, maxRetries, thinking)
    expect(draftCallArgs[5]).toBe(true);
  });

  it("handles synthesis failure gracefully", async () => {
    const docMap = buildDocMap();
    mockFetchFiles.mockResolvedValue(docMap);
    mockListCommits.mockResolvedValue([]);
    mockSynthesize.mockResolvedValue({ success: false, error: "API returned null", error_code: "API_ERROR" });

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
      success: true,
      content: "Here are my thoughts about the finalization:\n\nThe handoff should be updated...",
      input_tokens: 3000,
      output_tokens: 1000,
      model: "claude-opus-4-7",
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

// ── Archive Lifecycle (S40 FINDING-14 C2) ───────────────────────────────────────

describe("prism_finalize archive lifecycle (S40 FINDING-14 C2)", () => {
  /** Build a session-log.md exceeding a given size with a given entry count. */
  function buildLargeSessionLog(entryCount: number, bodyChars = 600): string {
    const lines = ["# Session Log -- PRISM Framework", ""];
    for (let n = entryCount; n >= 1; n--) {
      lines.push(`### Session ${n} (2026-04-${String(((n - 1) % 28) + 1).padStart(2, "0")})`);
      lines.push("x".repeat(bodyChars));
      lines.push("");
    }
    lines.push("<!-- EOF: session-log.md -->");
    return lines.join("\n");
  }

  it("over-threshold session-log triggers archive, both files land in atomic commit", async () => {
    const bigSessionLog = buildLargeSessionLog(30, 600);
    expect(bigSessionLog.length).toBeGreaterThan(15_000);

    // Handoff backup fetch succeeds; archive fetch throws (no existing archive)
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 40,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "session-log.md", content: bigSessionLog }],
    });

    const paths = capturedFiles.map(f => f.path);
    expect(paths).toContain("session-log.md");
    expect(paths).toContain(".prism/session-log-archive.md");

    const liveFile = capturedFiles.find(f => f.path === "session-log.md")!;
    const archiveFile = capturedFiles.find(f => f.path === ".prism/session-log-archive.md")!;

    expect(liveFile.content.length).toBeLessThan(bigSessionLog.length);
    expect(liveFile.content).toContain("<!-- EOF: session-log.md -->");
    expect(archiveFile.content).toContain("# Session Log Archive");
    expect(archiveFile.content).toContain("### Session 1");
  });

  it("under-threshold session-log — archive does not fire, files[] unchanged", async () => {
    const smallSessionLog =
      "# Session Log -- PRISM Framework\n\n### Session 1 (2026-04-17)\nbody\n\n<!-- EOF: session-log.md -->";

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "session-log.md", content: smallSessionLog }],
    });

    expect(capturedFiles).toHaveLength(1);
    expect(capturedFiles[0].path).toBe("session-log.md");
    expect(capturedFiles[0].content).toBe(smallSessionLog);
  });

  it("archive processing throws — finalize commits live docs anyway (fail-open)", async () => {
    // Insights.md over threshold but without "## Active" section → parseEntries throws.
    const lines = ["# Insights — PRISM Framework", ""];
    for (let n = 1; n <= 30; n++) {
      lines.push(`### INS-${n}: entry ${n}`);
      lines.push("x".repeat(800));
      lines.push("");
    }
    lines.push("<!-- EOF: insights.md -->");
    const badInsights = lines.join("\n");
    expect(badInsights.length).toBeGreaterThan(20_000);
    expect(badInsights).not.toContain("## Active");

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "insights.md", content: badInsights }],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    // No archive added — live doc committed unchanged
    expect(capturedFiles.map(f => f.path)).not.toContain(".prism/insights-archive.md");
    const insightsFile = capturedFiles.find(f => f.path === "insights.md")!;
    expect(insightsFile.content).toBe(badInsights);
  });

  it("appends to existing insights-archive when already present", async () => {
    // Build insights with active section that exceeds 20KB
    const lines = ["# Insights — PRISM Framework", "", "## Active", ""];
    for (let n = 1; n <= 25; n++) {
      lines.push(`### INS-${n}: entry ${n}`);
      lines.push("x".repeat(800));
      lines.push("");
    }
    lines.push("## Formalized", "");
    lines.push("<!-- EOF: insights.md -->");
    const bigInsights = lines.join("\n");
    expect(bigInsights.length).toBeGreaterThan(20_000);

    const existingArchive =
      "# Insights Archive — PRISM Framework\n\n## Archived\n\n### INS-0: pre-existing\nold body\n";

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/insights-archive.md") {
        return { content: existingArchive, sha: "archsha", size: existingArchive.length };
      }
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "insights.md", content: bigInsights }],
    });

    const archiveFile = capturedFiles.find(f => f.path === ".prism/insights-archive.md");
    expect(archiveFile).toBeDefined();
    // Pre-existing entry preserved
    expect(archiveFile!.content).toContain("### INS-0: pre-existing");
    // Header appears exactly once (no duplication)
    const headerMatches = archiveFile!.content.match(/# Insights Archive/g) ?? [];
    expect(headerMatches).toHaveLength(1);
  });
});

// ── Archival decoupled from files[] (brief-435 / D-240 Phase B R2-A) ────────────
//
// prism_log_insight commits insights.md out-of-band during the session, so at
// finalize time it is already committed and absent from the files[] array. The
// pre-brief-435 applyArchive bailed on `liveIdx === -1`, which meant D-80
// retention NEVER fired for insights.md (audit brief-431 §6.3.1). These tests
// pin the decoupled behavior: retention-eligible docs absent from files[] are
// fetched from the repo, split, and land in the same atomic finalize commit.

describe("prism_finalize archival decoupled from files[] (brief-435 R2-A)", () => {
  /** Build an insights.md exceeding 20KB with the D-80 `## Active` section shape. */
  function buildLargeInsights(entryCount: number, bodyChars = 800): string {
    const lines = ["# Insights — PRISM Framework", "", "## Active", ""];
    for (let n = 1; n <= entryCount; n++) {
      lines.push(`### INS-${n}: entry ${n}`);
      lines.push("x".repeat(bodyChars));
      lines.push("");
    }
    lines.push("## Formalized", "");
    lines.push("<!-- EOF: insights.md -->");
    return lines.join("\n");
  }

  const SMALL_SESSION_LOG =
    "# Session Log -- PRISM Framework\n\n### Session 146 (2026-06-03)\nbody\n\n<!-- EOF: session-log.md -->";

  it("over-threshold insights.md absent from files[] → fetched, pruned, archived in the same atomic commit (audit §9(d) regression)", async () => {
    const bigInsights = buildLargeInsights(30, 800);
    expect(bigInsights.length).toBeGreaterThan(20_000);

    // insights.md lives in the repo (committed out-of-band by prism_log_insight);
    // archive does not exist yet; everything else resolves to handoff content.
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/insights.md") {
        return { content: bigInsights, sha: "inssha", size: bigInsights.length };
      }
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    // NOTE: insights.md is deliberately NOT in files[] — that's the bug under test.
    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 146,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "session-log.md", content: SMALL_SESSION_LOG }],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);

    const paths = capturedFiles.map(f => f.path);
    // Archive produced even though insights.md was not declared in files[]
    expect(paths).toContain(".prism/insights-archive.md");
    // Pruned live doc rides the SAME atomic commit
    expect(paths).toContain(".prism/insights.md");

    const liveFile = capturedFiles.find(f => f.path === ".prism/insights.md")!;
    const archiveFile = capturedFiles.find(f => f.path === ".prism/insights-archive.md")!;

    // Live doc shrinks (archivedCount > 0 ⇒ entries moved out)
    expect(liveFile.content.length).toBeLessThan(bigInsights.length);
    expect(liveFile.content).toContain("<!-- EOF: insights.md -->");
    // Oldest entries moved to archive (mostRecentAt: bottom, retention 15 of 30)
    expect(archiveFile.content).toContain("# Insights Archive");
    expect(archiveFile.content).toContain("### INS-1: entry 1");
    // Most-recent entries stay live; archived ones are gone from live
    expect(liveFile.content).toContain("### INS-30: entry 30");
    expect(liveFile.content).not.toContain("### INS-1: entry 1");
    // Operator-declared session-log.md still committed untouched
    const sessionLog = capturedFiles.find(f => f.path === "session-log.md")!;
    expect(sessionLog.content).toBe(SMALL_SESSION_LOG);
  });

  it("doc absent from files[] AND absent from repo → archival skips fail-open, nothing injected", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/insights.md" || path.includes("-archive.md")) {
        throw new Error("Not found");
      }
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 146,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "session-log.md", content: SMALL_SESSION_LOG }],
    });

    const data = parseResult(result);
    // Finalize still succeeds — a missing doc is genuinely nothing to archive
    expect(data.all_succeeded).toBe(true);
    expect(capturedFiles).toHaveLength(1);
    expect(capturedFiles[0].path).toBe("session-log.md");
    expect(capturedFiles[0].content).toBe(SMALL_SESSION_LOG);
  });

  it("fetched out-of-band doc under threshold → no injection, commit unchanged", async () => {
    const smallInsights =
      "# Insights — PRISM Framework\n\n## Active\n\n### INS-1: small\nbody\n\n## Formalized\n\n<!-- EOF: insights.md -->";

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/insights.md") {
        return { content: smallInsights, sha: "inssha", size: smallInsights.length };
      }
      if (path.includes("-archive.md")) throw new Error("Not found");
      return { content: HANDOFF_CONTENT, sha: "sha", size: HANDOFF_CONTENT.length };
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    let capturedFiles: Array<{ path: string; content: string }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, _msg) => {
      capturedFiles = files;
      return { success: true, sha: "atomic_sha", files_committed: files.length };
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 146,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "session-log.md", content: SMALL_SESSION_LOG }],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    // Under-threshold fetched doc must NOT be re-committed
    expect(capturedFiles).toHaveLength(1);
    expect(capturedFiles[0].path).toBe("session-log.md");
  });
});

// ── Auto-Backup Behavior (INS-14 / Bug-A + Bug-B) ────────────────────────────

describe("prism_finalize auto-backup (INS-14)", () => {
  const NEW_HANDOFF = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Test item

## Where We Are
Testing.

<!-- EOF: handoff.md -->`;

  it("auto-backup EOF sentinel matches destination filename (Bug A regression)", async () => {
    // HANDOFF_CONTENT has version 30 and ends with <!-- EOF: handoff.md -->
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic_sha",
      files_committed: 1,
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: NEW_HANDOFF }],
    });

    // brief-460 / S170 post-mortem: the backup rides a safeMutation atomic
    // commit (shared with the prune) — never a separate pushFile commit.
    const backupCommit = mockCreateAtomicCommit.mock.calls.find((call) =>
      (call[1] as Array<{ path: string }>).some((f) =>
        f.path.includes("handoff-history/handoff_v"),
      ),
    );
    expect(backupCommit).toBeDefined();
    const backupWrite = (backupCommit![1] as Array<{ path: string; content: string }>).find(
      (f) => f.path.includes("handoff-history/handoff_v"),
    );
    expect(backupWrite).toBeDefined();

    const backupContent = backupWrite!.content;
    // Must NOT contain the source file's EOF sentinel
    expect(backupContent).not.toContain("<!-- EOF: handoff.md -->");
    // Must contain EOF sentinel matching the versioned backup filename
    expect(backupContent).toMatch(
      /<!-- EOF: handoff_v30_\d{4}-\d{2}-\d{2}\.md -->/,
    );
  });

  it("operator-provided backup in files array suppresses auto-backup (Bug B regression)", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic_sha",
      files_committed: 2,
    });

    // Operator provides their own backup with the correct EOF sentinel
    const operatorBackup = HANDOFF_CONTENT.replace(
      "<!-- EOF: handoff.md -->",
      "<!-- EOF: handoff_v30_2026-04-18.md -->",
    );

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "handoff.md", content: NEW_HANDOFF },
        {
          path: ".prism/handoff-history/handoff_v30_2026-04-18.md",
          content: operatorBackup,
        },
      ],
    });

    const data = parseResult(result);
    // Auto-backup was skipped (returns "")
    expect(data.backup_created).toBe("");

    // pushFile should NOT have been called for a backup
    const backupPushCalls = mockPushFile.mock.calls.filter(
      (call) => (call[1] as string).includes("handoff-history/handoff_v"),
    );
    expect(backupPushCalls).toHaveLength(0);
  });

  it("auto-backup still runs when operator does NOT provide a backup (backward compat)", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic_sha",
      files_committed: 1,
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: NEW_HANDOFF }],
    });

    const data = parseResult(result);
    // Auto-backup should have been created
    expect(data.backup_created).toContain("handoff-history/handoff_v30");

    // brief-460: the backup rides an atomic commit, not pushFile.
    const backupCommit = mockCreateAtomicCommit.mock.calls.find((call) =>
      (call[1] as Array<{ path: string }>).some((f) =>
        f.path.includes("handoff-history/handoff_v"),
      ),
    );
    expect(backupCommit).toBeDefined();
  });

  it("brief-460 / S170 post-mortem: backup write and history prune share ONE atomic commit — the pair can no longer race itself into MUTATION_CONFLICT", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    // 5 existing backups → 2 oldest must be pruned alongside the new write.
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v29_2026-06-01.md", path: ".prism/handoff-history/handoff_v29_2026-06-01.md", type: "file" },
      { name: "handoff_v28_2026-05-30.md", path: ".prism/handoff-history/handoff_v28_2026-05-30.md", type: "file" },
      { name: "handoff_v27_2026-05-28.md", path: ".prism/handoff-history/handoff_v27_2026-05-28.md", type: "file" },
      { name: "handoff_v26_2026-05-26.md", path: ".prism/handoff-history/handoff_v26_2026-05-26.md", type: "file" },
      { name: "handoff_v25_2026-05-24.md", path: ".prism/handoff-history/handoff_v25_2026-05-24.md", type: "file" },
    ] as never);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    const atomicCalls: Array<{ files: Array<{ path: string }>; message: string; deletes: string[] }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, files, message, deletes) => {
      atomicCalls.push({
        files: files as Array<{ path: string }>,
        message: message as string,
        deletes: (deletes as string[] | undefined) ?? [],
      });
      return { success: true, sha: "atomic_sha", files_committed: (files as unknown[]).length };
    });

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: NEW_HANDOFF }],
    });

    const data = parseResult(result);
    expect(data.backup_created).toContain("handoff-history/handoff_v30");

    // Exactly ONE commit carries BOTH the backup write AND the prune deletes.
    const backupCommits = atomicCalls.filter(
      (c) =>
        c.files.some((f) => f.path.includes("handoff-history/handoff_v30")) ||
        c.deletes.some((d) => d.includes("handoff-history/")),
    );
    expect(backupCommits).toHaveLength(1);
    const combined = backupCommits[0];
    expect(combined.files.some((f) => f.path.includes("handoff-history/handoff_v30"))).toBe(true);
    expect(combined.deletes).toEqual(
      expect.arrayContaining([
        ".prism/handoff-history/handoff_v26_2026-05-26.md",
        ".prism/handoff-history/handoff_v25_2026-05-24.md",
      ]),
    );
    expect(combined.deletes).toHaveLength(2);
    expect(combined.message).toContain("handoff-backup v30");
    expect(combined.message).toContain("prune 2");

    // And no pushFile-based backup commit exists at all.
    const backupPushCalls = mockPushFile.mock.calls.filter(
      (call) => typeof call[1] === "string" && (call[1] as string).includes("handoff-history/"),
    );
    expect(backupPushCalls).toHaveLength(0);
  });
});

// ── brief-459 / SRV-05 + SRV-31: numeric version handling for handoff backups ──
//
// Both prune and the drift-baseline pick sorted handoff-history with plain
// localeCompare — lexicographic, so v100+ sorts BELOW v9x (production proof:
// the prune deleted the PREVIOUS session's backup while pinning 6-week-old
// v97-v99 snapshots, and drift measured against a stale baseline for ~70
// sessions). The backup-exists check used substring matching — v17 matched
// handoff_v174.

describe("brief-459 / SRV-05: numeric version sort across digit-width boundaries", () => {
  it("prune keeps the numerically newest 3 (v12,v11,v10) and deletes v9,v8", async () => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: 100,
    });
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v8_2026-03-28.md", path: "handoff-history/handoff_v8_2026-03-28.md", size: 100, sha: "e", type: "file" as const },
      { name: "handoff_v12_2026-04-03.md", path: "handoff-history/handoff_v12_2026-04-03.md", size: 100, sha: "a", type: "file" as const },
      { name: "handoff_v9_2026-03-29.md", path: "handoff-history/handoff_v9_2026-03-29.md", size: 100, sha: "d", type: "file" as const },
      { name: "handoff_v10_2026-04-01.md", path: "handoff-history/handoff_v10_2026-04-01.md", size: 100, sha: "c", type: "file" as const },
      { name: "handoff_v11_2026-04-02.md", path: "handoff-history/handoff_v11_2026-04-02.md", size: 100, sha: "b", type: "file" as const },
    ]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    const pruneCalls: Array<{ deletes?: string[] }> = [];
    mockCreateAtomicCommit.mockImplementation(async (_repo, _files, _message, deletes) => {
      pruneCalls.push({ deletes: deletes ?? [] });
      return { success: true, sha: "atomic_sha", files_committed: 1 };
    });

    await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 13,
      files: [
        { path: "handoff.md", content: "# Handoff\n<!-- EOF: handoff.md -->" },
      ],
    });

    const pruneCommit = pruneCalls.find((c) => (c.deletes ?? []).length > 0);
    expect(pruneCommit).toBeDefined();
    expect(pruneCommit!.deletes).toEqual(
      expect.arrayContaining([
        "handoff-history/handoff_v9_2026-03-29.md",
        "handoff-history/handoff_v8_2026-03-28.md",
      ]),
    );
    expect(pruneCommit!.deletes).toHaveLength(2);
    expect(pruneCommit!.deletes).not.toContain("handoff-history/handoff_v10_2026-04-01.md");
    expect(pruneCommit!.deletes).not.toContain("handoff-history/handoff_v11_2026-04-02.md");
    expect(pruneCommit!.deletes).not.toContain("handoff-history/handoff_v12_2026-04-03.md");
  });

  it("drift baseline picks the numerically newest backup (v10, not v9)", async () => {
    const docMap = buildDocMap();
    const previousHandoff = `## Meta\n- Handoff Version: 10\n\n## Critical Context\n1. PRISM MCP Server is the core infrastructure\n\n<!-- EOF: handoff.md -->`;
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("handoff_v")) {
        return { content: previousHandoff, sha: "old_sha", size: 200 };
      }
      const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
      const entry = docMap.get(docName);
      if (entry) {
        return { content: entry.content, sha: entry.sha, size: entry.size };
      }
      throw new Error(`Not found: ${path}`);
    });
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v9_2026-03-29.md", path: "handoff-history/handoff_v9_2026-03-29.md", size: 100, sha: "d", type: "file" as const },
      { name: "handoff_v10_2026-04-01.md", path: "handoff-history/handoff_v10_2026-04-01.md", size: 100, sha: "c", type: "file" as const },
    ]);
    mockListCommits.mockResolvedValue([]);

    await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const fetchedHistoryPaths = mockFetchFile.mock.calls
      .map((c) => String(c[1]))
      .filter((p) => p.includes("handoff_v"));
    expect(fetchedHistoryPaths.length).toBeGreaterThan(0);
    expect(fetchedHistoryPaths.every((p) => p.includes("handoff_v10"))).toBe(true);
  });
});

describe("brief-459 / SRV-31: backup-exists check is version-anchored", () => {
  it("handoff_v304 does NOT count as a backup for version 30", async () => {
    const docMap = buildDocMap(); // HANDOFF_CONTENT → Handoff Version: 30
    const previousHandoff = `## Meta\n- Handoff Version: 304\n\n## Critical Context\n1. PRISM MCP Server is the core infrastructure\n\n<!-- EOF: handoff.md -->`;
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("handoff_v")) {
        return { content: previousHandoff, sha: "old_sha", size: 200 };
      }
      const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
      const entry = docMap.get(docName);
      if (entry) {
        return { content: entry.content, sha: entry.sha, size: entry.size };
      }
      throw new Error(`Not found: ${path}`);
    });
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v304_2026-06-11.md", path: "handoff-history/handoff_v304_2026-06-11.md", size: 100, sha: "x", type: "file" as const },
    ]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.audit.handoff_backup_exists).toBe(false);
  });

  it("an exact handoff_v30_ backup still counts for version 30", async () => {
    const docMap = buildDocMap();
    const previousHandoff = `## Meta\n- Handoff Version: 30\n\n## Critical Context\n1. PRISM MCP Server is the core infrastructure\n\n<!-- EOF: handoff.md -->`;
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("handoff_v")) {
        return { content: previousHandoff, sha: "old_sha", size: 200 };
      }
      const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
      const entry = docMap.get(docName);
      if (entry) {
        return { content: entry.content, sha: entry.sha, size: entry.size };
      }
      throw new Error(`Not found: ${path}`);
    });
    mockListDirectory.mockResolvedValue([
      { name: "handoff_v30_2026-06-10.md", path: "handoff-history/handoff_v30_2026-06-10.md", size: 100, sha: "y", type: "file" as const },
    ]);
    mockListCommits.mockResolvedValue([]);

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "audit",
      session_number: 26,
    });

    const data = parseResult(result);
    expect(data.audit.handoff_backup_exists).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// brief-460 Task C.1 — phased-finalize schema requirement is explicit.
// The S170/S171 post-mortem found the '## Meta' + '## Where We Are' schema
// to be an undocumented hard requirement whose absence failed SILENTLY
// (logger-only). The gap now surfaces as HANDOFF_SCHEMA_MISSING diagnostics.
// brief-460 / SRV-78 — finalize detects pre-existing ZWS header
// contamination in committed files (full-document channel: detect, never
// mutate; repair is M-041).
// ───────────────────────────────────────────────────────────────────────────

describe("brief-460 — phased-commit handoff schema diagnostics (S170 post-mortem)", () => {
  beforeEach(() => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic_sha",
      files_committed: 1,
    });
  });

  it("commit with handoff content missing '## Meta' emits HANDOFF_SCHEMA_MISSING naming the section (and validation still rejects)", async () => {
    const noMeta = `## Critical Context
1. An item

## Where We Are
Mid-flight.

<!-- EOF: handoff.md -->`;

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: noMeta }],
    });

    const data = parseResult(result);
    // The hard requirement still holds — validation rejects the commit…
    expect(data.all_succeeded).toBe(false);
    // …but the schema gap is now an explicit diagnostic, not a silent log.
    const schemaDiags = (data.diagnostics ?? []).filter(
      (d: { code: string }) => d.code === "HANDOFF_SCHEMA_MISSING",
    );
    expect(schemaDiags.length).toBeGreaterThanOrEqual(1);
    const metaDiag = schemaDiags.find((d: { context?: { section?: string } }) => d.context?.section === "## Meta");
    expect(metaDiag).toBeDefined();
    expect(metaDiag.message).toContain("## Meta");
  });

  it("commit with handoff content missing a non-empty '## Where We Are' emits HANDOFF_SCHEMA_MISSING for that section", async () => {
    const noWhere = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. An item

<!-- EOF: handoff.md -->`;

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: noWhere }],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    const whereDiag = (data.diagnostics ?? []).find(
      (d: { code: string; context?: { section?: string } }) =>
        d.code === "HANDOFF_SCHEMA_MISSING" && d.context?.section === "## Where We Are",
    );
    expect(whereDiag).toBeDefined();
  });

  it("schema-complete handoff content emits no HANDOFF_SCHEMA_MISSING diagnostic", async () => {
    const complete = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. An item

## Where We Are
All sections present.

<!-- EOF: handoff.md -->`;

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: complete }],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    const codes = (data.diagnostics ?? []).map((d: { code: string }) => d.code);
    expect(codes).not.toContain("HANDOFF_SCHEMA_MISSING");
  });
});

describe("brief-460 / SRV-78 — finalize-time ZWS contamination detection", () => {
  const ZWS = "​";

  beforeEach(() => {
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic_sha",
      files_committed: 2,
    });
  });

  it("a committed file carrying the ZWS-neutralized-header signature raises ZWS_CONTAMINATION_DETECTED naming file and line", async () => {
    const validHandoff = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. An item

## Where We Are
Clean handoff.

<!-- EOF: handoff.md -->`;
    const contaminatedLog = `# Session Log

## Sessions

###${ZWS} Session 99 (mangled by the old sanitizer)
- entry body

<!-- EOF: session-log.md -->`;

    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "handoff.md", content: validHandoff },
        { path: "session-log.md", content: contaminatedLog },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    const zwsDiag = (data.diagnostics ?? []).find(
      (d: { code: string }) => d.code === "ZWS_CONTAMINATION_DETECTED",
    );
    expect(zwsDiag).toBeDefined();
    expect(zwsDiag.context.path).toContain("session-log.md");
    expect(zwsDiag.message).toContain("Session 99");
    // Detection never mutates: the committed bytes are exactly as supplied.
    const committed = mockCreateAtomicCommit.mock.calls
      .flatMap((c) => c[1] as Array<{ path: string; content: string }>)
      .find((f) => f.path.includes("session-log.md"));
    expect(committed).toBeDefined();
    expect(committed!.content).toContain(`###${ZWS} Session 99`);
  });
});
