/**
 * D-275 / brief-s196c — openrouter adapter tests (INS-31: mocked global
 * fetch, no live network, no real keys anywhere).
 *
 * Pins the request contract: URL, method, Authorization-header PRESENCE
 * (never a value assertion beyond the injected dummy), model, payload shape
 * (usage.include / provider.data_collection / reasoning), the thinking
 * control mechanism, and the per-failure-class error taxonomy — including
 * the live-verified GLM hazard (finish_reason=length with zero answer text).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_REASONING_MIN_MAX_TOKENS,
  resolveOpenrouterReasoningParam,
} from "../openrouter.js";
import { synthesizeViaProvider } from "../provider-adapters.js";
import type { RouteDecision } from "../route-types.js";

function openrouterDecision(overrides: Partial<RouteDecision> = {}): RouteDecision {
  return {
    surface: "synthesis_pdu",
    taskClass: "synthesis-pdu",
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    transport: "openai_compatible_chat",
    authEnvVar: "OPENROUTER_API_KEY",
    reasoningSetting: "off",
    qualityTier: "mechanical-cost",
    liveInvocationAllowed: true,
    fallbackChain: ["openrouter", "anthropic"],
    reason: "live-provider-route",
    ...overrides,
  };
}

function chatResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const OK_BODY = {
  choices: [{ message: { content: "glm output text" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 41, completion_tokens: 13, cost: 0.000123 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openrouter adapter — request contract", () => {
  it("POSTs the OpenRouter chat endpoint with auth presence, model, and the D-275 payload shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(OK_BODY));

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "system instructions",
      userContent: "user input",
      maxTokens: 8192,
      timeoutMs: 1000,
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "glm output text",
      input_tokens: 41,
      output_tokens: 13,
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      stop_reason: "stop",
      cost_usd: 0.000123,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    // Authorization header PRESENCE only — never assert or log a real value.
    expect(init.headers.Authorization).toBeDefined();
    expect(init.headers.Authorization.startsWith("Bearer ")).toBe(true);
    // Attribution headers (design §4.1 defaults).
    expect(init.headers["HTTP-Referer"]).toBe("https://github.com/brdonath1/prism-mcp-server");
    expect(init.headers["X-Title"]).toBe("PRISM MCP Server");

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "z-ai/glm-5.2",
      messages: [
        { role: "system", content: "system instructions" },
        { role: "user", content: "user input" },
      ],
      max_tokens: 8192,
      stream: false,
      // D-275 §4.1 openrouter-only extensions:
      usage: { include: true },
      provider: { data_collection: "deny" },
      // §4.2 thinking control: GLM thinking OFF by default on every call.
      reasoning: { enabled: false },
    });
  });

  it("honors OPENROUTER_SITE_URL / OPENROUTER_APP_TITLE overrides for attribution headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(OK_BODY));

    await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: {
        OPENROUTER_API_KEY: "openrouter-test-secret",
        OPENROUTER_SITE_URL: "https://example.invalid/prism",
        OPENROUTER_APP_TITLE: "PRISM Staging",
      },
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["HTTP-Referer"]).toBe("https://example.invalid/prism");
    expect(init.headers["X-Title"]).toBe("PRISM Staging");
  });

  it("does not add openrouter extensions or attribution headers to other openai-compatible providers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(OK_BODY));

    await synthesizeViaProvider({
      decision: openrouterDecision({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        authEnvVar: "DEEPSEEK_API_KEY",
        qualityTier: "frontier",
      }),
      systemPrompt: "s",
      userContent: "u",
      env: { DEEPSEEK_API_KEY: "deepseek-test-secret" },
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers["HTTP-Referer"]).toBeUndefined();
    expect(init.headers["X-Title"]).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.reasoning).toBeUndefined();
    expect(body.usage).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });

  it("never leaks the key value into the outcome", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({
      error: { message: "denied for openrouter-test-secret" },
    }, 401));

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({ success: false, error_code: "AUTH", failure_class: "http" });
    expect(JSON.stringify(outcome)).not.toContain("openrouter-test-secret");
  });
});

describe("openrouter adapter — thinking control (design §4.2)", () => {
  it("sends reasoning effort when a site opts in AND the max_tokens floor is met", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(OK_BODY));

    await synthesizeViaProvider({
      decision: openrouterDecision({ surface: "synthesis_brief", taskClass: "synthesis-brief" }),
      systemPrompt: "s",
      userContent: "u",
      maxTokens: OPENROUTER_REASONING_MIN_MAX_TOKENS,
      env: {
        OPENROUTER_API_KEY: "openrouter-test-secret",
        LLM_ROUTING_OPENROUTER_REASONING_BRIEF: "low",
      },
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("forces reasoning OFF below the 16384 max_tokens floor (length-starvation guard)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse(OK_BODY));

    await synthesizeViaProvider({
      decision: openrouterDecision({ surface: "synthesis_brief", taskClass: "synthesis-brief" }),
      systemPrompt: "s",
      userContent: "u",
      maxTokens: 8192, // production brief cap — under the floor
      env: {
        OPENROUTER_API_KEY: "openrouter-test-secret",
        LLM_ROUTING_OPENROUTER_REASONING_BRIEF: "high",
      },
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it("keeps per-site reasoning envs independent and defaults unknown values to off", () => {
    const env = {
      LLM_ROUTING_OPENROUTER_REASONING_DRAFT: "medium",
      LLM_ROUTING_OPENROUTER_REASONING_PDU: "definitely-not-a-level",
    };
    expect(
      resolveOpenrouterReasoningParam("synthesis_draft", 32_768, env),
    ).toEqual({ effort: "medium" });
    expect(
      resolveOpenrouterReasoningParam("synthesis_pdu", 32_768, env),
    ).toEqual({ enabled: false });
    expect(
      resolveOpenrouterReasoningParam("synthesis_brief", 32_768, env),
    ).toEqual({ enabled: false });
  });
});

describe("openrouter adapter — failure taxonomy per class", () => {
  it("maps the live-verified GLM hazard (finish_reason=length, zero text) to a validation failure", async () => {
    // Exact shape of the S196 micro-call: all completion tokens consumed by
    // reasoning, empty content, finish_reason=length.
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({
      choices: [{ message: { content: "", reasoning: "…16 tokens of thinking…" }, finish_reason: "length" }],
      usage: { prompt_tokens: 20, completion_tokens: 16 },
    }));

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "provider response did not stop cleanly (length)",
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("maps empty choices / empty content to a validation failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatResponse({ choices: [] }));

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "z-ai/glm-5.2 returned empty text content",
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("maps malformed JSON bodies to a validation failure (unparseable → no content)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>garbage</html>", { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: false,
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("maps non-2xx to http failures with the AUTH/API_ERROR split", async () => {
    const fetch500 = vi.fn().mockResolvedValue(chatResponse({ error: "upstream" }, 500));
    const out500 = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl: fetch500,
    });
    expect(out500).toEqual({
      success: false,
      error: "provider HTTP 500",
      error_code: "API_ERROR",
      failure_class: "http",
    });

    const fetch403 = vi.fn().mockResolvedValue(chatResponse({ error: "no" }, 403));
    const out403 = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl: fetch403,
    });
    expect(out403).toMatchObject({ success: false, error_code: "AUTH", failure_class: "http" });
  });

  it("maps aborts to TIMEOUT with the timeout failure class", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: { OPENROUTER_API_KEY: "openrouter-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: false,
      error_code: "TIMEOUT",
      failure_class: "timeout",
    });
  });

  it("returns DISABLED without a network call when OPENROUTER_API_KEY is absent", async () => {
    const fetchImpl = vi.fn();

    const outcome = await synthesizeViaProvider({
      decision: openrouterDecision(),
      systemPrompt: "s",
      userContent: "u",
      env: {},
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "OPENROUTER_API_KEY not configured",
      error_code: "DISABLED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
