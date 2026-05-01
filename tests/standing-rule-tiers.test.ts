// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { selectStandingRulesForBoot, topicMatch, type StandingRule } from "../src/tools/bootstrap.js";
import { STANDING_RULE_TOPIC_KEYWORDS } from "../src/config.js";

const tierA = (id: string): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "A", topics: [] });
const tierB = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "B", topics });
const tierC = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "C", topics });

describe("topicMatch", () => {
  it("returns false when openingMessage is undefined", () => {
    expect(topicMatch(undefined, ["cc_dispatch"])).toBe(false);
  });

  it("returns false when openingMessage is empty string", () => {
    expect(topicMatch("", ["cc_dispatch"])).toBe(false);
  });

  it("returns false when ruleTopics is empty array", () => {
    expect(topicMatch("let me dispatch a CC brief", [])).toBe(false);
  });

  it("returns true when an opening message keyword matches a rule topic's keyword (case-insensitive)", () => {
    expect(topicMatch("Let me DISPATCH a CC brief", ["cc_dispatch"])).toBe(true);
  });

  it("returns true when any one of multiple rule topics matches", () => {
    expect(topicMatch("checking the trigger daemon", ["cc_dispatch", "trigger"])).toBe(true);
  });

  it("returns false when no rule topic's keywords appear in the opening message", () => {
    expect(topicMatch("just a friendly hello", ["cc_dispatch"])).toBe(false);
  });

  it("ignores unknown topic strings on the rule (no match, no throw)", () => {
    expect(topicMatch("any text", ["nonexistent_topic"])).toBe(false);
  });
});

describe("selectStandingRulesForBoot", () => {
  it("includes all Tier A rules unconditionally", () => {
    const rules = [tierA("INS-1"), tierA("INS-2")];
    expect(selectStandingRulesForBoot(rules, undefined)).toHaveLength(2);
    expect(selectStandingRulesForBoot(rules, "")).toHaveLength(2);
    expect(selectStandingRulesForBoot(rules, "anything")).toHaveLength(2);
  });

  it("excludes Tier B rules when openingMessage is undefined", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, undefined);
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("includes Tier B rules when topic keywords match the opening message", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"]), tierB("INS-3", ["trigger"])];
    const out = selectStandingRulesForBoot(rules, "let me dispatch a CC brief");
    expect(out.map(r => r.id).sort()).toEqual(["INS-1", "INS-2"]);
  });

  it("never includes Tier C rules even when topic keywords match", () => {
    const rules = [tierA("INS-1"), tierC("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, "let me dispatch a CC brief");
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("preserves input order", () => {
    const rules = [tierB("INS-3", ["cc_dispatch"]), tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, "dispatch");
    expect(out.map(r => r.id)).toEqual(["INS-3", "INS-1", "INS-2"]);
  });

  it("does not mutate the input array", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const before = rules.length;
    selectStandingRulesForBoot(rules, "");
    expect(rules.length).toBe(before);
  });

  it("back-compat: production-shape inputs (all Tier A by default) deliver everything", () => {
    // Every rule has tier "A" and topics [] (the default when no tag present)
    const rules: StandingRule[] = ["INS-22","INS-32","INS-33","INS-34","INS-35","INS-37","INS-39","INS-40","INS-43"]
      .map(id => tierA(id));
    const out = selectStandingRulesForBoot(rules, undefined);
    expect(out).toHaveLength(rules.length);
  });
});

describe("STANDING_RULE_TOPIC_KEYWORDS map shape", () => {
  it("includes all sixteen topic groups defined in D-156 + S107 Phase 2", () => {
    const topics = Object.keys(STANDING_RULE_TOPIC_KEYWORDS).sort();
    expect(topics).toEqual(["audit", "auth", "brief", "cc_dispatch", "ci_workflow", "cost", "credential", "debugging", "deployment", "enrollment", "launchd", "mcp_server", "post_merge", "prism_push", "rollout", "trigger"]);
  });

  it("every topic has at least one keyword", () => {
    for (const [topic, kws] of Object.entries(STANDING_RULE_TOPIC_KEYWORDS)) {
      expect(kws.length, `topic ${topic} has zero keywords`).toBeGreaterThan(0);
    }
  });

  it("every keyword is lowercase (case-insensitive matching depends on this)", () => {
    for (const [topic, kws] of Object.entries(STANDING_RULE_TOPIC_KEYWORDS)) {
      for (const kw of kws) {
        expect(kw, `topic ${topic} has non-lowercase keyword: ${kw}`).toBe(kw.toLowerCase());
      }
    }
  });
});
