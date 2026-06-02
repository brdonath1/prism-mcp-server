/**
 * Unit tests for the pure logic in scripts/check-model-freshness.mjs.
 *
 * These import the exported functions directly — no network, filesystem,
 * or gh CLI side-effects. The Anthropic models list is mocked inline.
 */

import { describe, it, expect } from "vitest";
import {
  KNOWN_FAMILIES,
  parseModelIdentifier,
  findNewestInFamily,
  isPinStale,
  extractPins,
  // @ts-expect-error — .mjs has no type declarations; runtime import works fine
} from "../scripts/check-model-freshness.mjs";

// ─── parseModelIdentifier ────────────────────────────────────────────

describe("parseModelIdentifier", () => {
  it("parses recommendation pin short form (family-major-minor)", () => {
    expect(parseModelIdentifier("opus-4-8")).toEqual({
      family: "opus",
      version: [4, 8],
    });
    expect(parseModelIdentifier("sonnet-4-6")).toEqual({
      family: "sonnet",
      version: [4, 6],
    });
    expect(parseModelIdentifier("haiku-3-5")).toEqual({
      family: "haiku",
      version: [3, 5],
    });
  });

  it("parses API model id with claude- prefix", () => {
    expect(parseModelIdentifier("claude-opus-4-7")).toEqual({
      family: "opus",
      version: [4, 7],
    });
    expect(parseModelIdentifier("claude-sonnet-4-5")).toEqual({
      family: "sonnet",
      version: [4, 5],
    });
  });

  it("parses legacy date-suffixed format", () => {
    expect(parseModelIdentifier("claude-3-5-sonnet-20241022")).toEqual({
      family: "sonnet",
      version: [3, 5],
    });
    expect(parseModelIdentifier("claude-3-opus-20240229")).toEqual({
      family: "opus",
      version: [3, 0],
    });
  });

  it("handles family-major without minor", () => {
    expect(parseModelIdentifier("opus-5")).toEqual({
      family: "opus",
      version: [5, 0],
    });
    expect(parseModelIdentifier("claude-haiku-4")).toEqual({
      family: "haiku",
      version: [4, 0],
    });
  });

  it("returns null for unrecognized family", () => {
    expect(parseModelIdentifier("gpt-4")).toBeNull();
    expect(parseModelIdentifier("claude-turbo-3")).toBeNull();
    expect(parseModelIdentifier("gemini-pro")).toBeNull();
    expect(parseModelIdentifier("claude-mega-5-0")).toBeNull();
  });

  it("returns null for empty or non-string input", () => {
    expect(parseModelIdentifier("")).toBeNull();
    expect(parseModelIdentifier(null)).toBeNull();
    expect(parseModelIdentifier(undefined)).toBeNull();
  });
});

// ─── findNewestInFamily ──────────────────────────────────────────────

describe("findNewestInFamily", () => {
  const mockModels = [
    {
      id: "claude-opus-4-7",
      display_name: "Opus 4.7",
      created_at: "2025-01-15T00:00:00Z",
    },
    {
      id: "claude-opus-4-8",
      display_name: "Opus 4.8",
      created_at: "2025-06-01T00:00:00Z",
    },
    {
      id: "claude-opus-4-9",
      display_name: "Opus 4.9",
      created_at: "2025-12-01T00:00:00Z",
    },
    {
      id: "claude-sonnet-4-5",
      display_name: "Sonnet 4.5",
      created_at: "2025-03-01T00:00:00Z",
    },
    {
      id: "claude-sonnet-4-6",
      display_name: "Sonnet 4.6",
      created_at: "2025-06-01T00:00:00Z",
    },
    {
      id: "claude-sonnet-5-0",
      display_name: "Sonnet 5.0",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      id: "claude-3-5-sonnet-20241022",
      display_name: "Claude 3.5 Sonnet",
      created_at: "2024-10-22T00:00:00Z",
    },
  ];

  it("returns the highest-versioned model in the requested family", () => {
    const newest = findNewestInFamily(mockModels, "opus");
    expect(newest.id).toBe("claude-opus-4-9");
    expect(newest._parsed.version).toEqual([4, 9]);
  });

  it("returns null when no models match the family", () => {
    expect(findNewestInFamily(mockModels, "haiku")).toBeNull();
  });

  it("uses created_at as tiebreak for equal versions", () => {
    const tieModels = [
      {
        id: "claude-opus-4-8",
        display_name: "Opus 4.8 (early)",
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "claude-opus-4-8",
        display_name: "Opus 4.8 (late)",
        created_at: "2025-06-01T00:00:00Z",
      },
    ];
    const newest = findNewestInFamily(tieModels, "opus");
    expect(newest.display_name).toBe("Opus 4.8 (late)");
  });

  it("prefers major version over minor", () => {
    const models = [
      {
        id: "claude-sonnet-4-99",
        display_name: "Sonnet 4.99",
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        id: "claude-sonnet-5-0",
        display_name: "Sonnet 5.0",
        created_at: "2025-06-01T00:00:00Z",
      },
    ];
    const newest = findNewestInFamily(models, "sonnet");
    expect(newest._parsed.version).toEqual([5, 0]);
  });
});

