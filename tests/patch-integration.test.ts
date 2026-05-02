/**
 * Integration tests for prism_patch tool (S62 Phase 1 Brief 1, Change 6).
 *
 * patch.ts now uses safeMutation, which:
 *   - moves applyPatch INTO computeMutation (re-runs against fresh content
 *     on every retry, closing the stale-content-on-retry bug)
 *   - replaces the bare pushFile path with createAtomicCommit
 *   - preserves PATCH_REDIRECTED and PATCH_PARTIAL_FAILURE diagnostics
 *
 * Brief 3's resolveDocPath silent-fallback fix is intentionally NOT in scope
 * here; the bare-catch path is preserved unchanged.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
}));

import {
  fetchFile,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import { registerPatch } from "../src/tools/patch.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);

async function callPatchTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerPatch(server);
  const tool = (server as any)._registeredTools["prism_patch"];
  if (!tool) throw new Error("Tool not registered");
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-patch-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(args, mockExtra)) as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

const TASK_QUEUE = `# Task Queue

## In Progress
- existing item

## Backlog

<!-- EOF: task-queue.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDocPath.mockResolvedValue({
    path: ".prism/task-queue.md",
    content: TASK_QUEUE,
    sha: "tq-sha",
    legacy: false,
  });
});

describe("prism_patch happy path (atomic commit via safeMutation)", () => {
  it("applies a single patch and commits via createAtomicCommit (no pushFile fallback)", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- new item" },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.file).toBe(".prism/task-queue.md");
    expect(data.patches_applied).toHaveLength(1);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    // Critical: no pushFile fallback path remains.
    expect(mockPushFile).not.toHaveBeenCalled();

    // The atomic commit body should contain the patched content.
    const [, files] = mockCreateAtomicCommit.mock.calls[0];
    const file = (files as Array<{ path: string; content: string }>)[0];
    expect(file.path).toBe(".prism/task-queue.md");
    expect(file.content).toContain("- new item");
  });

  it("emits PATCH_REDIRECTED when the resolved path differs from the requested path", async () => {
    // Resolver returns a redirected path.
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/task-queue.md",
      content: TASK_QUEUE,
      sha: "tq-sha",
      legacy: false,
    });
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md", // Bare name → resolved to .prism/
      patches: [
        { operation: "append", section: "## In Progress", content: "- redirected item" },
      ],
    });

    const data = parseResult(result);
    expect(data.redirected).toBe(true);
    const redirectDiag = (data.diagnostics as Array<{ code: string }>).find(
      (d) => d.code === "PATCH_REDIRECTED",
    );
    expect(redirectDiag).toBeDefined();
  });
});

describe("prism_patch concurrent-write recovery (S62 Phase 1 Brief 1)", () => {
  it("re-applies patches against fresh content on 409 retry (closes stale-content bug)", async () => {
    // First fetch returns the original content; the retry fetch returns a
    // version where a concurrent writer added a new item to "## Backlog".
    // Our patch (appending to "## In Progress") must apply cleanly against
    // the FRESH content, and the resulting commit body must include both
    // the concurrent change and our patch.
    const concurrentTaskQueue = TASK_QUEUE.replace(
      "## Backlog\n",
      "## Backlog\n- concurrent backlog item\n",
    );

    let fetches = 0;
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/task-queue.md") {
        fetches += 1;
        const content = fetches === 1 ? TASK_QUEUE : concurrentTaskQueue;
        return { content, sha: `tq-${fetches}`, size: content.length };
      }
      throw new Error(`Unexpected fetchFile: ${path}`);
    });
    mockGetHeadSha
      .mockResolvedValueOnce("HEAD_1")
      .mockResolvedValueOnce("HEAD_2") // post-failure check; HEAD moved
      .mockResolvedValueOnce("HEAD_2");
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "409 conflict",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "atomic-2",
        files_committed: 1,
      });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- our item" },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    expect(mockPushFile).not.toHaveBeenCalled();

    // Critical: second commit's body must include BOTH the concurrent
    // backlog item AND our in-progress item — proving fresh-content
    // recompute closed the stale-content-on-retry bug.
    const [, files2] = mockCreateAtomicCommit.mock.calls[1];
    const file = (files2 as Array<{ path: string; content: string }>)[0];
    expect(file.content).toContain("- concurrent backlog item");
    expect(file.content).toContain("- our item");
  });
});

describe("prism_patch resolveDocPath classification (S63 Phase 1 Brief 3)", () => {
  it("falls back silently to original path when resolveDocPath rejects with 'Not found'", async () => {
    // resolveDocPath rethrows the inner fetchFile 404, which has the form
    // "Not found: fetchFile <repo>/<path>". This is the legitimate fallback
    // case (arbitrary repo file, brand-new doc) — no diagnostic should fire.
    mockResolveDocPath.mockRejectedValueOnce(
      new Error("Not found: fetchFile test-project/notes/random.md"),
    );
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-3",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "notes/random.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- item" },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    // Original path was used (no redirect, no PATCH_REDIRECTED).
    expect(data.file).toBe("notes/random.md");
    expect(data.redirected).toBe(false);
    const codes = (data.diagnostics as Array<{ code: string }>).map(
      (d) => d.code,
    );
    expect(codes).not.toContain("PATCH_RESOLVE_FAILED");
    expect(codes).not.toContain("PATCH_REDIRECTED");
  });

  it("emits PATCH_RESOLVE_FAILED on operational error and falls back to original path", async () => {
    // 5xx-class operational error from resolveDocPath. The bare-catch bug
    // would have swallowed this silently; the fix surfaces it as a
    // PATCH_RESOLVE_FAILED diagnostic while preserving operational
    // continuity (Option A).
    mockResolveDocPath.mockRejectedValueOnce(
      new Error("GitHub API 503: Service Unavailable (fetchFile test-project/.prism/task-queue.md)"),
    );
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-4",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- item" },
      ],
    });

    const data = parseResult(result);
    // Option A: tool still succeeds against the original path.
    expect(data.success).toBe(true);
    expect(data.file).toBe("task-queue.md");
    expect(data.redirected).toBe(false);

    const resolveDiag = (data.diagnostics as Array<{
      code: string;
      message: string;
      context?: { original?: string; error?: string };
    }>).find((d) => d.code === "PATCH_RESOLVE_FAILED");
    expect(resolveDiag).toBeDefined();
    expect(resolveDiag!.message).toContain("503");
    expect(resolveDiag!.context?.original).toBe("task-queue.md");
    expect(resolveDiag!.context?.error).toContain("503");
  });
});

describe("prism_patch partial-failure surfaces PATCH_PARTIAL_FAILURE", () => {
  it("rejects the write when any patch fails and emits PATCH_PARTIAL_FAILURE", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- valid item" },
        { operation: "append", section: "## DoesNotExist", content: "- targets missing section" },
      ],
    });

    const data = parseResult(result);
    expect(result.isError).toBe(true);
    expect(data.error).toContain("patches failed");
    // PATCH_PARTIAL_FAILURE diagnostic must surface.
    const partialDiag = (data.diagnostics as Array<{ code: string }>).find(
      (d) => d.code === "PATCH_PARTIAL_FAILURE",
    );
    expect(partialDiag).toBeDefined();
    // No commit attempted on partial failure.
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

describe("KI-26 — prism_patch sanitizes header-injected content before write", () => {
  // The pattern these tests pin: a caller supplies `content` containing a
  // line that begins with `## ` or `### `. Without sanitization that line
  // would parse as a real section header on the next read, breaking the
  // section tree silently. sanitizeContentField inserts U+200B between the
  // `#` cluster and the following space; the line then reads as a normal
  // body line to the parser.
  const ZWS = "​";

  function getCommittedContent(): string {
    const calls = mockCreateAtomicCommit.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const files = calls[calls.length - 1][1] as Array<{ path: string; content: string }>;
    const tq = files.find((f) => f.path === ".prism/task-queue.md");
    if (!tq) throw new Error("task-queue.md missing from atomic-commit payload");
    return tq.content;
  }

  it("neutralizes a `## Injected` line in append content", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        {
          operation: "append",
          section: "## In Progress",
          content: "- normal task\n## Injected\n- after",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    const written = getCommittedContent();
    expect(written).toContain(`##${ZWS} Injected`);
    // Critical: no real `## Injected` header should land in the document.
    expect(written).not.toMatch(/^## Injected$/m);
    // Sanity: the unsanitized callers' bodies are still preserved on either
    // side of the injection — the caller's intent isn't lost.
    expect(written).toContain("- normal task");
    expect(written).toContain("- after");
  });

  it("neutralizes injected headers in replace content", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        {
          operation: "replace",
          section: "## In Progress",
          content: "### Sneaky Sub\n- replaced item",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    const written = getCommittedContent();
    expect(written).toContain(`###${ZWS} Sneaky Sub`);
    expect(written).not.toMatch(/^### Sneaky Sub$/m);
  });

  it("neutralizes injected headers in prepend content", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        {
          operation: "prepend",
          section: "## In Progress",
          content: "## Top-Of-Section Injection\n- prepended item",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    const written = getCommittedContent();
    expect(written).toContain(`##${ZWS} Top-Of-Section Injection`);
    expect(written).not.toMatch(/^## Top-Of-Section Injection$/m);
  });

  it("leaves header-free content untouched (no incidental ZWS injection)", async () => {
    mockFetchFile.mockResolvedValue({
      content: TASK_QUEUE,
      sha: "tq-sha",
      size: TASK_QUEUE.length,
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-1",
      files_committed: 1,
    });

    const result = await callPatchTool({
      project_slug: "test-project",
      file: "task-queue.md",
      patches: [
        { operation: "append", section: "## In Progress", content: "- plain item" },
      ],
    });

    const data = parseResult(result);
    expect(data.success).toBe(true);
    const written = getCommittedContent();
    expect(written).toContain("- plain item");
    expect(written).not.toContain(ZWS);
  });
});
