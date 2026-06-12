// S40 FINDING-14: Tests for pure-function archive logic
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  splitForArchive,
  parseEntries,
  type ArchiveConfig,
} from "../src/utils/archive.js";

const SESSION_LOG_CONFIG: ArchiveConfig = {
  thresholdBytes: 100,
  retentionCount: 2,
  entryMarker: /^### Session (\d+)/m,
  archiveHeader: "# Session Log Archive — PRISM Framework\n",
  mostRecentAt: "top",
};

const INSIGHTS_CONFIG: ArchiveConfig = {
  thresholdBytes: 100,
  retentionCount: 2,
  entryMarker: /^### INS-(\d+):/m,
  protectedMarkers: ["STANDING RULE"],
  activeSection: "## Active",
  archiveHeader: "# Insights Archive — PRISM Framework\n\n## Archived\n",
  mostRecentAt: "bottom",
};

describe("parseEntries", () => {
  it("returns entries in document order (reverse-chrono session-log)", () => {
    const input = `# Session Log

### Session 3 (2026-04-17)
body 3

### Session 2 (2026-04-16)
body 2

### Session 1 (2026-04-15)
body 1

<!-- EOF: session-log.md -->`;
    const result = parseEntries(input, /^### Session (\d+)/m);
    expect(result).toHaveLength(3);
    expect(result[0].number).toBe(3);
    expect(result[1].number).toBe(2);
    expect(result[2].number).toBe(1);
    expect(result[0].fullText).toContain("body 3");
    expect(result[2].fullText).toContain("body 1");
    expect(result[0].isProtected).toBe(false);
  });

  it("restricts parsing to activeSection", () => {
    const input = `# Insights — PRISM Framework

## Active

### INS-1: first active
body 1

### INS-2: second active
body 2

## Formalized

### INS-3: formalized only
body 3

<!-- EOF: insights.md -->`;
    const result = parseEntries(input, /^### INS-(\d+):/m, "## Active");
    expect(result).toHaveLength(2);
    expect(result.map(e => e.number)).toEqual([1, 2]);
  });

  it("throws when activeSection is not found", () => {
    expect(() =>
      parseEntries("# doc\n\n### Session 1\nbody", /^### Session (\d+)/m, "## Missing"),
    ).toThrow(/not found/);
  });
});

describe("splitForArchive", () => {
  it("under threshold → skip with reason", () => {
    const input = "small content";
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 100_000,
    });
    expect(result.skipReason).toBe("under threshold");
    expect(result.archivedCount).toBe(0);
    expect(result.archiveContent).toBeNull();
    expect(result.liveContent).toBe(input);
  });

  it("exactly at threshold → no archive (strict >)", () => {
    const content = "x".repeat(100);
    const result = splitForArchive(content, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 100,
    });
    expect(result.skipReason).toBe("under threshold");
    expect(result.archiveContent).toBeNull();
  });

  it("over threshold, no protected, reverse-chrono (top) — archives oldest", () => {
    const input = `# Session Log

### Session 5 (2026-04-17)
body 5

### Session 4 (2026-04-16)
body 4

### Session 3 (2026-04-15)
body 3

### Session 2 (2026-04-14)
body 2

### Session 1 (2026-04-13)
body 1

<!-- EOF: session-log.md -->`;
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 50,
      retentionCount: 2,
    });
    expect(result.archivedCount).toBe(3);
    expect(result.archiveContent).toContain("### Session 3");
    expect(result.archiveContent).toContain("### Session 2");
    expect(result.archiveContent).toContain("### Session 1");
    expect(result.liveContent).toContain("### Session 5");
    expect(result.liveContent).toContain("### Session 4");
    expect(result.liveContent).not.toContain("### Session 3");
    expect(result.liveContent).not.toContain("### Session 2");
    expect(result.liveContent).not.toContain("### Session 1");
    expect(result.liveContent).toContain("<!-- EOF: session-log.md -->");
  });

  it("over threshold, chronological (bottom), protected preserved", () => {
    const input = `# Insights — PRISM Framework

## Active

### INS-1: oldest — STANDING RULE
body 1

### INS-2: plain old
body 2

### INS-3: plain newer
body 3

### INS-4: newest
body 4
**STANDING RULE**

## Formalized

### INS-F1: formalized
body F1`;
    const result = splitForArchive(input, null, {
      ...INSIGHTS_CONFIG,
      thresholdBytes: 50,
      retentionCount: 1,
    });
    // INS-1 (title STANDING RULE) and INS-4 (body **STANDING RULE**) are protected.
    // Non-protected = [INS-2, INS-3]; retention=1, mostRecentAt=bottom → archive INS-2.
    expect(result.archivedCount).toBe(1);
    expect(result.archiveContent).toContain("INS-2");
    expect(result.liveContent).toContain("INS-1");
    expect(result.liveContent).toContain("INS-3");
    expect(result.liveContent).toContain("INS-4");
    expect(result.liveContent).not.toContain("INS-2");
    // Formalized section untouched
    expect(result.liveContent).toContain("INS-F1");
  });

  it("over threshold, ALL active entries protected — skip", () => {
    const input = `# Insights

## Active

### INS-1: foo — STANDING RULE
body 1

### INS-2: bar — STANDING RULE
body 2

### INS-3: baz — STANDING RULE
body 3
`;
    const result = splitForArchive(input, null, {
      ...INSIGHTS_CONFIG,
      thresholdBytes: 10,
      retentionCount: 0,
    });
    expect(result.skipReason).toContain("protected");
    expect(result.archivedCount).toBe(0);
    expect(result.archiveContent).toBeNull();
  });

  it("throws on malformed markers (no capture group)", () => {
    const input = `# Log

### Entry
body one

### Entry
body two

### Entry
body three
`;
    expect(() =>
      splitForArchive(input, null, {
        thresholdBytes: 10,
        retentionCount: 0,
        entryMarker: /^### Entry/m,
        archiveHeader: "# Archive\n",
      }),
    ).toThrow(/capturing group/);
  });

  it("existing archive is null → new archive includes header + entries", () => {
    const input = `# Log

### Session 5
body 5

### Session 4
body 4

### Session 3
body 3

### Session 2
body 2

### Session 1
body 1
`;
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 10,
      retentionCount: 2,
      archiveHeader: "# Session Log Archive — PRISM Framework\n",
    });
    expect(result.archiveContent).not.toBeNull();
    expect(result.archiveContent!.startsWith("# Session Log Archive")).toBe(true);
    expect(result.archiveContent).toContain("### Session 1");
  });

  it("existing archive present → appends without duplicating header", () => {
    const input = `# Log

### Session 5
body 5

### Session 4
body 4

### Session 3
body 3

### Session 2
body 2
`;
    const existing = `# Session Log Archive — PRISM Framework

### Session 0
pre-history entry
`;
    const result = splitForArchive(input, existing, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 10,
      retentionCount: 2,
    });
    const archive = result.archiveContent!;
    const headerMatches = archive.match(/# Session Log Archive/g) ?? [];
    expect(headerMatches).toHaveLength(1);
    expect(archive).toContain("### Session 0");
    expect(archive).toContain("### Session 3");
    expect(archive).toContain("### Session 2");
  });

  it("single protected at oldest position — stays in live, next-oldest archived", () => {
    const input = `# Insights

## Active

### INS-1: oldest — STANDING RULE
body 1

### INS-2: second
body 2

### INS-3: third
body 3
`;
    const result = splitForArchive(input, null, {
      ...INSIGHTS_CONFIG,
      thresholdBytes: 10,
      retentionCount: 1,
    });
    expect(result.archivedCount).toBe(1);
    expect(result.archiveContent).toContain("INS-2");
    expect(result.liveContent).toContain("INS-1");
    expect(result.liveContent).toContain("INS-3");
    expect(result.liveContent).not.toContain("INS-2");
  });

  it("round-trip: entries in live + archive == original entry set (no loss)", () => {
    const input = `# Log

### Session 5
body 5

### Session 4
body 4

### Session 3
body 3

### Session 2
body 2

### Session 1
body 1
`;
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 10,
      retentionCount: 2,
    });
    const liveEntries = parseEntries(result.liveContent, SESSION_LOG_CONFIG.entryMarker);
    const archiveEntries = parseEntries(result.archiveContent!, SESSION_LOG_CONFIG.entryMarker);
    const allNumbers = [
      ...liveEntries.map(e => e.number),
      ...archiveEntries.map(e => e.number),
    ].sort((a, b) => a - b);
    expect(allNumbers).toEqual([1, 2, 3, 4, 5]);
  });

  it("fewer entries than retention count → skip", () => {
    const filler = "x".repeat(200);
    const input = `# Log

### Session 1
body 1

${filler}
`;
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 100,
      retentionCount: 5,
    });
    expect(result.skipReason).toContain("fewer");
    expect(result.archiveContent).toBeNull();
  });
});

