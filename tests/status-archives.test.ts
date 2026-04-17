// S40 FINDING-14 C4: prism_status reports archive file presence and size
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

import { fetchFile, fileExists, listRepos } from "../src/github/client.js";
import {
  registerStatus,
  formatArchivesLine,
  STATUS_ARCHIVE_FILES,
} from "../src/tools/status.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);
const mockListRepos = vi.mocked(listRepos);

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
    // All fetches for documents succeed (handoff); archive fetches throw
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) {
        throw new Error("Not found");
      }
      if (path.endsWith("handoff.md")) {
        return { content: VALID_HANDOFF, sha: "sha", size: VALID_HANDOFF.length };
      }
      return { content: "# doc\n<!-- EOF -->", sha: "sha", size: 30 };
    });
    mockFileExists.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) return false;
      return true;
    });

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
    const archiveContent = "# Session Log Archive — PRISM Framework\n\n### Session 1\nold body\n";

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/session-log-archive.md") {
        return { content: archiveContent, sha: "arsha", size: archiveContent.length };
      }
      if (path.includes("-archive.md")) {
        throw new Error("Not found");
      }
      if (path.endsWith("handoff.md")) {
        return { content: VALID_HANDOFF, sha: "sha", size: VALID_HANDOFF.length };
      }
      return { content: "# doc\n<!-- EOF -->", sha: "sha", size: 30 };
    });
    mockFileExists.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) return false;
      return true;
    });

    const data = await callStatusTool({
      project_slug: "test-project",
      include_details: false,
    });

    expect(data.archives["session-log-archive.md"].exists).toBe(true);
    expect(data.archives["session-log-archive.md"].sizeBytes).toBe(archiveContent.length);
    expect(data.archives["insights-archive.md"].exists).toBe(false);
    expect(data.archives["known-issues-archive.md"].exists).toBe(false);
    expect(data.archives["build-history-archive.md"].exists).toBe(false);
  });

  it("include_details: true emits human-readable archives_summary", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("-archive.md")) throw new Error("Not found");
      if (path.endsWith("handoff.md")) {
        return { content: VALID_HANDOFF, sha: "sha", size: VALID_HANDOFF.length };
      }
      return { content: "# doc\n<!-- EOF -->", sha: "sha", size: 30 };
    });
    mockFileExists.mockImplementation(async () => true);

    const data = await callStatusTool({
      project_slug: "test-project",
      include_details: true,
    });

    expect(data.archives_summary).toBeDefined();
    expect(data.archives_summary).toContain("Archives:");
    expect(data.archives_summary).toContain("session-log-archive.md");
  });
});
