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
 *   - On ANY atomic-commit failure (not only 409): snapshots HEAD again and,
 *     when HEAD moved, fetches the new HEAD commit and compares its message to
 *     `commitMessage`. If it matches, the "failed" commit actually LANDED
 *     (lost response on a slow/dropped socket) — returns ok with that SHA
 *     instead of retrying, so the mutation is NOT double-applied (SRV-41).
 *     Otherwise it refuses retry if either SHA is null (HEAD_SHA_UNKNOWN),
 *     and otherwise re-reads files, re-runs computeMutation against fresh
 *     data, and retries. The retry-class diagnostic distinguishes a genuine
 *     409/non-fast-forward conflict (MUTATION_CONFLICT) from any other
 *     retryable failure (MUTATION_RETRY) — the old code mislabeled every
 *     failure MUTATION_CONFLICT (SRV-96).
 *   - On retry exhaustion: MUTATION_RETRY_EXHAUSTED.
 *   - Optional deadline via Promise.race. On expiry the in-flight commit's
 *     AbortSignal is fired (createAtomicCommit cancels its fetch) and the loop
 *     refuses to start another attempt, so a timed-out mutation cannot commit
 *     AFTER the DEADLINE_EXCEEDED response is returned (SRV-42).
 *
 * Diagnostic codes emitted by this primitive:
 *   MUTATION_CONFLICT, MUTATION_RETRY, MUTATION_ALREADY_APPLIED,
 *   MUTATION_RETRY_EXHAUSTED, HEAD_SHA_UNKNOWN, DEADLINE_EXCEEDED.
 */

import {
  fetchFile,
  createAtomicCommit,
  getCommit,
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
  /**
   * Optional external AbortSignal (SRV-42). When the caller owns the deadline
   * (e.g. prism_finalize's commit Promise.race), it passes a signal it aborts
   * on expiry; safeMutation forwards it to the in-flight commit so a
   * timed-out finalize cannot commit after the error response is returned.
   * Combined with the internal deadline signal when both are present.
   */
  signal?: AbortSignal;
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
  signal?: AbortSignal,
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
    signal,
  );
  return { headShaBefore, atomicResult };
}

/**
 * Classify an atomic-commit error string into the diagnostic code that
 * describes its retry class (SRV-96). A 409 / non-fast-forward is a genuine
 * concurrency conflict (MUTATION_CONFLICT); everything else that we still
 * retry (transient 401/5xx/timeout, or a permanent 4xx that will simply fail
 * again) is MUTATION_RETRY — NOT a conflict.
 */
function classifyAtomicError(error: string | undefined): "MUTATION_CONFLICT" | "MUTATION_RETRY" {
  if (error && /\b409\b|conflict|not a fast forward|fast-forward/i.test(error)) {
    return "MUTATION_CONFLICT";
  }
  return "MUTATION_RETRY";
}

/**
 * Internal mutation loop without the deadline wrapper. Returns the structured
 * result; the wrapper races this against an optional deadline timer.
 */
