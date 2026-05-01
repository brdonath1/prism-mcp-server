/**
 * Session classifier tests (brief-405 / D-191).
 */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  classifySession,
  injectPersistedRecommendation,
  parsePersistedRecommendation,
} from "../../src/utils/session-classifier.js";

describe("classifySession", () => {
  it("yields executional verdict for a pure cleanup queue", () => {
    const result = classifySession({
      next_steps: [
        "Cleanup INS-223 dead-config references in handoff.md",
        "Patch task-queue to demote stale items",
        "Push the updated boot-test fixture",
      ],
    });
    expect(result.category).toBe("executional");
    expect(result.model).toBe("sonnet-4-6");
    expect(result.thinking).toBe("adaptive-off");
    expect(result.display).toBe("Sonnet 4.6 · Adaptive off");
    expect(result.rationale.length).toBeLessThanOrEqual(80);
  });

  it("yields reasoning_heavy verdict for a pure design queue", () => {
    const result = classifySession({
      next_steps: [
        "Design the new orchestration architecture",
        "Brainstorm tradeoffs and compare strategy options",
        "Investigate the failure mode and propose a fix",
      ],
    });
    expect(result.category).toBe("reasoning_heavy");
    expect(result.model).toBe("opus-4-7");
    expect(result.thinking).toBe("adaptive-on");
    expect(result.display).toBe("Opus 4.7 · Adaptive on");
  });

  it("yields mixed verdict for balanced execution + judgment queue", () => {
    const result = classifySession({
      next_steps: [
        "Debug the regression",
        "Verify the fix",
      ],
    });
    // 1 reasoning (debug) + 1 executional (verify) → ratio 1.0 → mixed window
    expect(result.category).toBe("mixed");
    expect(result.model).toBe("opus-4-7");
    expect(result.thinking).toBe("adaptive-off");
    expect(result.display).toBe("Opus 4.7 · Adaptive off");
  });

  it("yields mixed verdict (safe default) for empty input", () => {
    const result = classifySession({ next_steps: [] });
    expect(result.category).toBe("mixed");
    expect(result.model).toBe("opus-4-7");
    expect(result.thinking).toBe("adaptive-off");
    expect(result.scores.reasoning_heavy).toBe(0);
    expect(result.scores.executional).toBe(0);
  });

  // brief-415 / F7: opening_message and critical_context are no longer
  // accepted by ClassifySessionInput. The opening_message 2x-weight test
  // and the critical_context boot-path test were removed at the same time
  // — finalize and bootstrap both pass next_steps only, so no runtime
  // behavior is lost; TypeScript surfaces any regression at compile time.

  it("is case-insensitive on keywords", () => {
    const lower = classifySession({ next_steps: ["design the api"] });
    const upper = classifySession({ next_steps: ["DESIGN THE API"] });
    const mixedCase = classifySession({ next_steps: ["Design The Api"] });

    expect(lower.scores.reasoning_heavy).toBe(upper.scores.reasoning_heavy);
    expect(lower.scores.reasoning_heavy).toBe(mixedCase.scores.reasoning_heavy);
    expect(lower.scores.reasoning_heavy).toBeGreaterThan(0);
  });

  it("counts each keyword hit when a single step contains multiple keywords", () => {
    const single = classifySession({ next_steps: ["design the architecture"] });
    // "design" + "architecture" both fire in one step.
    expect(single.scores.reasoning_heavy).toBe(2);

    const triple = classifySession({
      next_steps: ["cleanup, patch, and push the fix"],
    });
    expect(triple.scores.executional).toBe(3);
  });

  it("matches multi-word phrases like 'decide whether'", () => {
    const result = classifySession({
      next_steps: ["Decide whether to migrate the orchestrator"],
    });
    expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
  });

  it("requires qualifier for conditional 'audit' keyword", () => {
    const unqualified = classifySession({
      next_steps: ["audit the log file"],
    });
    // "audit" without "report"/"findings" should not score reasoning;
    // "log" still hits executional.
    expect(unqualified.scores.reasoning_heavy).toBe(0);

    const qualified = classifySession({
      next_steps: ["produce an audit report"],
    });
    expect(qualified.scores.reasoning_heavy).toBeGreaterThan(0);
  });

  it("rationale stays within the 80-char banner budget", () => {
    for (const cat of ["reasoning_heavy", "executional", "mixed"] as const) {
      // Construct an input that produces this category and inspect rationale.
      const inputs: Record<typeof cat, { next_steps: string[] }> = {
        reasoning_heavy: { next_steps: ["design architecture brainstorm"] },
        executional: { next_steps: ["cleanup patch push verify"] },
        mixed: { next_steps: ["debug then apply the patch"] },
      };
      const result = classifySession(inputs[cat]);
      expect(result.rationale.length).toBeLessThanOrEqual(80);
    }
  });

  it("does not fire on word fragments — 'logging' must not trigger 'log'", () => {
    const result = classifySession({
      // S109 / brief-415: "dispatcher" replaced with "receiver" because
      // F5 added the `dispatch` prefix, which would otherwise hit
      // "dispatcher" and break this test. The intent of the test — that
      // bare "log" whole-word does not fire on the substring "logging" —
      // is preserved.
      next_steps: ["Add logging to the receiver"],
    });
    expect(result.scores.executional).toBe(0);
  });
});

