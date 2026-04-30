/**
 * gh_update_release — Update an existing release on a GitHub repo (brief-403).
 *
 * Wraps `PATCH /repos/{owner}/{repo}/releases/{release_id}`. Only fields
 * the caller explicitly sets are forwarded — passing nothing is rejected
 * upfront so we don't fire a no-op PATCH against GitHub.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateRelease } from "../github/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  repo: z
    .string()
    .min(1)
    .describe("Repo name (no owner prefix; owner is GITHUB_OWNER)."),
  release_id: z
    .number()
    .int()
    .describe("Numeric release ID returned by gh_create_release or the GitHub Releases API."),
  tag_name: z
    .string()
    .optional()
    .describe("New tag name to point the release at."),
  target_commitish: z
    .string()
    .optional()
    .describe("New target branch or commit SHA for the tag."),
  name: z
    .string()
    .optional()
    .describe("New display name for the release."),
  body: z
    .string()
    .optional()
    .describe("New markdown body for the release notes."),
  draft: z
    .boolean()
    .optional()
    .describe("Toggle draft state."),
  prerelease: z
    .boolean()
    .optional()
    .describe("Toggle prerelease state."),
};

export function registerGhUpdateRelease(server: McpServer): void {
  server.tool(
    "gh_update_release",
    "Update an existing release on a GitHub repository owned by the configured GITHUB_OWNER.",
    inputSchema,
    async ({ repo, release_id, tag_name, target_commitish, name, body, draft, prerelease }) => {
      logger.info("gh_update_release", { repo, release_id });

      const params = {
        tag_name,
        target_commitish,
        name,
        body,
        draft,
        prerelease,
      };

      // Reject no-op calls — silently PATCHing with an empty body would
      // hit GitHub for nothing and confuse the operator.
      const hasUpdate = Object.values(params).some((v) => v !== undefined);
      if (!hasUpdate) {
        const errMsg =
          "gh_update_release requires at least one update field " +
          "(tag_name, target_commitish, name, body, draft, prerelease).";
        logger.warn("gh_update_release rejected: no fields", { repo, release_id });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: errMsg, repo, release_id },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await updateRelease(repo, release_id, params);

        if (!result.success) {
          logger.error("gh_update_release failed", {
            repo,
            release_id,
            error: result.error,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: result.error, repo, release_id },
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
                {
                  repo,
                  release_id: result.release_id,
                  html_url: result.html_url,
                  tag_name: result.tag_name,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("gh_update_release error", { repo, release_id, error: msg });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: msg, repo, release_id }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
