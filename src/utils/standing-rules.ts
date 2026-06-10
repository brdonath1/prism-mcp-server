/**
 * Standing-rule parsing, tier filtering, and topic matching.
 *
 * Shared helpers extracted from `src/tools/bootstrap.ts` (Phase 2 PR 4 / D-156)
 * so that both `prism_bootstrap` and `prism_load_rules` operate on a single
 * source of truth. Per INS-30, mirror-pattern divergence creates silent drift
 * bugs; the two call sites MUST call ONE function. `bootstrap.ts` re-exports
 * these names for back-compat with existing imports/tests.
 */
import { STANDING_RULE_TOPIC_KEYWORDS } from "../config.js";
import { logger } from "./logger.js";

/** Standing rule extracted from insights — procedure-only (D-47), tier-aware (D-156). */
export interface StandingRule {
  id: string;
  title: string;
  procedure: string; // D-47: procedure-only, not full content
  tier: "A" | "B" | "C"; // D-156: A=always-load, B=topic-load, C=reference-only. Default A when tag absent (back-compat).
  topics: string[];      // D-156: topics this rule applies to. Empty array when not specified. Used for Tier B selection.
}

/**
 * Which rule document a parse is reading — determines qualification (brief-451).
 *
 * - `"registry"` (.prism/standing-rules.md): the file IS the rule registry, so
 *   every `### INS-N:` section counts as a rule (INS-308 ground truth);
 *   untagged sections default to Tier A.
 * - `"insights"` (insights.md): a section qualifies ONLY when its title line
 *   ends with `— STANDING RULE`, optionally followed by the trailing tier tag.
 *   Mentions of the phrase elsewhere in the title or body do NOT qualify —
 *   prism INS-308/INS-310 are the live self-referential counterexamples that
 *   made the old whole-section substring test miscount (INS-310).
 */
export type StandingRuleSource = "registry" | "insights";

/**
 * Trailing tier tag, end-anchored to the title line (brief-451 / INS-310): the
 * title must END with `[TIER:X]`, optionally preceded by `— STANDING RULE`.
 * Mid-title `[TIER:*]` occurrences (e.g. the backticked literal in prism
 * INS-179's title) never match — neither for tier extraction nor cleanup.
 */
const TRAILING_TIER_TAG = /(?:—\s*STANDING\s+RULE\s*)?\[TIER:([A-Z])\]\s*$/i;

/**
 * insights.md qualification suffix (brief-451): title line ends with
 * `— STANDING RULE`, optionally followed by the trailing tier tag.
 */
const INSIGHTS_RULE_SUFFIX = /—\s*STANDING\s+RULE\s*(?:\[TIER:[A-Z]\]\s*)?$/i;

/**
 * Visible-title cleanup: strip ONLY the trailing decoration run — one or more
 * `— STANDING RULE` markers (doubled-marker tolerance) plus an optional
 * `[TIER:X]` — anchored at end of title. Mid-title occurrences are preserved
 * verbatim (brief-451: the old unanchored strip mangled self-referential
 * titles like prism INS-179).
 */
const TRAILING_TITLE_DECORATIONS = /(?:\s*—\s*STANDING\s+RULE)*(?:\s*\[TIER:[A-Z]\])?\s*$/i;

/**
 * Extract standing rules from a rule-source document, keeping only the
 * procedure portion.
 * ME-3 (D-48): Excludes ARCHIVED RULE, DORMANT RULE, ARCHIVED STANDING RULE,
 * and DORMANT STANDING RULE entries from the active set.
 *
 * brief-451: qualification is source-aware (see {@link StandingRuleSource}).
 * Defaults to `"insights"` — the function's historical contract — so existing
 * single-argument callers keep the stricter insights semantics; the union
 * layer passes `"registry"` for standing-rules.md.
 */
