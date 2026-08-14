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
    getCommit: vi.fn(),
  };
});

import {
  fetchFile,
  createAtomicCommit,
  getHeadSha,
  getCommit,
} from "../src/github/client.js";
import { DiagnosticsCollector } from "../src/utils/diagnostics.js";
import { safeMutation, gitBlobSha } from "../src/utils/safe-mutation.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockGetCommit = vi.mocked(getCommit);

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
      undefined, // SRV-42: signal arg (undefined on the no-deadline path)
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

    // SRV-41: HEAD moved, so safeMutation fetches the new HEAD commit to check
    // whether OUR commit landed. Here it's an EXTERNAL writer (message differs)
    // -> genuine conflict -> retry, preserving the original test intent.
    mockGetCommit.mockResolvedValue({
      sha: "head-2",
      message: "someone else's concurrent commit",
      date: "2026-06-13T00:00:00Z",
      files: [],
    });

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
      undefined, // SRV-42: signal arg (undefined on the no-deadline path)
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
      undefined, // SRV-42: signal arg (undefined on the no-deadline path)
    );
  });
});

describe("SRV-41 — landed-but-unreported commit is not double-applied on retry", () => {
  it("returns ok (no retry) when the 'failed' commit actually landed (new HEAD holds OUR blobs)", async () => {
    // Simulate: createAtomicCommit's ref PATCH succeeded server-side but the
    // response was lost (timeout/socket drop) -> reported failure while HEAD
    // moved to the commit we just made.
    mockGetHeadSha
      .mockResolvedValueOnce("head-before") // pre-atomic
      .mockResolvedValueOnce("head-after"); // post-failure check (HEAD moved)
    // Two-arg call = the attempt's read; three-arg call = the R25 structural
    // verification read at the landed commit.
    mockFetchFile.mockImplementation(async (_repo, _path, ref) =>
      ref === "head-after"
        ? { content: "appended", sha: gitBlobSha("appended"), size: 8 }
        : { content: "v1", sha: "blob-1", size: 2 },
    );
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "GitHub API request timed out after 15000ms",
    });
    // The new HEAD commit carries OUR exact commit message -> pre-filter passes.
    mockGetCommit.mockResolvedValue({
      sha: "head-after",
      message: "prism: patch session-log",
      date: "2026-06-13T00:00:00Z",
      files: [],
    });

    const computeMutation = vi.fn(() => ({
      writes: [{ path: "session-log.md", content: "appended" }],
    }));

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "prism: patch session-log",
      readPaths: ["session-log.md"],
      computeMutation,
      diagnostics,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitSha).toBe("head-after");
    // CRITICAL: the mutation was NOT re-applied — only the first attempt ran.
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(computeMutation).toHaveBeenCalledTimes(1);
    // Verification read the blob at the landed commit, not at the branch tip.
    expect(mockFetchFile).toHaveBeenCalledWith("test-repo", "session-log.md", "head-after");
    const codes = diagnostics.list().map((d) => d.code);
    expect(codes).toContain("MUTATION_ALREADY_APPLIED");
  });
});

