/**
 * Session classifier tests (brief-405 / D-191).
 */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { classifySession } from "../../src/utils/session-classifier.js";

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
