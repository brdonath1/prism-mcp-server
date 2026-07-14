import { describe, expect, it, vi } from "vitest";
import { synthesizeViaProvider } from "../provider-adapters.js";
import type { RouteDecision } from "../route-types.js";

function decision(overrides: Partial<RouteDecision>): RouteDecision {
  return {
    surface: "synthesis_brief",
    taskClass: "synthesis-brief",
    provider: "openai",
    model: "gpt-5.5",
    transport: "openai_responses",
    authEnvVar: "OPENAI_API_KEY",
    reasoningSetting: null,
    qualityTier: "frontier",
    liveInvocationAllowed: true,
    fallbackChain: ["openai", "anthropic"],
    reason: "live-provider-route",
    ...overrides,
  };
}

describe("provider adapters", () => {
  it("calls the OpenAI Responses API and parses text/tokens without exposing the key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: "live openai text",
      usage: { input_tokens: 11, output_tokens: 7 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({ provider: "openai", transport: "openai_responses" }),
      systemPrompt: "system instructions",
      userContent: "user input",
      maxTokens: 123,
      timeoutMs: 1000,
      env: { OPENAI_API_KEY: "openai-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "live openai text",
      input_tokens: 11,
      output_tokens: 7,
      model: "gpt-5.5",
      transport: "openai_responses",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers.Authorization).toBe("Bearer openai-test-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "system instructions" },
        { role: "user", content: "user input" },
      ],
      max_output_tokens: 123,
    });
    expect(JSON.stringify(outcome)).not.toContain("openai-test-secret");
  });

  it("treats incomplete Responses API output as a provider failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: "partial text",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 11, output_tokens: 7 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({ provider: "openai", transport: "openai_responses" }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { OPENAI_API_KEY: "openai-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "provider response incomplete (status=incomplete, reason=max_output_tokens)",
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("calls OpenAI-compatible chat providers for DeepSeek and parses the first message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "deepseek text" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 17, completion_tokens: 9 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        transport: "openai_compatible_chat",
        authEnvVar: "DEEPSEEK_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { DEEPSEEK_API_KEY: "deepseek-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "deepseek text",
      input_tokens: 17,
      output_tokens: 9,
      model: "deepseek-v4-pro",
      transport: "openai_compatible_chat",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "system instructions" },
        { role: "user", content: "user input" },
      ],
    });
  });

  it("treats OpenAI-compatible length finishes as provider failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "partial text" }, finish_reason: "length" }],
      usage: { prompt_tokens: 17, completion_tokens: 9 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        transport: "openai_compatible_chat",
        authEnvVar: "DEEPSEEK_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { DEEPSEEK_API_KEY: "deepseek-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "provider response did not stop cleanly (length)",
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("classifies provider AbortError exceptions as TIMEOUT", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    const outcome = await synthesizeViaProvider({
      decision: decision({ provider: "openai", transport: "openai_responses" }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { OPENAI_API_KEY: "openai-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: false,
      error_code: "TIMEOUT",
    });
  });

  it("calls Perplexity through its OpenAI-compatible chat endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "perplexity text" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 13, completion_tokens: 5 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "perplexity",
        model: "sonar-pro",
        transport: "openai_compatible_chat",
        authEnvVar: "PERPLEXITY_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { PERPLEXITY_API_KEY: "perplexity-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "perplexity text",
      input_tokens: 13,
      output_tokens: 5,
      model: "sonar-pro",
      transport: "openai_compatible_chat",
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.perplexity.ai/chat/completions");
  });

  it("calls the xAI Responses API and parses response text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        content: [{ type: "output_text", text: "xai text" }],
      }],
      usage: { input_tokens: 23, output_tokens: 11 },
      status: "completed",
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "xai",
        model: "grok-4.3",
        transport: "xai_responses",
        authEnvVar: "XAI_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { XAI_API_KEY: "xai-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "xai text",
      input_tokens: 23,
      output_tokens: 11,
      model: "grok-4.3",
      transport: "xai_responses",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "grok-4.3",
      store: false,
    });
  });

  it("calls Gemini generateContent and parses candidate parts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "gemini text" }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 8 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "gemini",
        model: "gemini-3.1-pro-preview",
        transport: "gemini_generate_content",
        authEnvVar: "GEMINI_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      maxTokens: 456,
      env: { GEMINI_API_KEY: "gemini-test-secret" },
      fetchImpl,
    });

    expect(outcome).toMatchObject({
      success: true,
      content: "gemini text",
      input_tokens: 19,
      output_tokens: 8,
      model: "gemini-3.1-pro-preview",
      transport: "gemini_generate_content",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(init.headers["x-goog-api-key"]).toBe("gemini-test-secret");
    expect(JSON.parse(init.body)).toMatchObject({
      systemInstruction: { parts: [{ text: "system instructions" }] },
      contents: [{ role: "user", parts: [{ text: "user input" }] }],
      generationConfig: { maxOutputTokens: 456 },
    });
  });

  it("treats Gemini MAX_TOKENS finishes as provider failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "partial gemini text" }] },
        finishReason: "MAX_TOKENS",
      }],
      usageMetadata: { promptTokenCount: 19, candidatesTokenCount: 8 },
    }), { status: 200 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({
        provider: "gemini",
        model: "gemini-3.1-pro-preview",
        transport: "gemini_generate_content",
        authEnvVar: "GEMINI_API_KEY",
      }),
      systemPrompt: "system instructions",
      userContent: "user input",
      env: { GEMINI_API_KEY: "gemini-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "provider response did not stop cleanly (MAX_TOKENS)",
      error_code: "API_ERROR",
      failure_class: "validation",
    });
  });

  it("returns DISABLED when the selected provider key is absent", async () => {
    const fetchImpl = vi.fn();

    const outcome = await synthesizeViaProvider({
      decision: decision({ authEnvVar: "OPENAI_API_KEY" }),
      systemPrompt: "system",
      userContent: "user",
      env: {},
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "OPENAI_API_KEY not configured",
      error_code: "DISABLED",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes provider errors before returning them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "bad auth openai-test-secret" },
    }), { status: 401 }));

    const outcome = await synthesizeViaProvider({
      decision: decision({ authEnvVar: "OPENAI_API_KEY" }),
      systemPrompt: "system",
      userContent: "user",
      env: { OPENAI_API_KEY: "openai-test-secret" },
      fetchImpl,
    });

    expect(outcome).toEqual({
      success: false,
      error: "provider HTTP 401",
      error_code: "AUTH",
      failure_class: "http",
    });
    expect(JSON.stringify(outcome)).not.toContain("openai-test-secret");
    expect(JSON.stringify(outcome)).not.toContain("bad auth");
  });
});
