/**
 * S41 C5 — finalize draft phase timeout + deadline + no-retry.
 *
 * Three tests:
 *   1. draftPhase passes FINALIZE_DRAFT_TIMEOUT_MS and maxRetries=0 to synthesize().
 *   2. synthesize() forwards maxRetries to Anthropic SDK when provided, omits it otherwise.
 *   3. draft-action deadline wrapper returns a structured timeout error on expiry.
 *
 * Each test uses `vi.resetModules()` + dynamic import so per-test env vars
 * (FINALIZE_DRAFT_TIMEOUT_MS, FINALIZE_DRAFT_DEADLINE_MS) take effect inside
 * the freshly-loaded config module.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function buildMockExtra(requestId: string) {
  return {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId,
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
}

describe("S41 C5 — finalize draft timeout + deadline + no-retry", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.FINALIZE_DRAFT_TIMEOUT_MS = process.env.FINALIZE_DRAFT_TIMEOUT_MS;
    savedEnv.FINALIZE_DRAFT_DEADLINE_MS = process.env.FINALIZE_DRAFT_DEADLINE_MS;
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    for (const key of [
      "FINALIZE_DRAFT_TIMEOUT_MS",
      "FINALIZE_DRAFT_DEADLINE_MS",
      "ANTHROPIC_API_KEY",
    ]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.resetModules();
    vi.doUnmock("../src/ai/client.js");
    vi.doUnmock("../src/github/client.js");
    vi.doUnmock("../src/utils/doc-resolver.js");
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("draftPhase passes FINALIZE_DRAFT_TIMEOUT_MS and maxRetries=0 to synthesize()", async () => {
    process.env.FINALIZE_DRAFT_TIMEOUT_MS = "5000";
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();

    const synthesizeSpy = vi.fn().mockResolvedValue({
      success: true,
      content: '{"drafts": []}',
      input_tokens: 100,
      output_tokens: 200,
      model: "claude-opus-4-7",
    });

    vi.doMock("../src/ai/client.js", () => ({
      synthesize: synthesizeSpy,
    }));

    vi.doMock("../src/github/client.js", () => ({
      fetchFile: vi.fn(),
      fetchFiles: vi.fn(),
      pushFile: vi.fn(),
      pushFiles: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([]),
      listCommits: vi.fn().mockResolvedValue([]),
      getCommit: vi.fn(),
      deleteFile: vi.fn(),
      fileExists: vi.fn(),
      createAtomicCommit: vi.fn(),
      getHeadSha: vi.fn(),
      getDefaultBranch: vi.fn(),
    }));

    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocPath: vi.fn(),
      resolveDocPushPath: vi.fn(),
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: "stub handoff body", sha: "h", size: 18 }],
          ["session-log.md", { content: "stub session log", sha: "s", size: 16 }],
        ]),
      ),
    }));

    const { registerFinalize } = await import("../src/tools/finalize.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];
    await tool.handler(
      { project_slug: "test-project", action: "draft", session_number: 1 },
      buildMockExtra("test-draft-timeout-1"),
    );

    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    const callArgs = synthesizeSpy.mock.calls[0];
    // synthesize(systemPrompt, userContent, maxTokens, timeoutMs, maxRetries, thinking)
    expect(callArgs[2]).toBe(4096);
    expect(callArgs[3]).toBe(5000);
    expect(callArgs[4]).toBe(0);
    // Phase 3b: draft (CS-1) enables adaptive thinking. Flag flipped after
    // the benchmark in briefs/results/phase-3b-benchmark.md confirmed safety
    // of the 150s draft budget (D-159 successor).
    expect(callArgs[5]).toBe(true);
  });

  it("synthesize() forwards maxRetries to Anthropic SDK when provided, omits it otherwise", async () => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();

    const capturedOptions: Array<Record<string, unknown>> = [];
    const createSpy = vi.fn().mockImplementation((_payload: unknown, options: Record<string, unknown>) => {
      capturedOptions.push(options);
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });

    const { synthesize } = await import("../src/ai/client.js");

    await synthesize("sys", "user", 100, 10_000, 0);
    expect(capturedOptions[0]).toHaveProperty("maxRetries", 0);
    expect(capturedOptions[0]).toHaveProperty("timeout", 10_000);

    await synthesize("sys", "user", 100, 10_000);
    expect(capturedOptions[1]).not.toHaveProperty("maxRetries");
    expect(capturedOptions[1]).toHaveProperty("timeout", 10_000);
  });

  it("draft-action deadline wrapper returns structured timeout error on expiry", async () => {
    process.env.FINALIZE_DRAFT_DEADLINE_MS = "50";
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();

    // Make synthesize hang so draftPhase never resolves within the deadline.
    vi.doMock("../src/ai/client.js", () => ({
      synthesize: vi.fn().mockImplementation(() => new Promise(() => { /* hang */ })),
    }));

    vi.doMock("../src/github/client.js", () => ({
      fetchFile: vi.fn(),
      fetchFiles: vi.fn(),
      pushFile: vi.fn(),
      pushFiles: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([]),
      listCommits: vi.fn().mockResolvedValue([]),
      getCommit: vi.fn(),
      deleteFile: vi.fn(),
      fileExists: vi.fn(),
      createAtomicCommit: vi.fn(),
      getHeadSha: vi.fn(),
      getDefaultBranch: vi.fn(),
    }));

    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocPath: vi.fn(),
      resolveDocPushPath: vi.fn(),
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: "stub", sha: "h", size: 4 }],
        ]),
      ),
    }));

    const { registerFinalize } = await import("../src/tools/finalize.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];

    const t0 = Date.now();
    const result = (await tool.handler(
      { project_slug: "test-project", action: "draft", session_number: 1 },
      buildMockExtra("test-draft-deadline"),
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toMatch(/draft deadline exceeded/);
    expect(data.action).toBe("draft");
    expect(data.project).toBe("test-project");
    expect(data.fallback).toMatch(/manually/i);
  });
});
