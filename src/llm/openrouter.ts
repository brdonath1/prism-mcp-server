/**
 * OpenRouter (GLM-5.2) mechanical-tier routing — D-275 / brief-s196c.
 *
 * PRISM's three mechanical synthesis call sites (CS-1 draft, CS-2 brief,
 * CS-3 pdu per docs/cost-rearchitecture/d275-callsite-inventory.json) can be
 * served by GLM-5.2 through OpenRouter's OpenAI-compatible chat endpoint at
 * ~5–15× below frontier list prices. This module owns everything
 * openrouter-specific that the routing layer and the chat adapter share:
 *
 *  - the activation surface (`LLM_ROUTING_OPENROUTER_SITES`, §4.7 of the
 *    design doc): openrouter serves exactly (SITES ∩ mechanical sites). SITES
 *    unset/empty ⇒ every branch in this module is dead code ⇒ behavior
 *    bit-identical to the pre-D-275 router.
 *  - per-site thinking control (§4.2): GLM-5.2 defaults to thinking mode and
 *    reasoning tokens consume max_tokens — the S196 live micro-call spent all
 *    16 completion tokens on reasoning and returned zero answer text with
 *    finish_reason=length. Reasoning is therefore OFF unless a site opts in
 *    via LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}.
 *  - the per-site output quality gates (§4.5): applied to openrouter results
 *    BEFORE they count as success; a gate failure is treated exactly like a
 *    provider failure and falls back to the site's existing anthropic chain.
 *
 * Never read or log credential VALUES here — env names only.
 */

import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../utils/intelligence-brief-spec.js";
import { extractJSON } from "../utils/extract-json.js";
import { logger } from "../utils/logger.js";
import type { LlmSurface, RoutingEnv } from "./route-types.js";

/** OpenRouter's OpenAI-compatible chat-completions endpoint (design §4.1). */
export const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

/**
 * The surfaces openrouter may EVER serve: the intersection filter's
 * right-hand side. Sourced from d275-callsite-inventory.json — exactly the
 * call sites classified MECHANICAL with verdict migrate-to-GLM-5.2 (CS-1/2/3).
 * x_sentiment stays on xAI (x_search is xAI-exclusive), cc_dispatch is the
 * protected Claude judgment tier, recommendation is NON-LLM. A site id in
 * LLM_ROUTING_OPENROUTER_SITES outside this set is ignored.
 */
export const OPENROUTER_MECHANICAL_SURFACES: ReadonlySet<LlmSurface> = new Set([
  "synthesis_brief",
  "synthesis_draft",
  "synthesis_pdu",
]);

/**
 * Parse LLM_ROUTING_OPENROUTER_SITES — a comma-separated list of call-site
 * ids (e.g. "synthesis_draft,synthesis_pdu"). Whitespace-tolerant,
 * case-insensitive, empty entries dropped. Unset/empty → empty set.
 */
export function parseOpenrouterSites(env: RoutingEnv = process.env): Set<string> {
  const raw = env.LLM_ROUTING_OPENROUTER_SITES;
  if (!raw || raw.trim().length === 0) return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
}

/**
 * The activation predicate (design §4.7): openrouter serves exactly
 * (SITES ∩ OPENROUTER_MECHANICAL_SURFACES).
 */
export function openrouterSiteSelected(
  surface: LlmSurface,
  env: RoutingEnv = process.env,
): boolean {
  if (!OPENROUTER_MECHANICAL_SURFACES.has(surface)) return false;
  return parseOpenrouterSites(env).has(surface);
}

/** Reasoning-effort levels a site may opt into (design §4.2). */
export type OpenrouterReasoningLevel = "off" | "low" | "medium" | "high";

/**
 * OpenRouter's unified reasoning parameter, sent on EVERY openrouter call:
 * `{ enabled: false }` (the cross-provider thinking off-switch) by default,
 * `{ effort }` when a site explicitly opts in.
 */
