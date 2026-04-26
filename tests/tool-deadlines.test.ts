/**
 * S40 C4 — Tool-level wall-clock deadlines on prism_push and prism_finalize
 * commit phase.
 *
 * We override the deadline constants via vi.mock so the tests can exercise
 * the deadline path in ~seconds rather than waiting 60s / 90s.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Override the deadlines to very small values for the test suite. Must be
// declared BEFORE importing any module that reads these constants.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    PUSH_WALL_CLOCK_DEADLINE_MS: 400,
    FINALIZE_COMMIT_DEADLINE_MS: 400,
    SYNTHESIS_ENABLED: false,
  };
});

// Mock GitHub client. createAtomicCommit is the primary hang point — we
// return a promise that never resolves within the deadline window.
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
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

import {
  createAtomicCommit,
  getHeadSha,
  pushFile,
  fileExists,
  fetchFile,
  fetchFiles,
  listCommits,
} from "../src/github/client.js";
import { registerPush } from "../src/tools/push.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockListCommits = vi.mocked(listCommits);

beforeEach(() => {
  vi.clearAllMocks();
  mockFileExists.mockResolvedValue(false);
  mockGetHeadSha.mockResolvedValue("HEAD_BEFORE");
});

async function callPushTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerPush(server);
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_push"];
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-push-deadline",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(args, mockExtra)) as any;
}

async function callFinalizeTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_finalize"];
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-finalize-deadline",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(args, mockExtra)) as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe("S40 C4 — prism_push wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when atomic commit hangs", async () => {
    // Simulate a hanging GitHub call: never resolves within the window.
    mockCreateAtomicCommit.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const t0 = Date.now();
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nContent\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });
    const elapsed = Date.now() - t0;

    // Deadline is 400ms; allow generous slack for CI.
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);

    const data = parseResult(result);
    expect(result.isError).toBe(true);
    expect(data.error).toMatch(/prism_push deadline exceeded/);
    expect(data.partial_state_warning).toMatch(/verify repo state manually/i);
    expect(data.project).toBe("test-project");
  });

  it("does NOT trip the deadline when the work completes quickly", async () => {
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "fast_sha",
      files_committed: 1,
    });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nContent\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(result.isError).not.toBe(true);
    expect(data.all_succeeded).toBe(true);
    expect(data.commit_sha).toBe("fast_sha");
    expect(data.error).toBeUndefined();
    expect(data.partial_state_warning).toBeUndefined();
  });
});

describe("S40 C4 — prism_finalize commit-phase wall-clock deadline", () => {
  it("returns a structured deadline-exceeded response when commit hangs", async () => {
    // Make the backup pushFile resolve so we get to the atomic commit step,
    // then atomic hangs. For brevity, just make atomic hang directly.
    mockPushFile.mockResolvedValue({ success: true, size: 10, sha: "backup_sha" });
    mockFetchFile.mockResolvedValue({ content: "stub", sha: "x", size: 4 });
    mockFetchFiles.mockResolvedValue(
      new Map([
        [
          "handoff.md",
          {
            content:
              "## Meta\n- Handoff Version: 1\n- Session Count: 1\n- Template Version: v2.9.0\n- Status: Active\n\n## Critical Context\n1. test\n\n## Where We Are\nhere\n<!-- EOF: handoff.md -->",
            sha: "h1",
            size: 120,
          },
        ],
      ]),
    );
    mockListCommits.mockResolvedValue([]);
    mockCreateAtomicCommit.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    );

    const t0 = Date.now();
    const result = await callFinalizeTool({
      project_slug: "test-project",
      action: "commit",
      session_number: 1,
      handoff_version: 2,
      files: [
        {
          path: "handoff.md",
          content:
            "## Meta\n- Handoff Version: 2\n- Session Count: 2\n- Template Version: v2.9.0\n- Status: Active\n\n## Critical Context\n1. test\n\n## Where We Are\nnext\n<!-- EOF: handoff.md -->",
          message: "prism: finalize session 1",
        },
      ],
      skip_synthesis: true,
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(3_000);

    const data = parseResult(result);
    expect(result.isError).toBe(true);
    expect(data.error).toMatch(/prism_finalize commit deadline exceeded/);
    expect(data.partial_state_warning).toMatch(/verify repo state manually/i);
    expect(data.action).toBe("commit");
  });
});
