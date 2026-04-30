/**
 * gh_delete_branch — Delete a branch from a GitHub repo (brief-403).
 *
 * Wraps the stable REST endpoint `DELETE /repos/{owner}/{repo}/git/refs/heads/{name}`
 * which the upstream `github/github-mcp-server` does not expose. PRISM S100
 * verified absence by grepping `delete_branch`, `Refs.Delete`, and
 * `git/refs/heads` against `github/github-mcp-server@926d04913d` (zero hits).
 *
 * Safety:
 *   - Refuses to delete the repository's default branch (resolved via
 *     getDefaultBranch) before any API call is made.
 *   - By default, refuses if the branch has any open pull requests against
 *     it. Set `allow_with_open_prs: true` to bypass that check.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GITHUB_API_BASE,
  GITHUB_OWNER,
  GITHUB_PAT,
  SERVER_VERSION,
} from "../config.js";
import { deleteRef, fetchWithRetry, getDefaultBranch } from "../github/client.js";
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
  allow_with_open_prs: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, skips the open-pull-request safety check. Defaults to false.",
    ),
};

interface OpenPrSummary {
  number: number;
  title: string;
}

/**
 * Query GitHub for open PRs whose head ref is the candidate branch.
 * Inlined here because no other tool needs this lookup. Builds headers
 * inline following the same pattern as cc-dispatch's createPullRequest.
 */
async function listOpenPullRequestsForBranch(
  repo: string,
  branch: string,
): Promise<OpenPrSummary[]> {
  const head = `${GITHUB_OWNER}:${branch}`;
  const url =
    `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/pulls` +
    `?state=open&head=${encodeURIComponent(head)}`;

  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `prism-mcp-server/${SERVER_VERSION}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`listOpenPullRequestsForBranch ${res.status}: ${text}`);
  }

  const data = (await res.json()) as Array<{ number: number; title: string }>;
  return data.map((pr) => ({ number: pr.number, title: pr.title }));
}

export function registerGhDeleteBranch(server: McpServer): void {
  server.tool(
    "gh_delete_branch",
    "Delete a branch from a GitHub repository owned by the configured GITHUB_OWNER. Refuses to delete the repository's default branch. Optionally refuses if the branch has any open pull requests against it.",
    inputSchema,
    async ({ repo, branch, allow_with_open_prs }) => {
      logger.info("gh_delete_branch", { repo, branch, allow_with_open_prs });

      try {
        // 1. Default-branch guard. Resolved upfront so the API is never
        //    called on a clearly-unsafe target. Git refs are case-sensitive
        //    so we compare by exact string match.
        const defaultBranch = await getDefaultBranch(repo);
        if (branch === defaultBranch) {
          const errMsg = `Refusing to delete default branch '${branch}' on ${repo}`;
          logger.warn("gh_delete_branch refused: default branch", { repo, branch });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: errMsg, repo, branch }, null, 2),
              },
            ],
            isError: true,
          };
        }

        // 2. Open-PR guard, unless the caller explicitly opts out.
        if (allow_with_open_prs !== true) {
          const openPrs = await listOpenPullRequestsForBranch(repo, branch);
          if (openPrs.length > 0) {
            const named = openPrs.slice(0, 5).map((pr) => `#${pr.number}`);
            const suffix = openPrs.length > 5 ? ` (+${openPrs.length - 5} more)` : "";
            const errMsg =
              `Refusing to delete '${branch}' on ${repo}: ` +
              `${openPrs.length} open pull request(s) ` +
              `[${named.join(", ")}${suffix}]. ` +
              "Pass allow_with_open_prs: true to override.";
            logger.warn("gh_delete_branch refused: open PRs", {
              repo,
              branch,
              openPrCount: openPrs.length,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: errMsg,
                      repo,
                      branch,
                      open_pull_requests: openPrs.slice(0, 5),
                      open_pull_request_count: openPrs.length,
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }
        }

        // 3. Delete the ref. deleteRef encodes 422 ("ref already absent")
        //    as a soft success with a `note` so re-runs don't error.
        const result = await deleteRef(repo, `heads/${branch}`);
        if (!result.success) {
          logger.error("gh_delete_branch failed", { repo, branch, error: result.error });
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

        const body: Record<string, unknown> = {
          repo,
          branch,
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
        logger.error("gh_delete_branch error", { repo, branch, error: msg });
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
