/**
 * gh_delete_tag — Delete a tag from a GitHub repo (brief-404).
 *
 * Wraps `DELETE /repos/{owner}/{repo}/git/refs/tags/{tag}` via the existing
 * `deleteRef` primitive. Pairs ergonomically with `gh_create_release`, which
 * creates tags as a side effect of release creation; this closes the
 * complementary lifecycle.
 *
 * Tags do not have a default-vs-non-default distinction and cannot have
 * pull requests against them, so this tool intentionally has no safety
 * guards beyond the idempotent 422 handling inherited from `deleteRef`.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteRef } from "../github/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  repo: z
    .string()
    .min(1)
    .describe("Repo name (no owner prefix; owner is GITHUB_OWNER)."),
  tag: z
    .string()
    .min(1)
    .describe("Tag name (no 'refs/tags/' or 'tags/' prefix; e.g. 'v1.0.0')."),
};

export function registerGhDeleteTag(server: McpServer): void {
  server.tool(
    "gh_delete_tag",
    "Delete a tag from a GitHub repository owned by the configured GITHUB_OWNER. Idempotent: a tag that does not exist resolves to success with a note. No default-tag or open-PR guards (tags have no such concepts).",
    inputSchema,
    async ({ repo, tag }) => {
      logger.info("gh_delete_tag", { repo, tag });

      try {
        // deleteRef encodes 422 ("ref already absent") as a soft success
        // with a `note` so re-runs don't error.
        const result = await deleteRef(repo, `tags/${tag}`);
        if (!result.success) {
          logger.error("gh_delete_tag failed", { repo, tag, error: result.error });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: result.error, repo, tag },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }

        const body: Record<string, unknown> = {
          repo,
          tag,
          deleted: true,
        };
        if (result.note) body.note = result.note;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(body, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("gh_delete_tag error", { repo, tag, error: msg });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: msg, repo, tag }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
