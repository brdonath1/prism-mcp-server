/**
 * Tests for src/utils/standing-rules.ts — the shared parser/matcher used
 * by both prism_bootstrap and prism_load_rules (D-156, Phase 2 PR 4 §3.6).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  extractStandingRules,
  matchesExplicitTopic,
  normalizeTopic,
  selectStandingRulesByTopic,
  selectStandingRulesForBoot,
  topicMatch,
  type StandingRule,
} from "../src/utils/standing-rules.js";

describe("normalizeTopic", () => {
  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeTopic("  Synthesis  ")).toBe("synthesis");
    expect(normalizeTopic("CC_DISPATCH")).toBe("cc_dispatch");
  });

  it("returns empty string when input is just whitespace", () => {
    expect(normalizeTopic("   ")).toBe("");
  });
});

describe("matchesExplicitTopic", () => {
  it("returns true for case-insensitive exact match", () => {
    expect(matchesExplicitTopic("synthesis", ["synthesis"])).toBe(true);
    expect(matchesExplicitTopic("Synthesis", ["synthesis"])).toBe(true);
    expect(matchesExplicitTopic("synthesis", ["SYNTHESIS"])).toBe(true);
  });

  it("returns true when one of multiple topics matches", () => {
    expect(matchesExplicitTopic("trigger", ["cc_dispatch", "trigger", "auth"])).toBe(true);
  });

  it("returns false when no topic matches", () => {
    expect(matchesExplicitTopic("synthesis", ["cc_dispatch", "trigger"])).toBe(false);
  });

  it("returns false when ruleTopics is empty", () => {
    expect(matchesExplicitTopic("synthesis", [])).toBe(false);
  });

  it("returns false when topic normalizes to empty string", () => {
    expect(matchesExplicitTopic("   ", ["synthesis"])).toBe(false);
  });

  it("does substring matching never (must be exact-equality on normalized values)", () => {
    // "synth" should NOT match "synthesis" — explicit-topic is exact, not substring.
    expect(matchesExplicitTopic("synth", ["synthesis"])).toBe(false);
    // ...and "synthesizer" should not match "synth" either.
    expect(matchesExplicitTopic("synth", ["synthesizer"])).toBe(false);
  });
});

describe("selectStandingRulesByTopic", () => {
  const tierA = (id: string, topics: string[] = []): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "A", topics });
  const tierB = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "B", topics });
  const tierC = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "C", topics });

  it("excludes Tier A even when its topics match", () => {
    const rules = [tierA("INS-1", ["synthesis"]), tierB("INS-2", ["synthesis"])];
    const out = selectStandingRulesByTopic(rules, "synthesis", false);
    expect(out.map(r => r.id)).toEqual(["INS-2"]);
  });

  it("includes only matching Tier B by default (include_tier_c=false)", () => {
    const rules = [
      tierB("INS-1", ["synthesis"]),
      tierB("INS-2", ["cc_dispatch"]),
      tierC("INS-3", ["synthesis"]),
    ];
    const out = selectStandingRulesByTopic(rules, "synthesis", false);
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("includes matching Tier C when include_tier_c=true", () => {
    const rules = [
      tierB("INS-1", ["synthesis"]),
      tierC("INS-2", ["synthesis"]),
      tierC("INS-3", ["cc_dispatch"]),
    ];
    const out = selectStandingRulesByTopic(rules, "synthesis", true);
    expect(out.map(r => r.id).sort()).toEqual(["INS-1", "INS-2"]);
  });

  it("preserves input order", () => {
    const rules = [
      tierB("INS-3", ["synthesis"]),
      tierB("INS-1", ["synthesis"]),
      tierB("INS-2", ["synthesis"]),
    ];
    const out = selectStandingRulesByTopic(rules, "synthesis", false);
    expect(out.map(r => r.id)).toEqual(["INS-3", "INS-1", "INS-2"]);
  });

  it("does not mutate the input array", () => {
    const rules = [tierB("INS-1", ["synthesis"])];
    const before = rules.length;
    selectStandingRulesByTopic(rules, "synthesis", false);
    expect(rules.length).toBe(before);
  });

  it("returns empty when topic is empty string", () => {
    const rules = [tierB("INS-1", ["synthesis"])];
    const out = selectStandingRulesByTopic(rules, "", false);
    expect(out).toEqual([]);
  });
});

// ── brief-451 / INS-310: end-anchored tier tags + title-suffix insights qualification ──
//
// The LIVE_* header lines below are copied VERBATIM from the live
// brdonath1/prism corpus fetched at commit 199f093beea1193b19734429551e2b9cf4a3f1c6
// (.prism/standing-rules.md and .prism/insights.md). Do not retype or "fix"
// them — their self-referential content (backticked `[TIER:X]` literals,
// quoted 'STANDING RULE' phrases, a doubled trailing marker) IS the
// regression corpus this brief hardens against.

const LIVE_REGISTRY_INS_179 = "### INS-179: Brief verification regex must be sanity-checked against a known-good case — `[^[]` swallows the space the spec requires before `[TIER:X]` — STANDING RULE [TIER:C]";
const LIVE_REGISTRY_INS_187 = "### INS-187: PAT rotation (KI-19) — suppress all proactive surfacing until operator explicitly lifts the directive — STANDING RULE";
const LIVE_REGISTRY_INS_307 = "### INS-307: Environment migrations over living docs need per-line classification (procedural vs historical) — blanket find-replace falsifies records — STANDING RULE — STANDING RULE";
const LIVE_INSIGHTS_INS_304 = "### INS-304: Guess-instead-of-verify cascade — STANDING RULE [TIER:A]";
const LIVE_INSIGHTS_INS_305 = "### INS-305: Trigger/CC worker transient API error mid-push — recover by nudging the idle pane to retry push+PR, not a daemon restart (verify remote state first) — STANDING RULE [TIER:B]";
const LIVE_INSIGHTS_INS_308 = "### INS-308: Standing-rule parser ground truth — every ### INS-N section counts (default Tier A untagged), bare [TIER:X] parses, but 'STANDING RULE' is also the insights archival pin";
const LIVE_INSIGHTS_INS_310 = "### INS-310: Boot tier-count mismatch root cause — first-match [TIER:] regex + substring 'standing rule' filter vs the two self-referential titles (INS-179, INS-308); parser regex is the census contract";

/** Render one section from a header line plus a minimal body. */
function section(headerLine: string, body = "**Standing procedure:** Do the thing."): string {
  return `${headerLine}\n\n${body}\n`;
}

