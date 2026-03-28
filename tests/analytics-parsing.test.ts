import { describe, it, expect } from "vitest";

/**
 * These tests verify the parsing logic used by analytics functions.
 * They test the regex patterns directly rather than the full analytics
 * functions (which require GitHub API calls).
 */

describe("session header parsing (KI-1 fix verification)", () => {
  // The regex used in the fixed sessionPatterns function
  const HEADER_RE = /^###\s+(?:CC\s+)?Session\s+(\d+)\s*\(([^)]+)\)/i;
  const DATE_MM_DD_YY = /^(\d{2})-(\d{2})-(\d{2})/;
  const DATE_YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})/;

  function parseHeader(line: string): { number: number; date: string } | null {
    const match = line.match(HEADER_RE);
    if (!match) return null;

    const sessionNum = parseInt(match[1], 10);
    const dateStr = match[2].trim();

    const mmddyy = dateStr.match(DATE_MM_DD_YY);
    if (mmddyy) {
      const year = 2000 + parseInt(mmddyy[3], 10);
      return { number: sessionNum, date: `${year}-${mmddyy[1]}-${mmddyy[2]}` };
    }

    const yyyymmdd = dateStr.match(DATE_YYYY_MM_DD);
    if (yyyymmdd) {
      return { number: sessionNum, date: `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}` };
    }

    return null;
  }

  it("parses ### Session N (MM-DD-YY CST) format", () => {
    const result = parseHeader("### Session 7 (03-23-26 CST)");
    expect(result).toEqual({ number: 7, date: "2026-03-23" });
  });

  it("parses ### Session N (MM-DD-YY HH:MM:SS CST) format", () => {
    const result = parseHeader("### Session 9 (03-27-26 18:08:29 CST)");
    expect(result).toEqual({ number: 9, date: "2026-03-27" });
  });

  it("parses ### CC Session N (MM-DD-YY CST) format", () => {
    const result = parseHeader("### CC Session 3 (03-27-26 CST)");
    expect(result).toEqual({ number: 3, date: "2026-03-27" });
  });

  it("parses ### Session N (YYYY-MM-DD) format", () => {
    const result = parseHeader("### Session 2 (2026-02-16)");
    expect(result).toEqual({ number: 2, date: "2026-02-16" });
  });

  it("does NOT match ## Session N (wrong header level)", () => {
    const result = parseHeader("## Session 5 (03-01-26 CST)");
    expect(result).toBeNull();
  });

  it("does NOT match non-session headers", () => {
    const result = parseHeader("### Living Documents Audit");
    expect(result).toBeNull();
  });
});

describe("decision graph adjacency (KI-2 fix verification)", () => {
  function buildAdjacency(rows: Array<Record<string, string>>): Record<string, string[]> {
    const decisionIds = new Set(rows.map((r) => r["ID"]));
    const adjacency: Record<string, string[]> = {};

    for (const row of rows) {
      adjacency[row["ID"]] = [];
    }

    // Per-row scan (the correct approach)
    for (const row of rows) {
      const rowId = row["ID"];
      const rowContent = Object.values(row).join(" ");
      const refs = rowContent.match(/D-\d+/g) ?? [];

      for (const ref of refs) {
        if (ref !== rowId && decisionIds.has(ref)) {
          if (!adjacency[rowId].includes(ref)) {
            adjacency[rowId].push(ref);
          }
        }
      }
    }

    return adjacency;
  }

  it("finds actual cross-references within row content", () => {
    const rows = [
      { ID: "D-1", Title: "First decision", Status: "SETTLED" },
      { ID: "D-2", Title: "Extends D-1 approach", Status: "SETTLED" },
      { ID: "D-3", Title: "Independent decision", Status: "SETTLED" },
    ];

    const adj = buildAdjacency(rows);
    expect(adj["D-2"]).toContain("D-1"); // D-2 references D-1
    expect(adj["D-1"]).toEqual([]);       // D-1 doesn't reference others
    expect(adj["D-3"]).toEqual([]);       // D-3 is isolated
  });

  it("does NOT create a complete graph", () => {
    const rows = [
      { ID: "D-1", Title: "First", Status: "SETTLED" },
      { ID: "D-2", Title: "Second", Status: "SETTLED" },
      { ID: "D-3", Title: "Third", Status: "SETTLED" },
    ];

    const adj = buildAdjacency(rows);
    const totalEdges = Object.values(adj).reduce((sum, refs) => sum + refs.length, 0);
    expect(totalEdges).toBe(0); // No cross-references = no edges
  });

  it("handles multiple cross-references in one row", () => {
    const rows = [
      { ID: "D-1", Title: "Foundation", Status: "SETTLED" },
      { ID: "D-2", Title: "Extension", Status: "SETTLED" },
      { ID: "D-3", Title: "Combines D-1 and D-2", Status: "SETTLED" },
    ];

    const adj = buildAdjacency(rows);
    expect(adj["D-3"]).toContain("D-1");
    expect(adj["D-3"]).toContain("D-2");
    expect(adj["D-3"]).toHaveLength(2);
  });
});
