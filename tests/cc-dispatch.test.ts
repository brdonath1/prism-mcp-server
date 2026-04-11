// brief-104 B.4: cc_dispatch tests
//
// The dispatch tool orchestrates clone → Agent SDK → commit/push/PR →
// persist. All external dependencies are mocked so the tests run in
// milliseconds with no network, no git, and no SDK subprocess.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Agent SDK wrapper and the repo helpers at the module level.
vi.mock("../src/claude-code/client.js", () => ({
  dispatchTask: vi.fn(),
}));

vi.mock("../src/claude-code/repo.js", () => ({
  cloneRepo: vi.fn(),
  commitAndPushBranch: vi.fn(),
}));

// Mock the cc-status module's persistence helpers — cc_dispatch writes
// records there, but we don't need real GitHub pushes for unit tests.
vi.mock("../src/tools/cc-status.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/tools/cc-status.js")
  >("../src/tools/cc-status.js");
  return {
    ...actual,
    writeDispatchRecord: vi.fn().mockResolvedValue(undefined),
    readDispatchRecord: vi.fn().mockResolvedValue(null),
  };
});

// Mock global fetch so createPullRequest() (inlined in cc-dispatch) doesn't
// try to hit github.com.
const originalFetch = globalThis.fetch;

import { dispatchTask } from "../src/claude-code/client.js";
import {
  cloneRepo,
  commitAndPushBranch,
} from "../src/claude-code/repo.js";
import { writeDispatchRecord } from "../src/tools/cc-status.js";
import { registerCCDispatch } from "../src/tools/cc-dispatch.js";

const mockDispatchTask = vi.mocked(dispatchTask);
const mockCloneRepo = vi.mocked(cloneRepo);
const mockCommitAndPushBranch = vi.mocked(commitAndPushBranch);
const mockWriteRecord = vi.mocked(writeDispatchRecord);

function createServerStub() {
  const handlers: Record<string, Function> = {};
  return {
    server: {
      tool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: Function,
      ) {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default clone: returns a synthetic workdir + no-op cleanup.
  mockCloneRepo.mockResolvedValue({
    path: "/tmp/cc-test-workdir",
    branch: "main",
    cleanup: vi.fn().mockResolvedValue(undefined),
  });

  // Default commit+push: one file changed, fresh SHA.
  mockCommitAndPushBranch.mockResolvedValue({
    branch: "cc-dispatch/test",
    sha: "deadbeef",
    filesChanged: 1,
  });

  // Stub global fetch so execute-mode PR creation doesn't call the network.
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      html_url: "https://github.com/brdonath1/mock-repo/pull/42",
      number: 42,
    }),
    text: async () => "",
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cc_dispatch — synchronous query mode", () => {
  it("clones, runs dispatchTask, and returns results inline", async () => {
    mockDispatchTask.mockResolvedValue({
      success: true,
      result: "Found 3 TODO markers.",
      turns: 7,
      usage: { input_tokens: 1200, output_tokens: 420 },
      cost_usd: 0.015,
      duration_ms: 3_200,
    });

    const { server, handlers } = createServerStub();
    registerCCDispatch(server as any);

    const response = await handlers.cc_dispatch({
      repo: "platformforge-v2",
      prompt: "Find TODO markers",
      branch: "main",
      mode: "query",
      async_mode: false,
    });

    expect(response.isError).toBeUndefined();
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.result).toBe("Found 3 TODO markers.");
    expect(parsed.turns).toBe(7);
    expect(parsed.pr_url).toBeNull();

    // Query mode uses the read-only tool list.
    const sdkArgs = mockDispatchTask.mock.calls[0][0];
    expect(sdkArgs.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(sdkArgs.workingDirectory).toBe("/tmp/cc-test-workdir");

    // Both initial + final records were persisted.
    expect(mockWriteRecord).toHaveBeenCalledTimes(2);
    expect(mockWriteRecord.mock.calls[0][0].status).toBe("running");
    expect(mockWriteRecord.mock.calls[1][0].status).toBe("completed");

    // Execute-mode plumbing must NOT run in query mode.
    expect(mockCommitAndPushBranch).not.toHaveBeenCalled();
  });

  it("marks status=failed when the Agent SDK returns an error", async () => {
    mockDispatchTask.mockResolvedValue({
      success: false,
      result: "",
      turns: 2,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost_usd: 0.001,
      duration_ms: 500,
      error: "rate_limit",
    });

    const { server, handlers } = createServerStub();
    registerCCDispatch(server as any);

    const response = await handlers.cc_dispatch({
      repo: "platformforge-v2",
      prompt: "x",
      branch: "main",
      mode: "query",
      async_mode: false,
    });

    expect(response.isError).toBe(true);
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("rate_limit");
  });
});

describe("cc_dispatch — execute mode", () => {
  it("commits, pushes, and opens a PR on success", async () => {
    mockDispatchTask.mockResolvedValue({
      success: true,
      result: "Refactored handler.",
      turns: 11,
      usage: { input_tokens: 5000, output_tokens: 1200 },
      cost_usd: 0.08,
      duration_ms: 12_000,
    });

    const { server, handlers } = createServerStub();
    registerCCDispatch(server as any);

    const response = await handlers.cc_dispatch({
      repo: "prism-mcp-server",
      prompt: "Refactor the logger to use structured output",
      branch: "main",
      mode: "execute",
      async_mode: false,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.pr_url).toBe(
      "https://github.com/brdonath1/mock-repo/pull/42",
    );

    // Execute mode expands the tool allowlist.
    const sdkArgs = mockDispatchTask.mock.calls[0][0];
    expect(sdkArgs.allowedTools).toContain("Write");
    expect(sdkArgs.allowedTools).toContain("Bash");

    expect(mockCommitAndPushBranch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // createPullRequest
  });

  it("skips PR creation when the agent made no file changes", async () => {
    mockDispatchTask.mockResolvedValue({
      success: true,
      result: "Nothing to change.",
      turns: 3,
      usage: { input_tokens: 200, output_tokens: 100 },
      cost_usd: 0.002,
      duration_ms: 800,
    });
    mockCommitAndPushBranch.mockResolvedValueOnce({
      branch: "cc-dispatch/test",
      sha: "",
      filesChanged: 0,
    });

    const { server, handlers } = createServerStub();
    registerCCDispatch(server as any);

    const response = await handlers.cc_dispatch({
      repo: "prism-mcp-server",
      prompt: "Check for TODOs (no changes expected)",
      branch: "main",
      mode: "execute",
      async_mode: false,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("completed");
    expect(parsed.pr_url).toBeNull();
    // No PR API call when nothing changed.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("cc_dispatch — async mode", () => {
  it("returns immediately with status=running and a dispatch_id", async () => {
    // Never-resolving promise — simulates a long-running agent. We should
    // not await it in async mode.
    mockDispatchTask.mockImplementation(
      () => new Promise(() => {}) as any,
    );

    const { server, handlers } = createServerStub();
    registerCCDispatch(server as any);

    const response = await handlers.cc_dispatch({
      repo: "platformforge-v2",
      prompt: "Big investigation",
      branch: "main",
      mode: "query",
      async_mode: true,
    });

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("running");
    expect(parsed.dispatch_id).toMatch(/^cc-\d+-[0-9a-f]+$/);
    expect(parsed.result).toBeNull();

    // Exactly one record persisted so far (the initial "running" one) —
    // the final record writes asynchronously in the never-resolving promise.
    expect(mockWriteRecord).toHaveBeenCalledTimes(1);
    expect(mockWriteRecord.mock.calls[0][0].status).toBe("running");
  });
});
