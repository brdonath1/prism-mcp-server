/**
 * cc_status — Check status / retrieve results of Claude Code dispatches.
 *
 * Dispatches are persisted as JSON files under
 *   brdonath1/prism-mcp-server/.dispatch/{dispatch_id}.json
 * so that async-mode results survive server restarts and can be read by any
 * stateless request handler. (The server itself has no memory between
 * requests.)
 *
 * This module exports both the MCP tool registration and the helpers
 * (`writeDispatchRecord`, `readDispatchRecord`, `DispatchRecord`) that
 * cc_dispatch uses internally.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CC_DISPATCH_STATE_DIR,
  CC_DISPATCH_STATE_REPO,
  GITHUB_OWNER,
} from "../config.js";
import {
  fetchFile,
  listDirectory,
  pushFile,
} from "../github/client.js";
import { logger } from "../utils/logger.js";

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

/** Path to a specific dispatch record in the state repo. */
function recordPath(dispatchId: string): string {
  return `${CC_DISPATCH_STATE_DIR}/${dispatchId}.json`;
}

/**
 * Read a dispatch record from GitHub. Returns null if the record does not
 * exist. Other errors are rethrown.
 */
export async function readDispatchRecord(
  dispatchId: string,
): Promise<DispatchRecord | null> {
  try {
    const file = await fetchFile(CC_DISPATCH_STATE_REPO, recordPath(dispatchId));
    return JSON.parse(file.content) as DispatchRecord;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not found")) return null;
    throw err;
  }
}

/**
 * Persist a dispatch record to GitHub. If a prior record exists, the
 * `started_at` field from the prior record is preserved (so the completion
 * write doesn't overwrite the original start time).
 */
export async function writeDispatchRecord(
  record: DispatchRecord,
): Promise<void> {
  let finalRecord = record;
  try {
    const existing = await readDispatchRecord(record.dispatch_id);
    if (existing?.started_at) {
      finalRecord = { ...record, started_at: existing.started_at };
    }
  } catch {
    // Non-fatal — first write.
  }

  const body = JSON.stringify(finalRecord, null, 2) + "\n";
  const commit = `prism: cc_dispatch ${record.dispatch_id} ${record.status}`;
  const result = await pushFile(
    CC_DISPATCH_STATE_REPO,
    recordPath(record.dispatch_id),
    body,
    commit,
  );
  if (!result.success) {
    throw new Error(
      `writeDispatchRecord failed for ${record.dispatch_id}: ${result.error}`,
    );
  }
  logger.debug("cc_dispatch record persisted", {
    dispatch_id: record.dispatch_id,
    status: record.status,
  });
}

/**
 * List recent dispatch IDs by enumerating .dispatch/*.json in the state repo.
 * Returns IDs sorted by filename (which includes a timestamp prefix from
 * cc-dispatch's ID generator, so lexical sort ≈ reverse chronological).
 */
async function listDispatchIds(limit: number): Promise<string[]> {
  try {
    const entries = await listDirectory(
      CC_DISPATCH_STATE_REPO,
      CC_DISPATCH_STATE_DIR,
    );
    const ids = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""))
      .sort()
      .reverse();
    return ids.slice(0, limit);
  } catch {
    return [];
  }
}

const inputSchema = {
  dispatch_id: z
    .string()
    .optional()
    .describe(
      "Specific dispatch ID to look up. Omit for a list of the most recent dispatches.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Max number of recent dispatches to return when dispatch_id is omitted."),
};

export function registerCCStatus(server: McpServer): void {
  server.tool(
    "cc_status",
    "Retrieve status / results of Claude Code dispatches. Supply dispatch_id for a specific run, or omit for the most recent N.",
    inputSchema,
    async ({ dispatch_id, limit }) => {
      logger.info("cc_status", { dispatch_id, limit });

      try {
        if (dispatch_id) {
          const record = await readDispatchRecord(dispatch_id);
          if (!record) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `No dispatch found with id ${dispatch_id}`,
                      dispatch_id,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(record, null, 2),
              },
            ],
          };
        }

        // No ID — return a summary list of recent dispatches.
        const ids = await listDispatchIds(limit);
        const records = await Promise.allSettled(
          ids.map((id) => readDispatchRecord(id)),
        );
        const dispatches = records
          .map((r, i) =>
            r.status === "fulfilled" && r.value
              ? summarizeRecord(r.value)
              : { dispatch_id: ids[i], status: "unknown" as const },
          )
          .filter((r): r is ReturnType<typeof summarizeRecord> => r !== null);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: dispatches.length,
                  state_repo: `${GITHUB_OWNER}/${CC_DISPATCH_STATE_REPO}`,
                  dispatches,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("cc_status failed", { dispatch_id, error: msg });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: msg, dispatch_id }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/** Compact record for list view — drops the verbose fields. */
function summarizeRecord(record: DispatchRecord) {
  return {
    dispatch_id: record.dispatch_id,
    repo: record.repo,
    branch: record.branch,
    mode: record.mode,
    status: record.status,
    started_at: record.started_at,
    completed_at: record.completed_at,
    turns: record.turns,
    cost_usd: record.cost_usd,
    pr_url: record.pr_url,
    error: record.error,
  };
}
