/**
 * Integration tests for prism_push tool (S40 C3 — atomic-first flow).
 *
 * The tool now tries a single atomic Git Trees commit first. pushFile is
 * only invoked as a sequential fallback when the atomic attempt fails AND
 * HEAD has not moved. When HEAD HAS moved after an atomic failure, the
 * tool refuses to retry and reports a partial-state warning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the GitHub client. createAtomicCommit and getHeadSha are new in S40 C3.
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

import {
  fetchFile,
  pushFile,
  fileExists,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { registerPush } from "../src/tools/push.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

/** Helper: invoke prism_push via McpServer internal handler. */
async function callPushTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerPush(server);

  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_push"];
  if (!tool) throw new Error("Tool not registered");

  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-push-1",
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
  // Default: doc-guard fileExists → false (paths not redirected).
  mockFileExists.mockResolvedValue(false);
  // Default: HEAD lookup returns a stable SHA so failure-path tests can
  // assert HEAD-unchanged behavior without extra boilerplate.
  mockGetHeadSha.mockResolvedValue("HEAD_BEFORE");
});

// ── Validate-all-or-push-none ──────────────────────────────────────────────────

describe("prism_push validate-all-or-push-none", () => {
  it("pushes nothing if ANY file fails validation", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "# Handoff\nValid content\n<!-- EOF: handoff.md -->",
          message: "prism: update handoff",
        },
        {
          path: "session-log.md",
          content: "# Session Log\nValid content\n<!-- EOF: wrong-filename.md -->",
          message: "prism: update session log",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(data.files_failed).toBe(2);
    // Neither atomic commit nor pushFile should have been attempted
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(data.results[1].validation_errors[0]).toContain("EOF");
  });

  it("pushes nothing if a commit message has invalid prefix", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "# Glossary\nTerms here\n<!-- EOF: glossary.md -->",
          message: "feat: this prefix is not allowed",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("pushes nothing if content is empty", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "",
          message: "prism: empty push",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

// ── Successful push flow (atomic-first) ────────────────────────────────────────

describe("prism_push successful flow (atomic-first)", () => {
  it("pushes a single file via one atomic commit", async () => {
    const atomicSha = "atomic_abc123";
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: atomicSha,
      files_committed: 1,
    });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms here\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(1);
    expect(data.files_failed).toBe(0);
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].verified).toBe(true);
    expect(data.results[0].sha).toBe(atomicSha);
    expect(data.commit_sha).toBe(atomicSha);
    // Atomic success — no sequential pushFile calls and no fetch-for-verify
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockFetchFile).not.toHaveBeenCalled();
  });

  it("multi-file push returns the same commit SHA for every file", async () => {
    const atomicSha = "atomic_multi_def456";
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: atomicSha,
      files_committed: 2,
    });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update docs",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nEntries\n<!-- EOF: eliminated.md -->",
          message: "prism: update docs",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(2);
    expect(data.commit_sha).toBe(atomicSha);
    // Every file result carries the atomic commit signature
    for (const r of data.results) {
      expect(r.success).toBe(true);
      expect(r.sha).toBe(atomicSha);
      expect(r.verified).toBe(true);
    }
    // atomic was called exactly once with both files
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    const [, filesArg] = mockCreateAtomicCommit.mock.calls[0];
    expect(Array.isArray(filesArg)).toBe(true);
    expect((filesArg as Array<{ path: string }>).map(f => f.path)).toEqual([
      "glossary.md",
      "eliminated.md",
    ]);
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

// ── Atomic failure: HEAD moved → partial state, no fallback ────────────────────

describe("prism_push atomic failure with HEAD moved", () => {
  it("reports partial-state when atomic failed and HEAD moved", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "updateRef failed: 422 Unprocessable Entity",
    });
    // Before/after HEAD SHAs differ → partial write suspected
    mockGetHeadSha
      .mockResolvedValueOnce("HEAD_BEFORE")
      .mockResolvedValueOnce("HEAD_AFTER");

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nEntries\n<!-- EOF: eliminated.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(data.files_failed).toBe(2);
    // Must NOT fall back to sequential pushFile — repo is indeterminate
    expect(mockPushFile).not.toHaveBeenCalled();
    // Every result should carry the partial-state signal
    for (const r of data.results) {
      expect(r.success).toBe(false);
      expect(r.validation_errors.join(" ")).toContain("Partial atomic commit");
      expect(r.error).toContain("updateRef failed");
    }
  });
});

// ── Atomic failure: HEAD unchanged → sequential fallback succeeds ──────────────

describe("prism_push atomic failure with HEAD unchanged (sequential fallback)", () => {
  it("falls back to sequential pushFile when HEAD didn't move", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "createTree failed: 500 Internal Server Error",
    });
    // HEAD stable before and after
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockPushFile
      .mockResolvedValueOnce({ success: true, size: 100, sha: "fallback_sha_1" })
      .mockResolvedValueOnce({ success: true, size: 200, sha: "fallback_sha_2" });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update docs",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nEntries\n<!-- EOF: eliminated.md -->",
          message: "prism: update docs",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(2);
    expect(data.files_failed).toBe(0);
    // Fallback path: pushFile called sequentially, once per file
    expect(mockPushFile).toHaveBeenCalledTimes(2);
    expect(data.results[0].sha).toBe("fallback_sha_1");
    expect(data.results[1].sha).toBe("fallback_sha_2");
    // No atomic commit SHA in the top-level response (atomic failed)
    expect(data.commit_sha).toBeUndefined();
  });

  it("propagates per-file errors from the sequential fallback", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "tree creation failed",
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");
    mockPushFile
      .mockResolvedValueOnce({ success: true, size: 100, sha: "ok_sha" })
      .mockResolvedValueOnce({ success: false, size: 0, sha: "", error: "409 Conflict" });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nOK\n<!-- EOF: glossary.md -->",
          message: "prism: update docs",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nContent\n<!-- EOF: eliminated.md -->",
          message: "prism: update docs",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    const succeeded = data.results.filter((r: any) => r.success);
    const failed = data.results.filter((r: any) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toBe("409 Conflict");
  });

  it("handles thrown errors during atomic commit gracefully", async () => {
    // createAtomicCommit catches internally and returns failure, but if the
    // wrapping tool logic itself rejects (e.g. getHeadSha throws before the
    // atomic call), the tool still produces a structured error payload.
    mockCreateAtomicCommit.mockRejectedValue(new Error("Network timeout"));

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.error).toContain("Network timeout");
  });
});

// ── skip_validation ─────────────────────────────────────────────────────────────

describe("prism_push skip_validation", () => {
  it("pushes without validation when skip_validation is true", async () => {
    const atomicSha = "atomic_skip_789";
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: atomicSha,
      files_committed: 1,
    });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "no EOF sentinel, invalid content",
          message: "invalid prefix: this would normally fail",
        },
      ],
      skip_validation: true,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(1);
    expect(data.results[0].sha).toBe(atomicSha);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});