export function extractStandingRules(
  content: string | null,
  source: StandingRuleSource = "insights",
): StandingRule[] {
  if (!content) return [];

  const rules: StandingRule[] = [];
  const sections = content.split(/(?=^### )/m);

  for (const section of sections) {
    // D-48: Skip archived or dormant entries
    if (/archived\s+(standing\s+)?rule/i.test(section) || /dormant\s+(standing\s+)?rule/i.test(section)) {
      continue;
    }

    const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
    if (!headerMatch) continue;
    const titleLine = headerMatch[2];

    // brief-451 qualification: registry sections all count (INS-308 ground
    // truth); insights sections qualify only via the title-line suffix form.
    if (source === "insights" && !INSIGHTS_RULE_SUFFIX.test(titleLine)) {
      continue;
    }

    // D-47: Extract procedure-only — find "Standing procedure:" and take everything after
    let procedure = '';
    const procStart = section.search(/\*\*Standing procedure:\*\*/i);
    if (procStart !== -1) {
      procedure = section.slice(procStart)
        .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
        .trim();
    }

    // D-156: Parse tier tag from header (defaults to "A" when absent).
    // brief-451: only a TRAILING tag counts; unknown letters in a trailing
    // tag keep the warn-and-default-A behavior.
    let tier: "A" | "B" | "C" = "A";
    const tierMatch = titleLine.match(TRAILING_TIER_TAG);
    if (tierMatch) {
      const letter = tierMatch[1].toUpperCase();
      if (letter === "A" || letter === "B" || letter === "C") {
        tier = letter;
      } else {
        logger.warn("standing rule has unknown tier letter; defaulting to A", { id: headerMatch[1], tierLetter: letter });
      }
    }

    // D-156 / brief-451: strip only the trailing — STANDING RULE / [TIER:X]
    // decorations from the visible title
    const title = titleLine.replace(TRAILING_TITLE_DECORATIONS, '').trim();

    // D-156: Parse topics from <!-- topics: foo, bar --> comment in section body
    let topics: string[] = [];
    const topicsMatch = section.match(/<!--\s*topics:\s*([^-]+?)\s*-->/i);
    if (topicsMatch) {
      topics = topicsMatch[1]
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
    }

    rules.push({
      id: headerMatch[1],
      title,
      procedure,
      tier,
      topics,
    });
  }

  return rules;
}

/**
 * Match a standing rule's topics against an opening message via STANDING_RULE_TOPIC_KEYWORDS (D-156).
 * Returns true if any topic on the rule has at least one keyword present in the opening message
 * (case-insensitive substring match). Returns false when openingMessage is empty/undefined or
 * the rule has no topics.
 *
 * History: this matcher powered the bootstrap path until R7-b (D-240 Phase B)
 * made Tier B delivery unconditional at boot — it expands a free-form opening
 * message into the set of topics it implies, then checks rule.topics against
 * that set. Kept exported per the INS-28 back-compat contract (bootstrap.ts
 * re-exports it). The explicit-topic path (prism_load_rules) uses
 * {@link matchesExplicitTopic} instead.
 */
export function topicMatch(openingMessage: string | undefined, ruleTopics: string[]): boolean {
  if (!openingMessage || ruleTopics.length === 0) return false;
  const lower = openingMessage.toLowerCase();
  for (const topic of ruleTopics) {
    const keywords = STANDING_RULE_TOPIC_KEYWORDS[topic];
    if (!keywords) continue; // Unknown topic on the rule — no match (and worth a future cleanup signal)
    for (const kw of keywords) {
      if (lower.includes(kw)) return true;
    }
  }
  return false;
}

/**
 * Select which standing rules to deliver at bootstrap based on tier.
 *
 * Selection rules (D-253 — partial, evidence-driven reversal of R7-b /
 * D-240 Phase B; restores the D-156 §3.5 lazy-load contract for Tier B):
 * - Tier A: always include (behavioral judgment rules effective across every
 *   session)
 * - Tier B: bodies NOT included at boot — lazy-loaded on demand via
 *   `prism_load_rules` by topic. The R7-b "500K-context" rationale for
 *   shipping all of Tier B broke in production: prism boots exceeded the
 *   Claude.ai inline tool-result cap, so the ENTIRE response (banner,
 *   behavioral rules, everything) was offloaded to a sandbox file and zero
 *   bytes reached the session (D-253). Tier B now joins the boot INDEX
 *   alongside Tier C.
 * - Tier C: bodies never included at bootstrap (reference-only; available via
 *   prism_load_rules) — bootstrap ships an INDEX (IDs + titles) instead
 *
 * Returns a new array — does not mutate the input. Order is preserved from the input.
 */
export function selectStandingRulesForBoot(rules: StandingRule[]): StandingRule[] {
  return rules.filter(rule => rule.tier === "A");
}

/**
 * Normalize a topic string for case-insensitive comparison.
 * Trims surrounding whitespace and lowercases. Used by the explicit-topic
 * matcher so callers may pass `"Synthesis"`, `" synthesis "`, `"SYNTHESIS"`, etc.
 */
export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

/**
 * Case-insensitive exact match of an explicit topic against a rule's topics array (D-156 §3.5).
 *
 * Used by `prism_load_rules` — caller passes a single topic keyword (e.g. `"synthesis"`)
 * and we check whether that keyword equals any entry in `ruleTopics` after normalization.
 * Distinct from {@link topicMatch}: that function uses STANDING_RULE_TOPIC_KEYWORDS to
 * expand a free-form opening message; this one is direct array-contains.
 */
export function matchesExplicitTopic(topic: string, ruleTopics: string[]): boolean {
  if (ruleTopics.length === 0) return false;
  const target = normalizeTopic(topic);
  if (target.length === 0) return false;
  for (const t of ruleTopics) {
    if (normalizeTopic(t) === target) return true;
  }
  return false;
}

/**
 * Filter standing rules for the prism_load_rules tool (D-156 §3.5).
 *
 * - Tier A is ALWAYS excluded (already loaded at bootstrap — re-loading wastes context).
 * - Tier B is included if its topics array contains the requested topic (case-insensitive exact match).
 * - Tier C is included only when `includeTierC` is true AND its topics match.
 *
 * Returns a new array — does not mutate the input. Order is preserved from the input.
 */
export function selectStandingRulesByTopic(
  rules: StandingRule[],
  topic: string,
  includeTierC: boolean,
): StandingRule[] {
  return rules.filter(rule => {
    if (rule.tier === "A") return false;
    if (rule.tier === "B") return matchesExplicitTopic(topic, rule.topics);
    if (rule.tier === "C") return includeTierC && matchesExplicitTopic(topic, rule.topics);
    return false;
  });
}
