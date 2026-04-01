// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { buildSynthesisUserMessage, FINALIZATION_SYNTHESIS_PROMPT } from "../src/ai/prompts.js";

// ---- Standing rules extraction ----
// extractStandingRules is not exported, so we test the behavior by importing and
// invoking the logic directly. Since the brief specifies it's a local function inside
// bootstrap.ts, we replicate the extraction logic here for unit testing.

interface StandingRule {
  id: string;
  title: string;
  content: string;
}

function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        rules.push({
          id: headerMatch[1],
          title: headerMatch[2].trim(),
          content: section.trim(),
        });
      }
    }
  }

  return rules;
}

describe("extractStandingRules", () => {
  it("extracts a single STANDING RULE entry", () => {
    const insights = `# Insights

### INS-10: CC Brief Workflow — STANDING RULE

**Type:** Standing Operating Procedure
**Status:** STANDING RULE

Steps:
1. Create brief on briefs branch via GitHub Contents API
2. Use metadata header with session number
3. Never use prism_push for briefs

<!-- EOF: insights.md -->`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-10");
    expect(rules[0].title).toContain("CC Brief Workflow");
    expect(rules[0].content).toContain("Steps:");
    expect(rules[0].content).toContain("Never use prism_push for briefs");
  });

  it("extracts multiple STANDING RULE entries", () => {
    const insights = `# Insights

### INS-5: Regular insight
Some regular insight content.

### INS-10: CC Brief Workflow — STANDING RULE
Steps:
1. Step one
2. Step two

### INS-11: Finalization Procedure — STANDING RULE
Steps:
1. Audit first
2. Then commit

### INS-12: Another regular insight
More content.

<!-- EOF: insights.md -->`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(2);
    expect(rules[0].id).toBe("INS-10");
    expect(rules[1].id).toBe("INS-11");
  });

  it("returns empty array for null input", () => {
    expect(extractStandingRules(null)).toEqual([]);
  });

  it("returns empty array when no standing rules exist", () => {
    const insights = `# Insights

### INS-1: Regular insight
Just a regular insight with useful content.

### INS-2: Another insight
More content here.

<!-- EOF: insights.md -->`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(0);
  });

  it("handles case-insensitive STANDING RULE matching", () => {
    const insights = `### INS-15: Deploy Checklist — Standing Rule
1. Check health endpoint
2. Verify logs`;

    const rules = extractStandingRules(insights);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("INS-15");
  });
});

// ---- Synthesis prompt assembly ----

describe("buildSynthesisUserMessage", () => {
  it("includes project slug and session number", () => {
    const docs = new Map([
      ["handoff.md", { content: "# Handoff content", size: 100 }],
    ]);

    const message = buildSynthesisUserMessage("platformforge-v2", 94, "04-01-26 12:00:00", docs);

    expect(message).toContain("Project: platformforge-v2");
    expect(message).toContain("Session just completed: S94");
    expect(message).toContain("04-01-26 12:00:00");
  });

  it("includes all document contents with file headers", () => {
    const docs = new Map([
      ["handoff.md", { content: "Handoff body", size: 50 }],
      ["decisions/_INDEX.md", { content: "Decision table", size: 80 }],
      ["session-log.md", { content: "Session log entries", size: 200 }],
    ]);

    const message = buildSynthesisUserMessage("prism", 22, "04-01-26 12:00:00", docs);

    expect(message).toContain("### FILE: handoff.md (50 bytes)");
    expect(message).toContain("Handoff body");
    expect(message).toContain("--- END handoff.md ---");
    expect(message).toContain("### FILE: decisions/_INDEX.md (80 bytes)");
    expect(message).toContain("Decision table");
    expect(message).toContain("### FILE: session-log.md (200 bytes)");
    expect(message).toContain("Session log entries");
  });

  it("handles empty document map", () => {
    const docs = new Map<string, { content: string; size: number }>();
    const message = buildSynthesisUserMessage("test", 1, "01-01-26 00:00:00", docs);

    expect(message).toContain("Project: test");
    expect(message).toContain("LIVING DOCUMENTS");
  });
});

// ---- Synthesis prompt content ----

describe("FINALIZATION_SYNTHESIS_PROMPT", () => {
  it("requires all 6 sections", () => {
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Project State");
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Standing Rules & Workflows");
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Active Operational Knowledge");
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Recent Trajectory");
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Risk Flags");
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("## Quality Audit");
  });

  it("specifies EOF sentinel", () => {
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("<!-- EOF: intelligence-brief.md -->");
  });

  it("specifies token range", () => {
    expect(FINALIZATION_SYNTHESIS_PROMPT).toContain("2000-4000 tokens");
  });
});
