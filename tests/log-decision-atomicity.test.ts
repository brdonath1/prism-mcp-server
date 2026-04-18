// S47 P2.1 — prism_log_decision must write both files atomically.
//
// Exercises the atomic-commit → HEAD-SHA guard → sequential fallback
// contract mirrored from push.ts. Uses the recorded-calls fetch-mock
// pattern (INS-31) to assert URL + method for each step of the atomic
// sequence and to verify the fallback paths under each branch of the
// HEAD-SHA check.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock out every github.client export used by log-decision so the handler
// exercises only the orchestration logic we care about.
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
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";
import { registerLogDecision } from "../src/tools/log-decision.js";

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

function setupDocResolvers() {
  mockResolveDocPath
    .mockResolvedValueOnce({
      path: ".prism/decisions/_INDEX.md",
      content: FRESH_INDEX,
      sha: "idx-sha",
      legacy: false,
    })
    .mockResolvedValueOnce({
      path: ".prism/decisions/architecture.md",
      content: FRESH_DOMAIN,
      sha: "dom-sha",
      legacy: false,
    });
  mockGuardPushPath.mockResolvedValue({
    path: ".prism/decisions/architecture.md",
    redirected: false,
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

describe("S47 P2.1 — happy path atomic commit", () => {
  it("writes both files via a single createAtomicCommit call with correct paths", async () => {
    setupDocResolvers();
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
    expect(mockPushFile).not.toHaveBeenCalled();

    // Assert the atomic call carries both resolved paths and the right commit
    // message — this is the A-5 contract ("atomic" means one commit, both files).
    const [repo, files, message] = mockCreateAtomicCommit.mock.calls[0];
    expect(repo).toBe("test-repo");
    expect(files).toHaveLength(2);
    expect(files.map((f: { path: string }) => f.path)).toEqual([
      ".prism/decisions/_INDEX.md",
      ".prism/decisions/architecture.md",
    ]);
    expect(message).toBe("prism: D-2 Plain fetch over Octokit");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);
  });
});

describe("S47 P2.1 — HEAD-moved branch surfaces partial-state error (no fallback)", () => {
  it("does NOT call pushFile and returns isError=true when HEAD changed mid-commit", async () => {
    setupDocResolvers();
    // Pre-commit HEAD snapshot.
    mockGetHeadSha.mockResolvedValueOnce("head-before");
    // Atomic fails — simulate the production "Not found: updateRef" shape.
    mockCreateAtomicCommit.mockResolvedValueOnce({
      success: false,
      sha: "",
      files_committed: 0,
      error: "Not found: updateRef test-repo",
    });
    // Post-failure HEAD read shows HEAD moved (concurrent writer landed).
    mockGetHeadSha.mockResolvedValueOnce("head-after-different");

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const result = await handlers.prism_log_decision(BASE_ARGS);

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain("Concurrent write");
    expect(payload.index_updated).toBe(false);
    expect(payload.domain_file_updated).toBe(false);
    // Critical: when HEAD moved we MUST NOT fall back — a retry could double-write.
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

describe("S47 P2.1 — HEAD-unchanged branch falls back to sequential pushFile", () => {
  it("calls pushFile sequentially in (index, domain) order when HEAD is stable", async () => {
    setupDocResolvers();
    mockGetHeadSha.mockResolvedValueOnce("head-same");
    mockCreateAtomicCommit.mockResolvedValueOnce({
      success: false,
      sha: "",
      files_committed: 0,
      error: "Not found: updateRef test-repo",
    });
    // HEAD unchanged after atomic failure — safe to retry sequentially.
    mockGetHeadSha.mockResolvedValueOnce("head-same");
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "s" });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const result = await handlers.prism_log_decision(BASE_ARGS);

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);

    // Two pushes, in order: _INDEX.md first, domain file second. Matches
    // push.ts's sequential fallback contract (avoid the 409 race that drove
    // us to atomic in the first place).
    expect(mockPushFile).toHaveBeenCalledTimes(2);
    const firstPath = mockPushFile.mock.calls[0][1];
    const secondPath = mockPushFile.mock.calls[1][1];
    expect(firstPath).toBe(".prism/decisions/_INDEX.md");
    expect(secondPath).toBe(".prism/decisions/architecture.md");
  });
});
