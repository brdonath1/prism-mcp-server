/**
 * Synthesis failure tracking and alerting.
 * Tracks recent synthesis outcomes in memory for health reporting.
 * Since the server is stateless per-request, this tracks across requests
 * within a single server process lifetime (between deploys).
 */

import { logger } from "../utils/logger.js";

/**
 * Distinguishes which background synthesis call produced this event.
 * Older events (pre-D-156 §3.6) lack this field — treat absence as
 * "intelligence_brief" for back-compat in any future segmentation.
 */
export type SynthesisKind = "intelligence_brief" | "pending_updates";

/**
 * Transport label for an event (brief-417 Phase 3c-A).
 *
 * - `messages_api` — direct Anthropic Messages API call (legacy default).
 * - `cc_subprocess` — routed through the Claude Code subprocess (OAuth path).
 * - `messages_api_fallback` — call-site requested cc_subprocess but the
 *   subprocess attempt failed and we automatically retried via the Messages
 *   API. Distinct from `messages_api` so the fallback rate is observable.
 *
 * Older events (pre-brief-417) lack this field. Absence means the transport
 * is unknown (effectively `messages_api` for everything historical).
 */
export type SynthesisTransport = "messages_api" | "cc_subprocess" | "messages_api_fallback";

export interface SynthesisEvent {
  project: string;
  sessionNumber: number;
  timestamp: string;
  success: boolean;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
  synthesis_kind?: SynthesisKind;
  /** brief-417: which transport ultimately produced this result. */
  transport?: SynthesisTransport;
  /** brief-417: model identifier (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`). */
  model?: string;
  /** brief-417: byte count of the synthesized output content (UTF-8). Drives
   *  the rolling-baseline quality check on CS-3. Optional for legacy events. */
  output_bytes?: number;
}

const MAX_EVENTS_PER_PROJECT = 20;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const projectEvents = new Map<string, SynthesisEvent[]>();

/** Drop events older than TTL from a project's list */
function pruneStale(events: SynthesisEvent[]): SynthesisEvent[] {
  const cutoff = Date.now() - TTL_MS;
  return events.filter(e => new Date(e.timestamp).getTime() > cutoff);
}

/**
 * Record a synthesis outcome (success or failure), scoped by project.
 */
export function recordSynthesisEvent(event: SynthesisEvent): void {
  const slug = event.project;
  let events = projectEvents.get(slug) ?? [];
  events = pruneStale(events);
  events.push(event);
  if (events.length > MAX_EVENTS_PER_PROJECT) {
    events = events.slice(-MAX_EVENTS_PER_PROJECT);
  }
  projectEvents.set(slug, events);

  if (!event.success) {
    const kind = event.synthesis_kind ?? "intelligence_brief";
    const kindLabel = kind === "pending_updates" ? "Pending doc-updates" : "Intelligence brief";
    logger.error(`SYNTHESIS ALERT: ${kindLabel} generation failed`, {
      project: event.project,
      session: event.sessionNumber,
      error: event.error,
      timestamp: event.timestamp,
      synthesis_kind: kind,
    });
  }
}

/** Get all events, optionally filtered by project */
function getAllEvents(projectSlug?: string): SynthesisEvent[] {
  if (projectSlug) {
    return pruneStale(projectEvents.get(projectSlug) ?? []);
  }
  const all: SynthesisEvent[] = [];
  for (const [, events] of projectEvents) {
    all.push(...pruneStale(events));
  }
  return all;
}

/**
 * Get synthesis health summary for status reporting.
 * Optionally scoped to a specific project.
 */
export function getSynthesisHealth(projectSlug?: string): {
  total_attempts: number;
  recent_successes: number;
  recent_failures: number;
  failure_rate: string;
  last_failure: SynthesisEvent | null;
  last_success: SynthesisEvent | null;
  status: "healthy" | "degraded" | "failing";
} {
  const events = getAllEvents(projectSlug);
  const total = events.length;
  const successes = events.filter(e => e.success).length;
  const failures = events.filter(e => !e.success).length;
  const failureRate = total > 0 ? `${Math.round((failures / total) * 100)}%` : "N/A";

  const lastFailure = [...events].reverse().find(e => !e.success) ?? null;
  const lastSuccess = [...events].reverse().find(e => e.success) ?? null;

  let status: "healthy" | "degraded" | "failing" = "healthy";
  if (failures > 0 && total > 0) {
    status = failures / total >= 0.5 ? "failing" : "degraded";
  }

  return {
    total_attempts: total,
    recent_successes: successes,
    recent_failures: failures,
    failure_rate: failureRate,
    last_failure: lastFailure,
    last_success: lastSuccess,
    status,
  };
}

/**
 * Get recent failures for alerting, optionally scoped by project.
 */
export function getRecentFailures(limit = 5, projectSlug?: string): SynthesisEvent[] {
  return getAllEvents(projectSlug).filter(e => !e.success).slice(-limit);
}

/**
 * Get the last N successful events for a project, optionally filtered by
 * synthesis kind. Used by quality-check baselines (brief-417 — CS-3 byte
 * count rolling baseline).
 *
 * Events are returned newest-first. Caller decides what statistic to compute
 * (mean, median, etc.) from the returned `output_tokens` / size info.
 */
export function getRecentSuccessful(
  projectSlug: string,
  limit: number,
  kind?: SynthesisKind,
): SynthesisEvent[] {
  const events = getAllEvents(projectSlug)
    .filter((e) => e.success)
    .filter((e) => (kind ? (e.synthesis_kind ?? "intelligence_brief") === kind : true));
  return events.slice(-limit).reverse();
}
