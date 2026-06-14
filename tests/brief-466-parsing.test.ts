// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { parseMarkdownTable } from "../src/utils/summarizer.js";
import { parseSections, applyPatch } from "../src/utils/markdown-sections.js";
import {
  parseSessionHeaders,
  parseDecisionSummaryRows,
  summarizeSessionTimeline,
} from "../src/tools/analytics.js";
import { buildQueryTerms } from "../src/tools/search.js";

/**
 * Brief-466 / W3-S7 — Task A (M-015) markdown/analytics parsing correctness.
 * One regression fixture per SRV finding; each test fails against the
 * pre-fix code and passes after the corresponding fix.
 */

// A production-shaped _INDEX.md: a Domain Files reference table leads the
// file, the Decision Summary table follows it. Parsing the raw file as a
// single table (the SRV-08 defect) reads the wrong columns.
const MULTI_TABLE_INDEX = `# Decisions Index

## Domain Files

| File | Decisions | Scope |
|------|-----------|-------|
| architecture.md | D-1..D-50 | Stack, system design |
| operations.md   | D-51..D-120 | Runtime, deploys |

## Decision Summary

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-115 | Something earlier | architecture | SETTLED | 142 |
| D-116 | Existing decision | operations | SETTLED | 143 |

<!-- EOF: _INDEX.md -->
`;

describe("SRV-08 — analytics parses the Decision Summary table, not the whole multi-table _INDEX", () => {
  it("parseDecisionSummaryRows reads the Decision Summary rows/columns on a multi-table index", () => {
    const rows = parseDecisionSummaryRows(MULTI_TABLE_INDEX);
    expect(rows).toHaveLength(2);
    // Columns come from the Decision Summary header, not Domain Files (File/Decisions/Scope)
    expect(rows.map((r) => r.ID)).toEqual(["D-115", "D-116"]);
    expect(rows[0].Session).toBe("142");
    expect(rows[0].Status).toBe("SETTLED");
    // decision_velocity session breakdown: real session numbers, not "unknown"
    const sessions = new Set(rows.map((r) => r.Session));
    expect(sessions.has("142")).toBe(true);
    expect(sessions.has("143")).toBe(true);
    // decision_graph knownIds is non-empty and holds real D-N ids
    const knownIds = new Set(rows.map((r) => r.ID).filter(Boolean));
    expect(knownIds.size).toBe(2);
    expect(knownIds.has("D-115")).toBe(true);
  });

  it("falls back to the whole content when no Decision Summary section exists (bare table)", () => {
    const bare = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-1 | First | architecture | SETTLED | 5 |`;
    const rows = parseDecisionSummaryRows(bare);
    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe("D-1");
    expect(rows[0].Session).toBe("5");
  });
});

describe("SRV-21 — parseMarkdownTable preserves interior empty cells", () => {
  it("keeps positional column alignment when an interior cell is blank", () => {
    const table = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-12 | Some title |  | SETTLED | 4 |`;
    const rows = parseMarkdownTable(table);
    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe("D-12");
    expect(rows[0].Title).toBe("Some title");
    expect(rows[0].Domain).toBe(""); // interior empty preserved, not collapsed
    expect(rows[0].Status).toBe("SETTLED"); // NOT shifted left into Domain
    expect(rows[0].Session).toBe("4");
  });

  it("still parses a fully-populated row identically (no regression)", () => {
    const table = `| ID | Title | Status |
|-----|-------|--------|
| D-1 | First decision | SETTLED |`;
    const rows = parseMarkdownTable(table);
    expect(rows[0]).toEqual({ ID: "D-1", Title: "First decision", Status: "SETTLED" });
  });
});

describe("SRV-24 — parseSections / applyPatch distinguish the true trailing EOF sentinel from an inline mention", () => {
  const doc = `# Known Issues

## Validation Rules

- All .md files must end with \`<!-- EOF: filename -->\` sentinel
- Second rule survives

## Other

- unrelated

<!-- EOF: known-issues.md -->
`;

  it("does not clip a section body at an inline `<!-- EOF:` mention inside backticks", () => {
    const sections = parseSections(doc);
    const vr = sections.find((s) => s.header.includes("Validation Rules"));
    expect(vr).toBeDefined();
    expect(vr!.body).toContain("must end with `<!-- EOF: filename -->` sentinel");
    expect(vr!.body).toContain("Second rule survives");
  });

  it("applyPatch append keeps the original inline-mention line intact", () => {
    const patched = applyPatch(doc, "## Validation Rules", "append", "- Third rule added");
    expect(patched).toContain("must end with `<!-- EOF: filename -->` sentinel");
    expect(patched).toContain("- Second rule survives");
    expect(patched).toContain("- Third rule added");
  });

  it("still clips at the real trailing sentinel for the final section", () => {
    const sections = parseSections(doc);
    const other = sections.find((s) => s.header.includes("Other"));
    expect(other!.body).toContain("unrelated");
    expect(other!.body).not.toContain("EOF: known-issues.md");
  });
});

describe("SRV-33 — search query tokens that strip to empty are dropped, not matched-everything", () => {
  it("strips punctuation BEFORE the length filter so '???' yields no term", () => {
    expect(buildQueryTerms("???")).toEqual([]);
    expect(buildQueryTerms("... ???")).toEqual([]);
  });

  it("retains hyphenated/underscored real tokens", () => {
    expect(buildQueryTerms("trigger-lock")).toEqual(["trigger-lock"]);
    expect(buildQueryTerms("the ?!? daemon")).toEqual(["the", "daemon"]);
  });
});

describe("SRV-34 — unparseable session dates are retained, not silently dropped", () => {
  it("parseSessionHeaders marks an unparseable date as 'unknown' instead of dropping the session", () => {
    const log = ["### Session 50 (last Tuesday)", "### Session 51 (2026-05-01)"].join("\n");
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([
      { number: 50, date: "unknown" },
      { number: 51, date: "2026-05-01" },
    ]);
  });

  it("summarizeSessionTimeline counts undated sessions but excludes them from gap math", () => {
    const current = [
      { number: 1, date: "2026-01-01" },
      { number: 2, date: "unknown" },
      { number: 3, date: "2026-01-11" },
    ];
    const { data } = summarizeSessionTimeline(current, []);
    expect(data.total_sessions).toBe(3);
    expect(data.undated_sessions).toBe(1);
    expect(data.first_session_date).toBe("2026-01-01");
    expect(data.last_session_date).toBe("2026-01-11");
    // 10-day span over the two dated sessions only — 'unknown' did not poison it.
    expect(data.average_gap_days).toBe(10);
  });
});
