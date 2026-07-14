/**
 * LLM_CALL telemetry — one structured info line per LLM invocation across ALL
 * providers and transports (D-275 / brief-s196c, design doc §4.8).
 *
 * Emission points: end of synthesize() (src/ai/client.ts — every synthesis
 * transport passes through it), dispatchTask (src/claude-code/client.ts,
 * CS-5) and analyzeXSentiment (src/tools/x-sentiment.ts, CS-4).
 *
 * Field contract (the permanent activation proof — grep `LLM_CALL` in
 * Railway logs): { call_site, provider, model, transport, input_tokens,
 * output_tokens, est_cost_usd, latency_ms, fallback_used, fallback_reason }.
 * Token counts come from provider usage when returned, otherwise a labeled
 * chars/3.5 estimate (token_source discriminates). est_cost_usd prefers the
 * provider-measured cost (OpenRouter usage.cost, Agent SDK total_cost_usd)
 * and falls back to the static price table in src/llm/pricing.ts. Never any
 * prompt/output content, credential value, or provider payload.
 */

import { logger } from "../utils/logger.js";
import { estimateCostUsd } from "./pricing.js";

/** Why the serving hop was not the resolved primary route (design §4.6). */
export type LlmFallbackReason = "validation_failed" | "provider_error" | "timeout";

export interface LlmCallTelemetry {
  /** Call-site id per the D-275 inventory (synthesis_draft, synthesis_brief,
   *  synthesis_pdu, cc_dispatch, x_sentiment). */
  call_site: string;
  provider: string;
  model: string;
  transport: string;
  success: boolean;
  /** From provider usage when available, else chars/3.5 estimates. */
  input_tokens: number;
  output_tokens: number;
  /** "usage" = provider-reported counts; "chars_estimate" = chars/3.5. */
  token_source: "usage" | "chars_estimate";
  /** Measured provider cost when the provider returned one; null otherwise. */
  measured_cost_usd?: number | null;
  latency_ms: number;
  fallback_used: boolean;
  fallback_reason: LlmFallbackReason | null;
  project_slug?: string;
}

/**
 * Estimated tokens from character count — the codebase-standard chars/3.5
 * proxy (src/config.ts SYNTHESIS_CHARS_PER_TOKEN; brief-s196c telemetry
 * contract says the fallback estimate is labeled chars/3.5).
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3.5);
}

/**
 * Emit the LLM_CALL line. Cost resolution: measured provider cost when
 * present (cost_source "provider_usage"), else the static price table
 * ("price_table_estimate"), else null ("unpriced").
 */
export function emitLlmCall(t: LlmCallTelemetry): void {
  let est_cost_usd: number | null;
  let cost_source: "provider_usage" | "price_table_estimate" | "unpriced";
  if (typeof t.measured_cost_usd === "number" && Number.isFinite(t.measured_cost_usd)) {
    est_cost_usd = t.measured_cost_usd;
    cost_source = "provider_usage";
  } else {
    est_cost_usd = estimateCostUsd(t.model, t.input_tokens, t.output_tokens);
    cost_source = est_cost_usd === null ? "unpriced" : "price_table_estimate";
  }

  logger.info("LLM_CALL", {
    call_site: t.call_site,
    provider: t.provider,
    model: t.model,
    transport: t.transport,
    success: t.success,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    token_source: t.token_source,
    est_cost_usd,
    cost_source,
    latency_ms: t.latency_ms,
    fallback_used: t.fallback_used,
    fallback_reason: t.fallback_reason,
    ...(t.project_slug ? { projectSlug: t.project_slug } : {}),
  });
}
