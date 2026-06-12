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
  /** Size threshold in bytes. Archiving runs only when input exceeds this
   *  (strict >). Measured in UTF-8 BYTES via TextEncoder (brief-459 /
   *  SRV-30) — `String.length` counts UTF-16 code units, which under-counts
   *  em-dash-heavy PRISM docs by ~3× per dash. */
  thresholdBytes: number;
  /** How many most-recent entries to keep in the live doc. */
  retentionCount: number;
  /**
   * Size-aware retention floor (brief-459 / SRV-79). When set, retention may
   * shrink BELOW retentionCount — oldest entries keep archiving until the
   * live doc fits thresholdBytes — but never below this count. Unset keeps
   * the legacy fixed-count behavior, under which a live doc whose retention
   * floor exceeds the threshold is PERMANENTLY over threshold (the flagship
   * project's 20-entry/18.8KB log vs the 15KB threshold).
   */
  minRetentionCount?: number;
  /**
   * Archive filename used to emit the trailing `<!-- EOF: {name} -->`
   * sentinel (brief-459 / SRV-06). When unset, a sentinel already trailing
   * the existing archive is preserved; fresh archives stay sentinel-less
   * (legacy behavior).
   */
  archiveFileName?: string;
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
   * "top" — newest appears FIRST.
   * "bottom" — newest appears LAST (e.g., insights.md Active section appends at bottom).
   * "auto" — detect per document from the parsed entry numbers in document order:
   *   ascending (first < last) → "bottom"; descending (first > last) → "top".
   *   Session-log layout is NOT uniform across projects — the prism repo's
   *   session-log.md is chronological (newest LAST); hardcoding "top" there
   *   archived the newest entries (S165 incident, INS-316).
   * Default: "bottom".
   */
  mostRecentAt?: "top" | "bottom" | "auto";
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

const utf8Encoder = new TextEncoder();

/** UTF-8 byte length — the unit ArchiveConfig.thresholdBytes is documented
 *  in (brief-459 / SRV-30). Exported so callers logging archive sizes speak
 *  the same unit. */
export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).length;
}

/**
 * Resolve an orientation from entry numbers in document order (brief-459 /
 * SRV-22: shared so scale's session-history condensation orients the same
 * way archival does — per INS-30, mirror-pattern divergence creates silent
 * drift bugs). Ascending (first < last) means newest-last → "bottom";
 * descending means newest-first → "top". Zero/single entries or equal
 * endpoints resolve to "bottom".
 */
export function detectMostRecentAtFromNumbers(numbers: number[]): "top" | "bottom" {
  if (numbers.length < 2) return "bottom";
  return numbers[0] > numbers[numbers.length - 1] ? "top" : "bottom";
}

/**
 * Resolve an "auto" orientation from parsed entries in document order.
 * A single entry or equal endpoints resolve to "bottom" — moot in practice,
 * since the retention early-return keeps small files untouched.
 */
function detectMostRecentAt(entries: EntryBounds[]): "top" | "bottom" {
  return detectMostRecentAtFromNumbers(entries.map((e) => e.number));
}

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
  // SRV-30 (brief-459): the documented unit is bytes — measure bytes.
  if (utf8ByteLength(input) <= config.thresholdBytes) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "under threshold",
    };
  }

  const entries = parseEntriesWithBounds(input, config.entryMarker, config.activeSection);

  // SRV-79 (brief-459): with a size-aware floor configured, retention may
  // shrink below retentionCount, so the "too few entries" gates compare
  // against the FLOOR — otherwise a live doc whose retention floor exceeds
  // the threshold can never archive its way back under it.
  const minRetention = config.minRetentionCount ?? config.retentionCount;

  if (entries.length <= minRetention) {
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

  if (nonProtected.length <= minRetention) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "all candidates are protected or within retention",
    };
  }

  const configured = config.mostRecentAt ?? "bottom";
  const mostRecentAt =
    configured === "auto" ? detectMostRecentAt(entries) : configured;

  // Build (liveContent, eligible) for a given keep-count of most-recent
  // non-protected entries. Protected entries always stay live.
  const lines = input.split("\n");
  const buildForKeepCount = (
    keepCount: number,
  ): { liveContent: string; eligible: typeof nonProtected } => {
    const eligible =
      mostRecentAt === "top"
        ? nonProtected.slice(keepCount)
        : nonProtected.slice(0, nonProtected.length - keepCount);
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
    return { liveContent: keptLines.join("\n"), eligible };
  };

  let keepCount = Math.min(config.retentionCount, nonProtected.length);
  let { liveContent, eligible } = buildForKeepCount(keepCount);

  // SRV-79: size-aware shrink — keep archiving the oldest entries until the
  // live doc fits the threshold, never dropping below the floor.
  if (config.minRetentionCount !== undefined) {
    while (
      keepCount > minRetention &&
      utf8ByteLength(liveContent) > config.thresholdBytes
    ) {
      keepCount--;
      ({ liveContent, eligible } = buildForKeepCount(keepCount));
    }
  }

  if (eligible.length === 0) {
    return {
      liveContent: input,
      archiveContent: null,
      archivedCount: 0,
      skipReason: "no eligible entries after retention",
    };
  }

  // Build archiveContent.
  const archiveEntriesText =
    eligible.map(e => e.fullText.replace(/\s+$/, "")).join("\n\n") + "\n";

  // SRV-06 (brief-459): the old append path stripped only trailing
  // WHITESPACE, so an existing EOF sentinel survived and new entries landed
  // AFTER it; fresh archives had no sentinel at all. Strip every full-line
  // sentinel from the existing archive (also repairing archives the old bug
  // already corrupted), then re-emit exactly one as the final line.
  let preservedSentinel: string | null = null;
  let base: string;
  if (existingArchive === null || existingArchive.trim() === "") {
    base = config.archiveHeader.replace(/\s+$/, "");
  } else {
    const keptArchiveLines: string[] = [];
    for (const line of existingArchive.split("\n")) {
      if (EOF_SENTINEL_PATTERN.test(line.trim())) {
        preservedSentinel = line.trim();
        continue;
      }
      keptArchiveLines.push(line);
    }
    base = keptArchiveLines.join("\n").replace(/\s+$/, "");
  }

  let archiveContent = base + "\n\n" + archiveEntriesText;
  const sentinel = config.archiveFileName
    ? `<!-- EOF: ${config.archiveFileName} -->`
    : preservedSentinel;
  if (sentinel) {
    archiveContent += `\n${sentinel}\n`;
  }

  return {
    liveContent,
    archiveContent,
    archivedCount: eligible.length,
  };
}

/**
 * Detect a session-log's orientation from its `### Session N` entry numbers
 * (brief-456 / SRV-19). Reuses the same ascending/descending heuristic as
 * splitForArchive's "auto" mode ({@link detectMostRecentAt}) so the finalize
 * draft bridge inserts new entries at the correct end — session-log layout is
 * NOT uniform across projects, and guessing wrong is the INS-316 bug class.
 * "bottom" = newest last (chronological). Zero/single-entry logs resolve to
 * "bottom", matching the appender's safe default.
 */
export function detectSessionLogOrientation(content: string): "top" | "bottom" {
  const entries = parseEntriesWithBounds(content, /^### Session (\d+)/m);
  if (entries.length === 0) return "bottom";
  return detectMostRecentAt(entries);
}
