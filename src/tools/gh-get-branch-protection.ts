/**
 * gh_get_branch_protection — Read a branch's protection settings (brief-446).
 *
 * Wraps `GET /repos/{owner}/{repo}/branches/{branch}/protection`, which
 * neither the GitHub MCP proxy nor this server's other `gh_*` tools expose.
 * PRISM S152 hit that gap when landing PR #64 on a protected `main` — the
 * drop/restore dance had to be done manually via `gh api`. This tool (with
 * gh_set_branch_protection) closes it.
 *
 * An unprotected branch is reported as the soft sentinel
 * `{ protected: false }` rather than an error, per the getBranchProtection
 * contract — callers can distinguish "no protection rule" from a real
 * API failure.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBranchProtection } from "../github/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  repo: z
    .string()
    .min(1)
    .describe("Repo name (no owner prefix; owner is GITHUB_OWNER)."),
  branch: z
    .string()
    .min(1)
    .describe("Branch name (no 'heads/' prefix)."),
};

export function registerGhGetBranchProtection(server: McpServer): void {
  server.tool(
    "gh_get_branch_protection",
    "Read the branch protection settings for a branch on a GitHub repository owned by the configured GITHUB_OWNER. Returns { protected: false } when the branch has no protection rule.",
    inputSchema,
    async ({ repo, branch }) => {
      logger.info("gh_get_branch_protection", { repo, branch });

      try {
        const result = await getBranchProtection(repo, branch);

        if (!result.success) {
          logger.error("gh_get_branch_protection failed", { repo, branch, error: result.error });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: result.error, repo, branch },
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
              text: JSON.stringify(
                { repo, branch, protection: result.protection },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("gh_get_branch_protection error", { repo, branch, error: msg });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: msg, repo, branch }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
