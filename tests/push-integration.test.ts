/**
 * Integration tests for prism_push tool (S64 Phase 1 Brief 1.5 — safeMutation).
 *
 * The tool delegates to safeMutation, which performs a single atomic Git
 * Trees commit, retries once on conflict against fresh content, and
 * refuses to retry when HEAD state is unknown. There is no sequential
 * pushFile fallback — atomic-only by design (S62 audit Verdict C).
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

  // SRV-76: a validation failure must set the MCP isError flag so clients
  // surface it, instead of a success-shaped envelope that hides the failure.
  it("SRV-76: a validation failure sets isError: true", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [{ path: "handoff.md", content: "", message: "prism: empty" }],
      skip_validation: false,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
  });

  it("SRV-76: a clean push does NOT set isError", async () => {
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "ok_sha", files_committed: 1 });
    const result = await callPushTool({
      project_slug: "test-project",
      files: [{ path: "glossary.md", content: "# Glossary\nT\n<!-- EOF: glossary.md -->", message: "prism: update glossary" }],
      skip_validation: false,
    });
    expect(result.isError).toBeUndefined();
    expect(parseResult(result).all_succeeded).toBe(true);
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

// ── Atomic failure: retry exhausted → return failure, no sequential fallback ───

describe("prism_push atomic failure with retry exhausted", () => {
  it("returns failure when safeMutation exhausts its retry budget", async () => {
    // Atomic always fails — safeMutation retries once, then surfaces
    // MUTATION_RETRY_EXHAUSTED. No sequential pushFile fallback exists.
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "updateRef failed: 422 Unprocessable Entity",
    });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");

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
    // Atomic-only — pushFile is no longer imported by push.ts.
    expect(mockPushFile).not.toHaveBeenCalled();
    for (const r of data.results) {
      expect(r.success).toBe(false);
      expect(r.error).toContain("retry budget exhausted");
    }
    // safeMutation's retry-exhausted diagnostic must be surfaced.
    const exhaustedDiag = (data.diagnostics as Array<{ code: string }>).find(
      (d) => d.code === "MUTATION_RETRY_EXHAUSTED",
    );
    expect(exhaustedDiag).toBeDefined();
  });
});

// ── Null-safe HEAD comparison (safeMutation owns the contract) ────────────────

describe("prism_push atomic failure with NULL HEAD (refuse retry)", () => {
  // safeMutation refuses to retry when either pre-atomic or post-atomic HEAD
  // snapshot returns undefined. The diagnostic surfaces with phase context.
  it("treats null HEAD pre-atomic as unknown and emits HEAD_SHA_UNKNOWN", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "createTree failed: 500",
    });
    mockGetHeadSha.mockResolvedValue(undefined);

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
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(mockPushFile).not.toHaveBeenCalled();
    const headDiag = (data.diagnostics as Array<{ code: string; context?: { phase?: string } }>).find(
      (d) => d.code === "HEAD_SHA_UNKNOWN",
    );
    expect(headDiag).toBeDefined();
    expect(headDiag!.context?.phase).toBe("pre-atomic-snapshot");
  });

  it("treats null HEAD post-atomic as unknown and emits HEAD_SHA_UNKNOWN", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "createTree failed: 500",
    });
    mockGetHeadSha
      .mockResolvedValueOnce("HEAD_BEFORE")
      .mockResolvedValueOnce(undefined);

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
    expect(data.all_succeeded).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
    const headDiag = (data.diagnostics as Array<{ code: string; context?: { phase?: string } }>).find(
      (d) => d.code === "HEAD_SHA_UNKNOWN",
    );
    expect(headDiag).toBeDefined();
    expect(headDiag!.context?.phase).toBe("post-atomic-check");
  });
});

// ── Atomic failure → safeMutation retry succeeds ───────────────────────────────

describe("prism_push atomic conflict retry (safeMutation)", () => {
  it("succeeds when atomic fails once then succeeds on retry", async () => {
    // safeMutation retries once on conflict — the second atomic call wins.
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        // SRV-96: a 409/non-fast-forward conflict is what the test name means
        // by "conflict" and is what surfaces MUTATION_CONFLICT (a plain 500 is
        // now MUTATION_RETRY).
        error: "GitHub API 409: Update is not a fast forward (updateRef)",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "atomic_retry_sha",
        files_committed: 2,
      });
    mockGetHeadSha.mockResolvedValue("HEAD_STABLE");

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
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(data.commit_sha).toBe("atomic_retry_sha");
    for (const r of data.results) {
      expect(r.sha).toBe("atomic_retry_sha");
    }
    // safeMutation emits MUTATION_CONFLICT on the way through.
    const conflictDiag = (data.diagnostics as Array<{ code: string }>).find(
      (d) => d.code === "MUTATION_CONFLICT",
    );
    expect(conflictDiag).toBeDefined();
  });

  it("handles thrown errors during atomic commit gracefully", async () => {
    // safeMutation propagates throws from createAtomicCommit; the tool
    // catches and produces a structured error payload.
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

// ───────────────────────────────────────────────────────────────────────────
// brief-460 / SRV-78 — prism_push is a full-document channel (intentionally
// unsanitized) driven by unattended cc workers; pre-existing ZWS header
// contamination is DETECTED and surfaced, never silently re-committed
// invisible. The bytes themselves are written exactly as supplied (repair
// is M-041).
// ───────────────────────────────────────────────────────────────────────────
describe("brief-460 / SRV-78 — prism_push ZWS contamination detection", () => {
  const ZWS = "​";

  it("a pushed file carrying ZWS-neutralized headers raises ZWS_CONTAMINATION_DETECTED naming file and header", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const contaminated = `# Task Queue

## Active

###${ZWS} S171 block (mangled upstream)
- carried over

<!-- EOF: task-queue.md -->`;

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "task-queue.md",
          content: contaminated,
          message: "prism: artifact task-queue.md",
        },
      ],
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    const diag = (data.diagnostics ?? []).find(
      (d: { code: string }) => d.code === "ZWS_CONTAMINATION_DETECTED",
    );
    expect(diag).toBeDefined();
    expect(diag.context.path).toBe("task-queue.md");
    expect(diag.message).toContain("S171 block");

    // The committed bytes are exactly as supplied — detect, never mutate.
    const committed = mockCreateAtomicCommit.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    expect(committed[0].content).toContain(`###${ZWS} S171 block`);
  });

  it("clean content raises no ZWS diagnostic", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "task-queue.md",
          content: "# Task Queue\n\n### Real Header\n- ok\n\n<!-- EOF: task-queue.md -->",
          message: "prism: artifact task-queue.md",
        },
      ],
    });

    const data = parseResult(result);
    const codes = (data.diagnostics ?? []).map((d: { code: string }) => d.code);
    expect(codes).not.toContain("ZWS_CONTAMINATION_DETECTED");
  });
});
