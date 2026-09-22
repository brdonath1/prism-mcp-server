/** Atomic PDU publication integration tests: real safeMutation, mocked GitHub boundary. */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  getHeadSha: vi.fn(),
  getCommit: vi.fn(),
  isCommitReachable: vi.fn(),
  createAtomicCommit: vi.fn(),
}));

import { applyPendingDocUpdates, PDU_ARCHIVE_DOC } from "../src/utils/apply-pdu.js";
import { gitBlobSha } from "../src/utils/safe-mutation.js";
import { createAtomicCommit, fetchFile, getCommit, getHeadSha, isCommitReachable } from "../src/github/client.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockGetCommit = vi.mocked(getCommit);
const mockIsCommitReachable = vi.mocked(isCommitReachable);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);

const PDU = `<!-- prism-pdu-transaction: v1 -->
# Pending Doc Updates — test

> Last synthesized: S99

## architecture.md

### Proposed: add fact
**Apply via \`prism_patch append\` on \`## Target\`:**
\`\`\`
Applied fact.
\`\`\`

<!-- EOF: pending-doc-updates.md -->`;
const CLEARED = `# Pending Doc Updates — test

No proposals remain.
<!-- EOF: pending-doc-updates.md -->`;
const ARCH = `# Architecture

## Target

Original.

<!-- EOF: architecture.md -->`;
const ARCH_CONCURRENT = `# Architecture

## Target

Original.

Concurrent edit.

<!-- EOF: architecture.md -->`;

function file(content: string, exactSha = false) {
  return { content, sha: exactSha ? gitBlobSha(content) : "sha", size: content.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHeadSha.mockResolvedValueOnce("head-1").mockResolvedValueOnce("head-2").mockResolvedValueOnce("head-2");
  mockGetCommit.mockResolvedValue({ message: "another writer" } as never);
});

describe("applyPendingDocUpdates atomic retry", () => {
  it("defers an unmarked legacy PDU without reading targets or creating a commit", async () => {
    const legacy = PDU.replace("<!-- prism-pdu-transaction: v1 -->\n", "");
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/pending-doc-updates.md") return file(legacy) as never;
      throw new Error(`unexpected path ${path}`);
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.applied).toEqual([]);
    expect(result.errors).toEqual([{
      title: "(legacy pending-doc-updates residue)",
      error: "legacy ambiguous residue; manual reconciliation required",
    }]);
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("rejects a marker embedded after content rather than trusting a legacy PDU", async () => {
    const embeddedMarker = PDU.replace(
      "<!-- prism-pdu-transaction: v1 -->\n",
      "# legacy preamble\n<!-- prism-pdu-transaction: v1 -->\n",
    );
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/pending-doc-updates.md") return file(embeddedMarker) as never;
      throw new Error(`unexpected path ${path}`);
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.errors[0]?.error).toBe("legacy ambiguous residue; manual reconciliation required");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("stops an asynchronous plan after its caller aborts before any commit", async () => {
    const controller = new AbortController();
    let releasePdu: ((value: ReturnType<typeof file>) => void) | undefined;
    const pduReady = new Promise<ReturnType<typeof file>>((resolve) => { releasePdu = resolve; });
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/pending-doc-updates.md") return pduReady as never;
      throw new Error(`unexpected path ${path}`);
    });

    const pending = applyPendingDocUpdates("test", 100, controller.signal);
    await Promise.resolve();
    controller.abort();
    releasePdu!(file(PDU));
    const result = await pending;

    expect(result.errors).toEqual([{
      title: "(atomic PDU commit)",
      error: "PDU publication aborted",
    }]);
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("replans from the concurrent target edit after a HEAD conflict", async () => {
    let architectureReads = 0;
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/pending-doc-updates.md") return file(PDU) as never;
      if (path === ".prism/architecture.md") {
        architectureReads += 1;
        return file(architectureReads === 1 ? ARCH : ARCH_CONCURRENT) as never;
      }
      if (path === ".prism/pending-doc-updates-archive.md" || path === "pending-doc-updates-archive.md") throw new Error("Not found");
      throw new Error(`unexpected path ${path}`);
    });
    mockCreateAtomicCommit
      .mockResolvedValueOnce({ success: false, sha: "", files_committed: 0, error: "409 conflict" })
      .mockResolvedValueOnce({ success: true, sha: "committed", files_committed: 3 });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(["add fact"]);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    const retryWrites = mockCreateAtomicCommit.mock.calls[1][1];
    const architecture = retryWrites.find((write) => write.path === ".prism/architecture.md")?.content;
    expect(architecture).toContain("Concurrent edit.");
    expect(architecture).toContain("Applied fact.");
  });

  it("accepts a structurally verified lost response without a second PDU commit", async () => {
    const committed: Record<string, string> = {};
    mockGetHeadSha.mockReset();
    mockGetHeadSha.mockResolvedValueOnce("head-1").mockResolvedValueOnce("head-2");
    mockGetCommit.mockResolvedValue({ message: "prism: S100 consume pending-doc-updates atomically" } as never);
    mockIsCommitReachable.mockResolvedValue(true);
    mockFetchFile.mockImplementation(async (_repo, path, ref) => {
      if (ref === "head-2" || ref === "attempted") return file(committed[path]!, true) as never;
      if (path === ".prism/pending-doc-updates.md") return file(PDU) as never;
      if (path === ".prism/architecture.md") return file(ARCH) as never;
      if (path === `.prism/${PDU_ARCHIVE_DOC}` || path === PDU_ARCHIVE_DOC) throw new Error("Not found");
      throw new Error(`unexpected path ${path}`);
    });
    mockCreateAtomicCommit.mockImplementationOnce(async (_repo, writes) => {
      Object.assign(committed, Object.fromEntries(writes.map((write) => [write.path, write.content])));
      return { success: false, sha: "", files_committed: 0, error: "socket dropped", attemptedCommitSha: "attempted" };
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(["add fact"]);
    expect(result.archived).toBe(true);
    expect(result.cleared).toBe(true);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
  });

  it("does not create a second commit when the retried PDU was already consumed", async () => {
    let pduReads = 0;
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/pending-doc-updates.md") {
        pduReads += 1;
        return file(pduReads === 1 ? PDU : CLEARED) as never;
      }
      if (path === ".prism/architecture.md") return file(ARCH) as never;
      if (path === ".prism/pending-doc-updates-archive.md" || path === "pending-doc-updates-archive.md") throw new Error("Not found");
      throw new Error(`unexpected path ${path}`);
    });
    mockCreateAtomicCommit.mockResolvedValueOnce({ success: false, sha: "", files_committed: 0, error: "409 conflict" });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result).toEqual({ applied: [], skipped: [], errors: [], sanitized: [], cleared: false, archived: false });
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
  });
});
