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
 *
 * Added 2026-08-14 (brief-s205a, S203 F-G-A11 — the registry configures these
 * two providers but the table priced neither, so any call they served logged
 * est_cost_usd: null). F-G-A11 names the GAP, not the numbers; these are
 * gpt-5.5-style UNVERIFIED estimates in the same list-price class the rows
 * above use, NOT vendor-console-confirmed figures. Re-derive from each
 * provider's price page before using them for a budget decision:
 *  - DeepSeek deepseek-v4-pro: UNVERIFIED midpoint $0.65/$2.15 (assumed range
 *    $0.30–1.00 / $1.10–3.20). Cheap-tier class, consistent with
 *    d275-audit-design §3.5's classification of DeepSeek as the genuinely
 *    cheap lane. Never reachable in prod today (double-gated — no surface
 *    selects it, absent from LLM_ROUTING_ALLOWED_PROVIDERS).
 *  - Perplexity sonar-pro: UNVERIFIED $3.00/$15.00 TOKEN pricing. Sonar also
 *    bills PER-REQUEST search fees that a per-token table cannot model, so
 *    this row is a FLOOR — a served sonar call costs at least this, plausibly
 *    more. Same double gate as deepseek in prod today.
 *
 * Added 2026-08-16 (S208 Cerebras registration) for the three models the
 * operator's Cerebras account actually serves (verified live against
 * https://api.cerebras.ai/v1/models). Same UNVERIFIED class as the F-G-A11
 * rows above -- conservative midpoints in the cheap/high-throughput tier,
 * NOT vendor-console-confirmed figures, and deliberately round rather than
 * falsely precise. Re-derive from the Cerebras price page before using them
 * for a budget decision. All three carry the same double gate as deepseek:
 * no surface selects cerebras, and cerebras is absent from
 * LLM_ROUTING_ALLOWED_PROVIDERS, so none is reachable in prod today.
 *  - zai-glm-4.7: UNVERIFIED midpoint $0.60/$2.20 (assumed range
 *    $0.35-0.90 / $1.40-3.00). GLM-class, priced just under the S196-pinned
 *    GLM-5.2 marketplace midpoints ($1.15/$3.70) it succeeds in the
 *    mechanical lane.
 *  - gpt-oss-120b: UNVERIFIED midpoint $0.35/$0.75 (assumed range
 *    $0.15-0.55 / $0.40-1.20). Open-weights MoE, cheap-tier class.
 *  - gemma-4-31b: UNVERIFIED midpoint $0.20/$0.60 (assumed range
 *    $0.10-0.35 / $0.30-1.00). Smallest of the three.
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
  // F-G-A11 (2026-08-14) — UNVERIFIED, see the header block.
  "deepseek-v4-pro": { input_per_mtok: 0.65, output_per_mtok: 2.15 },
  "sonar-pro": { input_per_mtok: 3, output_per_mtok: 15 },
  // S208 Cerebras catalog (2026-08-16) -- UNVERIFIED, see the header block.
  "zai-glm-4.7": { input_per_mtok: 0.6, output_per_mtok: 2.2 },
  "gpt-oss-120b": { input_per_mtok: 0.35, output_per_mtok: 0.75 },
  "gemma-4-31b": { input_per_mtok: 0.2, output_per_mtok: 0.6 },
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
