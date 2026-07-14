/**
 * Static LLM list-price table — the single pricing config module for the
 * LLM_CALL telemetry line (D-275 / brief-s196c, design doc §4.8).
 *
 * Used ONLY when a provider does not return a measured cost (OpenRouter
 * returns `usage.cost` when asked; the Agent SDK reports `total_cost_usd`).
 * Every number here is a LIST-PRICE ESTIMATE — authoritative dollars live in
 * each provider's billing console (INS-241).
 *
 * Source + date (docs/cost-rearchitecture/d275-audit-design.md §3
 * assumption 3, compiled 2026-07-13):
 *  - Anthropic: list prices cached 2026-06-24 (Opus 4.8 $5/$25,
 *    Sonnet 5 $3/$15, Haiku 4.5 $1/$5).
 *  - OpenAI gpt-5.5: audit assumption midpoint $1.75/$15 (UNVERIFIED range
 *    $1.25–2.50 / $10–20).
 *  - Gemini 3.1 Pro: audit assumption midpoint $3/$15 (UNVERIFIED range
 *    $2–4 / $12–18).
 *  - GLM-5.2 via OpenRouter: S196-pinned marketplace midpoints $1.15/$3.70
 *    (range $0.93–1.40 / $3.00–4.40; per-call telemetry uses the measured
 *    usage.cost instead whenever OpenRouter returns it).
 * Models without a sourced price (e.g. grok-4.3) intentionally have NO entry:
 * estimateCostUsd returns null rather than inventing a number.
 */

interface ModelPrice {
  /** USD per million input tokens. */
  input_per_mtok: number;
  /** USD per million output tokens. */
  output_per_mtok: number;
}

/**
 * Keyed by model-id prefix (longest match wins) so dated/suffixed variants
 * ("claude-opus-4-8-20260115", "gemini-3.1-pro-preview") price like their
 * base model.
 */
const MODEL_PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input_per_mtok: 5, output_per_mtok: 25 },
  "claude-sonnet-5": { input_per_mtok: 3, output_per_mtok: 15 },
  "claude-haiku-4-5": { input_per_mtok: 1, output_per_mtok: 5 },
  "gpt-5.5": { input_per_mtok: 1.75, output_per_mtok: 15 },
  "gemini-3.1-pro": { input_per_mtok: 3, output_per_mtok: 15 },
  "z-ai/glm-5.2": { input_per_mtok: 1.15, output_per_mtok: 3.7 },
};

/**
 * Estimate the USD cost of a call from the static table. Returns null when
 * the model has no sourced price — the LLM_CALL line then carries
 * est_cost_usd: null with cost_source "unpriced" instead of a fabricated
 * number.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const normalized = model.trim().toLowerCase();
  let match: ModelPrice | null = null;
  let matchLength = 0;
  for (const [prefix, price] of Object.entries(MODEL_PRICE_TABLE)) {
    if (normalized.startsWith(prefix) && prefix.length > matchLength) {
      match = price;
      matchLength = prefix.length;
    }
  }
  if (!match) return null;
  const cost =
    (inputTokens / 1_000_000) * match.input_per_mtok +
    (outputTokens / 1_000_000) * match.output_per_mtok;
  // Round to 6 decimals — sub-microdollar noise is meaningless in logs.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
