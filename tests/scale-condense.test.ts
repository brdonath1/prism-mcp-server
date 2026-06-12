/**
 * brief-459 (W3-S3, M-006) — SRV-22: condenseSessionHistory assumed
 * newest-LAST document order; on newest-first handoffs it kept the OLDEST
 * three sessions and archived the newest (the S165/INS-316 bug class).
 * Orientation now keys off the parsed session numbers (same heuristic as
 * archive.ts "auto"), and archive blocks are deduped against session numbers
 * already present in the destination before appending.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  condenseSessionHistory,
  stripDuplicateSessionEntries,
} from "../src/tools/scale.js";

const NEWEST_FIRST = [
  "### Session 30",
  "Did the thirty things.",
  "",
  "### Session 29",
  "Did the twenty-nine things.",
  "",
  "### Session 28",
  "Twenty-eight things.",
  "",
  "### Session 27",
  "Twenty-seven things.",
  "",
  "### Session 26",
  "Twenty-six things.",
].join("\n");

const CHRONOLOGICAL = [
  "### Session 26",
  "Twenty-six things.",
  "",
  "### Session 27",
  "Twenty-seven things.",
  "",
  "### Session 28",
  "Twenty-eight things.",
  "",
  "### Session 29",
  "Did the twenty-nine things.",
  "",
  "### Session 30",
  "Did the thirty things.",
].join("\n");

describe("brief-459 / SRV-22: condenseSessionHistory orientation", () => {
  it("newest-first body: the kept 3 are the HIGHEST-numbered sessions", () => {
    const { lean, archive } = condenseSessionHistory(NEWEST_FIRST);
    expect(lean).toContain("**Session 30:**");
    expect(lean).toContain("**Session 29:**");
    expect(lean).toContain("**Session 28:**");
    expect(lean).not.toContain("**Session 27:**");
    expect(archive).toContain("### Session 27");
    expect(archive).toContain("### Session 26");
    expect(archive).not.toContain("### Session 30");
  });

  it("chronological body: the kept 3 are still the HIGHEST-numbered sessions", () => {
    const { lean, archive } = condenseSessionHistory(CHRONOLOGICAL);
    expect(lean).toContain("**Session 30:**");
    expect(lean).toContain("**Session 29:**");
    expect(lean).toContain("**Session 28:**");
    expect(archive).toContain("### Session 26");
    expect(archive).toContain("### Session 27");
    expect(archive).not.toContain("### Session 28");
  });

  it("three or fewer sessions: body returned unchanged, nothing archived", () => {
    const body = "### Session 1\nOne.\n\n### Session 2\nTwo.";
    const { lean, archive } = condenseSessionHistory(body);
    expect(lean).toBe(body);
    expect(archive).toBe("");
  });
});

describe("brief-459 / SRV-22: stripDuplicateSessionEntries", () => {
  const existingLog = [
    "# Session Log",
    "",
    "### Session 27",
    "Already recorded here.",
    "",
    "<!-- EOF: session-log.md -->",
  ].join("\n");

  it("drops archive blocks whose session number already exists in the destination", () => {
    const archive = "### Session 27\nTwenty-seven things.\n\n### Session 26\nTwenty-six things.";
    const deduped = stripDuplicateSessionEntries(archive, existingLog);
    expect(deduped).not.toContain("### Session 27");
    expect(deduped).toContain("### Session 26");
  });

  it("returns the archive unchanged when no session numbers collide", () => {
    const archive = "### Session 25\nTwenty-five things.";
    expect(stripDuplicateSessionEntries(archive, existingLog)).toBe(archive);
  });

  it("returns the archive unchanged when the destination has no session headers", () => {
    const archive = "### Session 27\nTwenty-seven things.";
    const emptyLog = "# Session Log\n\n<!-- EOF: session-log.md -->";
    expect(stripDuplicateSessionEntries(archive, emptyLog)).toBe(archive);
  });

  it("returns empty when EVERY block is a duplicate", () => {
    const archive = "### Session 27\nTwenty-seven things.";
    expect(stripDuplicateSessionEntries(archive, existingLog).trim()).toBe("");
  });

  it("recognizes ## Session headers in the destination too", () => {
    const log = "## Session 26\nRecorded at level 2.\n";
    const archive = "### Session 26\nTwenty-six things.\n\n### Session 25\nKeep me.";
    const deduped = stripDuplicateSessionEntries(archive, log);
    expect(deduped).not.toContain("Twenty-six things.");
    expect(deduped).toContain("### Session 25");
  });
});
