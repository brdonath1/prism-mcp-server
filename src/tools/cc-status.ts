/**
 * cc_status — Check status / retrieve results of Claude Code dispatches.
 *
 * State management has been moved to ../dispatch-store.ts (D-123).
 * This module only contains the MCP tool registration.
 *
 * The dispatch store uses an in-memory Map as the primary read source,
 * with GitHub (brdonath1/prism-dispatch-state) as a durable backup.
 * This decouples state writes from the prism-mcp-server repo, preventing
 * Railway auto-deploy triggers that previously killed in-flight dispatches.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CC_DISPATCH_STATE_REPO,
  GITHUB_OWNER,
} from "../config.js";
import {
  readDispatchRecord,
  listDispatchIds,
  type DispatchRecord,
} from "../dispatch-store.js";
import { logger } from "../utils/logger.js";

// Re-export for backward compatibility — cc-dispatch.ts previously imported
// these from this module. New code should import from dispatch-store directly.
export type { DispatchRecord } from "../dispatch-store.js";
export { writeDispatchRecord, readDispatchRecord } from "../dispatch-store.js";

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
