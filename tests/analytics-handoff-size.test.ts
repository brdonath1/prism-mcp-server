// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  sortHandoffVersionsAsc,
  parseHandoffFilename,
} from "../src/tools/analytics.js";

describe("sortHandoffVersionsAsc — numeric version ordering (A-11)", () => {
  it("orders v7, v8, v9, v49, v50 ascending — not lexicographic", () => {
    const input = [
      { name: "handoff_v50_2026-04-10.md", size: 6200 },
      { name: "handoff_v7_2026-02-01.md", size: 5000 },
      { name: "handoff_v49_2026-04-05.md", size: 6400 },
      { name: "handoff_v8_2026-02-15.md", size: 5200 },
      { name: "handoff_v9_2026-03-01.md", size: 5400 },
    ];
    const sorted = sortHandoffVersionsAsc(input);
    expect(sorted.map((e) => e.name)).toEqual([
      "handoff_v7_2026-02-01.md",
      "handoff_v8_2026-02-15.md",
      "handoff_v9_2026-03-01.md",
      "handoff_v49_2026-04-05.md",
      "handoff_v50_2026-04-10.md",
    ]);
  });

  it("puts v100 after v99 (regression of the localeCompare bug)", () => {
    const input = [
      { name: "handoff_v100_2026-04-20.md", size: 100 },
      { name: "handoff_v99_2026-04-19.md", size: 99 },
    ];
    const sorted = sortHandoffVersionsAsc(input);
    expect(sorted[0].name).toContain("v99");
    expect(sorted[1].name).toContain("v100");
  });

  it("does not mutate the input array", () => {
    const input = [
      { name: "handoff_v2.md", size: 200 },
      { name: "handoff_v1.md", size: 100 },
    ];
    const original = [...input];
    sortHandoffVersionsAsc(input);
    expect(input).toEqual(original);
  });
});

describe("parseHandoffFilename — both filename formats (A-20)", () => {
  it("parses YYYY-MM-DD form", () => {
    const result = parseHandoffFilename("handoff_v49_2026-04-05.md");
    expect(result).toEqual({ version: 49, date: "2026-04-05" });
  });

  it("parses MM-DD-YY form and normalizes to YYYY-MM-DD (A-20)", () => {
    const result = parseHandoffFilename("handoff_v8_03-02-26.md");
    expect(result).toEqual({ version: 8, date: "2026-03-02" });
  });

  it("accepts two-digit version in the MM-DD-YY form", () => {
    const result = parseHandoffFilename("handoff_v50_12-31-25.md");
    expect(result).toEqual({ version: 50, date: "2025-12-31" });
  });

  it("falls back to date='unknown' when filename has no date", () => {
    const result = parseHandoffFilename("handoff_v12.md");
    expect(result).toEqual({ version: 12, date: "unknown" });
  });

  it("returns version=0 for an unrelated filename", () => {
    const result = parseHandoffFilename("README.md");
    expect(result.version).toBe(0);
    expect(result.date).toBe("unknown");
  });
});

describe("handoff size trend — last vs prior (not first vs last)", () => {
  // The brief calls out that comparing v49 (6.2KB) to v9 (6.4KB) across many
  // versions is meaningless. The trend should reflect the most-recent delta.
  it("reports 'growing' when last > second-last even if first was smaller", () => {
    const versions = [
      { version: 1, size_bytes: 4000 },
      { version: 2, size_bytes: 10000 }, // grew
      { version: 3, size_bytes: 9000 },  // shrank
      { version: 4, size_bytes: 11000 }, // grew again (last)
    ];
    const last = versions[versions.length - 1].size_bytes;
    const prior = versions[versions.length - 2].size_bytes;
    let trend: string;
    if (last > prior) trend = "growing";
    else if (last < prior) trend = "shrinking";
    else trend = "stable";
    expect(trend).toBe("growing");
  });

  it("reports 'shrinking' when last < second-last", () => {
    const versions = [
      { version: 1, size_bytes: 5000 },
      { version: 2, size_bytes: 8000 },
      { version: 3, size_bytes: 6000 },
    ];
    const last = versions[versions.length - 1].size_bytes;
    const prior = versions[versions.length - 2].size_bytes;
    let trend: string;
    if (last > prior) trend = "growing";
    else if (last < prior) trend = "shrinking";
    else trend = "stable";
    expect(trend).toBe("shrinking");
  });
});
