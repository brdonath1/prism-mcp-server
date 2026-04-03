/**
 * Synthesis failure tracking and alerting.
 * Tracks recent synthesis outcomes in memory for health reporting.
 * Since the server is stateless per-request, this tracks across requests
 * within a single server process lifetime (between deploys).
 */

import { logger } from "../utils/logger.js";

export interface SynthesisEvent {
  project: string;
  sessionNumber: number;
  timestamp: string;
  success: boolean;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  duration_ms?: number;
}

const MAX_EVENTS = 50;
const events: SynthesisEvent[] = [];

/**
 * Record a synthesis outcome (success or failure).
 */
export function recordSynthesisEvent(event: SynthesisEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  if (!event.success) {
    logger.error("SYNTHESIS ALERT: Intelligence brief generation failed", {
      project: event.project,
      session: event.sessionNumber,
      error: event.error,
      timestamp: event.timestamp,
    });
  }
}

/**
 * Get synthesis health summary for status reporting.
 */
export function getSynthesisHealth(): {
  total_attempts: number;
  recent_successes: number;
  recent_failures: number;
  failure_rate: string;
  last_failure: SynthesisEvent | null;
  last_success: SynthesisEvent | null;
  status: "healthy" | "degraded" | "failing";
} {
  const total = events.length;
  const successes = events.filter(e => e.success).length;
  const failures = events.filter(e => !e.success).length;
  const failureRate = total > 0 ? `${Math.round((failures / total) * 100)}%` : "N/A";

  const lastFailure = [...events].reverse().find(e => !e.success) ?? null;
  const lastSuccess = [...events].reverse().find(e => e.success) ?? null;

  // Status: healthy if no failures, degraded if <50% failure rate, failing if >=50%
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
 * Get recent failures for alerting.
 */
export function getRecentFailures(limit = 5): SynthesisEvent[] {
  return events.filter(e => !e.success).slice(-limit);
}
