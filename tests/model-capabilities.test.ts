/**
 * brief-s5 — Model Capability Registry (model x surface context windows).
 *
 * These tests are the executable half of the brief's core claim: a context
 * window is a property of (model, surface), NOT of a model alone. The S5
 * failure was cross-surface substitution — an API figure carried into the chat
 * column — so the assertions below deliberately pin each surface separately and
 * assert that a model's surfaces DISAGREE where the sources disagree.
 *
 * Pure data + pure functions. No network, no filesystem, no env.
 */

import { describe, it, expect } from "vitest";
import {
  CONTEXT_WINDOW_FLOOR_TOKENS,
  MODEL_CAPABILITIES,
  REGISTRY_AS_OF,
  STALENESS_THRESHOLD_DAYS,
  normalizeModelKey,
  resolveContextWindow,
} from "../src/models.js";

/** Fixed clock so stale_days assertions never drift with wall time. */
const AT_SEED = new Date("2026-07-31T00:00:00Z");
const PLUS_45_DAYS = new Date("2026-09-14T00:00:00Z"); // 45 days after seed
const PLUS_200_DAYS = new Date("2027-02-16T00:00:00Z"); // 200 days after seed

// ─── Registry shape ──────────────────────────────────────────────────

describe("MODEL_CAPABILITIES shape", () => {
  it("every cell carries tokens, a provenance tag, and an ISO date", () => {
    for (const [key, capability] of Object.entries(MODEL_CAPABILITIES)) {
      expect(capability.display, `${key}.display`).toBeTruthy();
      for (const surface of ["chat", "claude_code", "api"] as const) {
        const cell = capability[surface];
        if (!cell) continue;
        expect(typeof cell.tokens, `${key}.${surface}.tokens`).toBe("number");
        expect(cell.tokens, `${key}.${surface}.tokens`).toBeGreaterThan(0);
        expect(
          ["documented", "inferred", "observed", "undocumented_floor"],
          `${key}.${surface}.source`,
        ).toContain(cell.source);
        expect(cell.as_of, `${key}.${surface}.as_of`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it("non-documented cells explain themselves (the note is load-bearing, not decorative)", () => {
    for (const [key, capability] of Object.entries(MODEL_CAPABILITIES)) {
      for (const surface of ["chat", "claude_code", "api"] as const) {
        const cell = capability[surface];
        if (!cell || cell.source === "documented") continue;
        expect(cell.note, `${key}.${surface}.note`).toBeTruthy();
      }
    }
  });
});

// ─── chat column ─────────────────────────────────────────────────────

describe("resolveContextWindow — chat surface", () => {
  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-opus-4-8", 500_000],
    ["claude-opus-4-7", 500_000],
    ["claude-opus-4-6", 500_000],
    ["claude-sonnet-4-6", 500_000],
    ["claude-haiku-4-5", 200_000],
  ])("%s resolves to %i documented tokens", (model, tokens) => {
    const r = resolveContextWindow(model, "chat", AT_SEED);
    expect(r.tokens).toBe(tokens);
    expect(r.source).toBe("documented");
    expect(r.fallback_reason).toBeUndefined();
  });

  it("Fable 5 chat is the undocumented floor — its 1M API figure must NOT carry across", () => {
    const chat = resolveContextWindow("claude-fable-5", "chat", AT_SEED);
    expect(chat.tokens).toBe(200_000);
    expect(chat.source).toBe("undocumented_floor");
    expect(chat.matched).toBe("fable-5");
    // The disproof of substitution: same model, different surface, 5x apart.
    const api = resolveContextWindow("claude-fable-5", "api", AT_SEED);
    expect(api.tokens).toBe(1_000_000);
    expect(api.source).toBe("documented");
  });

  it("Sonnet 4.5 chat is inferred from the 'and older' catch-all, not documented", () => {
    const r = resolveContextWindow("claude-sonnet-4-5", "chat", AT_SEED);
    expect(r.tokens).toBe(200_000);
    expect(r.source).toBe("inferred");
  });

  it("Opus 4.6 disagrees across chat and api — 500K vs 1M (the documented disproof)", () => {
    expect(resolveContextWindow("claude-opus-4-6", "chat", AT_SEED).tokens).toBe(500_000);
    expect(resolveContextWindow("claude-opus-4-6", "api", AT_SEED).tokens).toBe(1_000_000);
  });
});

// ─── claude_code column ──────────────────────────────────────────────

describe("resolveContextWindow — claude_code surface (Max)", () => {
  it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"])(
    "%s resolves to 1M documented on Claude Code",
    (model) => {
      const r = resolveContextWindow(model, "claude_code", AT_SEED);
      expect(r.tokens).toBe(1_000_000);
      expect(r.source).toBe("documented");
    },
  );

  it("Sonnet 4.6's Pro usage-credit condition is recorded as documentation, not resolution logic", () => {
    const cell = MODEL_CAPABILITIES["sonnet-4-6"].claude_code;
    expect(cell?.plan_note).toMatch(/credit/i);
    // Inert on Max: the resolved value is unconditional.
    expect(resolveContextWindow("claude-sonnet-4-6", "claude_code", AT_SEED).tokens).toBe(1_000_000);
  });

  it("Fable 5 IS 1M on Claude Code even though it is the floor in chat", () => {
    expect(resolveContextWindow("claude-fable-5", "claude_code", AT_SEED).tokens).toBe(1_000_000);
    expect(resolveContextWindow("claude-fable-5", "chat", AT_SEED).tokens).toBe(200_000);
  });
});

// ─── api column ──────────────────────────────────────────────────────

describe("resolveContextWindow — api surface", () => {
  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-opus-4-8", 1_000_000],
    ["claude-opus-4-7", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-fable-5", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["claude-mythos-preview", 1_000_000],
    ["claude-haiku-4-5", 200_000],
    ["claude-sonnet-4-5", 200_000],
  ])("%s resolves to %i tokens", (model, tokens) => {
    const r = resolveContextWindow(model, "api", AT_SEED);
    expect(r.tokens).toBe(tokens);
    expect(r.source).toBe("documented");
  });
});

// ─── floor / degradation paths ───────────────────────────────────────

describe("resolveContextWindow — degradation to a disclosed floor", () => {
  it("unknown model returns the floor with a fallback_reason, and never throws", () => {
    const r = resolveContextWindow("gpt-5", "chat", AT_SEED);
    expect(r.tokens).toBe(CONTEXT_WINDOW_FLOOR_TOKENS);
    expect(r.source).toBe("undocumented_floor");
    expect(r.matched).toBeNull();
    expect(r.fallback_reason).toContain("unknown_model");
  });

  it("known model with no cell for the requested surface returns the floor, matched but disclosed", () => {
    // Mythos is API-only — it has no chat cell.
    const r = resolveContextWindow("claude-mythos-5", "chat", AT_SEED);
    expect(r.tokens).toBe(CONTEXT_WINDOW_FLOOR_TOKENS);
    expect(r.source).toBe("undocumented_floor");
    expect(r.matched).toBe("mythos-5");
    expect(r.fallback_reason).toContain("no_cell_for_surface");
  });

  it("unrecognised surface returns the floor rather than throwing", () => {
    const r = resolveContextWindow("claude-opus-5", "desktop" as never, AT_SEED);
    expect(r.tokens).toBe(CONTEXT_WINDOW_FLOOR_TOKENS);
    expect(r.fallback_reason).toContain("unknown_surface");
  });

  it.each([["", "empty string"], [null, "null"], [undefined, "undefined"]])(
    "degrades to the floor for %s input (%s)",
    (model) => {
      const r = resolveContextWindow(model as never, "chat", AT_SEED);
      expect(r.tokens).toBe(CONTEXT_WINDOW_FLOOR_TOKENS);
      expect(r.source).toBe("undocumented_floor");
      expect(r.fallback_reason).toBeTruthy();
    },
  );

  it("never throws for any input shape", () => {
    const inputs = ["", "   ", "claude-", "!!!", "claude-opus", "12345"];
    for (const input of inputs) {
      expect(() => resolveContextWindow(input, "chat", AT_SEED)).not.toThrow();
      expect(resolveContextWindow(input, "chat", AT_SEED).tokens).toBeGreaterThan(0);
    }
  });
});

// ─── model key normalization ─────────────────────────────────────────

describe("normalizeModelKey", () => {
  it.each([
    ["claude-opus-4-8", "opus-4-8"],
    ["opus-4-8", "opus-4-8"],
    ["Opus 4.8", "opus-4-8"],
    ["claude-opus-4-8[1m]", "opus-4-8"],
    ["  claude-sonnet-5  ", "sonnet-5"],
    ["Mythos Preview", "mythos-preview"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeModelKey(input)).toBe(expected);
  });

  it("resolves date-suffixed and -0-suffixed aliases to the same registry cell", () => {
    expect(resolveContextWindow("claude-opus-4-8-20260214", "chat", AT_SEED).matched).toBe("opus-4-8");
    expect(resolveContextWindow("claude-sonnet-5-0", "chat", AT_SEED).matched).toBe("sonnet-5");
  });

  it("accepts the RECOMMENDATION_MODELS short codes the classifier already emits", () => {
    expect(resolveContextWindow("opus-4-8", "chat", AT_SEED).tokens).toBe(500_000);
    expect(resolveContextWindow("sonnet-5", "chat", AT_SEED).tokens).toBe(1_000_000);
  });
});

// ─── staleness ───────────────────────────────────────────────────────

describe("staleness is a first-class signal", () => {
  it("stale_days is measured from the cell's as_of date", () => {
    expect(resolveContextWindow("claude-opus-5", "chat", AT_SEED).stale_days).toBe(0);
    expect(resolveContextWindow("claude-opus-5", "chat", PLUS_45_DAYS).stale_days).toBe(45);
  });

  it("low-confidence cells expire faster than documented ones", () => {
    expect(STALENESS_THRESHOLD_DAYS.documented).toBe(180);
    expect(STALENESS_THRESHOLD_DAYS.inferred).toBe(30);
    expect(STALENESS_THRESHOLD_DAYS.observed).toBe(30);
    expect(STALENESS_THRESHOLD_DAYS.undocumented_floor).toBe(30);

    // At +45d the undocumented_floor cell is stale but the documented one is not.
    expect(resolveContextWindow("claude-fable-5", "chat", PLUS_45_DAYS).stale).toBe(true);
    expect(resolveContextWindow("claude-opus-5", "chat", PLUS_45_DAYS).stale).toBe(false);

    // At +200d even the documented cell has expired.
    expect(resolveContextWindow("claude-opus-5", "chat", PLUS_200_DAYS).stale).toBe(true);
  });

  it("the synthetic floor is dated from the registry seed so it also expires", () => {
    const r = resolveContextWindow("gpt-5", "chat", PLUS_45_DAYS);
    expect(r.as_of).toBe(REGISTRY_AS_OF);
    expect(r.stale).toBe(true);
  });

  it("stale_days never goes negative for a clock behind the as_of date", () => {
    const r = resolveContextWindow("claude-opus-5", "chat", new Date("2020-01-01T00:00:00Z"));
    expect(r.stale_days).toBe(0);
    expect(r.stale).toBe(false);
  });
});

// ─── guardrail: no cross-surface promotion ───────────────────────────

describe("guardrail — API evidence must never promote a chat cell", () => {
  it("every model whose api cell is 1M but chat cell is NOT 1M keeps them apart", () => {
    const divergent = Object.entries(MODEL_CAPABILITIES).filter(
      ([, c]) => c.api && c.chat && c.api.tokens !== c.chat.tokens,
    );
    // If this list ever empties, the two columns have been silently merged.
    expect(divergent.length).toBeGreaterThan(0);
    for (const [key, c] of divergent) {
      expect(resolveContextWindow(key, "chat", AT_SEED).tokens).toBe(c.chat?.tokens);
      expect(resolveContextWindow(key, "api", AT_SEED).tokens).toBe(c.api?.tokens);
    }
  });

  it("no chat cell claims 'documented' at a value only the api column supports", () => {
    for (const [key, c] of Object.entries(MODEL_CAPABILITIES)) {
      if (!c.chat || !c.api) continue;
      if (c.chat.source !== "documented") continue;
      // A documented chat cell is fine at any value — it just must not have
      // been copied from api without its own statement. The ref proves it.
      expect(c.chat.ref, `${key}.chat.ref`).toBeTruthy();
    }
  });
});