// brief-453 / INS-316 — "auto" orientation detection. The S165 incident:
// SESSION_LOG_ARCHIVE_CONFIG hardcoded mostRecentAt: "top" (keep FIRST 20)
// against the prism repo's CHRONOLOGICAL session-log (newest LAST), which
// archived the newest entries. "auto" resolves the orientation per document
// from the parsed entry numbers.
describe('splitForArchive — mostRecentAt: "auto" (brief-453 / INS-316)', () => {
  /** Chronological session log — newest LAST (the prism repo's actual layout). */
  function chronologicalSessionLog(count: number, bodyChars = 40): string {
    const lines = ["# Session Log — prism", ""];
    for (let n = 1; n <= count; n++) {
      lines.push(`### Session ${n} (2026-05-${String(((n - 1) % 28) + 1).padStart(2, "0")})`);
      lines.push("x".repeat(bodyChars));
      lines.push("");
    }
    lines.push("<!-- EOF: session-log.md -->");
    return lines.join("\n");
  }

  /** Reverse-chronological session log — newest FIRST. */
  function reverseChronoSessionLog(count: number, bodyChars = 40): string {
    const lines = ["# Session Log — Test", ""];
    for (let n = count; n >= 1; n--) {
      lines.push(`### Session ${n} (2026-05-${String(((n - 1) % 28) + 1).padStart(2, "0")})`);
      lines.push("x".repeat(bodyChars));
      lines.push("");
    }
    lines.push("<!-- EOF: session-log.md -->");
    return lines.join("\n");
  }

  it('INS-316 incident replay: "auto" on a chronological session-log archives the OLDEST entries and keeps the NEWEST retentionCount', () => {
    // Mirrors the prism incident shape: over threshold, more than
    // retentionCount (production value: 20) ascending `### Session N` entries.
    const input = chronologicalSessionLog(25);
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 100,
      retentionCount: 20,
      mostRecentAt: "auto",
    });

    // Under the pre-fix "top" config this fixture lost Sessions 21-25 (the
    // newest) to the archive. "auto" must archive Sessions 1-5 instead.
    expect(result.archivedCount).toBe(5);
    for (let n = 1; n <= 5; n++) {
      expect(result.archiveContent).toContain(`### Session ${n} (`);
      expect(result.liveContent).not.toContain(`### Session ${n} (`);
    }
    for (let n = 6; n <= 25; n++) {
      expect(result.liveContent).toContain(`### Session ${n} (`);
    }
    expect(result.liveContent).toContain("<!-- EOF: session-log.md -->");

    // Round-trip: no entry lost.
    const liveEntries = parseEntries(result.liveContent, SESSION_LOG_CONFIG.entryMarker);
    const archiveEntries = parseEntries(result.archiveContent!, SESSION_LOG_CONFIG.entryMarker);
    const allNumbers = [
      ...liveEntries.map(e => e.number),
      ...archiveEntries.map(e => e.number),
    ].sort((a, b) => a - b);
    expect(allNumbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('"auto" on a reverse-chronological session-log keeps the FIRST retentionCount (newest)', () => {
    const input = reverseChronoSessionLog(5);
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 50,
      retentionCount: 2,
      mostRecentAt: "auto",
    });

    expect(result.archivedCount).toBe(3);
    expect(result.liveContent).toContain("### Session 5 (");
    expect(result.liveContent).toContain("### Session 4 (");
    for (const n of [3, 2, 1]) {
      expect(result.archiveContent).toContain(`### Session ${n} (`);
      expect(result.liveContent).not.toContain(`### Session ${n} (`);
    }
  });

  it('regression: explicit "top" still keeps the FIRST retentionCount', () => {
    const input = reverseChronoSessionLog(5);
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 50,
      retentionCount: 2,
      mostRecentAt: "top",
    });

    expect(result.archivedCount).toBe(3);
    expect(result.liveContent).toContain("### Session 5 (");
    expect(result.liveContent).toContain("### Session 4 (");
    expect(result.liveContent).not.toContain("### Session 3 (");
    expect(result.archiveContent).toContain("### Session 1 (");
  });

  it('regression: explicit "bottom" still keeps the LAST retentionCount', () => {
    const input = chronologicalSessionLog(5);
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 50,
      retentionCount: 2,
      mostRecentAt: "bottom",
    });

    expect(result.archivedCount).toBe(3);
    expect(result.liveContent).toContain("### Session 5 (");
    expect(result.liveContent).toContain("### Session 4 (");
    expect(result.liveContent).not.toContain("### Session 1 (");
    expect(result.archiveContent).toContain("### Session 1 (");
  });

  it('"auto" with equal endpoint numbers resolves to "bottom" (keeps the last occurrence)', () => {
    const input = `# Log

### Session 7 (first occurrence)
${"x".repeat(60)}

### Session 7 (second occurrence)
${"x".repeat(60)}
`;
    const result = splitForArchive(input, null, {
      ...SESSION_LOG_CONFIG,
      thresholdBytes: 50,
      retentionCount: 1,
      mostRecentAt: "auto",
    });

    expect(result.archivedCount).toBe(1);
    expect(result.archiveContent).toContain("first occurrence");
    expect(result.liveContent).toContain("second occurrence");
    expect(result.liveContent).not.toContain("first occurrence");
  });
});

