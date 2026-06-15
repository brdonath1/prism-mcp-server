/**
 * Env-overridable recommendation model
 * (feat/recommendation-model-env-override).
 *
 * RECOMMENDATION_MODELS in src/models.ts provides the per-category DEFAULT;
 * a deployment overrides the recommended model per category via env without a
 * code edit — matching the SYNTHESIS_MODEL / CC_DISPATCH_MODEL pattern, but the
 * override lives at the CONSUMER (the classifier), never in the `as const`
 * registry (whose literal shape the freshness automation regex-parses).
 *
 * Env vars (each an Anthropic model id, e.g. "claude-opus-4-8"):
 *   RECOMMENDATION_MODEL_REASONING    → reasoning_heavy
 *   RECOMMENDATION_MODEL_MIXED        → mixed (falls back to REASONING, then registry)
 *   RECOMMENDATION_MODEL_EXECUTIONAL  → executional
 *
 * Behavior pinned through the public classifySession /
 * parsePersistedRecommendation API rather than the resolver internals.
 */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECOMMENDATION_MODELS } from "../../src/models.js";
import { logger } from "../../src/utils/logger.js";
import {
  classifySession,
  parsePersistedRecommendation,
} from "../../src/utils/session-classifier.js";
import {
  extractPins,
  // @ts-expect-error — .mjs has no type declarations; runtime import works fine
} from "../../scripts/check-model-freshness.mjs";

const ENV_VARS = [
  "RECOMMENDATION_MODEL_REASONING",
  "RECOMMENDATION_MODEL_MIXED",
  "RECOMMENDATION_MODEL_EXECUTIONAL",
] as const;

// Proven category fixtures (reused from session-classifier.test.ts so the
// classification verdict is not itself under test here — only the model the
// verdict resolves to).
const REASONING_STEPS = [
  "Design the new orchestration architecture",
  "Brainstorm tradeoffs and compare strategy options",
  "Investigate the failure mode and propose a fix",
];
const EXECUTIONAL_STEPS = [
  "Cleanup INS-223 dead-config references in handoff.md",
  "Patch task-queue to demote stale items",
  "Push the updated boot-test fixture",
];
const MIXED_STEPS = ["Debug the regression", "Verify the fix"];

let original: Record<string, string | undefined>;

