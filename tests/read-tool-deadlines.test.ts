/**
 * brief-444 R-deadlines (D-240 Phase B / audit brief-431) — tool-level
 * wall-clock deadlines on the four read-path tools: prism_analytics,
 * prism_search, prism_status, prism_fetch. Before this brief only 4/23
 * tools (push, finalize, patch, cc_dispatch) carried a deadline; a hung
 * GitHub fan-out in any read tool held the MCP client connection until the
 * ~60s transport timeout with no structured error.
 *
 * Mirrors tests/tool-deadlines.test.ts: the deadline constants are mocked
 * to ~400ms so the deadline path runs in seconds, and the GitHub client is
 * mocked to hang (promises that never resolve).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Override the deadlines to very small values. Must be declared BEFORE
// importing any module that reads these constants.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ANALYTICS_WALL_CLOCK_DEADLINE_MS: 400,
    SEARCH_WALL_CLOCK_DEADLINE_MS: 400,
    STATUS_WALL_CLOCK_DEADLINE_MS: 400,
    FETCH_WALL_CLOCK_DEADLINE_MS: 400,
  };
});

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  pushFiles: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
  getDefaultBranch: vi.fn(),
  listRepos: vi.fn(),
}));

import {
  fetchFile,
  fileExists,
  listDirectory,
  listCommits,
  listRepos,
} from "../src/github/client.js";
import { registerAnalytics } from "../src/tools/analytics.js";
import { registerSearch } from "../src/tools/search.js";
import { registerStatus } from "../src/tools/status.js";
import { registerFetch } from "../src/tools/fetch.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockListRepos = vi.mocked(listRepos);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Capture a tool handler off a stub server. */
function captureHandler(
  register: (server: McpServer) => void,
  toolName: string,
): Handler {
  let captured: Handler | null = null;
  const stub = {
    tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === toolName) captured = handler as Handler;
    },
  } as unknown as McpServer;
  register(stub);
  if (!captured) throw new Error(`${toolName} handler was not registered`);
  return captured;
}

function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const HANGING = () => new Promise(() => { /* never resolves */ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("brief-444 — prism_analytics wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when the GitHub fetch hangs", async () => {
    mockFetchFile.mockImplementation(HANGING as never);
    const handler = captureHandler(registerAnalytics, "prism_analytics");

    const t0 = Date.now();
    const result = await handler({ project_slug: "test-project", metric: "decision_velocity" });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/prism_analytics deadline exceeded/);
    expect(data.metric).toBe("decision_velocity");
    expect(data.project).toBe("test-project");
  });

  it("does NOT trip the deadline when the work completes quickly", async () => {
    mockFetchFile.mockResolvedValue({
      content:
        "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | T | arch | SETTLED | 1 |\n",
      sha: "s1",
      size: 100,
    });
    const handler = captureHandler(registerAnalytics, "prism_analytics");

    const result = await handler({ project_slug: "test-project", metric: "decision_velocity" });

    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    expect(data.error).toBeUndefined();
    expect(data.metric).toBe("decision_velocity");
  });
});

describe("brief-444 — prism_search wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when the doc fan-out hangs", async () => {
    mockFetchFile.mockImplementation(HANGING as never);
    mockFileExists.mockImplementation(HANGING as never);
    mockListDirectory.mockImplementation(HANGING as never); // SRV-82: domain discovery now lists
    const handler = captureHandler(registerSearch, "prism_search");

    const t0 = Date.now();
    const result = await handler({ project_slug: "test-project", query: "deadline pattern" });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/prism_search deadline exceeded/);
    expect(data.project).toBe("test-project");
    expect(data.query).toBe("deadline pattern");
  });
});

describe("brief-444 — prism_status wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when the doc probes hang (single project)", async () => {
    mockFetchFile.mockImplementation(HANGING as never);
    mockFileExists.mockImplementation(HANGING as never);
    mockListDirectory.mockImplementation(HANGING as never); // SRV-70: existence/size now via listing
    const handler = captureHandler(registerStatus, "prism_status");

    const t0 = Date.now();
    const result = await handler({ project_slug: "test-project" });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/prism_status deadline exceeded/);
    expect(data.project).toBe("test-project");
  });

  it("returns a structured deadline-exceeded response when repo discovery hangs (multi project)", async () => {
    mockListRepos.mockImplementation(HANGING as never);
    const handler = captureHandler(registerStatus, "prism_status");

    const t0 = Date.now();
    const result = await handler({});
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/prism_status deadline exceeded/);
    expect(data.project).toBe("all");
  });
});

describe("brief-444 — prism_fetch wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when the file fetch hangs", async () => {
    mockFetchFile.mockImplementation(HANGING as never);
    const handler = captureHandler(registerFetch, "prism_fetch");

    const t0 = Date.now();
    const result = await handler({ project_slug: "test-project", files: ["notes/big.md"] });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/prism_fetch deadline exceeded/);
    expect(data.project).toBe("test-project");
  });

  it("does NOT trip the deadline when the fetch completes quickly", async () => {
    mockFetchFile.mockResolvedValue({ content: "# Small\n", sha: "s", size: 8 });
    const handler = captureHandler(registerFetch, "prism_fetch");

    const result = await handler({ project_slug: "test-project", files: ["notes/small.md"] });

    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    expect(data.error).toBeUndefined();
    expect(data.files_fetched).toBe(1);
  });

  // Suppress unused-variable lint for mocks reserved by the shared factory.
  void mockListDirectory;
  void mockListCommits;
});