// ── brief-459 / SRV-06: EOF sentinel preserved through archival ─────────────
//
// The append path used to strip only trailing WHITESPACE off the existing
// archive, so an EOF sentinel survived and new entries landed AFTER it; the
// fresh path emitted no sentinel at all. Both corrupt the archive's
// end-of-content contract ("corruption queued to fire" — s167 audit).

describe("brief-459 / SRV-06: archive EOF sentinel", () => {
  const sentinel = "<!-- EOF: session-log-archive.md -->";
  const config: ArchiveConfig = {
    thresholdBytes: 100,
    retentionCount: 1,
    entryMarker: /^### Session (\d+)/m,
    archiveHeader: "# Session Log Archive — PRISM Framework\n",
    mostRecentAt: "auto",
    archiveFileName: "session-log-archive.md",
  };
  // Chronological (newest LAST), comfortably over the 100-byte threshold.
  const live = [
    "# Session Log",
    "",
    "### Session 1",
    "oldest entry " + "x".repeat(40),
    "",
    "### Session 2",
    "middle entry " + "x".repeat(40),
    "",
    "### Session 3",
    "newest entry " + "x".repeat(40),
    "",
    "<!-- EOF: session-log.md -->",
  ].join("\n");

  it("appends new entries BEFORE an existing trailing EOF sentinel", () => {
    const existing = `# Session Log Archive — PRISM Framework\n\n### Session 0\nprevious archive entry\n\n${sentinel}\n`;
    const result = splitForArchive(live, existing, config);
    expect(result.archivedCount).toBe(2);
    const archive = result.archiveContent!;
    expect(archive.trimEnd().endsWith(sentinel)).toBe(true);
    expect(archive.match(/<!--\s*EOF:/g)).toHaveLength(1);
    // Newly archived sessions appear BEFORE the sentinel.
    expect(archive.indexOf("### Session 2")).toBeGreaterThan(-1);
    expect(archive.indexOf("### Session 2")).toBeLessThan(archive.indexOf(sentinel));
  });

  it("fresh archives end with a single EOF sentinel naming the archive file", () => {
    const result = splitForArchive(live, null, config);
    const archive = result.archiveContent!;
    expect(archive.trimEnd().endsWith(sentinel)).toBe(true);
    expect(archive.match(/<!--\s*EOF:/g)).toHaveLength(1);
  });

  it("normalizes an archive corrupted by the old append-after-sentinel bug to ONE trailing sentinel", () => {
    // The production-corrupted shape: sentinel mid-file, entries after it.
    const corrupted = `# Session Log Archive — PRISM Framework\n\n### Session 0\nentry\n\n${sentinel}\n\n### Session 00\nentry appended after sentinel by the old bug\n`;
    const result = splitForArchive(live, corrupted, config);
    const archive = result.archiveContent!;
    expect(archive.match(/<!--\s*EOF:/g)).toHaveLength(1);
    expect(archive.trimEnd().endsWith(sentinel)).toBe(true);
    // No content lost in the repair.
    expect(archive).toContain("entry appended after sentinel by the old bug");
  });

  it("without archiveFileName, an existing trailing sentinel is preserved (not duplicated)", () => {
    const existing = `# Session Log Archive — PRISM Framework\n\n### Session 0\nentry\n\n${sentinel}\n`;
    const { archiveFileName: _omitted, ...legacyConfig } = config;
    const result = splitForArchive(live, existing, legacyConfig as ArchiveConfig);
    const archive = result.archiveContent!;
    expect(archive.match(/<!--\s*EOF:/g)).toHaveLength(1);
    expect(archive.trimEnd().endsWith(sentinel)).toBe(true);
  });
});