// ─── isPinStale ──────────────────────────────────────────────────────

describe("isPinStale", () => {
  it("detects newer minor version in-family", () => {
    expect(isPinStale([4, 8], [4, 9])).toBe(true);
  });

  it("detects newer major version in-family", () => {
    expect(isPinStale([4, 8], [5, 0])).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isPinStale([4, 8], [4, 8])).toBe(false);
  });

  it("returns false when newest is actually older", () => {
    expect(isPinStale([4, 8], [4, 7])).toBe(false);
    expect(isPinStale([5, 0], [4, 9])).toBe(false);
  });
});

// ─── Cross-family isolation ──────────────────────────────────────────

describe("cross-family isolation", () => {
  it("does NOT mark opus stale when only sonnet has a newer model", () => {
    const models = [
      {
        id: "claude-opus-4-8",
        display_name: "Opus 4.8",
        created_at: "2025-06-01T00:00:00Z",
      },
      {
        id: "claude-sonnet-5-0",
        display_name: "Sonnet 5.0",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];

    // The opus pin is 4-8; the newest opus in the list is also 4-8 → not stale
    const newestOpus = findNewestInFamily(models, "opus");
    expect(newestOpus._parsed.version).toEqual([4, 8]);
    expect(isPinStale([4, 8], newestOpus._parsed.version)).toBe(false);

    // Meanwhile sonnet IS newer — but that is a DIFFERENT family check
    const newestSonnet = findNewestInFamily(models, "sonnet");
    expect(newestSonnet._parsed.version).toEqual([5, 0]);
    expect(isPinStale([4, 6], newestSonnet._parsed.version)).toBe(true);
  });

  it("newer haiku does not affect an opus pin", () => {
    const models = [
      {
        id: "claude-opus-4-8",
        display_name: "Opus 4.8",
        created_at: "2025-06-01T00:00:00Z",
      },
      {
        id: "claude-haiku-6-0",
        display_name: "Haiku 6.0",
        created_at: "2026-06-01T00:00:00Z",
      },
    ];

    const newestOpus = findNewestInFamily(models, "opus");
    expect(newestOpus._parsed.version).toEqual([4, 8]);
    expect(isPinStale([4, 8], newestOpus._parsed.version)).toBe(false);
  });
});

// ─── Unrecognized family detection ───────────────────────────────────

describe("unrecognized family detection", () => {
  it("returns null for unknown families, signalling the script to create an issue", () => {
    expect(parseModelIdentifier("claude-mega-5-0")).toBeNull();
    expect(parseModelIdentifier("claude-pro-2-1")).toBeNull();
    expect(parseModelIdentifier("ultra-7-0")).toBeNull();
  });

  it("all KNOWN_FAMILIES are parseable", () => {
    for (const family of KNOWN_FAMILIES) {
      const result = parseModelIdentifier(`${family}-1-0`);
      expect(result).not.toBeNull();
      expect(result.family).toBe(family);
    }
  });
});

// ─── extractPins ─────────────────────────────────────────────────────

describe("extractPins", () => {
  const sampleFile = `
export const RECOMMENDATION_MODELS = {
  reasoning_heavy: { code: "opus-4-8", display: "Opus 4.8" },
  mixed: { code: "opus-4-8", display: "Opus 4.8" },
  executional: { code: "sonnet-4-6", display: "Sonnet 4.6" },
} as const;

export const SYNTHESIS_MODEL_ID = "claude-opus-4-7";
`;

  it("extracts all recommendation pins", () => {
    const { recommendations } = extractPins(sampleFile);
    expect(recommendations).toHaveLength(3);
    expect(recommendations[0]).toEqual({
      category: "reasoning_heavy",
      code: "opus-4-8",
      display: "Opus 4.8",
    });
    expect(recommendations[2]).toEqual({
      category: "executional",
      code: "sonnet-4-6",
      display: "Sonnet 4.6",
    });
  });

  it("extracts the synthesis model id", () => {
    const { synthesisId } = extractPins(sampleFile);
    expect(synthesisId).toBe("claude-opus-4-7");
  });

  it("returns null synthesisId when not present", () => {
    const { synthesisId } = extractPins("const x = 1;");
    expect(synthesisId).toBeNull();
  });
});
