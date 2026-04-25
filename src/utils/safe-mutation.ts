/**
 * safeMutation primitive — atomic-commit-with-HEAD-comparison wrapper.
 *
 * Extracts the reference pattern from log-decision.ts's primary path and
 * extends it with: null-safe HEAD comparison, content-refresh-on-retry,
 * delete support, and an optional wall-clock deadline. No sequential-
 * pushFile fallback — atomic-only by design (S62 audit Verdict C).
 *
 * Behavior contract:
 *   - Snapshots HEAD SHA via getHeadSha BEFORE reading files.
 *   - Reads readPaths in parallel via fetchFile, passes the resulting Map
 *     to computeMutation.
 *   - Atomic-commits the returned writes/deletes via createAtomicCommit.
 *   - On 409 conflict: emits MUTATION_CONFLICT, snapshots HEAD again,
 *     refuses retry if either SHA is null (HEAD_SHA_UNKNOWN), otherwise
 *     re-reads files, re-runs computeMutation against fresh data, retries.
 *   - On retry exhaustion: MUTATION_RETRY_EXHAUSTED.
 *   - Optional deadline via Promise.race (DEADLINE_EXCEEDED on expiry).
 *
 * Diagnostic codes emitted by this primitive:
 *   MUTATION_CONFLICT, MUTATION_RETRY_EXHAUSTED, HEAD_SHA_UNKNOWN,
 *   DEADLINE_EXCEEDED.
 */

import {
  fetchFile,
  createAtomicCommit,
  getHeadSha,
} from "../github/client.js";
import type { FileResult } from "../github/types.js";
import { logger } from "./logger.js";
import type { DiagnosticsCollector } from "./diagnostics.js";

/** Sentinel used to signal that the safeMutation deadline fired. */
const SAFE_MUTATION_DEADLINE_SENTINEL = Symbol("safe-mutation.deadline");

export interface SafeMutationWrite {
  path: string;
  content: string;
}

export interface SafeMutationOutput {
  writes: SafeMutationWrite[];
  deletes?: string[];
}

export interface SafeMutationOpts {
  /** Project repo name (e.g., "platformforge"). */
  repo: string;
  /** Commit message for the atomic commit. */
  commitMessage: string;
  /** File paths to read before each mutation attempt. May be empty for delete-only mutations. */
  readPaths: string[];
  /**
   * Compute the mutation against fresh file contents. Re-runs on every retry
   * with re-read data, so any in-callback decision logic (dedup, applyPatch,
   * content rebuild) sees the latest state of the repo.
   *
   * Return null/undefined `deletes` is treated identically to `[]`.
   */
  computeMutation: (currentFiles: Map<string, FileResult>) => SafeMutationOutput;
  /** Diagnostic collector for surfacing primitive-level events. */
  diagnostics: DiagnosticsCollector;
  /** Number of retries on 409 conflict (default 1). */
  maxRetries?: number;
  /** Optional wall-clock deadline (ms) wrapping the entire operation. */
  deadlineMs?: number;
}

export type SafeMutationResult =
  | { ok: true; commitSha: string; retried: boolean }
  | { ok: false; error: string; code: SafeMutationErrorCode };

export type SafeMutationErrorCode =
  | "MUTATION_RETRY_EXHAUSTED"
  | "HEAD_SHA_UNKNOWN"
  | "DEADLINE_EXCEEDED";

/**
 * Read all paths in parallel and return a Map keyed by the requested path.
 * One missing path aborts the whole read — safeMutation cannot compute a
 * mutation against partial state. Errors propagate to the caller.
 */
async function readAll(
  repo: string,
  paths: string[],
): Promise<Map<string, FileResult>> {
  const results = await Promise.all(
    paths.map(async (path) => {
      const result = await fetchFile(repo, path);
      return { path, result };
    }),
  );
  const map = new Map<string, FileResult>();
  for (const { path, result } of results) {
    map.set(path, result);
  }
  return map;
}

/**
 * Run a single attempt: snapshot HEAD, read files, compute mutation,
 * atomic-commit. Returns the atomic-commit outcome plus the HEAD SHA captured
 * before the read so the caller can compare on conflict.
 */
async function attemptMutation(
  opts: SafeMutationOpts,
): Promise<{
  headShaBefore: string | undefined;
  atomicResult: Awaited<ReturnType<typeof createAtomicCommit>>;
}> {
  const headShaBefore = await getHeadSha(opts.repo);
  const files =
    opts.readPaths.length > 0
      ? await readAll(opts.repo, opts.readPaths)
      : new Map<string, FileResult>();
  const mutation = opts.computeMutation(files);
  const writes = mutation.writes;
  const deletes = mutation.deletes ?? [];
  const atomicResult = await createAtomicCommit(
    opts.repo,
    writes,
    opts.commitMessage,
    deletes,
  );
  return { headShaBefore, atomicResult };
}

