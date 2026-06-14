// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { selectStandingRulesForBoot, type StandingRule } from "../src/tools/bootstrap.js";

const tierA = (id: string): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "A", topics: [] });
const tierB = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "B", topics });
const tierC = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "C", topics });

describe("selectStandingRulesForBoot (D-253: Tier A bodies only; Tier B+C indexed, not delivered)", () => {
  it("includes all Tier A rules unconditionally", () => {
    const rules = [tierA("INS-1"), tierA("INS-2")];
    expect(selectStandingRulesForBoot(rules)).toHaveLength(2);
  });

  it("keeps the selected Tier A rules in input order", () => {
    const rules = [tierA("INS-3"), tierA("INS-1"), tierA("INS-2")];
    expect(selectStandingRulesForBoot(rules).map(r => r.id)).toEqual(["INS-3", "INS-1", "INS-2"]);
  });

  it("excludes Tier B rules regardless of topics (bodies lazy-loaded via prism_load_rules — D-156 §3.5 restored)", () => {
    // R7-b shipped ALL Tier B at boot; D-253 reverses that — Tier B bodies are
    // no longer delivered, whether they carry topics or not.
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"]), tierB("INS-3", ["trigger"]), tierB("INS-4", [])];
    const out = selectStandingRulesForBoot(rules);
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("excludes Tier C rule bodies (reference-only; index ships separately)", () => {
    const rules = [tierA("INS-1"), tierC("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules);
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("returns empty for empty input", () => {
    expect(selectStandingRulesForBoot([])).toEqual([]);
  });

  it("returns empty when only Tier B and Tier C rules exist (no Tier A)", () => {
    const rules = [tierB("INS-1", ["trigger"]), tierC("INS-2", ["audit"])];
    expect(selectStandingRulesForBoot(rules)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const before = rules.length;
    selectStandingRulesForBoot(rules);
    expect(rules.length).toBe(before);
  });

  it("back-compat: production-shape inputs (all Tier A by default) deliver everything", () => {
    // Every rule has tier "A" and topics [] (the default when no tag present)
    const rules: StandingRule[] = ["INS-22","INS-32","INS-33","INS-34","INS-35","INS-37","INS-39","INS-40","INS-43"]
      .map(id => tierA(id));
    const out = selectStandingRulesForBoot(rules);
    expect(out).toHaveLength(rules.length);
  });
});

