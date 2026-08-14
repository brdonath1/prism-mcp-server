/**
 * In-flight background-work registry + the shutdown reaper (R26 / F-C1-10).
 *
 * Background synthesis is started with `void` — the request that spawned it
 * has already returned, so nothing holds a handle to the promise. Railway
 * sends SIGTERM on every deploy, and `registerShutdownHandlers` was wired with
 * no `onDrain`: the process exited with that work mid-flight, unlogged, and
 * with async `cc_dispatch` records left at status `running` forever.
 *
 * Call sites wrap their promise in {@link registerInflight} (identity —
 * the same promise comes back, so `void registerInflight(work())` is a
 * drop-in). {@link shutdownReaper} is what `index.ts` hands to the shutdown
 * path: it marks stranded dispatch records and awaits the registry, both
 * bounded so a wedged promise can never hold a deploy open.
 */

import { CC_DISPATCH_ENABLED } from "../config.js";
import {
  listDispatchIds,
  readDispatchRecord,
  writeDispatchRecord,
} from "../dispatch-store.js";
import { logger } from "./logger.js";

/** Outstanding background promises. Entries remove themselves on settle. */
const inflight = new Set<Promise<unknown>>();

/** Registry cap — a leaking call site must not grow this set unbounded.
 *  Past the cap the promise runs untracked (today's behavior), with a log. */
const MAX_TRACKED = 200;

/** Default ceiling on the drain. Shorter than shutdown.ts's connection drain:
 *  by the time this runs the deploy is already waiting on us. */
export const DEFAULT_INFLIGHT_DRAIN_MS = 5_000;

/** How many recent dispatch records the reaper inspects for `running`. */
const DISPATCH_SCAN_LIMIT = 50;

/**
 * Track a background promise for the shutdown drain. Returns the SAME promise,
 * so wrapping a call site changes nothing about how its result is consumed.
 */
export function registerInflight<T>(promise: Promise<T>, label = "background"): Promise<T> {
  if (inflight.size >= MAX_TRACKED) {
    logger.warn("in-flight registry at capacity — background task untracked", {
      label,
      tracked: inflight.size,
      maxTracked: MAX_TRACKED,
    });
    return promise;
  }

  inflight.add(promise);
  // Settlement handlers only remove the entry — the caller's own handling is
  // untouched. Rejections are logged because a `void`ed promise otherwise
  // fails invisibly.
  promise.then(
    () => {
      inflight.delete(promise);
    },
    (err: unknown) => {
      inflight.delete(promise);
      logger.warn("tracked background task rejected", {
        label,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
  return promise;
}

/** Number of outstanding tracked promises. */
export function inflightCount(): number {
  return inflight.size;
}

/**
 * Await every outstanding background promise, bounded by `timeoutMs`. Never
 * rejects — a failing background task must not abort the shutdown sequence.
 */
export async function drainInflight(
  timeoutMs = DEFAULT_INFLIGHT_DRAIN_MS,
): Promise<{ pending: number; timedOut: boolean }> {
  const pending = Array.from(inflight);
  if (pending.length === 0) return { pending: 0, timedOut: false };

  logger.info("draining in-flight background tasks", {
    pending: pending.length,
    timeoutMs,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.(); // Must not itself hold the event loop open.
  });

  try {
    const outcome = await Promise.race([
      Promise.allSettled(pending).then(() => "settled" as const),
      timedOutPromise,
    ]);
    const timedOut = outcome === "timeout";
    if (timedOut) {
      logger.warn("in-flight drain timed out — proceeding with shutdown", {
        pending: inflight.size,
        timeoutMs,
      });
    }
    return { pending: pending.length, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mark still-`running` dispatch records as interrupted. The dispatch
 * subprocess does not survive the restart, so a record left at `running`
 * strands `cc_status` on a dispatch that can never finish. `failed` with an
 * explicit shutdown reason is the terminal state the record type carries.
 */
async function reapRunningDispatches(): Promise<number> {
  if (!CC_DISPATCH_ENABLED) return 0;

  const ids = await listDispatchIds(DISPATCH_SCAN_LIMIT);
  const records = await Promise.allSettled(ids.map((id) => readDispatchRecord(id)));

  let reaped = 0;
  for (const outcome of records) {
    if (outcome.status !== "fulfilled" || !outcome.value) continue;
    const record = outcome.value;
    if (record.status !== "running") continue;

    await writeDispatchRecord({
      ...record,
      status: "failed",
      completed_at: new Date().toISOString(),
      error:
        "interrupted — the server shut down (deploy/restart) while this dispatch was running; " +
        "the Claude Code subprocess did not survive it. Re-dispatch to retry.",
    });
    reaped += 1;
  }

  if (reaped > 0) {
    logger.warn("marked running dispatch records interrupted on shutdown", {
      reaped,
      scanned: ids.length,
    });
  }
  return reaped;
}

/** Ceiling on the dispatch sweep — it talks to GitHub, so it needs its own
 *  bound or a wedged read would hold the deploy past the drain. */
export const DEFAULT_DISPATCH_REAP_MS = 5_000;

/** Await `work` under a timeout, swallowing both failure and overrun. A
 *  shutdown step must never reject or hang the sequence behind it. */
async function bounded(work: Promise<unknown>, timeoutMs: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), expiry]);
    if (outcome === "timeout") {
      logger.warn("shutdown reaper step timed out (non-fatal)", { label, timeoutMs });
    }
  } catch (err) {
    logger.warn("shutdown reaper step failed (non-fatal)", {
      label,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The `onDrain` hook for {@link import("../shutdown.js").gracefulShutdown}.
 *
 * Sequential, not concurrent: the dispatch sweep's own write-through is
 * background work, so anything it registers must still be visible to the
 * drain that follows. Every step is bounded and none can reject — shutdown.ts
 * guards too, but a throw here would skip whatever came after it.
 */
export async function shutdownReaper(
  opts: { drainTimeoutMs?: number; reapTimeoutMs?: number } = {},
): Promise<void> {
  await bounded(
    reapRunningDispatches(),
    opts.reapTimeoutMs ?? DEFAULT_DISPATCH_REAP_MS,
    "dispatch-reap",
  );
  await drainInflight(opts.drainTimeoutMs);
}
