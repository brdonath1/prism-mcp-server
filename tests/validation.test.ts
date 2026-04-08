// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  validateHandoff,
  parseHandoffVersion,
  parseSessionCount,
  parseTemplateVersion,
} from "../src/validation/handoff.js";

describe("validateHandoff", () => {
  const validHandoff = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item

## Where We Are
Currently working on feature X.

<!-- EOF: handoff.md -->`;

  it("accepts a valid handoff with no errors", () => {
    const result = validateHandoff(validHandoff);
    expect(result.errors).toHaveLength(0);
  });

  it("errors on missing Meta section", () => {
    const content = `## Critical Context
1. Item

## Where We Are
Some text

<!-- EOF: handoff.md -->`;

    const result = validateHandoff(content);
    expect(result.errors.some((e) => e.includes("Meta"))).toBe(true);
  });

  it("errors on missing Critical Context section", () => {
    const content = `## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: 2.0.0
- Status: active

## Where We Are
Some text

<!-- EOF: handoff.md -->`;

    const result = validateHandoff(content);
    expect(result.errors.some((e) => e.includes("Critical Context"))).toBe(true);
  });

  it("errors on missing Where We Are section", () => {
    const content = `## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: 2.0.0
- Status: active

## Critical Context
1. Item

<!-- EOF: handoff.md -->`;

    const result = validateHandoff(content);
    expect(result.errors.some((e) => e.includes("Where We Are"))).toBe(true);
  });

  it("errors on empty Critical Context (no numbered items)", () => {
    const content = `## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: 2.0.0
- Status: active

## Critical Context
Just text, no numbered items.

## Where We Are
Some text

<!-- EOF: handoff.md -->`;

    const result = validateHandoff(content);
    expect(result.errors.some((e) => e.includes("at least 1"))).toBe(true);
  });

  it("warns on oversized handoff", () => {
    const bigContent = validHandoff + "\n" + "x".repeat(16000);
    const result = validateHandoff(bigContent);
    expect(result.warnings.some((w) => w.includes("15KB"))).toBe(true);
  });

  it("errors on session chat reference", () => {
    const content = validHandoff.replace(
      "Currently working on feature X.",
      "See session chat for details."
    );
    const result = validateHandoff(content);
    expect(result.errors.some((e) => e.includes("session chat"))).toBe(true);
  });
});

describe("parseHandoffVersion", () => {
  it("extracts version number from list format", () => {
    const content = `## Meta
- Handoff Version: 13
- Session Count: 9`;

    expect(parseHandoffVersion(content)).toBe(13);
  });

  it("extracts version from table format", () => {
    const content = `## Meta
| Field | Value |
|-------|-------|
| Handoff Version | v2 |
| Session Count | 5 |`;

    expect(parseHandoffVersion(content)).toBe(2);
  });

  it("handles v prefix", () => {
    const content = `## Meta
- Handoff Version: v42
- Session Count: 10`;

    expect(parseHandoffVersion(content)).toBe(42);
  });

  it("falls back to blockquote when no ## Meta section", () => {
    const content = `# Handoff
> **Handoff version:** 148
> **Session Count:** 100`;

    expect(parseHandoffVersion(content)).toBe(148);
  });

  it("returns null when no version info anywhere", () => {
    expect(parseHandoffVersion("No meta here, no version anywhere")).toBeNull();
  });
});

describe("parseSessionCount", () => {
  it("extracts session count from list format", () => {
    const content = `## Meta
- Handoff Version: 5
- Session Count: 42`;

    expect(parseSessionCount(content)).toBe(42);
  });

  it("extracts session count from table format", () => {
    const content = `## Meta
| Field | Value |
|-------|-------|
| Session Count | 77 |`;

    expect(parseSessionCount(content)).toBe(77);
  });

  it("falls back to blockquote when no ## Meta section", () => {
    const content = `# Handoff
> **Session Count:** 100`;

    expect(parseSessionCount(content)).toBe(100);
  });

  it("falls back to Last updated: S{N} pattern", () => {
    const content = `# Handoff
Last updated: S134
Some other content here.`;

    expect(parseSessionCount(content)).toBe(134);
  });

  it("returns null when no session count info anywhere", () => {
    expect(parseSessionCount("Nothing useful here")).toBeNull();
  });
});

describe("parseTemplateVersion", () => {
  it("extracts template version from list format", () => {
    const content = `## Meta
- Template Version: 2.0.0`;

    expect(parseTemplateVersion(content)).toBe("2.0.0");
  });

  it("extracts template version from table format", () => {
    const content = `## Meta
| Field | Value |
|-------|-------|
| Template Version | v2.9.0 |`;

    expect(parseTemplateVersion(content)).toBe("2.9.0");
  });

  it("handles PRISM prefix", () => {
    const content = `## Meta
- Template Version: PRISM v2.1.1`;

    expect(parseTemplateVersion(content)).toBe("2.1.1");
  });

  it("falls back to content search when no ## Meta section", () => {
    const content = `# Handoff
> **Template Version:** 2.5.0`;

    expect(parseTemplateVersion(content)).toBe("2.5.0");
  });

  it("returns null when no template version anywhere", () => {
    expect(parseTemplateVersion("No version here")).toBeNull();
  });
});
