/**
 * PRISM model registry — single source of truth for the model identifiers the
 * server pins (Phase 1 / D-235, S143; single-switch consolidation D-254, S162).
 *
 * Three consumers read from here:
 *  - src/utils/session-classifier.ts — the operator-facing model RECOMMENDATION
 *    shown in the boot / finalize banner (RECOMMENDATION_MODELS).
 *  - src/config.ts — the model the server itself CALLS for background
 *    synthesis (SYNTHESIS_MODEL_ID).
 *  - src/config.ts — the default model for Claude Code dispatches
 *    (CC_DISPATCH_MODEL_ID), consumed by src/claude-code/client.ts.
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
 * Phase 2 (live): a scheduled GitHub Action (scripts/check-model-freshness.mjs)
 * diffs the Anthropic Models API against this file and opens a one-line bump
 * PR — auto-detected, human-merged. This file is the edit target for that
 * automation; keep the literal shapes below regex-parseable by extractPins().
 *
 * THE SINGLE SWITCH (D-254): a fleet model migration inside this repo is the
 * edit block below — RECOMMENDATION_MODELS + SYNTHESIS_MODEL_ID +
 * CC_DISPATCH_MODEL_ID — and nothing else. The canonical bump SOP, including
 * the env-vs-registry precedence rule and every out-of-repo surface, lives at
 * docs/model-bump.md.
 *
 * IMPORTANT — three distinct surfaces, do not conflate:
 *  - RECOMMENDATION_MODELS pins what the operator should SELECT in the
 *    claude.ai app model picker. "Latest in the API" is NOT authoritative for
 *    this surface (an API key's model list is not the consumer app's picker),
 *    so these values are chosen deliberately, not auto-tracked.
 *  - SYNTHESIS_MODEL_ID pins the model the server CALLS programmatically
 *    (Messages API via ANTHROPIC_API_KEY, plus the cc_subprocess default).
 *    Bumping it carries cost + OAuth-availability gates (INS-244 / INS-245) and
 *    must stay human-reviewed even under the Phase-2 automation.
 *  - CC_DISPATCH_MODEL_ID pins the default model for Claude Code dispatches
 *    (Agent SDK subprocess on the Max OAuth surface). Same gates apply.
 */

/**
 * Recommendation model per session category (consumed by session-classifier).
 *  - `code`    : short identifier carried in the recommendation object's
 *                `model` field (used by core-template Rule 9 model-awareness).
 *  - `display` : human label shown in the banner (model portion only; the
 *                thinking portion is appended by the classifier).
 *  - `id`      : canonical Anthropic API model id for the recommended model
 *                (D-254). Pins the short code to the full id in ONE place so
 *                the registry — not a consumer — owns the mapping; the
 *                freshness automation bumps it together with code/display.
 *
 * The thinking setting is intentionally NOT here — it is workload-driven, not
 * model-driven, and lives in session-classifier's THINKING_BY_CATEGORY.
 *
 * `as const` (no Record annotation) is required so the `code` literals survive
 * into the derived RecommendedModel union rather than widening to `string`.
 *
 * Fable 5 is the top capability tier as of S162 (a tier above Opus);
 * reasoning_heavy and mixed map to it. executional stays on Sonnet 4.6.
 */
export const RECOMMENDATION_MODELS = {
  reasoning_heavy: { code: "fable-5", display: "Fable 5", id: "claude-fable-5" },
  mixed: { code: "fable-5", display: "Fable 5", id: "claude-fable-5" },
  executional: { code: "sonnet-4-6", display: "Sonnet 4.6", id: "claude-sonnet-4-6" },
} as const;

/**
 * Model the server calls for background synthesis (intelligence-brief +
 * pending-doc-updates). This is an API model id. Overridable per deployment
 * via the SYNTHESIS_MODEL env var (see config.ts). Pinned to "claude-fable-5":
 * the INS-244 / INS-245 gate (OAuth-surface availability + cost) PASSED S162 —
 * operator probe confirmed both the full id and the "fable" alias return
 * completions on the Max OAuth CC surface. Future bumps remain gated the same
 * way and stay human-reviewed under the Phase-2 automation.
 */
export const SYNTHESIS_MODEL_ID = "claude-fable-5";

/**
 * Default model for Claude Code dispatches (cc_dispatch / cc_status), sent to
 * the Agent SDK's `--model` flag on the Max OAuth surface. Overridable per
 * deployment via the CC_DISPATCH_MODEL env var (see config.ts). Consolidated
 * here S162 (D-254) — previously a hard-coded "opus" alias fallback in
 * config.ts; pinning the full id keeps every server-side model default in
 * this file's single edit block.
 */
export const CC_DISPATCH_MODEL_ID = "claude-fable-5";

/**
 * Derive a human display label from a model id — registry-coupled provenance
 * (brief-465 / SRV-89). The intelligence-brief prompt previously hardcoded
 * "Generated by Opus 4.6", two generations stale; the D-254 single-switch
 * registry missed that one literal so every brief carried false provenance.
 * Provenance is now stamped server-side from the model actually used, derived
 * here so a model bump never leaves a stale literal behind.
 *
 *   "claude-fable-5"      -> "Fable 5"
 *   "claude-opus-4-8"     -> "Opus 4.8"
 *   "claude-sonnet-4-6[1m]" -> "Sonnet 4.6"
 *
 * Unparseable ids fall back to the id verbatim (still truthful, just unstyled).
 */
export function modelDisplayFromId(id: string): string {
  const cleaned = id.replace(/\[1m\]$/, "").replace(/^claude-/, "");
  const m = cleaned.match(/^([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (!m) return id;
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const version = m[3] !== undefined ? `${m[2]}.${m[3]}` : m[2];
  return `${family} ${version}`;
}