export type OpenrouterReasoningParam =
  | { enabled: false }
  | { effort: Exclude<OpenrouterReasoningLevel, "off"> };

const REASONING_ENV_SEGMENT: Partial<Record<LlmSurface, string>> = {
  synthesis_brief: "BRIEF",
  synthesis_draft: "DRAFT",
  synthesis_pdu: "PDU",
};

/**
 * Reasoning tokens share the completion budget: with our 4096/8192 caps an
 * enabled reasoning pass can starve the answer text into finish_reason=length
 * (the S196 micro-call failure mode). Design §4.1: reasoning requires
 * max_tokens ≥ 16384, otherwise the guard forces reasoning off with a warn
 * instead of shipping a guaranteed length-failure.
 */
export const OPENROUTER_REASONING_MIN_MAX_TOKENS = 16_384;

/**
 * Resolve the per-site reasoning level from
 * LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}. Default "off";
 * unrecognized values warn once per call and fall back to "off" (fail-safe:
 * a typo must never silently re-enable GLM thinking).
 */
export function resolveOpenrouterReasoningLevel(
  surface: LlmSurface,
  env: RoutingEnv = process.env,
): OpenrouterReasoningLevel {
  const segment = REASONING_ENV_SEGMENT[surface];
  if (!segment) return "off";
  const raw = env[`LLM_ROUTING_OPENROUTER_REASONING_${segment}`]?.trim().toLowerCase();
  if (!raw) return "off";
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") {
    return raw;
  }
  logger.warn(
    "OPENROUTER_REASONING_INVALID — unrecognized reasoning level, defaulting to off",
    { surface, value: raw },
  );
  return "off";
}

/**
 * Build the reasoning parameter for an openrouter request (design §4.2),
 * applying the max_tokens floor guard. The caller-supplied Anthropic
 * `thinking` boolean is deliberately NOT an input: it maps to Anthropic
 * adaptive thinking on Anthropic transports only — CS-1 hardcodes it `true`,
 * and honoring it here would silently re-enable GLM thinking.
 */
export function resolveOpenrouterReasoningParam(
  surface: LlmSurface,
  maxTokens: number,
  env: RoutingEnv = process.env,
): OpenrouterReasoningParam {
  const level = resolveOpenrouterReasoningLevel(surface, env);
  if (level === "off") return { enabled: false };
  if (maxTokens < OPENROUTER_REASONING_MIN_MAX_TOKENS) {
    logger.warn(
      "OPENROUTER_REASONING_BUDGET_GUARD — reasoning requested but max_tokens is below the floor; forcing reasoning off (reasoning shares the completion budget and would starve answer text into finish_reason=length)",
      {
        surface,
        requested_level: level,
        max_tokens: maxTokens,
        required_min: OPENROUTER_REASONING_MIN_MAX_TOKENS,
      },
    );
    return { enabled: false };
  }
  return { effort: level };
}

/**
 * Optional OpenRouter attribution headers (design §4.1). Values come from
 * OPENROUTER_SITE_URL / OPENROUTER_APP_TITLE with the brief-pinned defaults;
 * these identify the app to OpenRouter's dashboard and carry no secrets.
 */
export function openrouterAttributionHeaders(
  env: RoutingEnv = process.env,
): Record<string, string> {
  return {
    "HTTP-Referer":
      env.OPENROUTER_SITE_URL?.trim() || "https://github.com/brdonath1/prism-mcp-server",
    "X-Title": env.OPENROUTER_APP_TITLE?.trim() || "PRISM MCP Server",
  };
}

/**
 * Per-site output quality gates for the openrouter leg (design §4.5).
 *
 * The floors are deliberately low — the gates exist to catch the GLM failure
 * classes (thinking-starved stubs, truncated or off-contract output), not to
 * judge prose quality. A failure here triggers the same fallback as a
 * provider HTTP error, so the artifact is still produced (by the site's
 * existing anthropic chain) rather than lost.
 *
 * Anthropic legs keep today's more lenient warn-level behavior — these gates
 * run ONLY on openrouter results (src/ai/client.ts).
 */
