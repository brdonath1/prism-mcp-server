/**
 * gh_create_release — Create a new release on a GitHub repo (brief-403).
 *
 * Wraps `POST /repos/{owner}/{repo}/releases`, which the upstream
 * `github/github-mcp-server` does not expose (PRISM S100 confirmed:
 * `create_release` returned zero hits against `github/github-mcp-server@926d04913d`).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRelease } from "../github/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  repo: z
    .string()
    .min(1)
    .describe("Repo name (no owner prefix; owner is GITHUB_OWNER)."),
  tag_name: z
    .string()
    .min(1)
    .describe("Tag name for the release (e.g., 'v1.2.3'). Created if it does not exist."),
  target_commitish: z
    .string()
    .optional()
    .describe(
      "Branch name or commit SHA the release tag points at. Defaults to the repo's default branch when omitted.",
    ),
  name: z
    .string()
    .optional()
    .describe("Display name for the release. Defaults to the tag name when omitted."),
  body: z
    .string()
    .optional()
    .describe("Markdown body for the release notes."),
  draft: z
    .boolean()
    .optional()
    .describe("When true, the release is created as a draft (unpublished)."),
  prerelease: z
    .boolean()
    .optional()
    .describe("When true, marks the release as a prerelease."),
  generate_release_notes: z
    .boolean()
    .optional()
    .describe("When true, GitHub auto-generates release notes from commits/PRs since the previous tag."),
};

export function registerGhCreateRelease(server: McpServer): void {
  server.tool(
    "gh_create_release",
    "Create a new release on a GitHub repository owned by the configured GITHUB_OWNER.",
    inputSchema,
    async ({ repo, tag_name, target_commitish, name, body, draft, prerelease, generate_release_notes }) => {
      logger.info("gh_create_release", { repo, tag_name });

      try {
        const result = await createRelease(repo, {
          tag_name,
          target_commitish,
          name,
          body,
          draft,
          prerelease,
          generate_release_notes,
        });

        if (!result.success) {
          logger.error("gh_create_release failed", { repo, tag_name, error: result.error });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: result.error, repo, tag_name },
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
        logger.error("gh_create_release error", { repo, tag_name, error: msg });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: msg, repo, tag_name }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
