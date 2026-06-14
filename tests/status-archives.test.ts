// S40 FINDING-14 C4: prism_status reports archive file presence and size
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  listRepos: vi.fn(),
}));

import { fetchFile, fileExists, listDirectory, listRepos } from "../src/github/client.js";
import {
  registerStatus,
  formatArchivesLine,
  STATUS_ARCHIVE_FILES,
} from "../src/tools/status.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockListRepos = vi.mocked(listRepos);

const LIVING_DOC_NAMES = [
  "handoff.md", "session-log.md", "task-queue.md", "eliminated.md",
  "architecture.md", "glossary.md", "known-issues.md", "insights.md",
  "intelligence-brief.md",
];

/**
 * SRV-70: prism_status now reads existence + size from directory LISTINGS and
 * fetches only handoff.md's content. This helper sets up listDirectory(".prism")
 * (root docs + the given archives), listDirectory(".prism/decisions") (_INDEX),
 * and fetchFile for the handoff body.
 */
function setupProject(opts: { archives?: Array<{ name: string; size: number }>; docSize?: number } = {}) {
  const docSize = opts.docSize ?? 30;
  const rootEntries = [
    ...LIVING_DOC_NAMES.map((name) => ({ name, path: `.prism/${name}`, size: docSize, sha: "s", type: "file" as const })),
    ...(opts.archives ?? []).map((a) => ({ name: a.name, path: `.prism/${a.name}`, size: a.size, sha: "s", type: "file" as const })),
  ];
  mockListDirectory.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism") return rootEntries;
    if (path === ".prism/decisions") return [{ name: "_INDEX.md", path: ".prism/decisions/_INDEX.md", size: docSize, sha: "s", type: "file" as const }];
    return [];
  });
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path.endsWith("handoff.md")) return { content: VALID_HANDOFF, sha: "sha", size: VALID_HANDOFF.length };
    return { content: "# doc\n<!-- EOF -->", sha: "sha", size: docSize };
  });
  mockFileExists.mockResolvedValue(true);
}

const VALID_HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 3
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Thing

## Where We Are
Working.

<!-- EOF: handoff.md -->`;

async function callStatusTool(args: Record<string, unknown>): Promise<any> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerStatus(server);
  const registered = (server as any)._registeredTools;
  const tool = registered["prism_status"];
  if (!tool) throw new Error("prism_status not registered");
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-status-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  const result = await tool.handler(args, mockExtra);
  return JSON.parse((result as any).content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatArchivesLine (S40 FINDING-14 C4)", () => {
  it("formats not-yet-created archives clearly", () => {
    const archives = Object.fromEntries(
      STATUS_ARCHIVE_FILES.map(name => [name, { exists: false, sizeBytes: null }]),
    ) as any;
    const line = formatArchivesLine(archives);
    expect(line).toContain("session-log-archive.md (not yet created)");
    expect(line).toContain("insights-archive.md (not yet created)");
  });

  it("formats existing archives with KB size", () => {
    const archives: any = {
      "session-log-archive.md": { exists: true, sizeBytes: 5120 },
      "insights-archive.md": { exists: false, sizeBytes: null },
      "known-issues-archive.md": { exists: false, sizeBytes: null },
      "build-history-archive.md": { exists: false, sizeBytes: null },
    };
    const line = formatArchivesLine(archives);
    expect(line).toContain("session-log-archive.md (5.0 KB)");
    expect(line).toContain("insights-archive.md (not yet created)");
  });
});

describe("prism_status archive reporting (S40 FINDING-14 C4)", () => {
  it("project with no archives — all four entries show exists: false", async () => {
    setupProject({ archives: [] });

    const data = await callStatusTool({
      project_slug: "test-project",
      include_details: false,
    });

    expect(data.archives).toBeDefined();
    for (const name of STATUS_ARCHIVE_FILES) {
      expect(data.archives[name].exists).toBe(false);
      expect(data.archives[name].sizeBytes).toBeNull();
    }
  });

  it("project with session-log-archive.md only — only that entry shows exists: true with size", async () => {
    setupProject({ archives: [{ name: "session-log-archive.md", size: 5120 }] });

    const data = await callStatusTool({
      project_slug: "test-project",
      include_details: false,
    });

    expect(data.archives["session-log-archive.md"].exists).toBe(true);
    expect(data.archives["session-log-archive.md"].sizeBytes).toBe(5120);
    expect(data.archives["insights-archive.md"].exists).toBe(false);
    expect(data.archives["known-issues-archive.md"].exists).toBe(false);
    expect(data.archives["build-history-archive.md"].exists).toBe(false);
  });

  it("include_details: true emits human-readable archives_summary", async () => {
    setupProject({ archives: [{ name: "session-log-archive.md", size: 5120 }] });

    const data = await callStatusTool({
      project_slug: "test-project",
      include_details: true,
    });

    expect(data.archives_summary).toBeDefined();
    expect(data.archives_summary).toContain("Archives:");
    expect(data.archives_summary).toContain("session-log-archive.md");
  });

  // SRV-70 missing_test: the optimization is provable by COUNTING GitHub calls —
  // ~3 listings + 1 handoff content fetch per project, not ~30 full downloads.
  it("SRV-70: a single project costs a handful of listings + one handoff fetch, not a per-doc download", async () => {
    setupProject({ archives: [] });

    await callStatusTool({ project_slug: "test-project", include_details: false });

    // Listings: .prism + .prism/decisions (migrated layout — no root fallback).
    expect(mockListDirectory.mock.calls.length).toBeLessThanOrEqual(3);
    // Exactly one content fetch — handoff.md — never the other 9 docs / 4 archives.
    const fetchedPaths = mockFetchFile.mock.calls.map((c) => c[1] as string);
    expect(fetchedPaths.length).toBe(1);
    expect(fetchedPaths[0]).toContain("handoff.md");
  });
});
