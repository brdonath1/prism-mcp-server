// S62 Phase 1 Brief 1 — prism_log_decision now uses safeMutation (atomic-only).
//
// Replaces the prior atomic-commit -> HEAD-SHA guard -> sequential pushFile
// fallback with a single safeMutation call. The dedup check moves INSIDE
// computeMutation so it runs against fresh data on every retry. There is no
// sequential-pushFile fallback in the migrated tool — atomic-only by design.
//
// These tests verify:
//   1. Happy path: single createAtomicCommit call covers both files.
//   2. 409 conflict: safeMutation retries with re-read content; the 2nd
//      atomic commit's payload reflects the freshly-read state.
//   3. Retry exhaustion: maxRetries=0 + 409 surfaces a structured error
//      response with no pushFile fallback.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock out every github.client export used by log-decision (and safeMutation
// underneath it) so the handler exercises only the orchestration logic we
// care about.
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn(),
}));

import {
  fetchFile,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";
import { registerLogDecision } from "../src/tools/log-decision.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

const FRESH_INDEX = `# Decisions Index

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-1 | Stateless server | architecture | SETTLED | 1 |

<!-- EOF: _INDEX.md -->
`;

const FRESH_DOMAIN = `# Decisions — architecture

<!-- EOF: architecture.md -->
`;

function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(name: string, _d: string, _s: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

function setupResolvers() {
  mockResolveDocPath.mockImplementation(async (_repo, doc) => {
    if (doc === "decisions/_INDEX.md") {
      return {
        path: ".prism/decisions/_INDEX.md",
        content: FRESH_INDEX,
        sha: "idx-sha",
        legacy: false,
      };
    }
    if (doc === "decisions/architecture.md") {
      return {
        path: ".prism/decisions/architecture.md",
        content: FRESH_DOMAIN,
        sha: "dom-sha",
        legacy: false,
      };
    }
    throw new Error(`Unexpected resolveDocPath: ${doc}`);
  });
  mockGuardPushPath.mockResolvedValue({
    path: ".prism/decisions/architecture.md",
    redirected: false,
  });
}

function setupFetchFile(indexContent: string, domainContent: string) {
  mockFetchFile.mockImplementation(async (_repo, path) => {
    if (path === ".prism/decisions/_INDEX.md") {
      return { content: indexContent, sha: "idx-sha", size: indexContent.length };
    }
    if (path === ".prism/decisions/architecture.md") {
      return { content: domainContent, sha: "dom-sha", size: domainContent.length };
    }
    throw new Error(`Unexpected fetchFile: ${path}`);
  });
}

const BASE_ARGS = {
  project_slug: "test-repo",
  id: "D-2",
  title: "Plain fetch over Octokit",
  domain: "architecture",
  status: "SETTLED",
  reasoning: "Octokit is heavy.",
  session: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("S62 Brief 1 — happy path atomic commit", () => {
  it("writes both files via a single createAtomicCommit call with correct paths", async () => {
    setupResolvers();
    setupFetchFile(FRESH_INDEX, FRESH_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "new-commit-sha",
      files_committed: 2,
    });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const result = await handlers.prism_log_decision(BASE_ARGS);

    expect(result.isError).toBeUndefined();
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    // Critical: no pushFile fallback path exists anymore.
    expect(mockPushFile).not.toHaveBeenCalled();

    // Atomic call carries both resolved paths and the right commit message.
    const [repo, files, message, deletes] = mockCreateAtomicCommit.mock.calls[0];
    expect(repo).toBe("test-repo");
    expect(files).toHaveLength(2);
    expect((files as Array<{ path: string }>).map((f) => f.path)).toEqual([
      ".prism/decisions/_INDEX.md",
      ".prism/decisions/architecture.md",
    ]);
    expect(message).toBe("prism: D-2 Plain fetch over Octokit");
    // No deletes on a write-only mutation (regression guard).
    expect(deletes).toEqual([]);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);
  });
});

describe("S62 Brief 1 — concurrent-write recovery via safeMutation retry", () => {
  it("re-reads + recomputes on 409, lands the write on the second attempt, no pushFile fallback", async () => {
    setupResolvers();

    // Fresh-data simulation: concurrent writer added D-99 between the two
    // attempts. Our retry must re-fetch and append D-2 against the new
    // content (this closes the stale-content-on-retry bug from log-insight
    // and the partial-state risk from the old log-decision fallback).
    const concurrentIndex = FRESH_INDEX.replace(
      "<!-- EOF: _INDEX.md -->",
      "| D-99 | Concurrent | architecture | SETTLED | 99 |\n<!-- EOF: _INDEX.md -->",
    );
    let indexFetches = 0;
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/decisions/_INDEX.md") {
        indexFetches += 1;
        const content = indexFetches === 1 ? FRESH_INDEX : concurrentIndex;
        return { content, sha: `idx-${indexFetches}`, size: content.length };
      }
      if (path === ".prism/decisions/architecture.md") {
        return {
          content: FRESH_DOMAIN,
          sha: "dom-sha",
          size: FRESH_DOMAIN.length,
        };
      }
      throw new Error(`Unexpected fetchFile: ${path}`);
    });

    mockGetHeadSha
      .mockResolvedValueOnce("head-1") // pre-1st attempt
      .mockResolvedValueOnce("head-2") // post-failure check (HEAD moved)
      .mockResolvedValueOnce("head-2"); // pre-2nd attempt
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "409 conflict",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "new-commit",
        files_committed: 2,
      });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const result = await handlers.prism_log_decision(BASE_ARGS);

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);

    // Two atomic attempts; ZERO pushFile fallbacks (atomic-only contract).
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    expect(mockPushFile).not.toHaveBeenCalled();

    // Second attempt's payload must include both D-99 (concurrent) and D-2 (us)
    // — proving fresh-content recompute on retry.
    const secondCall = mockCreateAtomicCommit.mock.calls[1];
    const indexFile = (secondCall[1] as Array<{ path: string; content: string }>).find(
      (f) => f.path === ".prism/decisions/_INDEX.md",
    );
    expect(indexFile?.content).toContain("| D-99 |");
    expect(indexFile?.content).toContain("| D-2 |");
  });
});

describe("S62 Brief 1 — atomic-only contract, no sequential fallback", () => {
  it("repeated 409s exhaust retries and surface a structured error without falling back to pushFile", async () => {
    setupResolvers();
    setupFetchFile(FRESH_INDEX, FRESH_DOMAIN);

    // safeMutation default maxRetries = 1. Two failures exhaust the budget.
    mockGetHeadSha.mockResolvedValue("head-stable");
    mockCreateAtomicCommit.mockResolvedValue({
      success: false,
      sha: "",
      files_committed: 0,
      error: "persistent 409",
    });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const result = await handlers.prism_log_decision(BASE_ARGS);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(false);
    expect(payload.domain_file_updated).toBe(false);
    // 1 initial + 1 retry = 2 attempts at most. No pushFile fallback.
    expect(mockCreateAtomicCommit.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});