// ── brief-459 / SRV-30: threshold measured in UTF-8 bytes, not code units ───

describe("brief-459 / SRV-30: byte-accurate threshold", () => {
  it("archives an em-dash-heavy doc whose UTF-16 length is under threshold but UTF-8 bytes are over", () => {
    // '—' (U+2014) is 1 UTF-16 code unit but 3 UTF-8 bytes.
    const dashBody = "—".repeat(150); // 150 units / 450 bytes per session
    const lines: string[] = ["# Log", ""];
    for (let s = 1; s <= 5; s++) {
      lines.push(`### Session ${s}`);
      lines.push(dashBody);
      lines.push("");
    }
    const input = lines.join("\n");
    const config: ArchiveConfig = {
      thresholdBytes: 1_500,
      retentionCount: 2,
      entryMarker: /^### Session (\d+)/m,
      archiveHeader: "# Archive\n",
      mostRecentAt: "auto",
    };
    // Sanity: the fixture sits exactly in the defect window.
    expect(input.length).toBeLessThanOrEqual(config.thresholdBytes);
    expect(new TextEncoder().encode(input).length).toBeGreaterThan(config.thresholdBytes);

    const result = splitForArchive(input, null, config);
    expect(result.archivedCount).toBe(3);
    expect(result.liveContent).toContain("### Session 5");
    expect(result.liveContent).not.toContain("### Session 1\n");
  });
});

