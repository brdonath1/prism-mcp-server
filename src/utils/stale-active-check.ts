/**
 * Stale-active detector for Trigger state files (brief-416 / D-196 Piece 3).
 *
 * Pieces 1+2 (PR #38 on brdonath1/trigger) prevent the dispatch-pipeline
 * failure modes that produce stale active records. This piece surfaces ones
 * that slip through (e.g. daemon down between sessions) so the operator can
 * recover before queuing more work.
 *
 * Pure function — no I/O, no throws. Caller hands in the JSON content read
 * from `brdonath1/trigger:state/<slug>.json` and a clock; this function
 * answers "is the active slot stuck?" and never blows up. Invalid JSON,
 * schema mismatch, or missing nested fields all resolve to
 * `{ is_stale: false, ...nulls }` — the visibility hint accepts false
 * negatives (caller cannot distinguish "not stale" from "could not check"),
 * and that asymmetry is intentional: this is not a guard.
 */

export interface StaleActiveResult {
  is_stale: boolean;
  brief_id: string | null;
  elapsed_minutes: number | null;
  execution_started_at: string | null;
}

const NOT_STALE: StaleActiveResult = {
  is_stale: false,
  brief_id: null,
  elapsed_minutes: null,
  execution_started_at: null,
};

/**
 * Parse a Trigger state file and determine whether the active slot is stuck.
 *
 * `is_stale` is true only when ALL of the following hold:
 *   - state.active is non-null (slot occupied)
 *   - state.active.timeline.execution_started_at is a parseable ISO timestamp
 *     (slot is past the queued/pre-dispatch state)
 *   - state.active.timeline.pr_created_at is null (no PR opened yet — even
 *     post-PR wedges clear the active slot via post-merge actions or the
 *     next daemon cycle, so this targets the pre-PR wedge class only)
 *   - now - execution_started_at strictly exceeds thresholdMs
 *
 * Threshold comparison is strict `>` so a state file at exactly `thresholdMs`
 * elapsed reports `is_stale: false`. The elapsed_minutes field is rounded
 * down (Math.floor) for human-readable display.
 */
export function checkStaleActive(
  stateJson: string,
  now: Date,
  thresholdMs: number,
): StaleActiveResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    return NOT_STALE;
  }

  if (!parsed || typeof parsed !== "object") return NOT_STALE;
  const state = parsed as { active?: unknown };

  if (!state.active || typeof state.active !== "object") return NOT_STALE;
  const active = state.active as {
    brief_id?: unknown;
    timeline?: unknown;
  };

  if (!active.timeline || typeof active.timeline !== "object") return NOT_STALE;
  const timeline = active.timeline as {
    execution_started_at?: unknown;
    pr_created_at?: unknown;
  };

  // pr_created_at must be explicitly null (or undefined) — an opened PR
  // means the wedge class this surface targets does not apply.
  if (timeline.pr_created_at != null) return NOT_STALE;

  if (typeof timeline.execution_started_at !== "string") return NOT_STALE;

  const startedMs = Date.parse(timeline.execution_started_at);
  if (Number.isNaN(startedMs)) return NOT_STALE;

  const elapsedMs = now.getTime() - startedMs;
  if (elapsedMs <= thresholdMs) return NOT_STALE;

  const briefId = typeof active.brief_id === "string" ? active.brief_id : null;
  return {
    is_stale: true,
    brief_id: briefId,
    elapsed_minutes: Math.floor(elapsedMs / 60_000),
    execution_started_at: timeline.execution_started_at,
  };
}
