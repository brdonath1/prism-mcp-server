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
 * Fable 5 was removed from active defaults on 2026-06-25 after operator
 * availability evidence said it is unavailable for the foreseeable future.
 * Opus 4.8 is the current Claude fallback target for reasoning_heavy and
 * mixed. executional stays on Sonnet 5.
 *
 * ── HOLD as of 2026-08-14 (S203 F-B9) ─────────────────────────────────────
 * Opus 5 is GA and MODEL_CAPABILITIES below documents its 1M chat window, so
 * this registry knowingly recommends a generation behind its own capability
 * table. That is DELIBERATE, not drift: the recommendation surface pins what
 * the operator should SELECT in the claude.ai picker, and per the model-bump
 * SOP (docs/model-bump.md §1) that bump is auto-detected but HUMAN-MERGED —
 * it lands only on explicit operator adoption. Until the operator flips it,
 * the recommendation stays opus-4-8. Do not "fix" this to opus-5 as part of
 * an unrelated change; re-raise it as its own bump decision.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const RECOMMENDATION_MODELS = {
  reasoning_heavy: { code: "opus-4-8", display: "Opus 4.8", id: "claude-opus-4-8" },
  mixed: { code: "opus-4-8", display: "Opus 4.8", id: "claude-opus-4-8" },
  executional: { code: "sonnet-5", display: "Sonnet 5", id: "claude-sonnet-5" },
} as const;

/**
 * Model the server calls for background synthesis (intelligence-brief +
 * pending-doc-updates). This is an API model id. Overridable per deployment
 * via the SYNTHESIS_MODEL env var (see config.ts). Pinned to Opus 4.8 as the
 * source fallback after Fable 5 was declared unavailable on 2026-06-25.
 * Production merge/deploy and Railway env adoption remain gated by the model
 * bump SOP's availability and cost checks.
 */
export const SYNTHESIS_MODEL_ID = "claude-opus-4-8";

/**
 * Default model for Claude Code dispatches (cc_dispatch / cc_status), sent to
 * the Agent SDK's `--model` flag on the Max OAuth surface. Overridable per
 * deployment via the CC_DISPATCH_MODEL env var (see config.ts). Consolidated
 * here S162 (D-254) — previously a hard-coded "opus" alias fallback in
 * config.ts; pinning the full id keeps every server-side model default in
 * this file's single edit block.
 */
export const CC_DISPATCH_MODEL_ID = "claude-opus-4-8";

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
 *   "claude-sonnet-5"      -> "Sonnet 5"
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

/* ══════════════════════════════════════════════════════════════════════
 * MODEL CAPABILITY REGISTRY — context windows, keyed by model x SURFACE
 * (brief-s5, commission-platform S5, seeded 2026-07-31)
 *
 * WHY THIS EXISTS. Context-window figures lived in three places — Rule 9
 * prose in prism-framework, DEFAULT_CONTEXT_WINDOW_TOKENS in config.ts, and a
 * Railway env override — and none of them recorded where the number came from
 * or when it was last checked. They drifted 5x apart and survived three model
 * generations unnoticed. Observed live in S5: a session ran a conservation
 * posture from ~50% of a phantom budget while actually sitting at ~14% of its
 * true window.
 *
 * WHY PER-SURFACE, PER-CELL PROVENANCE. The second failure class is
 * cross-surface substitution — carrying a figure between claude.ai chat,
 * Claude Code, and the API as though the three were interchangeable. They are
 * not, and Anthropic's own documentation is the disproof: Opus 4.6 and Sonnet
 * 4.6 are 1M on the API but 500K in web chat. A single `source` field per
 * MODEL invites exactly that substitution, because "documented" is true — just
 * for the wrong surface. So provenance is a property of the CELL, not the row.
 *
 * The concrete case this guards: during S5 an agent asserted Fable 5 = 1M in
 * chat on the strength of six API-surface sources. The correct answer is that
 * Fable's chat window is UNDOCUMENTED. Its cell below says so.
 *
 * MAINTENANCE. The `api` column is machine-checkable and IS checked in CI
 * (tests/model-capabilities-api-drift.test.ts against
 * client.models.retrieve(id).max_input_tokens). The `chat` and `claude_code`
 * columns have no programmatic endpoint and are hand-maintained — which is
 * precisely why `as_of` and the staleness thresholds are load-bearing rather
 * than decorative. Models ship monthly; a table without an expiry will drift.
 *
 * GUARDRAIL. Do NOT raise a cell from `undocumented_floor` to a real number on
 * API evidence. Only a statement about THAT surface, or a measurement on it,
 * promotes a cell.
 * ══════════════════════════════════════════════════════════════════════ */