// Keyword calibration changes (S109 / brief-415).
//
// All findings F1–F7 from the S109 audit are exercised here. Pre-calibration
// behavior is documented in the brief; this group asserts post-calibration
// scoring matches the audit's expected work-character mapping.
describe("classifySession — keyword calibration (S109 / brief-415)", () => {
  describe("F1: prefix-match catches noun/gerund/adjective derivatives", () => {
    it("'verif' prefix matches verify, verifies, verification, verified, verifying", () => {
      for (const word of ["verify", "verifies", "verification", "verified", "verifying"]) {
        const result = classifySession({
          next_steps: [`Need to ${word} the patch`],
        });
        // verif fires (executional) and patch fires (executional) — both ≥ 1.
        expect(result.scores.executional).toBeGreaterThanOrEqual(1);
      }
    });

    it("'architect' prefix matches architect, architecture, architectural", () => {
      for (const word of ["architect", "architecture", "architectural"]) {
        const result = classifySession({
          next_steps: [`The ${word} matters here`],
        });
        expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
      }
    });

    it("'analyz' prefix matches analyze, analysis, analyzing", () => {
      for (const word of ["analyze", "analysis", "analyzing"]) {
        const result = classifySession({
          next_steps: [`We need ${word} of the trace`],
        });
        expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
      }
    });

    it("'merg' prefix matches merge, merging, merged, merger", () => {
      for (const word of ["merge", "merging", "merged", "merger"]) {
        const result = classifySession({
          next_steps: [`Plan the ${word}`],
        });
        expect(result.scores.executional).toBeGreaterThan(0);
      }
    });

    it("collision check: 'log' (whole-word) does NOT match 'login', but 'merg' (prefix) DOES match 'merging'", () => {
      const noMatch = classifySession({ next_steps: ["Add login flow"] });
      // No "log" whole-word match on "login"; "flow" / "Add" not keywords.
      expect(noMatch.scores.executional).toBe(0);

      const match = classifySession({ next_steps: ["Continue merging the rebase"] });
      // merg prefix fires on "merging"; "rebase" / "Continue" not keywords.
      expect(match.scores.executional).toBeGreaterThan(0);
    });
  });

  describe("F2: expanded `audit` conditional qualifier list", () => {
    it("'audit the keyword lists' fires reasoning (lists qualifier)", () => {
      const result = classifySession({
        next_steps: ["audit the keyword lists"],
      });
      expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
    });

    it("'audit log file rotation' does NOT fire reasoning (no qualifier)", () => {
      const result = classifySession({
        next_steps: ["audit log file rotation"],
      });
      // None of the qualifiers (report/findings/list/lists/rules/keywords/
      // code/system/behavior/session/sessions) appear in this text.
      expect(result.scores.reasoning_heavy).toBe(0);
    });

    it("each new audit qualifier fires reasoning when paired with audit", () => {
      const cases: Array<[string, string]> = [
        ["list",     "audit the brief list"],
        ["rules",    "audit standing rules"],
        ["keywords", "audit the keywords map"],
        ["code",     "audit the code paths"],
        ["system",   "audit the system surface"],
        ["behavior", "audit retry behavior"],
        ["session",  "audit recent session boundaries"],
      ];
      for (const [qualifier, text] of cases) {
        const result = classifySession({ next_steps: [text] });
        expect(result.scores.reasoning_heavy, `qualifier=${qualifier}`).toBeGreaterThan(0);
      }
    });
  });

  describe("F3: new reasoning keywords", () => {
    it("'scope' fires reasoning", () => {
      const result = classifySession({ next_steps: ["scope the brief"] });
      expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
    });

    it("'diagnose' fires reasoning", () => {
      const result = classifySession({ next_steps: ["diagnose the regression"] });
      expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
    });

    it("'diagnostic' fires reasoning via prefix-match (catches noun derivative)", () => {
      const result = classifySession({ next_steps: ["build the diagnostic chain"] });
      expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
    });
  });

  describe("F5: new executional keywords", () => {
    const cases: Array<[string, string]> = [
      ["dispatch", "dispatch the brief"],
      ["merge",    "merge the PR"],
      ["delete",   "delete the env var"],
      ["migrate",  "migrate the layout"],
      ["close",    "close the issue"],
      ["pin",      "pin the lockfile entry"],
      ["wire",     "wire up the new handler"],
      ["redeploy", "redeploy after the rollback"],
    ];
    for (const [keyword, text] of cases) {
      it(`'${keyword}' fires executional`, () => {
        const result = classifySession({ next_steps: [text] });
        expect(result.scores.executional).toBeGreaterThan(0);
      });
    }
  });

  describe("F6: 'follow-up on' phrase removed from REASONING_PHRASES", () => {
    it("'follow-up on the verification' produces zero reasoning hits from the phrase counter", () => {
      const result = classifySession({
        next_steps: ["follow-up on the verification"],
      });
      // Pre-calibration: "follow-up on" phrase fired (1 reasoning).
      // Post-calibration: phrase removed, so reasoning is 0.
      // verif prefix still matches "verification" (1 executional).
      expect(result.scores.reasoning_heavy).toBe(0);
      expect(result.scores.executional).toBe(1);
    });
  });

  describe("F7: regression guard — real S108→S109 next_steps sample yields mixed", () => {
    it("S109 next_steps reach mixed via genuine keyword scoring (not the empty-input default)", () => {
      // Pre-calibration: this exact bundle hit reasoning=0, executional=0
      // and reached the empty-input default branch (which also returns
      // mixed). Post-calibration: the keywords actually score and the
      // verdict survives the calibration as `mixed`.
      const result = classifySession({
        next_steps: [
          "Verify D-193 boot gate end-to-end",
          "Scope the D-193 Piece 3 brief",
          "Audit the classifier keyword lists",
          "Investigate the empty-input default branch behavior",
          "Update the persisted recommendation block",
          "Push the calibration brief",
        ],
      });
      expect(result.category).toBe("mixed");
      // Sanity check — the verdict is NOT reached via the empty-input
      // default branch any more.
      expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
      expect(result.scores.executional).toBeGreaterThan(0);
    });
  });
});