async function runMutationLoop(
  opts: SafeMutationOpts,
  signal?: AbortSignal,
): Promise<SafeMutationResult> {
  const maxRetries = opts.maxRetries ?? 1;
  let retriesRemaining = maxRetries;
  let retried = false;

  // First attempt
  let { headShaBefore, atomicResult } = await attemptMutation(opts, signal);

  while (true) {
    if (atomicResult.success) {
      return { ok: true, commitSha: atomicResult.sha, retried };
    }

    // SRV-42: the deadline fired and aborted the in-flight commit. Do NOT
    // start another attempt — a retry here is exactly the post-deadline
    // commit the abort is meant to prevent. The Promise.race has already
    // returned DEADLINE_EXCEEDED to the caller; this just stops the loop.
    if (signal?.aborted) {
      return {
        ok: false,
        error: "mutation aborted by deadline",
        code: "DEADLINE_EXCEEDED",
      };
    }

    // Atomic commit reported failure. Snapshot HEAD again to learn whether it
    // moved (concurrent writer OR our own lost-response commit).
    const headShaAfter = await getHeadSha(opts.repo);

    // SRV-41: landed-but-unreported detection. If HEAD moved, the "failed"
    // commit may have actually LANDED — createAtomicCommit's final ref PATCH
    // can succeed server-side while the response is lost to a timeout/socket
    // drop. Re-applying on retry would double-write (e.g. prism_patch appends
    // the same entry twice). Fetch the new HEAD commit and compare its message
    // to ours; if it matches, our commit landed — return ok with that SHA
    // instead of retrying. getCommit failure is non-fatal: fall through to the
    // normal conflict/retry path (the prior safe behavior).
    if (headShaBefore && headShaAfter && headShaBefore !== headShaAfter) {
      try {
        const headCommit = await getCommit(opts.repo, headShaAfter);
        if (headCommit.message === opts.commitMessage) {
          opts.diagnostics.warn(
            "MUTATION_ALREADY_APPLIED",
            "Atomic commit reported failure but the commit actually landed (HEAD message matches) — returning success instead of double-applying",
            { repo: opts.repo, headShaBefore, headShaAfter, atomicError: atomicResult.error },
          );
          logger.warn("safeMutation: failed commit actually landed — not retrying", {
            repo: opts.repo,
            headShaAfter,
            atomicError: atomicResult.error,
          });
          return { ok: true, commitSha: headShaAfter, retried };
        }
      } catch (verifyErr) {
        logger.warn("safeMutation could not verify HEAD commit message — proceeding to retry", {
          repo: opts.repo,
          headShaAfter,
          error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
        });
      }
    }

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

    // The commit did NOT land. Decide whether it's safe to retry.
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

    // SRV-96: label the retry by its real failure class. A 409 /
    // non-fast-forward is a genuine concurrency conflict (MUTATION_CONFLICT);
    // any other retryable failure is MUTATION_RETRY — the old code mislabeled
    // every failure MUTATION_CONFLICT, contradicting the module contract.
    const retryCode = classifyAtomicError(atomicResult.error);
    opts.diagnostics.warn(retryCode, "Atomic commit failed — retrying with fresh content", {
      repo: opts.repo,
      headShaBefore,
      headShaAfter,
      headChanged: headShaBefore !== headShaAfter,
      atomicError: atomicResult.error,
    });
    logger.warn("safeMutation retrying", {
      repo: opts.repo,
      retryClass: retryCode,
      headChanged: headShaBefore !== headShaAfter,
      retriesRemaining,
      atomicError: atomicResult.error,
    });

    retriesRemaining -= 1;
    retried = true;
    ({ headShaBefore, atomicResult } = await attemptMutation(opts, signal));
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
    // No internal deadline — forward any caller-owned signal directly so an
    // external deadline (e.g. prism_finalize's commit race) still cancels the
    // in-flight commit (SRV-42).
    return runMutationLoop(opts, opts.signal);
  }

  // SRV-42: an AbortController fences the in-flight commit. When the deadline
  // fires we abort it so createAtomicCommit's in-flight fetch is cancelled and
  // the loop refuses to start another attempt — a "timed-out" mutation can no
  // longer commit AFTER the DEADLINE_EXCEEDED response is returned. When the
  // caller also owns a signal, combine them so either source cancels.
  const controller = new AbortController();
  const loopSignal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<typeof SAFE_MUTATION_DEADLINE_SENTINEL>((resolve) => {
    deadlineTimer = setTimeout(
      () => resolve(SAFE_MUTATION_DEADLINE_SENTINEL),
      opts.deadlineMs,
    );
  });

  try {
    const raced = await Promise.race([
      runMutationLoop(opts, loopSignal),
      deadlinePromise,
    ]);
    if (raced === SAFE_MUTATION_DEADLINE_SENTINEL) {
      // Cancel the in-flight (and any would-be next) commit.
      controller.abort();
      const msg =
        `safeMutation deadline exceeded after ${opts.deadlineMs}ms — in-flight ` +
        `commit signaled to abort. The atomic commit is all-or-nothing: it may ` +
        `or may not have landed before the abort; verify via the repo HEAD.`;
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