/** Delivery surface a context window is being asked about. The same model has
 *  different windows on different surfaces; they are never interchangeable. */
export type Surface = "chat" | "claude_code" | "api";

/** Where a single cell's number came from. Per CELL, never per model. */
export type Provenance =
  /** An explicit published statement about THIS surface. */
  | "documented"
  /** Derived from a catch-all row or an omission ("X and older"), not named. */
  | "inferred"
  /** Measured in a live session; no documentation supports it. */
  | "observed"
  /** No evidence for this surface at all — the conservative floor, disclosed. */
  | "undocumented_floor";

/** One (model, surface) cell. */
export interface CapabilityCell {
  /** Context window in tokens for this model on this surface. */
  tokens: number;
  /** Where this specific number came from. */
  source: Provenance;
  /** ISO date (YYYY-MM-DD) this cell was last verified. */
  as_of: string;
  /** URL of the statement relied on, when one exists. */
  ref?: string;
  /** Why, when `source` is not "documented". Required by test for such cells. */
  note?: string;
  /**
   * Plan-conditional documentation (e.g. Pro usage-credit requirements).
   * Recorded so a future plan change is a one-line edit — deliberately NOT
   * consumed by resolveContextWindow. The operator runs Claude Max 20x
   * exclusively, so every credit branch is inert; building resolution logic
   * for a condition that never fires is the non-goal that produced the
   * original Rule 9 bug (an unsatisfiable condition silently resolving
   * downward). See brief-s5 Non-goals.
   */
  plan_note?: string;
}

/** One model row: a display label plus at most one cell per surface. */
export interface ModelCapability {
  display: string;
  chat?: CapabilityCell;
  claude_code?: CapabilityCell;
  api?: CapabilityCell;
}

/** Date the whole table was verified. Also dates the synthetic floor so an
 *  un-reverified fallback expires like any other low-confidence cell. */
export const REGISTRY_AS_OF = "2026-07-31";

/** Conservative window assumed when no cell supports the request. Chosen as
 *  the smallest window any current paid surface offers, so a resolution
 *  failure under-promises rather than over-promises. */
export const CONTEXT_WINDOW_FLOOR_TOKENS = 200_000;

/**
 * Days after `as_of` at which a cell should be re-verified. Low-confidence
 * cells expire ~6x faster than documented ones: an `undocumented_floor` is a
 * standing request for evidence, whereas a published figure is stable until
 * the vendor changes it.
 */
export const STALENESS_THRESHOLD_DAYS: Record<Provenance, number> = {
  documented: 180,
  inferred: 30,
  observed: 30,
  undocumented_floor: 30,
};

/** Source for the chat + Claude Code columns (verified 2026-07-31). */
const PAID_PLANS_REF =
  "https://support.claude.com/en/articles/8606394-how-large-is-the-context-window-on-paid-claude-plans";

/** Max-plan Claude Code has no usage-credit step; the credit condition is a
 *  Pro-plan requirement. Attaching this to the cells it applies to (rather
 *  than to resolution logic) is the brief's Non-goal #2. */
const MAX_NO_CREDIT_STEP =
  "No usage-credit condition on Max; the credit step is a Pro-plan requirement (inert here).";