describe("brief-451: end-anchored trailing tier tags (both sources)", () => {
  it("INS-179 (live registry line): mid-title backticked [TIER:X] is ignored — the TRAILING [TIER:C] wins", () => {
    const rules = extractStandingRules(section(LIVE_REGISTRY_INS_179), "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-179");
    expect(rules[0].tier).toBe("C");
  });

  it("INS-179 visible title keeps the mid-title backticked literal and loses ONLY the trailing tag", () => {
    const rules = extractStandingRules(section(LIVE_REGISTRY_INS_179), "registry");
    expect(rules[0].title).toBe(
      "Brief verification regex must be sanity-checked against a known-good case — `[^[]` swallows the space the spec requires before `[TIER:X]`",
    );
  });

  it("a mid-title [TIER:*] token with no trailing tag is ignored for tier AND cleanup", () => {
    const rules = extractStandingRules(
      section("### INS-900: Docs quote `[TIER:B]` as an example — STANDING RULE"),
      "insights",
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A"); // mid-title token ignored — untagged default
    expect(rules[0].title).toBe("Docs quote `[TIER:B]` as an example");
  });

  it("unknown letter in a TRAILING tag keeps warn-and-default-A and is stripped from the title", () => {
    const rules = extractStandingRules(section("### INS-901: Bad letter — STANDING RULE [TIER:Q]"), "insights");
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].title).toBe("Bad letter");
  });
});