/**
 * Internal mutation loop without the deadline wrapper. Returns the structured
 * result; the wrapper races this against an optional deadline timer.
 */
async function runMutationLoop(
  opts: SafeMutationOpts,
): Promise<SafeMutationResult> {
  const maxRetries = opts.maxRetries ?? 1;
  let retriesRemaining = maxRetries;
  let retried = false;

  // First attempt
  let { headShaBefore, atomicResult } = await attemptMutation(opts);

  while (true) {
    if (atomicResult.success) {
      return { ok: true, commitSha: atomicResult.sha, retried };
    }

    // Atomic commit failed. Decide whether it's safe to retry.
    if (retriesRemaining <= 0) {
      const msg = `Atomic commit failed and retry budget exhausted: ${atomicResult.error}`;
      opts.diagnostics.error("MUTATION_RETRY_EXHAUSTED", msg, {
        repo: opts.repo,
        atomicError: atomicResult.error,
      });
      logger.error("safeMutation retry exhausted", {
        repo: opts.repo,
        atomicError: atomicResult.error,
      });
      return { ok: false, error: msg, code: "MUTATION_RETRY_EXHAUSTED" };
    }

    // Snapshot HEAD again to detect concurrent writes.
    const headShaAfter = await getHeadSha(opts.repo);
    if (!headShaBefore || !headShaAfter) {
      // Either snapshot failed — HEAD state is unknown. Refuse to retry: a
      // blind retry could double-write. The audit's null-safe contract is
      // "unknown -> refuse fallback."
      const phase = !headShaBefore ? "pre-atomic-snapshot" : "post-atomic-check";
      const msg =
        `getHeadSha returned null (${phase}) — HEAD state unknown, refusing retry`;
      opts.diagnostics.warn("HEAD_SHA_UNKNOWN", msg, {
        repo: opts.repo,
        phase,
        atomicError: atomicResult.error,
      });
      logger.warn("safeMutation HEAD SHA unknown", {
        repo: opts.repo,
        phase,
        atomicError: atomicResult.error,
      });
      return { ok: false, error: msg, code: "HEAD_SHA_UNKNOWN" };
    }

    // HEAD comparison succeeded on both ends. Whether HEAD moved or not, the
    // safeMutation contract is to retry against fresh content (re-read files,
    // re-compute mutation). The atomic primitive itself surfaces partial-state
    // through subsequent commit failures, but we never fall back to sequential
    // writes here — atomic-only.
    opts.diagnostics.warn("MUTATION_CONFLICT", "Atomic commit conflict — retrying with fresh content", {
      repo: opts.repo,
      headShaBefore,
      headShaAfter,
      headChanged: headShaBefore !== headShaAfter,
      atomicError: atomicResult.error,
    });
    logger.warn("safeMutation conflict — retrying", {
      repo: opts.repo,
      headChanged: headShaBefore !== headShaAfter,
      retriesRemaining,
      atomicError: atomicResult.error,
    });

    retriesRemaining -= 1;
    retried = true;
    ({ headShaBefore, atomicResult } = await attemptMutation(opts));
  }
}

/**
 * Atomic-only multi-file mutation primitive. See module docstring for the
 * full behavior contract.
 */
export async function safeMutation(
  opts: SafeMutationOpts,
): Promise<SafeMutationResult> {
  if (opts.deadlineMs === undefined) {
    return runMutationLoop(opts);
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<typeof SAFE_MUTATION_DEADLINE_SENTINEL>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve(SAFE_MUTATION_DEADLINE_SENTINEL),
      opts.deadlineMs,
    );
  });

  try {
    const raced = await Promise.race([runMutationLoop(opts), deadlinePromise]);
    if (raced === SAFE_MUTATION_DEADLINE_SENTINEL) {
      const msg = `safeMutation deadline exceeded after ${opts.deadlineMs}ms`;
      opts.diagnostics.error("DEADLINE_EXCEEDED", msg, {
        repo: opts.repo,
        deadlineMs: opts.deadlineMs,
      });
      logger.error("safeMutation deadline exceeded", {
        repo: opts.repo,
        deadlineMs: opts.deadlineMs,
      });
      return { ok: false, error: msg, code: "DEADLINE_EXCEEDED" };
    }
    return raced;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}
