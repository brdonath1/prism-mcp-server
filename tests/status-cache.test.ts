// S47 P3.1 — caches for prism_status multi-project fan-out.
//
// Asserts the back-to-back pattern: a second multi-project status call
// made shortly after the first MUST reuse the cached listRepos + per-repo
// handoff-existence lookups instead of re-fetching.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocExists: vi.fn(),
  resolveDocPath: vi.fn(),
}));

import { fetchFile, fileExists, listRepos } from "../src/github/client.js";
import { resolveDocExists, resolveDocPath } from "../src/utils/doc-resolver.js";
import {
  registerStatus,
  clearRepoListCache,
  clearHandoffExistenceCache,
} from "../src/tools/status.js";

const mockListRepos = vi.mocked(listRepos);
const mockFetchFile = vi.mocked(fetchFile);
const mockResolveDocExists = vi.mocked(resolveDocExists);
const mockResolveDocPath = vi.mocked(resolveDocPath);

async function callStatus(args: Record<string, unknown> = {}) {
  const server = new McpServer(
    { name: "t", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerStatus(server);
  const tool = (server as any)._registeredTools["prism_status"];
  return tool.handler(args, {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "r",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  });
}

function setupHappyMocks(): void {
  mockListRepos.mockResolvedValue(["project-a", "project-b"]);
  mockResolveDocExists.mockImplementation(async (repo: string, docName: string) => {
    if (docName === "handoff.md") {
      return { exists: true, path: `.prism/${docName}`, legacy: false };
    }
    // Other living docs: pretend they exist so health computation stays healthy.
    return { exists: true, path: `.prism/${docName}`, legacy: false };
  });
  mockFetchFile.mockImplementation(async (repo: string, path: string) => ({
    content: path.endsWith("handoff.md")
      ? "## Meta\n- Handoff Version: 1\n- Session Count: 1\n- Status: active\n\n<!-- EOF: handoff.md -->"
      : "<!-- EOF: x -->",
    sha: "s",
    size: 200,
  }));
  mockResolveDocPath.mockImplementation(async (repo: string, docName: string) => ({
    path: `.prism/${docName}`,
    content: "<!-- EOF: " + docName + " -->",
    sha: "s",
    legacy: false,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoListCache();
  clearHandoffExistenceCache();
});

describe("S47 P3.1 — listReposCache (5-min TTL)", () => {
  it("second back-to-back multi-project status call hits the cache (listRepos called exactly once)", async () => {
    setupHappyMocks();

    const first = await callStatus({}); // multi-project
    expect(first.isError).toBeUndefined();
    expect(mockListRepos).toHaveBeenCalledTimes(1);

    const second = await callStatus({});
    expect(second.isError).toBeUndefined();
    // Cache hit — listRepos was not invoked again.
    expect(mockListRepos).toHaveBeenCalledTimes(1);
  });

  it("after clearRepoListCache(), the next call re-fetches listRepos", async () => {
    setupHappyMocks();

    await callStatus({});
    expect(mockListRepos).toHaveBeenCalledTimes(1);

    clearRepoListCache();

    await callStatus({});
    expect(mockListRepos).toHaveBeenCalledTimes(2);
  });
});

describe("S47 P3.1 — handoffExistenceCache (10-min TTL)", () => {
  // The cache only covers the DISCOVERY path ("is this repo a PRISM project?").
  // Per-project getProjectHealth() still runs its own resolveDocExists loop
  // across every living document including handoff.md; that is independent
  // of the discovery cache and runs once per call. The delta between calls
  // therefore drops by exactly the number of discovery probes (one per repo).

  it("second back-to-back call drops the discovery probes but keeps per-project doc-checks", async () => {
    setupHappyMocks();

    await callStatus({});
    const firstHandoffExistsCalls = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // 2 repos × (1 discovery probe + 1 per-project doc-check) = 4.
    expect(firstHandoffExistsCalls).toBe(4);

    await callStatus({});
    const totalHandoffExistsCalls = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // Discovery cache absorbed the 2 repo probes; only the 2 per-project
    // doc-checks run. Delta = 2 (the 2 cached discovery probes).
    expect(totalHandoffExistsCalls - firstHandoffExistsCalls).toBe(2);
  });

  it("clearHandoffExistenceCache(repo) re-runs discovery for that repo only", async () => {
    setupHappyMocks();

    await callStatus({});
    const firstCallCount = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    expect(firstCallCount).toBe(4);

    clearHandoffExistenceCache("project-a");

    await callStatus({});
    const secondCallCount = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // Uncached repo: 1 discovery probe + 1 per-project doc-check = 2 new calls.
    // Cached repo: 0 discovery + 1 per-project = 1 new call.
    // Delta = 3.
    expect(secondCallCount - firstCallCount).toBe(3);
  });
});

describe("S47 P3.1 — single-project status does not touch the multi-project caches", () => {
  it("single-project calls do not invoke listRepos at all", async () => {
    setupHappyMocks();
    await callStatus({ project_slug: "project-a" });
    // Single-project path bypasses the repo-list discovery.
    expect(mockListRepos).not.toHaveBeenCalled();
  });
});