export const OPENROUTER_BRIEF_MIN_BYTES = 2_000;
export const OPENROUTER_PDU_MIN_BYTES = 500;

/**
 * The four H2 sections of the PDU machine grammar. Mirror of the inline list
 * in src/ai/synthesize.ts (which stays warn-level for anthropic legs) and of
 * PENDING_DOC_UPDATES_PROMPT — pinned by the contract test in
 * src/llm/__tests__/openrouter-gates.test.ts.
 */
export const OPENROUTER_PDU_REQUIRED_SECTIONS: readonly string[] = [
  "## architecture.md",
  "## glossary.md",
  "## insights.md",
  "## No Updates Needed",
];

/**
 * The 6 keys of the CS-1 draft JSON contract (FINALIZATION_DRAFT_PROMPT in
 * src/ai/prompts.ts — pinned by the contract test). The openrouter gate
 * requires a parseable JSON object carrying at least
 * OPENROUTER_DRAFT_MIN_CONTRACT_KEYS of them — closing the raw_content
 * success gap (finalize.ts draftPhase) on the GLM route only.
 */
export const OPENROUTER_DRAFT_CONTRACT_KEYS: readonly string[] = [
  "session_log_entry",
  "handoff_where_we_are",
  "handoff_next_steps",
  "handoff_session_history",
  "task_queue_completed",
  "task_queue_new",
];
export const OPENROUTER_DRAFT_MIN_CONTRACT_KEYS = 4;

export type OpenrouterGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate an openrouter synthesis result for its call site. Returns a
 * machine-readable failure reason (attached to the SYNTHESIS_PROVIDER_FALLBACK
 * warn as validation_failure) — never any output content.
 */
export function validateOpenrouterSynthesisOutput(
  surface: LlmSurface,
  content: string,
): OpenrouterGateResult {
  const bytes = new TextEncoder().encode(content).length;

  switch (surface) {
    case "synthesis_brief": {
      if (bytes < OPENROUTER_BRIEF_MIN_BYTES) {
        return { ok: false, reason: `brief-below-min-bytes(${bytes}<${OPENROUTER_BRIEF_MIN_BYTES})` };
      }
      const missing = INTELLIGENCE_BRIEF_SPEC_SECTIONS.filter((s) => !content.includes(s));
      if (missing.length > 0) {
        return { ok: false, reason: `brief-missing-sections(${missing.join("; ")})` };
      }
      return { ok: true };
    }
    case "synthesis_pdu": {
      if (bytes < OPENROUTER_PDU_MIN_BYTES) {
        return { ok: false, reason: `pdu-below-min-bytes(${bytes}<${OPENROUTER_PDU_MIN_BYTES})` };
      }
      const missing = OPENROUTER_PDU_REQUIRED_SECTIONS.filter((s) => !content.includes(s));
      if (missing.length > 0) {
        return { ok: false, reason: `pdu-missing-sections(${missing.join("; ")})` };
      }
      return { ok: true };
    }
    case "synthesis_draft": {
      let parsed: unknown;
      try {
        parsed = extractJSON(content);
      } catch {
        return { ok: false, reason: "draft-json-parse-failed" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, reason: "draft-json-not-an-object" };
      }
      const present = OPENROUTER_DRAFT_CONTRACT_KEYS.filter((key) =>
        Object.hasOwn(parsed, key),
      ).length;
      if (present < OPENROUTER_DRAFT_MIN_CONTRACT_KEYS) {
        return {
          ok: false,
          reason: `draft-contract-keys(${present}<${OPENROUTER_DRAFT_MIN_CONTRACT_KEYS})`,
        };
      }
      return { ok: true };
    }
    default:
      // Non-mechanical surfaces never route to openrouter; nothing to gate.
      return { ok: true };
  }
}
