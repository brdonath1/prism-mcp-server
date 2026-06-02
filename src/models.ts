/**
 * PRISM model registry — single source of truth for the model identifiers the
 * server pins (Phase 1 / D-235, S143).
 *
 * Two consumers read from here:
 *  - src/utils/session-classifier.ts — the operator-facing model RECOMMENDATION
 *    shown in the boot / finalize banner (RECOMMENDATION_MODELS).
 *  - src/config.ts — the model the server itself CALLS for background
 *    synthesis (SYNTHESIS_MODEL_ID).
 *
 * Why a registry: before S143 these strings were hard-coded across the
 * classifier (display table + model table + the RecommendedModel union) and
 * config.ts. A model release required edits in several places, and the
 * RecommendedModel union silently drifted from the tables — the S143 bug was
 * exactly this: the union topped out at "opus-4-7" so the classifier could not
 * emit 4.8 even though Opus 4.8 was the current top model. Centralizing here
 * makes a model bump a one-line edit in ONE file, and RecommendedModel is
 * DERIVED from RECOMMENDATION_MODELS so the type can never drift again.
 *
 * Phase 2 (follow-up): a scheduled GitHub Action diffs the Anthropic Models
 * API against this file and opens a one-line bump PR — auto-detected,
 * human-merged. This file is the edit target for that automation.
 *
 * IMPORTANT — two distinct surfaces, do not conflate:
 *  - RECOMMENDATION_MODELS pins what the operator should SELECT in the
 *    claude.ai app model picker. "Latest in the API" is NOT authoritative for
 *    this surface (an API key's model list is not the consumer app's picker),
 *    so these values are chosen deliberately, not auto-tracked.
 *  - SYNTHESIS_MODEL_ID pins the model the server CALLS programmatically.
 *    Bumping it carries cost + OAuth-availability gates (INS-244 / INS-245) and
 *    must stay human-reviewed even under the Phase-2 automation.
 */

/**
 * Recommendation model per session category (consumed by session-classifier).
 *  - `code`    : short identifier carried in the recommendation object's
 *                `model` field (used by core-template Rule 9 model-awareness).
 *  - `display` : human label shown in the banner (model portion only; the
 *                thinking portion is appended by the classifier).
 *
 * The thinking setting is intentionally NOT here — it is workload-driven, not
 * model-driven, and lives in session-classifier's THINKING_BY_CATEGORY.
 *
 * `as const` (no Record annotation) is required so the `code` literals survive
 * into the derived RecommendedModel union rather than widening to `string`.
 */
export const RECOMMENDATION_MODELS = {
  reasoning_heavy: { code: "opus-4-8", display: "Opus 4.8" },
  mixed: { code: "opus-4-8", display: "Opus 4.8" },
  executional: { code: "sonnet-4-6", display: "Sonnet 4.6" },
} as const;

/**
 * Model the server calls for background synthesis (intelligence-brief +
 * pending-doc-updates). This is an API model id. Overridable per deployment
 * via the SYNTHESIS_MODEL env var (see config.ts). UNCHANGED at S143
 * ("claude-opus-4-7") — centralization only; any bump is gated by
 * INS-244 / INS-245 (OAuth-surface availability + cost).
 */
export const SYNTHESIS_MODEL_ID = "claude-opus-4-8";
