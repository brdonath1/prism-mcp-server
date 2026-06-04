/**
 * standing-rules-union — R2-B (D-240 Phase B): union the standing-rule sets
 * parsed from `.prism/standing-rules.md` (the registry) and `insights.md`
 * (the legacy location), dedup'd by INS-N with the registry winning on
 * conflict.
 *
 * Why this exists: ~78% of a mature insights.md is STANDING-RULE entries,
 * which the `"STANDING RULE"` protected marker pins permanently — so the
 * insights archival (R2-A) can only evict the chronological tail. R2-B gives
 * standing rules their own file so R3-imm can later prune insights.md. The
 * union read makes the change safe to deploy BEFORE any project migrates
 * data: a project with no standing-rules.md keeps resolving its rules from
 * insights.md exactly as before, and the transient mid-migration state (old
 * rules in insights.md, new ones in standing-rules.md) resolves to the
 * combined set.
 *
 * Per INS-30, both consumers (`prism_bootstrap` and `prism_load_rules`) MUST
 * call this one function rather than each merging on their own —
 * mirror-pattern divergence creates silent drift bugs. The underlying parser
 * (`extractStandingRules`) is format-driven and untouched by R2-B.
 */
import { extractStandingRules, type StandingRule } from "./standing-rules.js";

/** Result of unioning the two standing-rule sources. */
export interface StandingRulesUnion {
  /**
   * Merged rule set: registry rules first (file order), then insights-only
   * rules (file order). When standing-rules.md is absent this is exactly
   * `extractStandingRules(insightsContent)` — identical to pre-R2-B behavior.
   */
  rules: StandingRule[];
  /**
   * INS-N ids present in BOTH sources — the standing-rules.md version won.
   * Non-empty conflicts mean a migration left a duplicate behind; surfaced
   * via diagnostics so the operator can finish consolidating (R3-imm).
   */
  conflicts: string[];
  /** Rule count parsed from standing-rules.md (pre-dedup). */
  fromStandingRulesFile: number;
  /** Rule count parsed from insights.md (pre-dedup). */
  fromInsights: number;
}

/**
 * Union the standing rules from the registry (`standing-rules.md`) and the
 * legacy location (`insights.md`), dedup'd by INS-N. The registry wins on
 * conflict. Either input may be null (file absent) — `extractStandingRules`
 * returns `[]` for null, so the union degrades gracefully to whichever
 * source exists.
 */
export function unionStandingRules(
  standingRulesContent: string | null,
  insightsContent: string | null,
): StandingRulesUnion {
  const fromRegistry = extractStandingRules(standingRulesContent);
  const fromInsights = extractStandingRules(insightsContent);

  const registryIds = new Set(fromRegistry.map(r => r.id));
  const conflictIds = new Set<string>();
  const rules = [...fromRegistry];

  for (const rule of fromInsights) {
    if (registryIds.has(rule.id)) {
      conflictIds.add(rule.id);
    } else {
      rules.push(rule);
    }
  }

  return {
    rules,
    conflicts: Array.from(conflictIds),
    fromStandingRulesFile: fromRegistry.length,
    fromInsights: fromInsights.length,
  };
}