/**
 * The registry. Keys are normalized model keys (see normalizeModelKey) — the
 * canonical API id minus its `claude-` prefix, e.g. "opus-4-8", "sonnet-5".
 *
 * A MISSING cell is meaningful: it means no evidence exists for that surface,
 * and the resolver degrades to the disclosed floor. Do not fill a gap with a
 * number borrowed from a neighbouring column.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "opus-5": {
    display: "Opus 5",
    chat: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "opus-4-8": {
    display: "Opus 4.8",
    chat: { tokens: 500_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "opus-4-7": {
    display: "Opus 4.7",
    chat: { tokens: 500_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "opus-4-6": {
    display: "Opus 4.6",
    // The documented disproof of cross-surface substitution: 500K here, 1M below.
    chat: { tokens: 500_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "sonnet-5": {
    display: "Sonnet 5",
    chat: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "sonnet-4-6": {
    display: "Sonnet 4.6",
    chat: { tokens: 500_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note:
        "Pro plans require usage credits for the 1M window on this model; inert on Max. Recorded as documentation only — the resolver does not branch on it.",
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "sonnet-4-5": {
    display: "Sonnet 4.5",
    chat: {
      tokens: 200_000,
      source: "inferred",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      note: "Covered only by the help-centre's 'Haiku 4.5 and older' catch-all row — not named individually. Inferred, so it expires on the 30-day clock.",
    },
    api: { tokens: 200_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "haiku-4-5": {
    display: "Haiku 4.5",
    chat: { tokens: 200_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    // Haiku 4.5 is a 200K-context model with no extended-context (1M) variant,
    // so its Claude Code window is the same 200K ceiling — NOT the 1M Max window
    // the Opus/Sonnet rows document (hence no MAX_NO_CREDIT_STEP plan_note, which
    // is about that 1M window and is inapplicable here). Recorded so the row is
    // surface-complete like opus-4-8 / sonnet-5 and never degrades to the
    // undocumented floor on any surface. Haiku 4.5 is now a first-class synthesis
    // model — the direct-Anthropic mechanical-draft tier (SYNTHESIS_DRAFT_MODEL),
    // resolving to its documented 200K api window rather than the floor.
    claude_code: { tokens: 200_000, source: "documented", as_of: REGISTRY_AS_OF, ref: PAID_PLANS_REF },
    api: { tokens: 200_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "fable-5": {
    display: "Fable 5",
    chat: {
      tokens: CONTEXT_WINDOW_FLOOR_TOKENS,
      source: "undocumented_floor",
      as_of: REGISTRY_AS_OF,
      note: "The paid-plans chat table never names Fable. Its 1M API figure must NOT be carried across — that substitution is the exact S5 error. Only a statement about the chat surface, or a measurement on it, promotes this cell.",
    },
    claude_code: {
      tokens: 1_000_000,
      source: "documented",
      as_of: REGISTRY_AS_OF,
      ref: PAID_PLANS_REF,
      plan_note: MAX_NO_CREDIT_STEP,
    },
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "mythos-5": {
    display: "Mythos 5",
    // API-only: no chat or Claude Code cell exists, so those surfaces
    // deliberately resolve to the disclosed floor.
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
  "mythos-preview": {
    display: "Mythos Preview",
    api: { tokens: 1_000_000, source: "documented", as_of: REGISTRY_AS_OF },
  },
};

/**
 * Normalize any model identifier the client might declare into a registry key.
 *
 * Accepts the several shapes that circulate in this system: canonical API ids
 * ("claude-opus-4-8"), the RECOMMENDATION_MODELS short codes the classifier
 * emits ("opus-4-8"), human display labels ("Opus 4.8"), and the `[1m]`
 * long-context beta suffix. Returns "" for anything non-string or empty —
 * the resolver treats that as an unknown model, never an error.
 */
