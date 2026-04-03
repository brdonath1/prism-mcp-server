// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { extractJSON } from "../src/tools/finalize.js";

describe("extractJSON (B.8 — robust AI output parsing)", () => {
  it("parses raw JSON directly", () => {
    const input = '{"handoff": "content", "session_log": "entries"}';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.handoff).toBe("content");
  });

  it("strips markdown code fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("strips code fences without language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("extracts JSON from surrounding text", () => {
    const input = 'Here is the output:\n\n{"drafts": [1, 2, 3]}\n\nLet me know if this looks good.';
    const result = extractJSON(input) as Record<string, number[]>;
    expect(result.drafts).toEqual([1, 2, 3]);
  });

  it("extracts JSON array from text", () => {
    const input = 'The results: [{"id": 1}, {"id": 2}]';
    const result = extractJSON(input) as Array<{ id: number }>;
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
  });

  it("handles whitespace around JSON", () => {
    const input = '  \n  {"key": "value"}  \n  ';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("throws on completely invalid input", () => {
    expect(() => extractJSON("This is just text with no JSON")).toThrow(
      "Failed to extract JSON from AI response"
    );
  });

  it("handles nested JSON objects", () => {
    const input = '```json\n{"handoff": {"version": 31}, "decisions": {"count": 48}}\n```';
    const result = extractJSON(input) as Record<string, Record<string, number>>;
    expect(result.handoff.version).toBe(31);
    expect(result.decisions.count).toBe(48);
  });
});
