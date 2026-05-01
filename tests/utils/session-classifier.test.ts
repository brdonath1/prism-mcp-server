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

  it("opening_message gets 2x weight and can flip the verdict", () => {
    const reasoningQueue = [
      "Design new module",
      "Architect the system",
      "Investigate prior art",
    ];

    // Without an opening message: reasoning_heavy queue dominates.
    const baseline = classifySession({ next_steps: reasoningQueue });
    expect(baseline.category).toBe("reasoning_heavy");

    // With a heavily executional opening message (5 hits × 2 = 10),
    // executional score (10) overcomes the reasoning queue (3) and the
    // ratio drops to 0.3, flipping the verdict to executional.
    const flipped = classifySession({
      next_steps: reasoningQueue,
      opening_message:
        "Just need to cleanup, patch, push, verify, and bump the changelog",
    });
    expect(flipped.category).toBe("executional");
    expect(flipped.scores.executional).toBeGreaterThan(flipped.scores.reasoning_heavy);
  });

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

  it("includes critical_context in scoring on the boot path", () => {
    const result = classifySession({
      next_steps: [],
      critical_context: ["Investigate the production outage", "Analyze recent commits"],
    });
    expect(result.scores.reasoning_heavy).toBeGreaterThan(0);
    expect(result.category).toBe("reasoning_heavy");
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
      next_steps: ["Add logging to the dispatcher"],
    });
    // Bare "log" keyword should not match the substring "logging".
    expect(result.scores.executional).toBe(0);
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
