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
 * (`extractStandingRules`) is format-driven and untouched by R2-B; brief-451
 * made its QUALIFICATION source-aware, and this union is the single place
 * that knows which content is which — registry sections all count as rules,
 * insights.md sections qualify only via the `— STANDING RULE` title suffix.
 */
import { extractStandingRules, type StandingRule } from "./standing-rules.js";
import { MemoryCache } from "./cache.js";
import { logger } from "./logger.js";

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
  const fromRegistry = extractStandingRules(standingRulesContent, "registry");
  const fromInsights = extractStandingRules(insightsContent, "insights");

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

/**
 * Parse cache for {@link unionStandingRules}, keyed `${repo}:${srSha}:${insSha}`
 * (S208 PR-S2a / MCP-1). Both consumers hit it -- `prism_bootstrap` once per
 * boot and `prism_load_rules` on every mid-session call -- and the parse is the
 * expensive half once the 304 path has removed the download: prism's registry
 * is ~320KB of markdown split into ~100 regex-scanned sections.
 *
 * Keying on the CONTENT SHAS is what makes the cache safe: a changed document
 * is a changed sha is a different key, so a stale parse is unreachable rather
 * than merely unlikely. 10-minute TTL / 40 entries bound the memory.
 */
const unionParseCache = new MemoryCache<StandingRulesUnion>("standing-rules-parse", 10, 40);

/** Test seam: drop every cached parse. */
export function clearStandingRulesParseCache(): void {
  unionParseCache.clear();
}

/**
 * Sha-keyed {@link unionStandingRules}. Identical result, computed once per
 * (repo, registry sha, insights sha) triple.
 *
 * Pass `null` shas when a source is absent or its sha is unknown -- an unknown
 * sha disables caching for that call rather than guessing, because a cache
 * whose key cannot distinguish two document versions is a correctness bug, not
 * an optimization.
 *
 * Returned arrays are fresh shallow copies, so a caller that sorts or splices
 * its result cannot corrupt the cached entry. The rule OBJECTS are shared and
 * treated as immutable by every consumer (both call sites only filter/map).
 */
export function unionStandingRulesCached(
  repo: string,
  standingRules: { content: string | null; sha: string | null },
  insights: { content: string | null; sha: string | null },
): StandingRulesUnion {
  const cacheable =
    (standingRules.content === null || standingRules.sha !== null) &&
    (insights.content === null || insights.sha !== null);

  if (!cacheable) {
    return unionStandingRules(standingRules.content, insights.content);
  }

  const key = `${repo}:${standingRules.sha ?? "-"}:${insights.sha ?? "-"}`;
  const cached = unionParseCache.get(key);
  if (cached) {
    logger.debug("standing-rules parse served from cache", { repo, key });
    return { ...cached, rules: [...cached.rules], conflicts: [...cached.conflicts] };
  }

  const union = unionStandingRules(standingRules.content, insights.content);
  unionParseCache.set(key, union);
  return { ...union, rules: [...union.rules], conflicts: [...union.conflicts] };
}
