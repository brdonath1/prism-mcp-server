/**
 * Synthesis observation-event extractor for boot-time visibility surfacing
 * (brief-419 / Phase 3c-A observation gate).
 *
 * Pure function — no I/O, no throws. Caller hands in a list of Railway log
 * entries (already filtered server-side by environment + a coarse `@level:warn`
 * filter), the booting project's slug, the current clock, and a lookback
 * window. This function returns the subset that match one of the three Phase
 * 3c-A observation codes for the given project, plus per-kind counts.
 *
 * Defensive contract: any malformed log entry, missing attribute, unknown
 * kind, or unparseable timestamp resolves to "skip this entry" — never
 * throws. `has_events: false` when the filtered set is empty. The caller
 * cannot distinguish "no events" from "could not check" — visibility hint,
 * not a guard, per INS-238.
 */

import type { RailwayLog, RailwayLogAttribute } from "../railway/types.js";

export type ObservationEventKind =
  | "SYNTHESIS_TRANSPORT_FALLBACK"
  | "CS3_QUALITY_BYTE_COUNT_WARNING"
  | "CS3_QUALITY_PREAMBLE_WARNING";

export interface ObservationEvent {
  kind: ObservationEventKind;
  timestamp: string; // ISO
  attributes: Record<string, string>; // raw flattened attribute map
}

export interface ObservationCheckResult {
  has_events: boolean;
  /** Grouped by kind, most-recent first within each kind. */
  events: ObservationEvent[];
  fallback_count: number;
  byte_warning_count: number;
  preamble_warning_count: number;
}

const EMPTY_RESULT: ObservationCheckResult = {
  has_events: false,
  events: [],
  fallback_count: 0,
  byte_warning_count: 0,
  preamble_warning_count: 0,
};

const KIND_TOKENS: Record<ObservationEventKind, string> = {
  SYNTHESIS_TRANSPORT_FALLBACK: "SYNTHESIS_TRANSPORT_FALLBACK",
  CS3_QUALITY_BYTE_COUNT_WARNING: "CS3_QUALITY_BYTE_COUNT_WARNING",
  CS3_QUALITY_PREAMBLE_WARNING: "CS3_QUALITY_PREAMBLE_WARNING",
};

/**
 * Flatten Railway's `[{key, value}]` attribute array into a plain
 * `Record<string, string>`. Returns null when the attribute payload is not a
 * well-formed array of `{key, value}` entries — caller skips that log entry.
 */
function flattenAttributes(
  attributes: RailwayLogAttribute[] | undefined,
): Record<string, string> | null {
  if (attributes === undefined) return {};
  if (!Array.isArray(attributes)) return null;
  const out: Record<string, string> = {};
  for (const attr of attributes) {
    if (!attr || typeof attr !== "object") return null;
    const key = (attr as { key?: unknown }).key;
    const value = (attr as { value?: unknown }).value;
    if (typeof key !== "string" || typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

/**
 * Identify which observation kind a log entry represents, if any.
 *
 * Matches the kind token against:
 *   1. `attributes.code` (preferred — emitted by structured logs that bind
 *      a stable code field). The current emissions in src/ai/client.ts and
 *      src/ai/synthesize.ts use the kind as the message string, but future
 *      emissions may move to a `code` attribute. Both forms are accepted.
 *   2. `message` substring — handles the current emission shape where the
 *      kind is the leading token of the human-readable log message.
 */
function identifyKind(
  message: string | undefined,
  attrs: Record<string, string>,
): ObservationEventKind | null {
  const code = attrs.code;
  if (code) {
    const codeUpper = code.toUpperCase();
    for (const kind of Object.keys(KIND_TOKENS) as ObservationEventKind[]) {
      if (codeUpper === kind) return kind;
    }
  }
  if (typeof message === "string" && message.length > 0) {
    for (const kind of Object.keys(KIND_TOKENS) as ObservationEventKind[]) {
      if (message.includes(kind)) return kind;
    }
  }
  return null;
}

/**
 * Inspect a list of Railway log entries (already filtered by environment +
 * substring/regex by the caller) and extract the subset matching one of the
 * three Phase 3c-A observation codes for the given project slug, within the
 * lookback window.
 *
 * Boundary: comparison is strict `<` — a log entry whose `now - timestamp`
 * exactly equals `lookbackMs` is NOT surfaced. Entries with `now - timestamp`
 * less than `lookbackMs` are surfaced.
 *
 * Defensive contract: invalid timestamps, missing attributes, unknown kinds,
 * and out-of-window entries are silently skipped. The function never throws.
 */
export function checkSynthesisObservationEvents(
  logs: RailwayLog[],
  projectSlug: string,
  now: Date,
  lookbackMs: number,
): ObservationCheckResult {
  if (!Array.isArray(logs) || logs.length === 0) return cloneEmpty();
  if (typeof projectSlug !== "string" || projectSlug.length === 0) return cloneEmpty();

  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) return cloneEmpty();

  const buckets: Record<ObservationEventKind, ObservationEvent[]> = {
    SYNTHESIS_TRANSPORT_FALLBACK: [],
    CS3_QUALITY_BYTE_COUNT_WARNING: [],
    CS3_QUALITY_PREAMBLE_WARNING: [],
  };

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;

    const attrs = flattenAttributes(log.attributes);
    if (attrs === null) continue;

    if (attrs.projectSlug !== projectSlug) continue;

    const kind = identifyKind(log.message, attrs);
    if (kind === null) continue;

    const tsRaw = log.timestamp;
    if (typeof tsRaw !== "string") continue;
    const tsMs = Date.parse(tsRaw);
    if (Number.isNaN(tsMs)) continue;

    const elapsed = nowMs - tsMs;
    if (elapsed >= lookbackMs) continue;

    buckets[kind].push({ kind, timestamp: tsRaw, attributes: attrs });
  }

  const sortDesc = (a: ObservationEvent, b: ObservationEvent): number =>
    Date.parse(b.timestamp) - Date.parse(a.timestamp);

  buckets.SYNTHESIS_TRANSPORT_FALLBACK.sort(sortDesc);
  buckets.CS3_QUALITY_BYTE_COUNT_WARNING.sort(sortDesc);
  buckets.CS3_QUALITY_PREAMBLE_WARNING.sort(sortDesc);

  const events: ObservationEvent[] = [
    ...buckets.SYNTHESIS_TRANSPORT_FALLBACK,
    ...buckets.CS3_QUALITY_BYTE_COUNT_WARNING,
    ...buckets.CS3_QUALITY_PREAMBLE_WARNING,
  ];

  const fallback_count = buckets.SYNTHESIS_TRANSPORT_FALLBACK.length;
  const byte_warning_count = buckets.CS3_QUALITY_BYTE_COUNT_WARNING.length;
  const preamble_warning_count = buckets.CS3_QUALITY_PREAMBLE_WARNING.length;

  if (fallback_count + byte_warning_count + preamble_warning_count === 0) {
    return cloneEmpty();
  }

  return {
    has_events: true,
    events,
    fallback_count,
    byte_warning_count,
    preamble_warning_count,
  };
}

function cloneEmpty(): ObservationCheckResult {
  return {
    has_events: EMPTY_RESULT.has_events,
    events: [],
    fallback_count: EMPTY_RESULT.fallback_count,
    byte_warning_count: EMPTY_RESULT.byte_warning_count,
    preamble_warning_count: EMPTY_RESULT.preamble_warning_count,
  };
}
