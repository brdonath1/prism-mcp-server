// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { parseSessionHeaders } from "../src/tools/analytics.js";

describe("parseSessionHeaders — PRISM format", () => {
  it("parses ### Session N (YYYY-MM-DD)", () => {
    const log = "### Session 25 (2026-03-15)\nSome body text\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 25, date: "2026-03-15" }]);
  });

  it("parses ### Session N (MM-DD-YY CST) — older PRISM convention", () => {
    const log = "### Session 7 (03-23-26 CST)\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 7, date: "2026-03-23" }]);
  });

  it("parses ### CC Session N (MM-DD-YY time CST)", () => {
    const log = "### CC Session 3 (03-27-26 18:08:29 CST)\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 3, date: "2026-03-27" }]);
  });

  it("handles ## (level 2) headers in addition to ###", () => {
    const log = "## Session 9 (2026-02-19)\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 9, date: "2026-02-19" }]);
  });
});

describe("parseSessionHeaders — platformforge-v2 format", () => {
  it("parses ## S{N} — MM-DD-YY", () => {
    const log = "## S162 — 03-15-26\nSession body\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 162, date: "2026-03-15" }]);
  });

  it("accepts ASCII dash in place of em-dash", () => {
    const log = "## S99 - 01-02-26\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 99, date: "2026-01-02" }]);
  });

  it("accepts en-dash", () => {
    const log = "## S42 \u2013 06-07-26\n";
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 42, date: "2026-06-07" }]);
  });
});

describe("parseSessionHeaders — mixed + sorting", () => {
  it("returns entries in source order (caller sorts by date)", () => {
    const log = [
      "## S162 — 03-15-26",
      "",
      "### Session 25 (2026-03-10)",
      "",
      "### CC Session 7 (03-23-26 CST)",
    ].join("\n");
    const parsed = parseSessionHeaders(log);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((s) => s.number)).toEqual([162, 25, 7]);
  });

  it("after sort-by-date ASC, earliest first", () => {
    const log = [
      "### Session 25 (2026-03-15)",
      "### Session 9 (2026-02-19)",
      "### Session 30 (2026-04-01)",
    ].join("\n");
    const parsed = parseSessionHeaders(log);
    const sorted = [...parsed].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    expect(sorted.map((s) => s.date)).toEqual([
      "2026-02-19",
      "2026-03-15",
      "2026-04-01",
    ]);
    expect(sorted[0].number).toBe(9);
    expect(sorted[sorted.length - 1].number).toBe(30);
  });

  it("ignores lines that match neither format", () => {
    const log = [
      "# Session Log",
      "",
      "Some prose about last session.",
      "### Session 25 (2026-03-15)",
      "- Not a header",
      "Session 9 (03-23-26) — should NOT match, missing leading ###",
    ].join("\n");
    const parsed = parseSessionHeaders(log);
    expect(parsed).toEqual([{ number: 25, date: "2026-03-15" }]);
  });
});

describe("average_gap_days is non-negative for multi-day spans", () => {
  it("three sessions spanning 10 days gives positive average gap", () => {
    const log = [
      "### Session 1 (2026-01-01)",
      "### Session 2 (2026-01-05)",
      "### Session 3 (2026-01-11)",
    ].join("\n");
    const parsed = parseSessionHeaders(log);
    const sorted = [...parsed].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const diff = Math.round(
        (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) /
          (1000 * 60 * 60 * 24),
      );
      gaps.push(diff);
    }
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeCloseTo(5, 0); // (4 + 6) / 2 = 5
  });
});

describe("archive + current merge semantics", () => {
  it("deduplicates sessions by number, current wins on collision", () => {
    // Simulating the archive + current merge done in sessionPatterns().
    const archive = parseSessionHeaders(
      ["### Session 1 (2026-01-01)", "### Session 2 (2026-01-10)"].join("\n"),
    );
    const current = parseSessionHeaders(
      ["### Session 2 (2026-01-11)", "### Session 3 (2026-01-20)"].join("\n"),
    );
    const bySessionNum = new Map<number, { number: number; date: string }>();
    for (const s of archive) bySessionNum.set(s.number, s);
    for (const s of current) bySessionNum.set(s.number, s);
    const merged = Array.from(bySessionNum.values()).sort((a, b) => a.number - b.number);
    expect(merged).toEqual([
      { number: 1, date: "2026-01-01" },
      { number: 2, date: "2026-01-11" }, // current wins
      { number: 3, date: "2026-01-20" },
    ]);
  });
});
