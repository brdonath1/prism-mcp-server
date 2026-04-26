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
 * Extract standing rules from insights content, keeping only the procedure portion.
 * ME-3 (D-48): Excludes ARCHIVED RULE, DORMANT RULE, ARCHIVED STANDING RULE,
 * and DORMANT STANDING RULE entries from the active set.
 */
export function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    // D-48: Skip archived or dormant entries
    if (/archived\s+(standing\s+)?rule/i.test(section) || /dormant\s+(standing\s+)?rule/i.test(section)) {
      continue;
    }

    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        // D-47: Extract procedure-only — find "Standing procedure:" and take everything after
        let procedure = '';
        const procStart = section.search(/\*\*Standing procedure:\*\*/i);
        if (procStart !== -1) {
          procedure = section.slice(procStart)
            .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
            .trim();
        }

        // D-156: Parse tier tag from header (defaults to "A" when absent)
        let tier: "A" | "B" | "C" = "A";
        const tierMatch = headerMatch[2].match(/\[TIER:([A-Z])\]/i);
        if (tierMatch) {
          const letter = tierMatch[1].toUpperCase();
          if (letter === "A" || letter === "B" || letter === "C") {
            tier = letter;
          } else {
            logger.warn("standing rule has unknown tier letter; defaulting to A", { id: headerMatch[1], tierLetter: letter });
          }
        }

        // D-156: Strip both — STANDING RULE and [TIER:X] from the visible title
        const title = headerMatch[2]
          .replace(/\s*\[TIER:[A-Z]\]\s*/i, '')
          .replace(/\s*—\s*STANDING RULE\s*/gi, '')
          .trim();

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
    }
  }

  return rules;
}

/**
 * Match a standing rule's topics against an opening message via STANDING_RULE_TOPIC_KEYWORDS (D-156).
 * Returns true if any topic on the rule has at least one keyword present in the opening message
 * (case-insensitive substring match). Returns false when openingMessage is empty/undefined or
 * the rule has no topics.
 *
 * This matcher powers the bootstrap path — it expands a free-form opening message into the set
 * of topics it implies, then checks rule.topics against that set. The explicit-topic path
 * (prism_load_rules) uses {@link matchesExplicitTopic} instead.
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
 * Select which standing rules to deliver at bootstrap based on tier (D-156).
 *
 * Selection rules:
 * - Tier A: always include (behavioral judgment rules effective across every session)
 * - Tier B: include if topicMatch returns true (rule's topics overlap with opening_message keywords)
 * - Tier C: never include at bootstrap (reference-only; available via prism_load_rules in PR 4)
 *
 * Returns a new array — does not mutate the input. Order is preserved from the input.
 */
export function selectStandingRulesForBoot(
  rules: StandingRule[],
  openingMessage: string | undefined,
): StandingRule[] {
  return rules.filter(rule => {
    if (rule.tier === "A") return true;
    if (rule.tier === "B") return topicMatch(openingMessage, rule.topics);
    return false; // tier C
  });
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
