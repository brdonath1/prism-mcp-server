/**
 * Standing-rule parsing, tier filtering, and topic matching.
 *
 * Shared helpers extracted from `src/tools/bootstrap.ts` (Phase 2 PR 4 / D-156)
 * so that both `prism_bootstrap` and `prism_load_rules` operate on a single
 * source of truth. Per INS-30, mirror-pattern divergence creates silent drift
 * bugs; the two call sites MUST call ONE function. `bootstrap.ts` re-exports
 * these names for back-compat with existing imports/tests.
 */
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
 * STANDING-RULE HEADER GRAMMAR (brief-459 / SRV-01 — the single source of
 * truth, consumed by this parser and emitted by prism_log_insight's composer):
 *
 *   header         = "### " INS-id ":" SP title [decoration-run]
 *   decoration-run = 1*( SP? ( "— STANDING RULE" | "[TIER:" letter "]" ) )
 *   canonical      = title " — STANDING RULE" [" [TIER:" tier "]"]
 *
 * - The decoration run is ORDER-INSENSITIVE and end-anchored: both
 *   `— STANDING RULE [TIER:B]` (canonical) and `[TIER:B] — STANDING RULE`
 *   (the order the writer minted for prism INS-316) parse identically.
 *   Mid-title `[TIER:*]` occurrences (e.g. the backticked literal in prism
 *   INS-179's title) never match — neither for tier extraction nor cleanup
 *   (brief-451 / INS-310, preserved).
 * - Tier: the LAST `[TIER:X]` tag in the run wins. An unknown letter warns
 *   and defaults to A. NO tag in the run → Tier A — the documented
 *   untagged-mint default (INS-328). A trailing `[TIER:…]`-like token the
 *   run grammar cannot consume emits STANDING_RULE_TIER_TAG_UNPARSED and
 *   defaults to A — never silently.
 * - insights.md qualification: the decoration run must contain
 *   `— STANDING RULE` (brief-451 title-suffix rule, order-relaxed).
 * - Section bounds: a rule section ends at the next `### ` header, the first
 *   H1/H2 heading (e.g. `## Formalized`), or a line-anchored `<!-- EOF:`
 *   sentinel — the final rule never swallows trailing file content
 *   (SRV-01b, the S171 boot repro).
 */
const TITLE_DECORATION_RUN = /(?:\s*(?:—\s*STANDING\s+RULE|\[TIER:[A-Z]\]))+\s*$/i;

/** Tier tags inside a matched decoration run — the LAST one wins. */
const TIER_TAG_IN_RUN = /\[TIER:([A-Z])\]/gi;

/** A trailing `[TIER:…]`-like token the run grammar could not consume (e.g.
 *  `[TIER:]`, `[TIER:BB]`) — evidence the author tried to tag a tier. */
const MALFORMED_TRAILING_TIER_TAG = /\[TIER:[^\]]*\]\s*$/i;

/** Section terminator (SRV-01b): first H1/H2 heading or line-anchored EOF
 *  sentinel inside a `### `-split section. */
const RULE_SECTION_TERMINATOR = /^(?:#{1,2}\s|<!--\s*EOF:)/m;

/** Parsed trailing decorations of a standing-rule title line (brief-459). */
export interface TitleDecorations {
  /** Title with the trailing decoration run removed (mid-title text kept). */
  cleanTitle: string;
  /** Valid tier from the run's last `[TIER:X]` tag, or null when absent. */
  tier: "A" | "B" | "C" | null;
  /** Letter as found in the run's last tag (may be an unknown letter), or
   *  null when the run carries no tag. */
  rawTierLetter: string | null;
  /** True when the run contains a `— STANDING RULE` marker. */
  hasStandingRuleSuffix: boolean;
  /** True when no tag was parsed from the run but the remaining title still
   *  ENDS with a `[TIER:…]`-like token — a malformed tag attempt. */
  unparsedTierTag: boolean;
}

/**
 * Parse the trailing decoration run off a standing-rule title line. This is
 * THE grammar — `extractStandingRules` consumes it and `prism_log_insight`'s
 * composer normalizes through it, so the writer can never mint a header the
 * parser misreads (SRV-01: the INS-316 tag-then-suffix drift class).
 */
export function parseTitleDecorations(titleLine: string): TitleDecorations {
  const runMatch = titleLine.match(TITLE_DECORATION_RUN);
  const run = runMatch ? runMatch[0] : "";
  const cleanTitle = runMatch
    ? titleLine.slice(0, runMatch.index).trim()
    : titleLine.trim();

  let rawTierLetter: string | null = null;
  if (run) {
    const tags = [...run.matchAll(TIER_TAG_IN_RUN)];
    if (tags.length > 0) {
      rawTierLetter = tags[tags.length - 1][1].toUpperCase();
    }
  }
  const tier =
    rawTierLetter === "A" || rawTierLetter === "B" || rawTierLetter === "C"
      ? rawTierLetter
      : null;

  return {
    cleanTitle,
    tier,
    rawTierLetter,
    hasStandingRuleSuffix: /—\s*STANDING\s+RULE/i.test(run),
    unparsedTierTag: rawTierLetter === null && MALFORMED_TRAILING_TIER_TAG.test(cleanTitle),
  };
}

/**
 * Ceiling on the SRV-13 body fallback when a qualifying rule lacks a
 * `**Standing procedure:**` marker. Bounded so the fallback cannot regress
 * the D-47 procedure-only payload diet; the cut is flagged with `…`.
 */
export const EMPTY_PROCEDURE_FALLBACK_MAX_CHARS = 1_000;

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
  const rawSections = content.split(/(?=^### )/m);

  for (const rawSection of rawSections) {
    // SRV-01b (brief-459): bound the section BEFORE any extraction — the
    // final rule's section otherwise runs to end-of-file and swallows
    // trailing content (`## Formalized`, the EOF sentinel) into its
    // procedure. Mid-file sections are already bounded by the next `### `.
    const terminator = rawSection.match(RULE_SECTION_TERMINATOR);
    const section =
      terminator && terminator.index !== undefined
        ? rawSection.slice(0, terminator.index)
        : rawSection;

    // D-48: Skip archived or dormant entries
    if (/archived\s+(standing\s+)?rule/i.test(section) || /dormant\s+(standing\s+)?rule/i.test(section)) {
      continue;
    }

    const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
    if (!headerMatch) continue;
    const id = headerMatch[1];
    const titleLine = headerMatch[2];

    // brief-459 / SRV-01: ONE grammar — parse the trailing decoration run
    // (order-insensitive) for qualification, tier, and title cleanup.
    const decor = parseTitleDecorations(titleLine);

    // brief-451 qualification (order-relaxed by brief-459): registry sections
    // all count (INS-308 ground truth); insights sections qualify only when
    // the trailing run carries the `— STANDING RULE` marker.
    if (source === "insights" && !decor.hasStandingRuleSuffix) {
      continue;
    }

    // D-156: tier defaults to "A" when the run carries no tag (the documented
    // untagged-mint default — INS-328). Unknown letters keep the brief-451
    // warn-and-default-A behavior; a malformed trailing tag is surfaced via
    // STANDING_RULE_TIER_TAG_UNPARSED instead of silently defaulting.
    let tier: "A" | "B" | "C" = "A";
    if (decor.tier) {
      tier = decor.tier;
    } else if (decor.rawTierLetter !== null) {
      logger.warn("standing rule has unknown tier letter; defaulting to A", { id, tierLetter: decor.rawTierLetter });
    } else if (decor.unparsedTierTag) {
      logger.warn(
        "standing-rule title ends with a [TIER:…] token the grammar cannot parse; defaulting to A (STANDING_RULE_TIER_TAG_UNPARSED)",
        { id, titleTail: decor.cleanTitle.slice(-40) },
      );
    }

    const title = decor.cleanTitle;

    // D-47: Extract procedure-only — find "Standing procedure:" and take
    // everything after (within the bounded section).
    let procedure = '';
    const procStart = section.search(/\*\*Standing procedure:\*\*/i);
    if (procStart !== -1) {
      procedure = section.slice(procStart)
        .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
        .trim();
    } else {
      // SRV-13 (brief-459): a qualifying rule without the marker used to ship
      // procedure:'' silently — the rule looked active while delivering
      // nothing (live: prism INS-304). Fall back to a bounded slice of the
      // section body (minus the topics metadata comment) and flag the source
      // for repair.
      const bodyStart = section.indexOf("\n");
      const body = (bodyStart === -1 ? "" : section.slice(bodyStart + 1))
        .replace(/^<!--\s*topics:.*?-->[^\S\n]*$/gim, "")
        .trim();
      if (body.length > 0) {
        procedure =
          body.length > EMPTY_PROCEDURE_FALLBACK_MAX_CHARS
            ? body.slice(0, EMPTY_PROCEDURE_FALLBACK_MAX_CHARS) + "…"
            : body;
      }
      logger.warn(
        "standing rule lacks a **Standing procedure:** marker — delivering bounded body fallback (STANDING_RULE_EMPTY_PROCEDURE)",
        { id, fallbackChars: procedure.length },
      );
    }

    // D-156: Parse topics from <!-- topics: foo, bar --> comment in the
    // section body. brief-459 / SRV-11: lazy-match to the closing marker so
    // hyphenated topics (live: prism INS-297's `trigger-lock`) parse whole.
    let topics: string[] = [];
    const topicsMatch = section.match(/<!--\s*topics:\s*(.*?)\s*-->/i);
    if (topicsMatch) {
      topics = topicsMatch[1]
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
      if (topics.length === 0) {
        logger.warn(
          "standing-rule topics comment present but yields zero topics (STANDING_RULE_TOPICS_EMPTY)",
          { id },
        );
      }
    }

    rules.push({
      id,
      title,
      procedure,
      tier,
      topics,
    });
  }

  return rules;
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
 * This is a direct array-contains match (case-insensitive), not keyword expansion.
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