describe("brief-451: insights.md title-suffix qualification", () => {
  it("INS-308 (live insights line) does NOT qualify — phrase mentions are mid-title, not the suffix form", () => {
    expect(extractStandingRules(section(LIVE_INSIGHTS_INS_308, "- Description: not a rule."), "insights")).toEqual([]);
  });

  it("INS-310 (live insights line) does NOT qualify", () => {
    expect(extractStandingRules(section(LIVE_INSIGHTS_INS_310, "- Description: not a rule."), "insights")).toEqual([]);
  });

  it("tagged live insights rules still qualify with correct tiers (INS-304 → A, INS-305 → B)", () => {
    const doc = [section(LIVE_INSIGHTS_INS_304), section(LIVE_INSIGHTS_INS_305)].join("\n");
    const rules = extractStandingRules(doc, "insights");
    expect(rules.map(r => [r.id, r.tier])).toEqual([
      ["INS-304", "A"],
      ["INS-305", "B"],
    ]);
  });

  it("a body-only STANDING RULE mention does not qualify (old substring behavior removed)", () => {
    const doc = section("### INS-902: Plain insight", "- Description: discusses the STANDING RULE concept at length.");
    expect(extractStandingRules(doc, "insights")).toEqual([]);
  });

  it("a bare trailing [TIER:B] without — STANDING RULE does not qualify in insights.md", () => {
    expect(extractStandingRules(section("### INS-903: Bare tag [TIER:B]"), "insights")).toEqual([]);
  });

  it("default source is insights — single-arg callers get suffix qualification", () => {
    const doc = section("### INS-904: Mentions standing rule mid-title only", "- Description: body.");
    expect(extractStandingRules(doc)).toEqual([]);
  });
});

describe("brief-451: standing-rules.md registry qualification (INS-308 ground truth, unchanged)", () => {
  it("INS-187 (live untagged registry line) still qualifies as Tier A", () => {
    const rules = extractStandingRules(section(LIVE_REGISTRY_INS_187), "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
  });

  it("INS-307 (live doubled-marker registry line) qualifies Tier A and sheds BOTH trailing markers", () => {
    const rules = extractStandingRules(section(LIVE_REGISTRY_INS_307), "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].title).toBe(
      "Environment migrations over living docs need per-line classification (procedural vs historical) — blanket find-replace falsifies records",
    );
  });

  it("a registry section with NO marker anywhere still counts as a Tier A rule", () => {
    const rules = extractStandingRules(section("### INS-905: Unmarked registry entry"), "registry");
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].title).toBe("Unmarked registry entry");
  });

  it("D-48 archived/dormant exclusion still applies in registry mode", () => {
    expect(extractStandingRules(section("### INS-906: Old — ARCHIVED STANDING RULE [TIER:B]"), "registry")).toEqual([]);
    expect(extractStandingRules(section("### INS-907: Paused — DORMANT RULE"), "registry")).toEqual([]);
  });
});

describe("back-compat: bootstrap helpers still callable from this module", () => {
  // The brief calls out (§3.6) that bootstrap's existing behavior must not
  // change. Spot-check the helpers extracted from bootstrap.ts still work.
  it("extractStandingRules returns [] for null input", () => {
    expect(extractStandingRules(null)).toEqual([]);
  });

  it("topicMatch returns false when openingMessage is undefined", () => {
    expect(topicMatch(undefined, ["cc_dispatch"])).toBe(false);
  });

  it("selectStandingRulesForBoot includes Tier A unconditionally", () => {
    const rules: StandingRule[] = [
      { id: "INS-1", title: "t1", procedure: "p", tier: "A", topics: [] },
    ];
    expect(selectStandingRulesForBoot(rules)).toHaveLength(1);
  });
});
