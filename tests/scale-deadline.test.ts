/**
 * SRV-64 (brief-461 Task B) — prism_scale_handoff hard wall-clock deadline.
 *
 * Scale previously had only cooperative SAFETY_TIMEOUT_MS checkpoints; a hung
 * GitHub call (stage-1 fetch, stage-6 commit) had no hard backstop. This adds
 * the push.ts-style Promise.race sentinel. Mirrors read-tool-deadlines.test.ts:
 * override the deadline to ~400ms, hang the GitHub client, assert a structured
 * deadline-exceeded response with a partial-state warning.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SCALE_WALL_CLOCK_DEADLINE_MS: 400,
  };
});

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
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

import { fetchFile, getHeadSha } from "../src/github/client.js";
import { registerScaleHandoff } from "../src/tools/scale.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockGetHeadSha = vi.mocked(getHeadSha);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

function captureHandler(): Handler {
  let captured: Handler | null = null;
  const stub = {
    tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === "prism_scale_handoff") captured = handler as Handler;
    },
  } as unknown as McpServer;
  registerScaleHandoff(stub);
  if (!captured) throw new Error("prism_scale_handoff handler was not registered");
  return captured;
}

const HANGING = () => new Promise(() => { /* never resolves */ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SRV-64 — prism_scale_handoff wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response with a partial-state warning when the GitHub fetch hangs", async () => {
    mockFetchFile.mockImplementation(HANGING as never);
    mockGetHeadSha.mockImplementation(HANGING as never);
    const handler = captureHandler();

    const t0 = Date.now();
    const result = await handler({ project_slug: "test-project", action: "full" }, { _meta: {} });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toMatch(/deadline exceeded/i);
    expect(data.partial_state_warning).toBeTruthy();
    expect(data.project).toBe("test-project");
  });
});
