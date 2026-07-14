/**
 * D-275 / brief-s196c — pricing table + LLM_CALL emitter unit tests (§4.8).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitLlmCall, estimateTokensFromChars } from "../llm-call-telemetry.js";
import { estimateCostUsd } from "../pricing.js";

describe("pricing — static list-price estimates", () => {
  it("prices the D-275 models from the sourced table", () => {
    // Opus 4.8 $5/$25 per MTok.
    expect(estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBe(30);
    // GLM-5.2 midpoints $1.15/$3.70 — a typical PDU call (60K in / 3K out).
    expect(estimateCostUsd("z-ai/glm-5.2", 60_000, 3_000)).toBe(0.0801);
    // Sonnet 5 $3/$15.
    expect(estimateCostUsd("claude-sonnet-5", 100_000, 10_000)).toBe(0.45);
  });

  it("matches by model-id prefix so dated/suffixed variants price like their base", () => {
    expect(estimateCostUsd("claude-opus-4-8-20260115", 1_000_000, 0)).toBe(5);
    expect(estimateCostUsd("gemini-3.1-pro-preview", 1_000_000, 0)).toBe(3);
  });

  it("returns null for unpriced models instead of inventing a number", () => {
    expect(estimateCostUsd("grok-4.3", 1_000, 1_000)).toBeNull();
    expect(estimateCostUsd("some-unknown-model", 1_000, 1_000)).toBeNull();
  });
});

describe("estimateTokensFromChars — the labeled chars/3.5 fallback", () => {
  it("rounds up at the chars/3.5 ratio", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(7)).toBe(2);
    expect(estimateTokensFromChars(35)).toBe(10);
    expect(estimateTokensFromChars(36)).toBe(11);
  });
});

describe("emitLlmCall — one structured line, cost-source resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Minimal structural view of the stdout write spy — vi.spyOn's overloaded
   *  MockInstance type doesn't unify with the generic ReturnType form. */
  interface StdoutSpyLike {
    mock: { calls: unknown[][] };
  }

  function lastLlmCall(spy: StdoutSpyLike): Record<string, unknown> {
    const lines = spy.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((entry) => entry.msg === "LLM_CALL");
    expect(lines.length).toBeGreaterThan(0);
    return lines[lines.length - 1];
  }

  it("prefers the provider-measured cost (cost_source=provider_usage)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitLlmCall({
      call_site: "synthesis_pdu",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      success: true,
      input_tokens: 60_000,
      output_tokens: 3_000,
      token_source: "usage",
      measured_cost_usd: 0.000456,
      latency_ms: 1234,
      fallback_used: false,
      fallback_reason: null,
      project_slug: "prism",
    });
    expect(lastLlmCall(spy)).toMatchObject({
      level: "info",
      call_site: "synthesis_pdu",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      est_cost_usd: 0.000456,
      cost_source: "provider_usage",
      latency_ms: 1234,
      projectSlug: "prism",
    });
  });

  it("falls back to the price table (cost_source=price_table_estimate)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitLlmCall({
      call_site: "synthesis_brief",
      provider: "anthropic",
      model: "claude-opus-4-8",
      transport: "messages_api",
      success: true,
      input_tokens: 100,
      output_tokens: 50,
      token_source: "usage",
      measured_cost_usd: null,
      latency_ms: 10,
      fallback_used: true,
      fallback_reason: "provider_error",
    });
    expect(lastLlmCall(spy)).toMatchObject({
      est_cost_usd: 0.00175,
      cost_source: "price_table_estimate",
      fallback_used: true,
      fallback_reason: "provider_error",
    });
  });

  it("reports unpriced models honestly (est_cost_usd=null, cost_source=unpriced)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emitLlmCall({
      call_site: "x_sentiment",
      provider: "xai",
      model: "grok-4.3",
      transport: "xai_responses",
      success: true,
      input_tokens: 200,
      output_tokens: 800,
      token_source: "usage",
      latency_ms: 900,
      fallback_used: false,
      fallback_reason: null,
    });
    expect(lastLlmCall(spy)).toMatchObject({
      est_cost_usd: null,
      cost_source: "unpriced",
    });
  });
});
