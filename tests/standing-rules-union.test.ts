/**
 * Tests for src/utils/standing-rules-union.ts — the R2-B (D-240 Phase B)
 * union of the standing-rule registry (.prism/standing-rules.md) and the
 * legacy location (insights.md). Per INS-30 both prism_bootstrap and
 * prism_load_rules consume THIS function; these tests pin the merge
 * contract: dedup by INS-N, registry wins on conflict, order stable.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { unionStandingRules } from "../src/utils/standing-rules-union.js";
import { extractStandingRules } from "../src/utils/standing-rules.js";

/** Render one parseable standing-rule section. */
function rule(id: string, title: string, tier: "A" | "B" | "C" = "A", procedure = "Do it."): string {
  return [
    `### ${id}: ${title} — STANDING RULE [TIER:${tier}]`,
    "",
    `**Standing procedure:** ${procedure}`,
    "",
  ].join("\n");
}

function doc(...sections: string[]): string {
  return ["# Doc", "", ...sections].join("\n");
}

describe("unionStandingRules", () => {
  it("returns empty for null/null", () => {
    const union = unionStandingRules(null, null);
    expect(union.rules).toEqual([]);
    expect(union.conflicts).toEqual([]);
    expect(union.fromStandingRulesFile).toBe(0);
    expect(union.fromInsights).toBe(0);
  });

  it("degrades to insights-only exactly (pre-migration projects)", () => {
    const insights = doc(rule("INS-1", "One"), rule("INS-2", "Two", "B"));
    const union = unionStandingRules(null, insights);
    // Identical to calling the parser directly — pre-R2-B behavior preserved.
    expect(union.rules).toEqual(extractStandingRules(insights));
    expect(union.conflicts).toEqual([]);
    expect(union.fromStandingRulesFile).toBe(0);
    expect(union.fromInsights).toBe(2);
  });

  it("degrades to registry-only when insights is null", () => {
    const registry = doc(rule("INS-3", "Three"));
    const union = unionStandingRules(registry, null);
    expect(union.rules.map(r => r.id)).toEqual(["INS-3"]);
    expect(union.fromStandingRulesFile).toBe(1);
    expect(union.fromInsights).toBe(0);
  });

  it("unions disjoint sets with registry rules first, insights order preserved", () => {
    const registry = doc(rule("INS-10", "Reg A"), rule("INS-11", "Reg B"));
    const insights = doc(rule("INS-1", "Ins A"), rule("INS-2", "Ins B"));
    const union = unionStandingRules(registry, insights);
    expect(union.rules.map(r => r.id)).toEqual(["INS-10", "INS-11", "INS-1", "INS-2"]);
    expect(union.conflicts).toEqual([]);
  });

  it("dedups by INS-N with the registry version winning", () => {
    const registry = doc(rule("INS-5", "Registry title", "B", "Registry proc"));
    const insights = doc(rule("INS-5", "Insights title", "A", "Insights proc"), rule("INS-6", "Keep me"));
    const union = unionStandingRules(registry, insights);

    expect(union.rules.map(r => r.id)).toEqual(["INS-5", "INS-6"]);
    const winner = union.rules[0];
    expect(winner.title).toBe("Registry title");
    expect(winner.tier).toBe("B"); // tier comes from the winning entry too
    expect(union.conflicts).toEqual(["INS-5"]);
  });

  it("reports each conflicting id once even if insights repeats it", () => {
    const registry = doc(rule("INS-7", "Reg"));
    const insights = doc(rule("INS-7", "Dup one"), rule("INS-7", "Dup two"));
    const union = unionStandingRules(registry, insights);
    expect(union.conflicts).toEqual(["INS-7"]);
    expect(union.rules.map(r => r.id)).toEqual(["INS-7"]);
    expect(union.rules[0].title).toBe("Reg");
  });

  it("does not mutate parser results shared by reference", () => {
    const registry = doc(rule("INS-1", "Reg"));
    const union = unionStandingRules(registry, null);
    union.rules.pop(); // caller mutates its copy
    // A second union over the same content is unaffected.
    expect(unionStandingRules(registry, null).rules).toHaveLength(1);
  });

  // brief-451 / INS-310: the union is the one place that knows which content
  // is which, so it pins the source-aware qualification — registry sections
  // ALL count (INS-308 ground truth), insights.md sections qualify only via
  // the `— STANDING RULE` title suffix.
  it("applies registry qualification to standing-rules.md and title-suffix qualification to insights.md (brief-451)", () => {
    const registry = doc(
      "### INS-50: Unmarked registry entry\n\n**Standing procedure:** Always applies.\n",
    );
    const insights = doc(
      "### INS-51: Mentions a standing rule mid-title only\n- Description: body also says STANDING RULE.\n",
      rule("INS-52", "Suffix-qualified insights rule", "B"),
    );
    const union = unionStandingRules(registry, insights);

    expect(union.rules.map(r => r.id)).toEqual(["INS-50", "INS-52"]);
    expect(union.rules[0].tier).toBe("A"); // untagged registry entry defaults to Tier A
    expect(union.fromStandingRulesFile).toBe(1);
    expect(union.fromInsights).toBe(1); // INS-51 does not qualify
    expect(union.conflicts).toEqual([]);
  });
});
