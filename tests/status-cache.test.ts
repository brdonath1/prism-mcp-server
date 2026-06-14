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
  listDirectory: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocExists: vi.fn(),
  resolveDocPath: vi.fn(),
}));

import { fetchFile, fileExists, listDirectory, listRepos } from "../src/github/client.js";
import { resolveDocExists, resolveDocPath } from "../src/utils/doc-resolver.js";
import {
  registerStatus,
  clearRepoListCache,
  clearHandoffExistenceCache,
} from "../src/tools/status.js";

const mockListRepos = vi.mocked(listRepos);
const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockResolveDocExists = vi.mocked(resolveDocExists);
const mockResolveDocPath = vi.mocked(resolveDocPath);

const STATUS_DOC_NAMES = [
  "handoff.md", "session-log.md", "task-queue.md", "eliminated.md",
  "architecture.md", "glossary.md", "known-issues.md", "insights.md",
  "intelligence-brief.md",
];

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
  // SRV-70: getProjectHealth now reads existence + size from directory listings.
  mockListDirectory.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism") {
      return STATUS_DOC_NAMES.map((name) => ({ name, path: `.prism/${name}`, size: 200, sha: "s", type: "file" as const }));
    }
    if (path === ".prism/decisions") {
      return [{ name: "_INDEX.md", path: ".prism/decisions/_INDEX.md", size: 200, sha: "s", type: "file" as const }];
    }
    return [];
  });
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
  // The cache covers the DISCOVERY path ("is this repo a PRISM project?").
  // SRV-70: getProjectHealth no longer runs a per-doc resolveDocExists loop —
  // it reads existence + size from a directory listing — so resolveDocExists is
  // now invoked ONLY by discovery (one probe per repo), and the cache absorbs
  // every one of them on a back-to-back call.

  it("second back-to-back call serves discovery entirely from cache (zero new probes)", async () => {
    setupHappyMocks();

    await callStatus({});
    const firstHandoffExistsCalls = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // 2 repos × 1 discovery probe = 2 (no per-project resolveDocExists anymore).
    expect(firstHandoffExistsCalls).toBe(2);

    await callStatus({});
    const totalHandoffExistsCalls = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // Discovery cache absorbed both repo probes; no new resolveDocExists calls.
    expect(totalHandoffExistsCalls - firstHandoffExistsCalls).toBe(0);
  });

  it("clearHandoffExistenceCache(repo) re-runs discovery for that repo only", async () => {
    setupHappyMocks();

    await callStatus({});
    const firstCallCount = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    expect(firstCallCount).toBe(2);

    clearHandoffExistenceCache("project-a");

    await callStatus({});
    const secondCallCount = mockResolveDocExists.mock.calls.filter(
      (c) => c[1] === "handoff.md",
    ).length;
    // Only the cleared repo (project-a) re-probes discovery; project-b stays
    // cached. Delta = 1.
    expect(secondCallCount - firstCallCount).toBe(1);
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

// SRV-54: a transient fetch failure must not make a project silently vanish
// from the fleet view — surface it.
describe("SRV-54 — dropped projects are surfaced, not silently omitted", () => {
  it("a project whose health fetch rejects is reported via PROJECTS_DROPPED + projects_failed", async () => {
    setupHappyMocks();
    // project-b's directory listing fails (transient GitHub error); project-a is fine.
    mockListDirectory.mockImplementation(async (repo: string, path: string) => {
      if (repo === "project-b") throw new Error("github 503");
      if (path === ".prism") {
        return STATUS_DOC_NAMES.map((name) => ({ name, path: `.prism/${name}`, size: 200, sha: "s", type: "file" as const }));
      }
      if (path === ".prism/decisions") {
        return [{ name: "_INDEX.md", path: ".prism/decisions/_INDEX.md", size: 200, sha: "s", type: "file" as const }];
      }
      return [];
    });

    const data = JSON.parse((await callStatus({})).content[0].text);

    // The healthy project is still reported ...
    expect(data.total_projects).toBe(1);
    // ... and the dropped one is COUNTED + named, not vanished.
    expect(data.projects_failed).toBe(1);
    const dropped = data.diagnostics.find((d: any) => d.code === "PROJECTS_DROPPED");
    expect(dropped).toBeDefined();
    expect(dropped.context.dropped.map((p: any) => p.project)).toContain("project-b");
  });
});
