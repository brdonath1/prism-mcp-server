/**
 * SRV-47 (brief-461 Task B) — idempotent archival.
 *
 * The INS-314 surface: an errored-turn finalize whose atomic commit actually
 * landed is retried with the operator's ORIGINAL (un-pruned) files[]. The same
 * oldest entries are eligible for archiving again, and the old append path
 * blindly concatenated them onto the existing archive — duplicating entries
 * that were archived on the first run. splitForArchive must skip entries whose
 * number already exists in the existing archive.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { splitForArchive, parseEntries, type ArchiveConfig } from "../src/utils/archive.js";

const CONFIG: ArchiveConfig = {
  thresholdBytes: 120,
  retentionCount: 2,
  entryMarker: /^### Session (\d+)/m,
  archiveHeader: "# Session Log Archive\n",
  mostRecentAt: "top", // newest first; oldest (archived) are at the bottom
  archiveFileName: "session-log-archive.md",
};

// Newest at top (Session 5 .. 1). With retentionCount 2 the 3 oldest
// (Sessions 3, 2, 1) are eligible for archiving once we exceed the threshold.
const FULL_LOG = [
  "## Session History",
  "### Session 5",
  "Fifth session body content here.",
  "### Session 4",
  "Fourth session body content here.",
  "### Session 3",
  "Third session body content here.",
  "### Session 2",
  "Second session body content here.",
  "### Session 1",
  "First session body content here.",
  "<!-- EOF: session-log.md -->",
].join("\n");

describe("SRV-47 — splitForArchive is idempotent against an already-archived retry", () => {
  it("first run archives the oldest entries", () => {
    const r1 = splitForArchive(FULL_LOG, null, CONFIG);
    expect(r1.archivedCount).toBeGreaterThan(0);
    expect(r1.archiveContent).not.toBeNull();
  });

  it("retry with the same full input does NOT duplicate already-archived entries", () => {
    const r1 = splitForArchive(FULL_LOG, null, CONFIG);
    const archiveAfterRun1 = r1.archiveContent!;
    const run1Nums = parseEntries(archiveAfterRun1, CONFIG.entryMarker).map((e) => e.number);

    // The errored-turn retry: identical full input, archive now holds run 1.
    const r2 = splitForArchive(FULL_LOG, archiveAfterRun1, CONFIG);

    // Nothing NEW to archive — every eligible entry is already in the archive.
    expect(r2.archivedCount).toBe(0);

    // Whatever archive content the caller would write must carry each entry
    // number exactly once (no duplicates).
    const finalArchive = r2.archiveContent ?? archiveAfterRun1;
    const finalNums = parseEntries(finalArchive, CONFIG.entryMarker).map((e) => e.number);
    expect(new Set(finalNums).size).toBe(finalNums.length);
    expect(finalNums.sort()).toEqual([...run1Nums].sort());
  });

  it("a partially-overlapping archive only appends the genuinely-new entries", () => {
    // Pre-existing archive already holds Session 1; a run that would archive
    // 3, 2, 1 must add only 3 and 2 (not a second copy of 1).
    const priorArchive = [
      "# Session Log Archive",
      "",
      "### Session 1",
      "First session body content here.",
      "<!-- EOF: session-log-archive.md -->",
    ].join("\n");

    const r = splitForArchive(FULL_LOG, priorArchive, CONFIG);
    expect(r.archiveContent).not.toBeNull();
    const nums = parseEntries(r.archiveContent!, CONFIG.entryMarker).map((e) => e.number);
    expect(new Set(nums).size).toBe(nums.length); // no duplicate Session 1
    expect(nums).toContain(1);
  });
});
