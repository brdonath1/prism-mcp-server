// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { parseHandoffVersion, parseSessionCount } from "../src/validation/handoff.js";
import { extractStandingRules } from "../src/tools/bootstrap.js";
import { PREFETCH_KEYWORDS, HANDOFF_CRITICAL_SIZE } from "../src/config.js";

describe("handoff parsing", () => {
  it("extracts handoff version from Meta section", () => {
    const content = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active`;

    expect(parseHandoffVersion(content)).toBe(31);
  });

  it("extracts session count from Meta section", () => {
    const content = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active`;

    expect(parseSessionCount(content)).toBe(26);
  });

  it("returns null for missing handoff version", () => {
    expect(parseHandoffVersion("# Handoff\nNo meta section here")).toBeNull();
  });

  it("returns null for missing session count", () => {
    expect(parseSessionCount("# Handoff\nNo meta section here")).toBeNull();
  });
});

describe("handoff size threshold detection", () => {
  it("identifies handoffs that need scaling", () => {
    // 15,360 bytes is the critical threshold
    expect(HANDOFF_CRITICAL_SIZE).toBe(15_360);

    // A handoff above the threshold should trigger scaling
    const largeHandoff = "x".repeat(16_000);
    const sizeBytes = new TextEncoder().encode(largeHandoff).length;
    expect(sizeBytes > HANDOFF_CRITICAL_SIZE).toBe(true);
  });

  it("identifies healthy handoffs below threshold", () => {
    const smallHandoff = "# Handoff\nSmall content";
    const sizeBytes = new TextEncoder().encode(smallHandoff).length;
    expect(sizeBytes < HANDOFF_CRITICAL_SIZE).toBe(true);
  });
});

describe("keyword-to-document mapping for intelligent prefetch", () => {
  it("maps architecture keywords to architecture.md", () => {
    for (const kw of ["architecture", "stack", "infrastructure", "deploy", "integration"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("architecture.md");
    }
  });

  it("maps bug keywords to known-issues.md", () => {
    for (const kw of ["bug", "issue", "error", "workaround", "debt"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("known-issues.md");
    }
  });

  it("maps task keywords to task-queue.md", () => {
    for (const kw of ["task", "priority", "next", "queue", "backlog", "plan"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("task-queue.md");
    }
  });

  it("maps glossary keywords to glossary.md", () => {
    for (const kw of ["term", "definition", "glossary"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("glossary.md");
    }
  });

  it("maps history keywords to session-log.md", () => {
    for (const kw of ["session", "history", "previous"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("session-log.md");
    }
  });

  it("maps elimination keywords to eliminated.md", () => {
    for (const kw of ["reject", "eliminate", "guardrail", "tried"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("eliminated.md");
    }
  });

  it("maps insight keywords to insights.md", () => {
    for (const kw of ["insight", "pattern", "preference", "gotcha", "learned"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe("insights.md");
    }
  });
});

describe("standing rules extraction from bootstrap", () => {
  it("extracts procedure-only content per D-47", () => {
    const insights = `### INS-10: Brief Workflow — STANDING RULE

**Type:** Standing Operating Procedure
**Discovered:** S20

Background context here.

**Standing procedure:**
1. Create brief file on briefs branch
2. Push via GitHub API directly
3. Verify file exists after push`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].procedure).toContain("Create brief file");
    expect(rules[0].procedure).not.toContain("Background context");
  });
});
