/**
 * archive.ts — Pure-function archive logic for PRISM living documents (S40 FINDING-14).
 *
 * Splits an oversized living doc into (liveContent, archiveContent) based on a
 * size threshold, a retention count of "most recent" entries, and optional
 * "protected marker" strings that keep specific entries in the live doc
 * regardless of age.
 *
 * No I/O. Callers fetch the existing archive (if any) and push the resulting
 * liveContent + archiveContent to the repo.
 */

export interface ArchiveResult {
  /** Content to push as the live doc. Same header + most-recent N entries. */
  liveContent: string;
  /** Content to push/append as the archive doc. Null if no archiving occurred. */
  archiveContent: string | null;
  /** Number of entries moved to archive. Zero when under threshold. */
  archivedCount: number;
  /** Human-readable reason for skip decisions (under threshold, no candidates, etc). */
  skipReason?: string;
}

export interface ArchiveConfig {
  /** Size threshold in bytes. Archiving runs only when input exceeds this (strict >). */
  thresholdBytes: number;
  /** How many most-recent entries to keep in the live doc. */
  retentionCount: number;
  /** Regex identifying entry start lines. MUST have a capturing group for the entry number. */
  entryMarker: RegExp;
  /** Entries whose title or body contains any of these strings are NEVER archived. */
  protectedMarkers?: string[];
  /** Header text for the archive file (used when creating a fresh archive). */
  archiveHeader: string;
  /** If set, only archive entries under this top-level section (e.g., "## Active"). */
  activeSection?: string;
  /**
   * Position of most-recent entries within the doc.
   * "top" — newest appears FIRST (e.g., session-log.md is reverse-chronological).
   * "bottom" — newest appears LAST (e.g., insights.md is chronological).
   * Default: "bottom".
   */
  mostRecentAt?: "top" | "bottom";
}

export interface ParsedEntry {
  number: number;
  title: string;
  body: string;
  isProtected: boolean;
  fullText: string;
}

interface EntryBounds {
  number: number;
  title: string;
  body: string;
  fullText: string;
  startLine: number;
  /** Exclusive end line. Lines [startLine, endLine) form the entry. */
  endLine: number;
}

const EOF_SENTINEL_PATTERN = /^<!--\s*EOF:.*-->$/;

function stripExecutionFlags(flags: string): string {
  return flags.replace(/[gy]/g, "");
}

/** Top-level "## " heading — used to bound entries within an activeSection. */
function isTopLevelSectionHeading(line: string): boolean {
  return /^##\s+/.test(line) && !/^###/.test(line);
}

function parseEntriesWithBounds(
  input: string,
  marker: RegExp,
  activeSection?: string,
): EntryBounds[] {
  const lines = input.split("\n");
  const lineRegex = new RegExp(marker.source, stripExecutionFlags(marker.flags));

  let startLine = 0;
  let endLine = lines.length;

  if (activeSection) {
    const target = activeSection.trim();
    const idx = lines.findIndex(l => l.trim() === target);
    if (idx === -1) {
      throw new Error(
        `archive: activeSection "${activeSection}" not found in input`,
      );
    }
    startLine = idx + 1;
    for (let i = startLine; i < lines.length; i++) {
      if (isTopLevelSectionHeading(lines[i])) {
        endLine = i;
        break;
      }
    }
  }

  // Trailing blank lines + optional EOF sentinel within [startLine, endLine) are
  // "trailer" content that must stay in liveContent (e.g., <!-- EOF: session-log.md -->).
  let trailerStart = endLine;
  for (let i = endLine - 1; i >= startLine; i--) {
    const line = lines[i];
    if (line.trim() === "" || EOF_SENTINEL_PATTERN.test(line.trim())) {
      trailerStart = i;
    } else {
      break;
    }
  }

  const markerIndices: number[] = [];
  for (let i = startLine; i < endLine; i++) {
    const m = lines[i].match(lineRegex);
    if (m && m.index === 0) {
      markerIndices.push(i);
    }
  }

  if (markerIndices.length === 0) {
    return [];
  }

  // Validate the marker has a capture group before building entries.
  const firstMatch = lines[markerIndices[0]].match(lineRegex);
  if (!firstMatch || firstMatch.length < 2 || firstMatch[1] === undefined) {
    throw new Error(
      `archive: entryMarker ${marker} must have a capturing group for the entry number`,
    );
  }

  // If trailer encroaches on the last entry, disable it.
  const lastMarker = markerIndices[markerIndices.length - 1];
  if (trailerStart <= lastMarker) {
    trailerStart = endLine;
  }

  const entries: EntryBounds[] = [];
  for (let i = 0; i < markerIndices.length; i++) {
    const start = markerIndices[i];
    let end = markerIndices[i + 1] ?? trailerStart;
    // Stop at any top-level "## " heading encountered before the next marker.
    for (let j = start + 1; j < end; j++) {
      if (isTopLevelSectionHeading(lines[j])) {
        end = j;
        break;
      }
    }

    const m = lines[start].match(lineRegex);
    if (!m || m[1] === undefined) {
      throw new Error(
        `archive: line ${start} matched marker but has no capture-group value`,
      );
    }
    const number = parseInt(m[1], 10);
    if (!Number.isFinite(number)) {
      throw new Error(
        `archive: entry at line ${start} has non-numeric capture "${m[1]}"`,
      );
    }

    const title = lines[start];
    const body = lines.slice(start + 1, end).join("\n");
    const fullText = lines.slice(start, end).join("\n");

    entries.push({ number, title, body, fullText, startLine: start, endLine: end });
  }

  return entries;
}