describe("S203 R25 (F-C1-9) — structural identity, not commit-message equality", () => {
  it("409, HEAD moved to a different commit with an identical message → does NOT return ok; retries", async () => {
    // The concurrent-write hazard (INS-69): PRISM commit messages are
    // templated, so the other actor's commit can carry byte-identical text.
    // Pre-R25 that was read as "our commit landed" and THIS mutation was
    // silently dropped while reporting success.
    mockGetHeadSha
      .mockResolvedValueOnce("head-before") // pre-atomic, attempt 1
      .mockResolvedValueOnce("head-other") // post-failure check (HEAD moved)
      .mockResolvedValueOnce("head-other"); // pre-atomic, attempt 2

    mockFetchFile.mockImplementation(async (_repo, _path, ref) =>
      ref === "head-other"
        ? // The landed tree holds the OTHER writer's bytes, not ours.
          { content: "theirs", sha: gitBlobSha("theirs"), size: 6 }
        : { content: "v1", sha: "blob-1", size: 2 },
    );

    // Same message, different author — the pre-R25 sole criterion.
    mockGetCommit.mockResolvedValue({
      sha: "head-other",
      message: "prism: finalize session 42 [2026-08-14]",
      date: "2026-08-14T00:00:00Z",
      files: [],
    });

    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "GitHub API 409: Update is not a fast forward (updateRef)",
      })
      .mockResolvedValueOnce({ success: true, sha: "commit-ours", files_committed: 1 });

    const computeMutation = vi.fn(() => ({
      writes: [{ path: "handoff.md", content: "ours" }],
    }));

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "prism: finalize session 42 [2026-08-14]",
      readPaths: ["handoff.md"],
      computeMutation,
      diagnostics,
    });

    // The mutation was RETRIED and landed for real — not reported as already
    // applied off the back of a matching message.
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    expect(computeMutation).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commitSha).toBe("commit-ours");
      expect(result.retried).toBe(true);
    }
    const codes = diagnostics.list().map((d) => d.code);
    expect(codes).not.toContain("MUTATION_ALREADY_APPLIED");
    expect(codes).toContain("MUTATION_CONFLICT");
  });

  it("does not claim 'already applied' when the verification read fails (fails closed)", async () => {
    mockGetHeadSha
      .mockResolvedValueOnce("head-before")
      .mockResolvedValueOnce("head-after")
      .mockResolvedValueOnce("head-after");
    mockFetchFile.mockImplementation(async (_repo, _path, ref) => {
      if (ref === "head-after") throw new Error("GitHub API 500: upstream blip");
      return { content: "v1", sha: "blob-1", size: 2 };
    });
    mockGetCommit.mockResolvedValue({
      sha: "head-after",
      message: "prism: checkpoint [2026-08-14]",
      date: "2026-08-14T00:00:00Z",
      files: [],
    });
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "GitHub API 409: Update is not a fast forward (updateRef)",
      })
      .mockResolvedValueOnce({ success: true, sha: "commit-2", files_committed: 1 });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "prism: checkpoint [2026-08-14]",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
    });

    expect(result.ok).toBe(true);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    const codes = diagnostics.list().map((d) => d.code);
    expect(codes).not.toContain("MUTATION_ALREADY_APPLIED");
  });

  it("verifies a delete-only mutation by absence at the landed commit", async () => {
    mockGetHeadSha
      .mockResolvedValueOnce("head-before")
      .mockResolvedValueOnce("head-after");
    // fetchFile at the landed commit 404s -> the delete is confirmed landed.
    mockFetchFile.mockRejectedValue(new Error("Not found: fetchFile test-repo/old.md"));
    mockGetCommit.mockResolvedValue({
      sha: "head-after",
      message: "prism: supersede old.md",
      date: "2026-08-14T00:00:00Z",
      files: [],
    });
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "GitHub API request timed out after 15000ms",
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "prism: supersede old.md",
      readPaths: [],
      computeMutation: () => ({ writes: [], deletes: ["old.md"] }),
      diagnostics,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitSha).toBe("head-after");
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
  });

  it("gitBlobSha matches git's own object id for a known blob", () => {
    // `printf '' | git hash-object --stdin` -> the empty-blob sha.
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("SRV-42 — deadline cancels (does not abandon) in-flight mutation", () => {
  it("aborts the in-flight createAtomicCommit signal and never re-invokes it after DEADLINE_EXCEEDED", async () => {
    mockGetHeadSha.mockResolvedValue("head-1");
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });

    let callCount = 0;
    let capturedSignal: AbortSignal | undefined;
    mockCreateAtomicCommit.mockImplementation(
      async (_repo, _writes, _msg, _deletes, signal) => {
        callCount += 1;
        capturedSignal = signal;
        // Hang until the deadline aborts the signal, then resolve as a failure.
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ success: false, sha: "", files_committed: 0, error: "aborted" }),
          );
        });
      },
    );

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: deadline cancel",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
      deadlineMs: 30,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DEADLINE_EXCEEDED");
    // The in-flight commit received an aborted signal...
    expect(capturedSignal?.aborted).toBe(true);
    // ...and was never re-invoked after the deadline fired.
    expect(callCount).toBe(1);
  });
});

describe("SRV-96 — diagnostic code reflects the real failure class", () => {
  it("emits MUTATION_RETRY (not MUTATION_CONFLICT) for a non-conflict atomic failure", async () => {
    mockGetHeadSha.mockResolvedValue("head-1"); // HEAD did NOT move
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "GitHub validation failed: invalid path (createTree test-repo)",
    });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: non-conflict failure",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
      maxRetries: 1,
    });

    expect(result.ok).toBe(false);
    const codes = diagnostics.list().map((d) => d.code);
    // A 422 validation failure is NOT a 409 conflict — it must not be
    // mislabeled MUTATION_CONFLICT (the SRV-96 false-contract bug).
    expect(codes).toContain("MUTATION_RETRY");
    expect(codes).not.toContain("MUTATION_CONFLICT");
  });

  it("still emits MUTATION_CONFLICT for a genuine 409/non-fast-forward failure", async () => {
    mockGetHeadSha
      .mockResolvedValueOnce("head-1")
      .mockResolvedValueOnce("head-2")
      .mockResolvedValueOnce("head-2");
    mockGetCommit.mockResolvedValue({
      sha: "head-2",
      message: "external commit",
      date: "2026-06-13T00:00:00Z",
      files: [],
    });
    mockFetchFile.mockResolvedValue({ content: "v1", sha: "blob-1", size: 2 });
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "GitHub API 409: Update is not a fast forward (updateRef)",
      })
      .mockResolvedValueOnce({ success: true, sha: "commit-2", files_committed: 1 });

    const diagnostics = new DiagnosticsCollector();
    const result = await safeMutation({
      repo: "test-repo",
      commitMessage: "test: conflict",
      readPaths: ["a.md"],
      computeMutation: () => ({ writes: [{ path: "a.md", content: "new" }] }),
      diagnostics,
    });

    expect(result.ok).toBe(true);
    const codes = diagnostics.list().map((d) => d.code);
    expect(codes).toContain("MUTATION_CONFLICT");
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
