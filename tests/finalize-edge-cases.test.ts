// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { extractJSON } from "../src/tools/finalize.js";

describe("extractJSON edge cases", () => {
  it("handles deeply nested JSON", () => {
    const input = '{"a": {"b": {"c": {"d": "deep"}}}}';
    const result = extractJSON(input) as any;
    expect(result.a.b.c.d).toBe("deep");
  });

  it("handles JSON with special characters", () => {
    const input = '{"message": "Hello \\"world\\"! Tab\\there."}';
    const result = extractJSON(input) as any;
    expect(result.message).toContain("world");
  });

  it("handles JSON preceded by AI thinking text", () => {
    const input = `Let me think about this carefully.

Here are the finalization drafts:

\`\`\`json
{
  "handoff": "# Handoff\\n\\n## Meta\\nVersion: 42",
  "session_log": "### Session 133\\nStuff happened."
}
\`\`\`

I hope these look good!`;
    const result = extractJSON(input) as any;
    expect(result.handoff).toContain("Handoff");
    expect(result.session_log).toContain("Session 133");
  });

  it("handles empty JSON object", () => {
    const result = extractJSON("{}");
    expect(result).toEqual({});
  });

  it("handles JSON array", () => {
    const result = extractJSON("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws on completely empty input", () => {
    expect(() => extractJSON("")).toThrow();
  });

  it("throws on prose with no JSON", () => {
    expect(() => extractJSON("This is just a sentence with no structured data.")).toThrow();
  });

  it("handles JSON with unicode characters", () => {
    const input = '{"name": "caf\u00e9 r\u00e9sum\u00e9 na\u00efve"}';
    const result = extractJSON(input) as any;
    expect(result.name).toContain("caf");
  });

  it("throws on input with multiple JSON blocks (ambiguous extraction)", () => {
    // extractJSON finds first { to last }, which produces invalid JSON when multiple blocks exist
    const input = 'First: {"a": 1} Second: {"b": 2}';
    expect(() => extractJSON(input)).toThrow();
  });

  it("extracts array from surrounding prose (L-6)", () => {
    const input = 'Here are the results:\n\n[{"id": 1}, {"id": 2}, {"id": 3}]\n\nThat is all.';
    const result = extractJSON(input) as any[];
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe(1);
    expect(result[2].id).toBe(3);
  });

  it("handles very large JSON strings without crashing", () => {
    const bigValue = "x".repeat(100_000);
    const input = `{"big": "${bigValue}"}`;
    const result = extractJSON(input) as any;
    expect(result.big.length).toBe(100_000);
  });
});

describe("Handoff validation edge cases", () => {
  it("validateHandoff is exported from validation module", async () => {
    const validation = await import("../src/validation/handoff.js");
    expect(typeof validation.validateHandoff).toBe("function");
  });

  it("rejects handoff without Meta section", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Where We Are\nDoing stuff.\n\n## Critical Context\n1. Thing one.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes("Meta"))).toBe(true);
  });

  it("rejects handoff with Meta section missing required fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- Handoff Version: 42\n\n## Critical Context\n1. Thing one.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    // Missing Session Count, Template Version, Status
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts valid handoff with all required fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- **Handoff Version:** 42\n- **Session Count:** 10\n- **Template Version:** PRISM v2.9.0\n- **Status:** Active\n\n## Critical Context\n1. Thing one.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors).toEqual([]);
  });

  it("handles bold-formatted Meta fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- **Handoff Version:** 42\n- **Session Count:** 10\n- **Template Version:** v2.9.0\n- **Status:** Active\n\n## Critical Context\n1. Critical thing.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors).toEqual([]);
  });
});
