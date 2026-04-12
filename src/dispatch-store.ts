/**
 * dispatch-store — In-memory dispatch state with GitHub write-through.
 *
 * This module is the single source of truth for cc_dispatch state. It solves
 * the deploy-trigger problem (D-123): writing state to `prism-mcp-server`
 * triggered Railway auto-deploys, killing in-flight dispatches.
 *
 * Architecture:
 * - Primary store: in-memory Map (fast reads, instant writes, no side effects)
 * - Durable backup: GitHub repo `prism-dispatch-state` (survives restarts)
 * - Write pattern: memory-first, then async fire-and-forget push to GitHub
 * - Read pattern: memory-first, GitHub fallback for cold reads (pre-boot records)
 * - Startup: hydrate memory from GitHub so cc_status works across restarts
 *
 * Key invariant: writeDispatchRecord NEVER blocks on GitHub I/O. The in-memory
 * update is synchronous and the function returns immediately. The GitHub push
 * runs in the background. This means:
 * - Dispatch execution is never delayed by state persistence
 * - A GitHub API outage degrades durability but not functionality
 * - The server can restart and recover state from GitHub on next boot
 */

import {
  CC_DISPATCH_STATE_DIR,
  CC_DISPATCH_STATE_REPO,
} from "./config.js";
import {
  fetchFile,
  listDirectory,
  pushFile,
} from "./github/client.js";
import { logger } from "./utils/logger.js";

/**
 * Shape of a dispatch record. `started_at` is set at dispatch start and
 * preserved across subsequent writes so a completed record still reflects
 * the original start time.
 */
export interface DispatchRecord {
  dispatch_id: string;
  repo: string;
  branch: string;
  mode: "query" | "execute";
  prompt: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string;
  agent: string;
  server_version: string;
  result?: string;
  turns?: number;
  usage?: Record<string, number>;
  cost_usd?: number;
  pr_url?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** Primary dispatch store. Module-level Map persists across requests within
 *  the same Node.js process (stateless per-MCP-request, not per-process). */
const store = new Map<string, DispatchRecord>();

/** Whether initial hydration from GitHub has completed. When false,
 *  listDispatchIds merges memory with GitHub to avoid missing records. */
let hydrated = false;

/** Path to a specific dispatch record in the state repo. */
function recordPath(dispatchId: string): string {
  return `${CC_DISPATCH_STATE_DIR}/${dispatchId}.json`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a dispatch record. Updates in-memory store immediately, then
 * persists to GitHub asynchronously (non-blocking, fire-and-forget).
 *
 * If a prior record exists in memory, the `started_at` field from the
 * prior record is preserved so the completion write doesn't overwrite
 * the original start time.
 *
 * Returns a resolved Promise for interface compatibility with callers
 * that `await` this function — the await resolves instantly since all
 * meaningful work (memory update) is synchronous.
 */
export async function writeDispatchRecord(
  record: DispatchRecord,
): Promise<void> {
  // Preserve started_at from existing record
  const existing = store.get(record.dispatch_id);
  const finalRecord =
    existing?.started_at
      ? { ...record, started_at: existing.started_at }
      : record;

  // Update memory immediately (synchronous, instant)
  store.set(record.dispatch_id, finalRecord);

  // Write-through to GitHub (async, non-blocking, fire-and-forget)
  void persistToGitHub(finalRecord).catch((err) => {
    logger.warn("dispatch-store: GitHub persist failed (non-fatal)", {
      dispatch_id: record.dispatch_id,
      status: record.status,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Read a dispatch record. Checks in-memory store first (instant),
 * falls back to GitHub for records from before this server lifecycle.
 * GitHub-fetched records are cached in memory for future reads.
 */
export async function readDispatchRecord(
  dispatchId: string,
): Promise<DispatchRecord | null> {
  // Check memory first (instant)
  const cached = store.get(dispatchId);
  if (cached) return cached;

  // Fallback to GitHub for pre-boot records
  try {
    const file = await fetchFile(
      CC_DISPATCH_STATE_REPO,
      recordPath(dispatchId),
    );
    const record = JSON.parse(file.content) as DispatchRecord;
    store.set(dispatchId, record); // Cache for future reads
    return record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not found")) return null;
    throw err;
  }
}

/**
 * List recent dispatch IDs. After hydration, memory is the complete source
 * of truth. Before hydration, merges memory with GitHub listing.
 */
export async function listDispatchIds(limit: number): Promise<string[]> {
  // Start with in-memory records
  const memoryIds = Array.from(store.keys());

  // If hydrated, memory is the source of truth
  if (hydrated) {
    return memoryIds.sort().reverse().slice(0, limit);
  }

  // Pre-hydration: merge with GitHub
  try {
    const entries = await listDirectory(
      CC_DISPATCH_STATE_REPO,
      CC_DISPATCH_STATE_DIR,
    );
    const githubIds = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""));

    const allIds = [...new Set([...memoryIds, ...githubIds])];
    return allIds.sort().reverse().slice(0, limit);
  } catch {
    // GitHub unavailable — return what we have in memory
    return memoryIds.sort().reverse().slice(0, limit);
  }
}

/**
 * Hydrate the in-memory store from GitHub on server startup.
 * Loads the most recent N records so cc_status works immediately for
 * dispatches from prior server lifecycles.
 *
 * This runs asynchronously after the server starts listening — it does
 * NOT block request handling. If hydration fails, the server operates
 * in memory-only mode (new dispatches still work; old ones are inaccessible
 * until the next successful hydration).
 */
export async function hydrateStore(limit = 50): Promise<void> {
  const start = Date.now();
  try {
    const entries = await listDirectory(
      CC_DISPATCH_STATE_REPO,
      CC_DISPATCH_STATE_DIR,
    );
    const files = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .sort((a, b) => b.name.localeCompare(a.name)) // newest first
      .slice(0, limit);

    if (files.length === 0) {
      hydrated = true;
      logger.info("dispatch-store: hydrated (no records found)", {
        ms: Date.now() - start,
      });
      return;
    }

    const results = await Promise.allSettled(
      files.map(async (entry) => {
        const file = await fetchFile(
          CC_DISPATCH_STATE_REPO,
          `${CC_DISPATCH_STATE_DIR}/${entry.name}`,
        );
        return JSON.parse(file.content) as DispatchRecord;
      }),
    );

    let loaded = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        store.set(result.value.dispatch_id, result.value);
        loaded++;
      }
    }

    hydrated = true;
    logger.info("dispatch-store: hydrated", {
      loaded,
      total_entries: files.length,
      ms: Date.now() - start,
    });
  } catch (err) {
    // Mark as hydrated even on failure — prevents repeated GitHub calls
    // on every listDispatchIds. The server operates in memory-only mode.
    hydrated = true;
    logger.warn(
      "dispatch-store: hydration failed (operating memory-only)",
      {
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - start,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Persist a record to GitHub. Called asynchronously after memory write.
 * Failures are non-fatal — the record exists in memory regardless.
 */
async function persistToGitHub(record: DispatchRecord): Promise<void> {
  const body = JSON.stringify(record, null, 2) + "\n";
  const commit = `prism: cc_dispatch ${record.dispatch_id} ${record.status}`;
  const result = await pushFile(
    CC_DISPATCH_STATE_REPO,
    recordPath(record.dispatch_id),
    body,
    commit,
  );
  if (!result.success) {
    throw new Error(
      `persistToGitHub failed for ${record.dispatch_id}: ${result.error}`,
    );
  }
  logger.debug("dispatch-store: persisted to GitHub", {
    dispatch_id: record.dispatch_id,
    status: record.status,
  });
}