// Historical-session regression guard (brief-415 B.3).
//
// Five representative sessions from the past 12 — the post-calibration
// classifier must reach the same verdict a reader of the session-log would
// reach when characterizing the work. Fixtures hand-curated from the
// resumption-point text in `brdonath1/prism:.prism/session-log.md`; cited
// inline so the reasoning is auditable.
describe("classifySession — historical regression guard (brief-415 B.3)", () => {
  it("S98 → reasoning_heavy (forensic root-cause work, INS-225 logged)", () => {
    // Reconstructed from S98 session-log Focus + Key outcomes — diagnosis
    // chain for the failure that produced INS-225.
    const result = classifySession({
      next_steps: [
        "Diagnose root cause of authentication regression",
        "Investigate failure mode and propose mitigation",
        "Analyze the boot logs for the failure signature",
      ],
    });
    expect(result.category).toBe("reasoning_heavy");
  });

  it("S104 → executional (trigger-channel.md authoring + enrollment audit)", () => {
    // Reconstructed from S104 session-log Focus — trigger-channel.md spec
    // authoring plus a deterministic batch-enrollment migration.
    const result = classifySession({
      next_steps: [
        "Author the trigger-channel.md specification",
        "Apply pending-doc-updates batch enrollment",
        "Push enrollment marker files for 9 projects",
        "Audit the enrollment-marker file integrity",
      ],
    });
    expect(result.category).toBe("executional");
  });

  it("S101 → mixed (boot verification + 17-branch sweep + emergency D-187 pin)", () => {
    // Reconstructed from S101 session-log — verification + investigation +
    // pin work; mixed character is the operator-validated read.
    const result = classifySession({
      next_steps: [
        "Verify D-187 boot gate behavior",
        "Investigate the boot regression cause",
        "Analyze the 17-branch sweep impact",
        "Pin the viper-static-config in lockfile",
      ],
    });
    expect(result.category).toBe("mixed");
  });

  it("S106 → reasoning_heavy (D-191 five-phase strategy brainstorming)", () => {
    // Reconstructed from S106 session-log Focus — D-191 token-reduction
    // strategy brainstorming + design + comparison.
    const result = classifySession({
      next_steps: [
        "Brainstorm the five-phase strategy options",
        "Design the rollout phases and tradeoffs",
        "Compare alternative phase orderings",
        "Investigate D-191 historical context",
      ],
    });
    expect(result.category).toBe("reasoning_heavy");
  });

  it("S109 → mixed (verification gates + scoping decision + audit)", () => {
    // Reconstructed from S109 session-log Focus — D-193 Piece 1 verification
    // + Piece 3 scoping + classifier-calibration audit.
    const result = classifySession({
      next_steps: [
        "Verify D-193 boot gate end-to-end",
        "Scope the D-193 Piece 3 brief",
        "Audit the classifier keyword lists",
        "Investigate the empty-input default branch behavior",
        "Update the persisted recommendation block",
        "Push the calibration brief",
      ],
    });
    expect(result.category).toBe("mixed");
  });
});

