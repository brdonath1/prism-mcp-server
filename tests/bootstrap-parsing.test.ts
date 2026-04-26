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
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/architecture.md");
    }
  });

  it("maps bug keywords to known-issues.md", () => {
    for (const kw of ["bug", "workaround", "debt"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/known-issues.md");
    }
  });

  it("maps task keywords to task-queue.md", () => {
    for (const kw of ["task", "priority", "queue", "backlog"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/task-queue.md");
    }
  });

  it("maps glossary keywords to glossary.md", () => {
    for (const kw of ["term", "definition", "glossary"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/glossary.md");
    }
  });

  it("maps history keywords to session-log.md", () => {
    for (const kw of ["history"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/session-log.md");
    }
  });

  it("maps elimination keywords to eliminated.md", () => {
    for (const kw of ["reject", "eliminate", "guardrail", "tried"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/eliminated.md");
    }
  });

  it("maps insight keywords to insights.md", () => {
    for (const kw of ["insight", "pattern", "preference", "gotcha", "learned"]) {
      expect(PREFETCH_KEYWORDS[kw]).toBe(".prism/insights.md");
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

describe("T-3: standing rule lifecycle filtering (D-48)", () => {
  it("STANDING RULE entries are included", () => {
    const insights = `### INS-6: ZodDefault — STANDING RULE
**Standing procedure:** Never use .default() in MCP schemas.

### INS-7: Brief Workflow — STANDING RULE
**Standing procedure:** Use brief-on-repo workflow.`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(2);
  });

  it("ARCHIVED RULE entries are excluded", () => {
    const insights = `### INS-6: ZodDefault — STANDING RULE
**Standing procedure:** Never use .default().

### INS-99: Old Rule — ARCHIVED RULE
**Standing procedure:** This should not appear.`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-6");
  });

  it("DORMANT RULE entries are excluded", () => {
    const insights = `### INS-6: ZodDefault — STANDING RULE
**Standing procedure:** Never use .default().

### INS-98: Paused Rule — DORMANT RULE
**Standing procedure:** This is dormant.`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-6");
  });

  it("ARCHIVED STANDING RULE entries are excluded", () => {
    const insights = `### INS-6: ZodDefault — STANDING RULE
**Standing procedure:** Never use .default().

### INS-97: Old Standing — ARCHIVED STANDING RULE
**Standing procedure:** This was archived.`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-6");
  });

  it("entries with no lifecycle tag are excluded (not a standing rule)", () => {
    const insights = `### INS-1: Cross-project context loss
- Category: pattern
- Description: Some insight without the required lifecycle tag.

### INS-6: ZodDefault — STANDING RULE
**Standing procedure:** Never use .default().`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-6");
  });
});

describe("standing rule tier parsing", () => {
  it("defaults to tier A when no [TIER:X] tag is present (back-compat)", () => {
    const content = `### INS-99: Test rule — STANDING RULE
- Discovered: Session 1
- Description: A test rule.
**Standing procedure:**
1. Do something.
`;
    const rules = extractStandingRules(content);
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].topics).toEqual([]);
  });

  it("parses [TIER:A] explicitly", () => {
    const content = `### INS-100: Tier A rule — STANDING RULE [TIER:A]
**Standing procedure:** do A.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].title).toBe("Tier A rule");
  });

  it("parses [TIER:B]", () => {
    const content = `### INS-101: Tier B rule — STANDING RULE [TIER:B]
<!-- topics: cc_dispatch -->
**Standing procedure:** do B.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("B");
    expect(rules[0].topics).toEqual(["cc_dispatch"]);
  });

  it("parses [TIER:C]", () => {
    const content = `### INS-102: Tier C rule — STANDING RULE [TIER:C]
<!-- topics: trigger, auth -->
**Standing procedure:** do C.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("C");
    expect(rules[0].topics).toEqual(["trigger", "auth"]);
  });

  it("strips [TIER:X] from the visible title", () => {
    const content = `### INS-103: Title here — STANDING RULE [TIER:B]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].title).toBe("Title here");
  });

  it("strips a doubled — STANDING RULE tag from the title (cosmetic-bug tolerance)", () => {
    const content = `### INS-104: Title — STANDING RULE — STANDING RULE
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].title).toBe("Title");
  });

  it("defaults to tier A on unknown tier letter (e.g., [TIER:Z])", () => {
    const content = `### INS-105: Bad tier — STANDING RULE [TIER:Z]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("A");
  });

  it("returns empty topics array when no <!-- topics: --> comment present", () => {
    const content = `### INS-106: No topics — STANDING RULE [TIER:B]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].topics).toEqual([]);
  });

  it("preserves D-48 archived/dormant exclusion", () => {
    const content = `### INS-107: Archived — ARCHIVED STANDING RULE [TIER:A]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules).toHaveLength(0);
  });
});
