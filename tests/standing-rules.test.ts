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
    expect(selectStandingRulesForBoot(rules, undefined)).toHaveLength(1);
  });
});