// brief-411 / D-193 Piece 1 — persisted recommendation parser + injector.

const HANDOFF_SHELL = `# Handoff

## Meta
- Handoff Version: 113
- Session Count: 108
- Template Version: v2.16.0
- Status: Active

## Critical Context
1. Test context.

## Where We Are
Working on tests.

<!-- EOF: handoff.md -->`;

describe("parsePersistedRecommendation", () => {
  it("parses a well-formed reasoning_heavy block", () => {
    const block = `## Recommended Session Settings

<!-- prism:recommended_session_settings -->
- Model: Opus 4.7
- Thinking: Adaptive on
- Category: reasoning_heavy
- Rationale: Queue includes design / multi-doc investigation
<!-- /prism:recommended_session_settings -->`;
    const result = parsePersistedRecommendation(block);
    expect(result).not.toBeNull();
    expect(result?.category).toBe("reasoning_heavy");
    expect(result?.model).toBe("opus-4-7");
    expect(result?.thinking).toBe("adaptive-on");
    expect(result?.display).toBe("Opus 4.7 · Adaptive on");
    expect(result?.rationale).toBe("Queue includes design / multi-doc investigation");
    expect(result?.scores).toEqual({ reasoning_heavy: 0, executional: 0 });
  });

  it("parses an executional block", () => {
    const block = `<!-- prism:recommended_session_settings -->
- Model: Sonnet 4.6
- Thinking: Adaptive off
- Category: executional
- Rationale: Queue is mechanical cleanup / patches
<!-- /prism:recommended_session_settings -->`;
    const result = parsePersistedRecommendation(block);
    expect(result?.category).toBe("executional");
    expect(result?.model).toBe("sonnet-4-6");
    expect(result?.thinking).toBe("adaptive-off");
    expect(result?.display).toBe("Sonnet 4.6 · Adaptive off");
  });

  it("parses a mixed block", () => {
    const block = `<!-- prism:recommended_session_settings -->
- Model: Opus 4.7
- Thinking: Adaptive off
- Category: mixed
- Rationale: Mixed queue — execution with some judgment
<!-- /prism:recommended_session_settings -->`;
    const result = parsePersistedRecommendation(block);
    expect(result?.category).toBe("mixed");
    expect(result?.model).toBe("opus-4-7");
    expect(result?.thinking).toBe("adaptive-off");
  });

  it("returns null when the block is absent", () => {
    expect(parsePersistedRecommendation(HANDOFF_SHELL)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const block = `<!-- prism:recommended_session_settings -->
- Model: Opus 4.7
- Thinking: Adaptive on
- Rationale: missing the Category field
<!-- /prism:recommended_session_settings -->`;
    expect(parsePersistedRecommendation(block)).toBeNull();
  });

  it("returns null when the category value is invalid", () => {
    const block = `<!-- prism:recommended_session_settings -->
- Model: Opus 4.7
- Thinking: Adaptive on
- Category: bogus_category
- Rationale: bad category
<!-- /prism:recommended_session_settings -->`;
    expect(parsePersistedRecommendation(block)).toBeNull();
  });

  it("tolerates extra whitespace around field values", () => {
    const block = `<!-- prism:recommended_session_settings -->
-    Model:    Opus 4.7
-   Thinking:   Adaptive on
- Category:    reasoning_heavy
-  Rationale:   spaced rationale
<!-- /prism:recommended_session_settings -->`;
    const result = parsePersistedRecommendation(block);
    expect(result).not.toBeNull();
    expect(result?.category).toBe("reasoning_heavy");
    expect(result?.display).toBe("Opus 4.7 · Adaptive on");
    expect(result?.rationale).toBe("spaced rationale");
  });
});

describe("injectPersistedRecommendation", () => {
  const reasoningRec = classifySession({
    next_steps: ["Design the orchestrator", "Investigate prior art"],
  });

  it("returns null when ## Meta section is absent", () => {
    const noMeta = `# Handoff

## Critical Context
1. No meta here.

<!-- EOF: handoff.md -->`;
    expect(injectPersistedRecommendation(noMeta, reasoningRec)).toBeNull();
  });

  it("inserts the block immediately after ## Meta and before the next ## section", () => {
    const result = injectPersistedRecommendation(HANDOFF_SHELL, reasoningRec);
    expect(result).not.toBeNull();
    expect(result).toContain("<!-- prism:recommended_session_settings -->");
    expect(result).toContain("- Category: reasoning_heavy");

    // Block must appear after ## Meta and before ## Critical Context.
    const metaIdx = result!.indexOf("## Meta");
    const blockIdx = result!.indexOf("## Recommended Session Settings");
    const criticalIdx = result!.indexOf("## Critical Context");
    expect(metaIdx).toBeLessThan(blockIdx);
    expect(blockIdx).toBeLessThan(criticalIdx);

    // EOF sentinel must still be present at end of file.
    expect(result!.trimEnd().endsWith("<!-- EOF: handoff.md -->")).toBe(true);
  });

  it("round-trips back to the same recommendation when re-parsed", () => {
    const mutated = injectPersistedRecommendation(HANDOFF_SHELL, reasoningRec);
    const reparsed = parsePersistedRecommendation(mutated!);
    expect(reparsed?.category).toBe(reasoningRec.category);
    expect(reparsed?.model).toBe(reasoningRec.model);
    expect(reparsed?.thinking).toBe(reasoningRec.thinking);
    expect(reparsed?.rationale).toBe(reasoningRec.rationale);
    expect(reparsed?.display).toBe(reasoningRec.display);
  });

  it("replaces an existing block in place rather than duplicating", () => {
    const stale = injectPersistedRecommendation(HANDOFF_SHELL, reasoningRec);
    const executionalRec = classifySession({
      next_steps: ["Cleanup, patch, push, verify"],
    });
    expect(executionalRec.category).toBe("executional");

    const replaced = injectPersistedRecommendation(stale!, executionalRec);
    expect(replaced).not.toBeNull();

    // Exactly one occurrence of the opening delimiter.
    const opens = (replaced!.match(/<!-- prism:recommended_session_settings -->/g) ?? []).length;
    expect(opens).toBe(1);
    // Exactly one Category line, with the new value.
    expect(replaced).toContain("- Category: executional");
    expect(replaced).not.toContain("- Category: reasoning_heavy");
  });

  it("is idempotent — same input twice yields the same output", () => {
    const once = injectPersistedRecommendation(HANDOFF_SHELL, reasoningRec);
    const twice = injectPersistedRecommendation(once!, reasoningRec);
    expect(twice).toBe(once);
  });
});
