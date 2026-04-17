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
