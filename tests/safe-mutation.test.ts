/**
 * Unit tests for the safeMutation primitive (S62 Phase 1 Brief 1, Change 2).
 *
 * Covers:
 *  - happy path (single attempt)
 *  - 409 conflict triggers re-read + recompute (retry budget honored)
 *  - retry budget exhaustion -> MUTATION_RETRY_EXHAUSTED
 *  - getHeadSha returns undefined -> HEAD_SHA_UNKNOWN, no commit attempted
 *    on the retry path (atomic-only contract; see "delete + sha:null" test
 *    below for the HTTP-routing assertion called for by INS-31)
 *  - delete support: writes pass `deletes` through to createAtomicCommit
 *    (the actual sha:null Git Trees payload assertion lives in
 *    `atomic-commit-url.test.ts` per INS-31, where fetch-routing tests
 *    against the real createAtomicCommit are already wired up).
 *  - deadline enforcement -> DEADLINE_EXCEEDED via Promise.race
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github/client.js")>();
  return {
    ...actual,
    fetchFile: vi.fn(),
    createAtomicCommit: vi.fn(),
    getHeadSha: vi.fn(),
  };
});

import {
  fetchFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { DiagnosticsCollector } from "../src/utils/diagnostics.js";
import { safeMutation } from "../src/utils/safe-mutation.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeMutation — atomic commit success path", () => {
  it("snapshots HEAD, reads files, calls computeMutation once, atomic-commits", async () => {
    mockGetHeadSha.mockResolvedValue("head-1");
    mockFetchFile.mockResolvedValue({
      content: "original",
      sha: "blob-1",
      size: 8,
    });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "commit-1",
      files_committed: 1,
    });

    const computeMutation = vi.fn(() => ({
      writes: [{ path: "a.md", content: "new" }],
    }));

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: success path",
      readPaths: ["a.md"],
      computeMutation,
      diagnostics,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commitSha).toBe("commit-1");
      expect(result.retried).toBe(false);
    }
    expect(mockGetHeadSha).toHaveBeenCalledTimes(1);
    expect(mockFetchFile).toHaveBeenCalledTimes(1);
    expect(mockFetchFile).toHaveBeenCalledWith("test-repo", "a.md");
    expect(computeMutation).toHaveBeenCalledTimes(1);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockCreateAtomicCommit).toHaveBeenCalledWith(
      "test-repo",
      [{ path: "a.md", content: "new" }],
      "test: success path",
      [],
    );
    expect(diagnostics.list()).toHaveLength(0);
  });
});

describe("safeMutation — 409 conflict triggers re-read and recompute", () => {
  it("re-reads files, re-runs computeMutation, retries atomic commit on conflict", async () => {
    // Two HEAD snapshots: before (1st attempt), after-conflict-check, before (2nd attempt)
    mockGetHeadSha
      .mockResolvedValueOnce("head-1") // before 1st attempt
      .mockResolvedValueOnce("head-2") // after-failure check (HEAD moved)
      .mockResolvedValueOnce("head-2"); // before 2nd attempt

    mockFetchFile
      .mockResolvedValueOnce({ content: "v1", sha: "blob-1", size: 2 })
      .mockResolvedValueOnce({ content: "v2", sha: "blob-2", size: 2 });

    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "409 conflict",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "commit-2",
        files_committed: 1,
      });

    const computedFromContent: string[] = [];
    const computeMutation = vi.fn((files: Map<string, { content: string }>) => {
      const f = files.get("a.md")!;
      computedFromContent.push(f.content);
      return {
        writes: [{ path: "a.md", content: `${f.content}+entry` }],
      };
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: retry on conflict",
      readPaths: ["a.md"],
      computeMutation,
      diagnostics,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.retried).toBe(true);
      expect(result.commitSha).toBe("commit-2");
    }
    // Critical: fetchFile called twice (once per attempt)
    expect(mockFetchFile).toHaveBeenCalledTimes(2);
    // Critical: computeMutation called twice with potentially different content
    expect(computeMutation).toHaveBeenCalledTimes(2);
    expect(computedFromContent).toEqual(["v1", "v2"]);
    // 2nd atomic commit body uses the freshly-computed content from the 2nd read
    expect(mockCreateAtomicCommit).toHaveBeenLastCalledWith(
      "test-repo",
      [{ path: "a.md", content: "v2+entry" }],
      "test: retry on conflict",
      [],
    );
    // MUTATION_CONFLICT diagnostic emitted on the retry
    const codes = diagnostics.list().map((d) => d.code);
    expect(codes).toContain("MUTATION_CONFLICT");
  });
});

describe("safeMutation — retry budget exhaustion", () => {
  it("emits MUTATION_RETRY_EXHAUSTED and returns ok:false when maxRetries=0 hits 409", async () => {
    mockGetHeadSha.mockResolvedValue("head-1");
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "409 conflict",
    });

    const computeMutation = vi.fn(() => ({
      writes: [{ path: "a.md", content: "new" }],
    }));

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: exhaust retries",
      readPaths: ["a.md"],
      computeMutation,
      diagnostics,
      maxRetries: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("MUTATION_RETRY_EXHAUSTED");
      expect(result.error).toContain("retry budget exhausted");
    }
    // Only ONE attempt — no retry budget
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(computeMutation).toHaveBeenCalledTimes(1);
    const exhaustedDiag = diagnostics.list().find(
      (d) => d.code === "MUTATION_RETRY_EXHAUSTED",
    );
    expect(exhaustedDiag).toBeDefined();
    expect(exhaustedDiag?.level).toBe("error");
  });
});

describe("safeMutation — null HEAD SHA refuses retry", () => {
  it("emits HEAD_SHA_UNKNOWN and returns ok:false when getHeadSha returns undefined pre-atomic", async () => {
    // First snapshot returns undefined — primitive should NOT attempt the
    // atomic commit's retry path, but it WILL still attempt the first commit.
    // After the first commit fails, the post-failure HEAD check happens,
    // and that's where HEAD_SHA_UNKNOWN fires (because pre-atomic was null).
    mockGetHeadSha.mockResolvedValue(undefined);
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "tree creation failed",
    });

    const computeMutation = vi.fn(() => ({
      writes: [{ path: "a.md", content: "new" }],
    }));

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: null HEAD",
      readPaths: ["a.md"],
      computeMutation,
      diagnostics,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HEAD_SHA_UNKNOWN");
    }
    // Critical: NO retry — only one createAtomicCommit call.
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    const unknownDiag = diagnostics.list().find(
      (d) => d.code === "HEAD_SHA_UNKNOWN",
    );
    expect(unknownDiag).toBeDefined();
    expect(unknownDiag?.level).toBe("warn");
  });

  it("emits HEAD_SHA_UNKNOWN on null post-atomic snapshot too", async () => {
    mockGetHeadSha
      .mockResolvedValueOnce("head-1") // pre-atomic
      .mockResolvedValueOnce(undefined); // post-failure check
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "tree creation failed",
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: post null",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("HEAD_SHA_UNKNOWN");
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    const phaseCtx = diagnostics
      .list()
      .find((d) => d.code === "HEAD_SHA_UNKNOWN")?.context;
    expect(phaseCtx?.phase).toBe("post-atomic-check");
  });
});

describe("safeMutation — delete support (createAtomicCommit pass-through)", () => {
  it("forwards deletes to createAtomicCommit", async () => {
    mockGetHeadSha.mockResolvedValue("head-1");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "commit-1",
      files_committed: 2,
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "chore: prune",
      readPaths: [],
      computeMutation: () => ({
        writes: [],
        deletes: ["a.md", "b.md"],
      }),
      diagnostics,
    });

    expect(result.ok).toBe(true);
    expect(mockFetchFile).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).toHaveBeenCalledWith(
      "test-repo",
      [],
      "chore: prune",
      ["a.md", "b.md"],
    );
  });
});

describe("safeMutation — deadline enforcement", () => {
  it("returns DEADLINE_EXCEEDED when the operation exceeds deadlineMs", async () => {
    mockGetHeadSha.mockImplementation(
      () =>
        new Promise<string>((resolve) => setTimeout(() => resolve("head-1"), 200)),
    );
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "commit-1",
      files_committed: 1,
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: deadline",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
      deadlineMs: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DEADLINE_EXCEEDED");
    const deadlineDiag = diagnostics
      .list()
      .find((d) => d.code === "DEADLINE_EXCEEDED");
    expect(deadlineDiag).toBeDefined();
    expect(deadlineDiag?.level).toBe("error");
  });
});
