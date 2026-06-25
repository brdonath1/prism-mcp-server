process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "test-dummy-oauth-token";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.query,
}));

vi.mock("node:child_process", () => ({
  execSync: mocks.execSync,
}));

import { CC_DISPATCH_MODEL } from "../src/config.js";
import { dispatchTask } from "../src/claude-code/client.js";

const ENV_KEYS_TO_RESET = [
  "LLM_ROUTING_ENABLED",
  "LLM_ROUTING_DRY_RUN",
  "LLM_ROUTING_DEFAULT_PROVIDER",
  "LLM_ROUTING_CC_DISPATCH_PROVIDER",
  "OPENAI_API_KEY",
];

async function* successfulQuery() {
  yield {
    type: "result",
    subtype: "success",
    result: "ok",
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.01,
  };
}

describe("dispatchTask route observation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
    mocks.execSync.mockReturnValue("/tmp/claude\n");
    mocks.query.mockReturnValue(successfulQuery());
  });

  afterEach(() => {
    for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
  });

  it("logs the dormant cc_dispatch route without changing model or leaking provider credentials", async () => {
    process.env.LLM_ROUTING_ENABLED = "true";
    process.env.LLM_ROUTING_DRY_RUN = "true";
    process.env.LLM_ROUTING_DEFAULT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "openai-test-secret-should-not-log";
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const result = await dispatchTask({
        prompt: "Inspect routing",
        workingDirectory: "/tmp/work",
        allowedTools: ["Read"],
        maxTurns: 1,
      });

      expect(result.success).toBe(true);
      expect(mocks.query).toHaveBeenCalledTimes(1);
      const queryArgs = mocks.query.mock.calls[0][0];
      expect(queryArgs.options.model).toBe(CC_DISPATCH_MODEL);
      expect(queryArgs.options.env.OPENAI_API_KEY).toBeUndefined();

      const routeLogs = stdoutSpy.mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((entry) => entry.msg === "LLM_ROUTE_OBSERVATION");
      expect(routeLogs).toHaveLength(1);
      expect(routeLogs[0]).toMatchObject({
        surface: "cc_dispatch",
        provider: "anthropic",
        transport: "claude_code_oauth",
        authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
        liveInvocationAllowed: false,
        reason: "activation-not-authorized",
      });
      expect(JSON.stringify(routeLogs)).not.toContain("openai-test-secret-should-not-log");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