export function normalizeModelKey(model: string): string {
  if (typeof model !== "string") return "";
  return model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .trim()
    .replace(/^claude[-\s]/, "")
    .replace(/[\s.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a normalized key to an actual registry key, tolerating the two
 * alias shapes Anthropic ids take: a trailing release date
 * ("opus-4-8-20260214") and an explicit zero minor ("sonnet-5-0").
 */
function lookupCapabilityKey(key: string): string | null {
  // Object.hasOwn (not `in`): the key comes from client-supplied text in the
  // bootstrap contract, so prototype members like "toString" must not match.
  const has = (k: string) => Object.hasOwn(MODEL_CAPABILITIES, k);
  if (key && has(key)) return key;
  const undated = key.replace(/-\d{6,}$/, "");
  if (undated !== key && has(undated)) return undated;
  const unpadded = undated.replace(/-0$/, "");
  if (unpadded !== undated && has(unpadded)) return unpadded;
  return null;
}

/** Whole days elapsed since an ISO date, floored at 0 (a clock behind the
 *  as_of date reports 0 rather than a negative age). */
function daysSince(isoDate: string, now: Date): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/** What the resolver returns. `matched` is the registry key that answered the
 *  query (null when nothing matched); `fallback_reason` is present only when
 *  the answer is the disclosed floor rather than a real cell. */
export interface ResolvedContextWindow {
  tokens: number;
  source: Provenance;
  as_of: string;
  stale_days: number;
  stale: boolean;
  matched: string | null;
  fallback_reason?: string;
}

function floorResult(
  matched: string | null,
  fallbackReason: string,
  now: Date,
): ResolvedContextWindow {
  const staleDays = daysSince(REGISTRY_AS_OF, now);
  return {
    tokens: CONTEXT_WINDOW_FLOOR_TOKENS,
    source: "undocumented_floor",
    as_of: REGISTRY_AS_OF,
    stale_days: staleDays,
    stale: staleDays > STALENESS_THRESHOLD_DAYS.undocumented_floor,
    matched,
    fallback_reason: fallbackReason,
  };
}

/**
 * Resolve the context window for a (model, surface) pair.
 *
 * NEVER THROWS. Every failure mode — unknown model, unknown surface, a known
 * model with no cell for the requested surface — degrades to the
 * CONTEXT_WINDOW_FLOOR_TOKENS floor tagged `undocumented_floor` and carrying a
 * `fallback_reason`. A resolution failure must be a *disclosed* conservative
 * answer, not an error: the caller is a boot path, and a throw there would
 * leave the client with no map at all.
 *
 * @param model   Any model identifier shape (see normalizeModelKey).
 * @param surface Which delivery surface the caller is running on.
 * @param now     Injectable clock; defaults to wall time. Tests pin it.
 */
export function resolveContextWindow(
  model: string,
  surface: Surface,
  now: Date = new Date(),
): ResolvedContextWindow {
  const key = normalizeModelKey(model);
  const matched = lookupCapabilityKey(key);

  if (surface !== "chat" && surface !== "claude_code" && surface !== "api") {
    return floorResult(
      matched,
      `unknown_surface: "${String(surface)}" is not one of chat|claude_code|api`,
      now,
    );
  }

  if (!matched) {
    return floorResult(
      null,
      `unknown_model: "${typeof model === "string" ? model : String(model)}" is not in MODEL_CAPABILITIES`,
      now,
    );
  }

  const cell = MODEL_CAPABILITIES[matched][surface];
  if (!cell) {
    return floorResult(
      matched,
      `no_cell_for_surface: "${matched}" has no ${surface} entry — no evidence exists for that surface`,
      now,
    );
  }

  const staleDays = daysSince(cell.as_of, now);
  return {
    tokens: cell.tokens,
    source: cell.source,
    as_of: cell.as_of,
    stale_days: staleDays,
    stale: staleDays > STALENESS_THRESHOLD_DAYS[cell.source],
    matched,
  };
}