// ── brief-459 / SRV-79: size-aware retention (minRetentionCount) ────────────
//
// The flagship-project failure: retention floor (20 entries ≈ 18.8KB) exceeds
// the 15KB threshold, so the live log is PERMANENTLY over threshold and every
// finalize runs a 1-entry archive cycle. With minRetentionCount set, retention
// shrinks below retentionCount until the live doc fits, never below the floor.

describe("brief-459 / SRV-79: size-aware retention", () => {
  function chronoLog(sessions: number, charsPerSession: number): string {
    const lines: string[] = ["# Session Log", ""];
    for (let s = 1; s <= sessions; s++) {
      lines.push(`### Session ${s}`);
      lines.push("y".repeat(charsPerSession));
      lines.push("");
    }
    lines.push("<!-- EOF: session-log.md -->");
    return lines.join("\n");
  }
  function reverseLog(sessions: number, charsPerSession: number): string {
    const lines: string[] = ["# Session Log", ""];
    for (let s = sessions; s >= 1; s--) {
      lines.push(`### Session ${s}`);
      lines.push("y".repeat(charsPerSession));
      lines.push("");
    }
    lines.push("<!-- EOF: session-log.md -->");
    return lines.join("\n");
  }
  const sizeAwareConfig: ArchiveConfig = {
    thresholdBytes: 2_500,
    retentionCount: 20,
    minRetentionCount: 5,
    entryMarker: /^### Session (\d+)/m,
    archiveHeader: "# Session Log Archive\n",
    mostRecentAt: "auto",
    archiveFileName: "session-log-archive.md",
  };

  it("archives BELOW retentionCount until the live doc fits the threshold (the entries==retention trap)", () => {
    const input = chronoLog(20, 180); // ~20 entries ≈ 3.9KB, threshold 2.5KB, retention 20
    const result = splitForArchive(input, null, sizeAwareConfig);
    expect(result.archivedCount).toBeGreaterThan(0);
    expect(new TextEncoder().encode(result.liveContent).length).toBeLessThanOrEqual(2_500);
    // NEWEST entries retained, floor respected.
    expect(result.liveContent).toContain("### Session 20");
    expect(result.liveContent).not.toContain("### Session 1\n");
    const kept = result.liveContent.match(/^### Session \d+$/gm) ?? [];
    expect(kept.length).toBeGreaterThanOrEqual(5);
  });

  it("never archives below minRetentionCount even when still over threshold", () => {
    const input = chronoLog(20, 180);
    const result = splitForArchive(input, null, { ...sizeAwareConfig, thresholdBytes: 100 });
    const kept = result.liveContent.match(/^### Session \d+$/gm) ?? [];
    expect(kept.length).toBe(5);
    // The five newest.
    for (const s of [16, 17, 18, 19, 20]) {
      expect(result.liveContent).toContain(`### Session ${s}`);
    }
    expect(result.archiveContent).toContain("### Session 15");
  });

  it("reverse-chronological fixture retains the NEWEST entries (verification f)", () => {
    const input = reverseLog(20, 180);
    const result = splitForArchive(input, null, { ...sizeAwareConfig, thresholdBytes: 100 });
    const kept = result.liveContent.match(/^### Session \d+$/gm) ?? [];
    expect(kept.length).toBe(5);
    for (const s of [16, 17, 18, 19, 20]) {
      expect(result.liveContent).toContain(`### Session ${s}`);
    }
    expect(result.liveContent).not.toContain("### Session 1\n");
    expect(result.archiveContent).toContain("### Session 15");
  });

  it("without minRetentionCount, entries <= retentionCount still skips (legacy behavior pinned)", () => {
    const { minRetentionCount: _omitted, ...legacy } = sizeAwareConfig;
    const input = chronoLog(20, 180);
    const result = splitForArchive(input, null, legacy as ArchiveConfig);
    expect(result.archivedCount).toBe(0);
    expect(result.skipReason).toBe("fewer entries than retention count");
  });

  it("single trailing EOF sentinel after a size-aware archival (verification h)", () => {
    const input = chronoLog(20, 180);
    const result = splitForArchive(input, null, sizeAwareConfig);
    const archive = result.archiveContent!;
    expect(archive.match(/<!--\s*EOF:/g)).toHaveLength(1);
    expect(archive.trimEnd().endsWith("<!-- EOF: session-log-archive.md -->")).toBe(true);
    // The live doc keeps its own sentinel, exactly once, at the end.
    expect(result.liveContent.match(/<!--\s*EOF:/g)).toHaveLength(1);
    expect(result.liveContent.trimEnd().endsWith("<!-- EOF: session-log.md -->")).toBe(true);
  });
});