/**
 * Parse entries from a doc using the given marker regex. Returns entries in
 * document order (not sorted).
 *
 * An "entry" is: the marker line + all subsequent lines until the next marker
 * line OR a top-level section heading (`^## `) OR end of file.
 *
 * If `activeSection` is provided, parsing is restricted to the lines between
 * that section heading and the next top-level heading (or EOF).
 */
export function parseEntries(
  input: string,
  marker: RegExp,
  activeSection?: string,
): ParsedEntry[] {
  return parseEntriesWithBounds(input, marker, activeSection).map(
    ({ number, title, body, fullText }) => ({
      number,
      title,
      body,
      fullText,
      isProtected: false,
    }),
  );
}

/**
 * Split a living doc into (liveContent, archiveContent) based on config.
 * Pure function — no I/O.
 *
 * Returns { archiveContent: null, archivedCount: 0, skipReason: "..." } when
 * archiving does not occur (under threshold, no candidates after protection
 * filter, etc). Throws if the marker regex is malformed or activeSection is
 * not found.
 */
export function splitForArchive(
  input: string,
  existingArchive: string | null,
  config: ArchiveConfig,
): ArchiveResult {
  if (input.length <= config.thresholdBytes) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "under threshold",
    };
  }

  const entries = parseEntriesWithBounds(input, config.entryMarker, config.activeSection);

  if (entries.length <= config.retentionCount) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "fewer entries than retention count",
    };
  }

  const markers = config.protectedMarkers ?? [];
  const marked = entries.map(e => ({
    ...e,
    isProtected: markers.some(m => e.title.includes(m) || e.body.includes(m)),
  }));

  const nonProtected = marked.filter(e => !e.isProtected);

  if (nonProtected.length <= config.retentionCount) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "all candidates are protected or within retention",
    };
  }

  const mostRecentAt = config.mostRecentAt ?? "bottom";
  const eligible =
    mostRecentAt === "top"
      ? nonProtected.slice(config.retentionCount)
      : nonProtected.slice(0, nonProtected.length - config.retentionCount);

  if (eligible.length === 0) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "no eligible entries after retention",
    };
  }

  // Build liveContent by removing eligible entries' line ranges.
  const lines = input.split("\n");
  const removeSet = new Set<number>();
  for (const e of eligible) {
    for (let i = e.startLine; i < e.endLine; i++) {
      removeSet.add(i);
    }
  }
  const keptLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removeSet.has(i)) keptLines.push(lines[i]);
  }
  const liveContent = keptLines.join("\n");

  // Build archiveContent.
  const archiveEntriesText =
    eligible.map(e => e.fullText.replace(/\s+$/, "")).join("\n\n") + "\n";

  let archiveContent: string;
  if (existingArchive === null || existingArchive.trim() === "") {
    const headerClean = config.archiveHeader.replace(/\s+$/, "");
    archiveContent = headerClean + "\n\n" + archiveEntriesText;
  } else {
    const trimmed = existingArchive.replace(/\s+$/, "");
    archiveContent = trimmed + "\n\n" + archiveEntriesText;
  }

  return {
    liveContent,
    archiveContent,
    archivedCount: eligible.length,
  };
}