beforeEach(() => {
  original = {};
  for (const key of ENV_VARS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_VARS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  vi.restoreAllMocks();
});

describe("recommendation model env override", () => {
  it("all env unset → registry defaults per category", () => {
    const r = classifySession({ next_steps: REASONING_STEPS });
    expect(r.category).toBe("reasoning_heavy");
    expect(r.model).toBe(RECOMMENDATION_MODELS.reasoning_heavy.code);
    expect(r.display).toBe(`${RECOMMENDATION_MODELS.reasoning_heavy.display} · Adaptive on`);

    const e = classifySession({ next_steps: EXECUTIONAL_STEPS });
    expect(e.category).toBe("executional");
    expect(e.model).toBe(RECOMMENDATION_MODELS.executional.code);
    expect(e.display).toBe(`${RECOMMENDATION_MODELS.executional.display} · Adaptive off`);

    const m = classifySession({ next_steps: MIXED_STEPS });
    expect(m.category).toBe("mixed");
    expect(m.model).toBe(RECOMMENDATION_MODELS.mixed.code);
    expect(m.display).toBe(`${RECOMMENDATION_MODELS.mixed.display} · Adaptive off`);
  });

  it("RECOMMENDATION_MODEL_REASONING overrides reasoning_heavy AND (via fallback) mixed; executional unchanged", () => {
    process.env.RECOMMENDATION_MODEL_REASONING = "claude-opus-4-8";

    const r = classifySession({ next_steps: REASONING_STEPS });
    expect(r.category).toBe("reasoning_heavy");
    expect(r.model).toBe("opus-4-8");
    expect(r.display).toBe("Opus 4.8 · Adaptive on");

    // mixed has no own override → falls back to REASONING
    const m = classifySession({ next_steps: MIXED_STEPS });
    expect(m.category).toBe("mixed");
    expect(m.model).toBe("opus-4-8");
    expect(m.display).toBe("Opus 4.8 · Adaptive off");

    // executional has its own (unset) var → registry default, untouched
    const e = classifySession({ next_steps: EXECUTIONAL_STEPS });
    expect(e.category).toBe("executional");
    expect(e.model).toBe(RECOMMENDATION_MODELS.executional.code);
    expect(e.display).toBe(`${RECOMMENDATION_MODELS.executional.display} · Adaptive off`);
  });

  it("RECOMMENDATION_MODEL_MIXED overrides only mixed", () => {
    process.env.RECOMMENDATION_MODEL_MIXED = "claude-opus-4-8";

    expect(classifySession({ next_steps: MIXED_STEPS }).model).toBe("opus-4-8");
    expect(classifySession({ next_steps: REASONING_STEPS }).model).toBe(
      RECOMMENDATION_MODELS.reasoning_heavy.code,
    );
    expect(classifySession({ next_steps: EXECUTIONAL_STEPS }).model).toBe(
      RECOMMENDATION_MODELS.executional.code,
    );
  });

  it("mixed precedence: MIXED wins over REASONING when both are set", () => {
    process.env.RECOMMENDATION_MODEL_MIXED = "claude-haiku-4-5";
    process.env.RECOMMENDATION_MODEL_REASONING = "claude-opus-4-8";

    expect(classifySession({ next_steps: MIXED_STEPS }).model).toBe("haiku-4-5");
    expect(classifySession({ next_steps: REASONING_STEPS }).model).toBe("opus-4-8");
  });

  it("RECOMMENDATION_MODEL_EXECUTIONAL overrides only executional", () => {
    process.env.RECOMMENDATION_MODEL_EXECUTIONAL = "claude-opus-4-8";

    const e = classifySession({ next_steps: EXECUTIONAL_STEPS });
    expect(e.model).toBe("opus-4-8");
    expect(e.display).toBe("Opus 4.8 · Adaptive off");

    expect(classifySession({ next_steps: REASONING_STEPS }).model).toBe(
      RECOMMENDATION_MODELS.reasoning_heavy.code,
    );
    expect(classifySession({ next_steps: MIXED_STEPS }).model).toBe(
      RECOMMENDATION_MODELS.mixed.code,
    );
  });

  it("strips a [1m] long-context suffix when deriving the short code", () => {
    process.env.RECOMMENDATION_MODEL_REASONING = "claude-sonnet-4-6[1m]";
    const r = classifySession({ next_steps: REASONING_STEPS });
    expect(r.model).toBe("sonnet-4-6");
    expect(r.display).toBe("Sonnet 4.6 · Adaptive on");
  });

  it("garbage env value → registry default + a logged warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.RECOMMENDATION_MODEL_REASONING = "not-a-model";

    const r = classifySession({ next_steps: REASONING_STEPS });
    expect(r.model).toBe(RECOMMENDATION_MODELS.reasoning_heavy.code);
    expect(r.display).toBe(`${RECOMMENDATION_MODELS.reasoning_heavy.display} · Adaptive on`);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("blank/whitespace env value is treated as unset (registry default, no warning)", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.RECOMMENDATION_MODEL_REASONING = "   ";

    const r = classifySession({ next_steps: REASONING_STEPS });
    expect(r.model).toBe(RECOMMENDATION_MODELS.reasoning_heavy.code);
    expect(warn).not.toHaveBeenCalled();
  });

  it("parsePersistedRecommendation resolves model via env override while preserving persisted display text", () => {
    process.env.RECOMMENDATION_MODEL_REASONING = "claude-opus-4-8";
    const block = `<!-- prism:recommended_session_settings -->
- Model: Fable 5
- Thinking: Adaptive on
- Category: reasoning_heavy
- Rationale: Queue includes design / multi-doc investigation
<!-- /prism:recommended_session_settings -->`;

    const r = parsePersistedRecommendation(block);
    expect(r).not.toBeNull();
    // `model` (code) follows the live env override...
    expect(r?.model).toBe("opus-4-8");
    // ...while `display` is reconstructed from the persisted text verbatim.
    expect(r?.display).toBe("Fable 5 · Adaptive on");
  });
});

describe("freshness automation contract", () => {
  it("extractPins still parses the real src/models.ts registry shape", () => {
    const modelsPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/models.ts",
    );
    const content = readFileSync(modelsPath, "utf-8");
    const { recommendations, synthesisId, ccDispatchId } = extractPins(content);

    expect(recommendations).toHaveLength(3);
    for (const rec of recommendations) {
      expect(rec.code).toBeTruthy();
      expect(rec.display).toBeTruthy();
      expect(rec.id).toBeTruthy();
    }
    expect(synthesisId).toBeTruthy();
    expect(ccDispatchId).toBeTruthy();
  });
});
