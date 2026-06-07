/**
 * gh_set_branch_protection — Replace a branch's protection settings (brief-446).
 *
 * Wraps `PUT /repos/{owner}/{repo}/branches/{branch}/protection`, which
 * neither the GitHub MCP proxy nor this server's other `gh_*` tools expose.
 * PRISM S152 hit that gap when landing PR #64 on a protected `main` — the
 * drop/restore dance had to be done manually via `gh api`. This tool (with
 * gh_get_branch_protection) closes it.
 *
 * This is a faithful general setter — no opinionated guards; the caller
 * decides intent. PUT replaces protection wholesale; GET first (via
 * gh_get_branch_protection) and merge when preserving existing settings.
 *
 * The GitHub PUT quirk (required-or-null keys) is normalized in
 * setBranchProtection: `required_status_checks`, `enforce_admins`,
 * `required_pull_request_reviews`, and `restrictions` are sent as explicit
 * `null` when omitted here, so the API does not 422.
 *
 * INS-6: no `.default()` in the Zod schemas — optional fields stay absent
 * and any fallback happens in the handler body.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setBranchProtection } from "../github/client.js";
import { logger } from "../utils/logger.js";

/** `{ users, teams, apps }` actor-list shape shared by dismissal_restrictions and bypass_pull_request_allowances. */
const actorListSchema = z.object({
  users: z
    .array(z.string())
    .optional()
    .describe("User logins."),
  teams: z
    .array(z.string())
    .optional()
    .describe("Team slugs."),
  apps: z
    .array(z.string())
    .optional()
    .describe("GitHub App slugs."),
});

const protectionSchema = z
  .object({
    required_status_checks: z
      .object({
        strict: z
          .boolean()
          .optional()
          .describe("Require branches to be up to date with the base branch before merging."),
        contexts: z
          .array(z.string())
          .optional()
          .describe("Status check context names that must pass (deprecated by GitHub in favor of checks)."),
        checks: z
          .array(
            z.object({
              context: z
                .string()
                .describe("Name of the required status check context."),
              app_id: z
                .number()
                .int()
                .optional()
                .describe("ID of the GitHub App that must provide this check. Omit to allow any source; pass -1 to explicitly allow any app."),
            }),
          )
          .optional()
          .describe("Status checks that must pass before merging."),
      })
      .nullable()
      .optional()
      .describe("Require status checks to pass before merging. Omit or pass null to disable status-check enforcement."),
    enforce_admins: z
      .boolean()
      .nullable()
      .optional()
      .describe("Enforce all configured restrictions for administrators too. Omit or pass null to disable."),
    required_pull_request_reviews: z
      .object({
        dismissal_restrictions: actorListSchema
          .optional()
          .describe("Who can dismiss pull request reviews (organization-owned repos only)."),
        dismiss_stale_reviews: z
          .boolean()
          .optional()
          .describe("Automatically dismiss approving reviews when new commits are pushed."),
        require_code_owner_reviews: z
          .boolean()
          .optional()
          .describe("Block merging until a code owner has reviewed."),
        required_approving_review_count: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe("Number of approving reviews required before merging (0-6)."),
        require_last_push_approval: z
          .boolean()
          .optional()
          .describe("Require someone other than the most recent pusher to approve."),
        bypass_pull_request_allowances: actorListSchema
          .optional()
          .describe("Who is allowed to bypass pull request requirements (organization-owned repos only)."),
      })
      .nullable()
      .optional()
      .describe("Require pull request reviews before merging. Omit or pass null to disable review requirements."),
    restrictions: z
      .object({
        users: z
          .array(z.string())
          .describe("User logins allowed to push to the branch."),
        teams: z
          .array(z.string())
          .describe("Team slugs allowed to push to the branch."),
        apps: z
          .array(z.string())
          .optional()
          .describe("GitHub App slugs allowed to push to the branch."),
      })
      .nullable()
      .optional()
      .describe("Restrict who can push to the branch (organization-owned repos only). Omit or pass null to disable push restrictions."),
    required_linear_history: z
      .boolean()
      .optional()
      .describe("Require a linear commit history — blocks merge commits onto the branch."),
    allow_force_pushes: z
      .boolean()
      .optional()
      .describe("Permit force pushes to the branch by anyone with push access."),
    allow_deletions: z
      .boolean()
      .optional()
      .describe("Allow users with push access to delete the branch."),
    block_creations: z
      .boolean()
      .optional()
      .describe("Block creation of matching branches (only meaningful when the protection rule pattern matches branches that do not yet exist)."),
    required_conversation_resolution: z
      .boolean()
      .optional()
      .describe("Require all PR review conversations to be resolved before merging."),
    lock_branch: z
      .boolean()
      .optional()
      .describe("Lock the branch read-only — no pushes from anyone."),
    allow_fork_syncing: z
      .boolean()
      .optional()
      .describe("Allow users to pull changes from upstream when the branch is locked (fork repos only)."),
  })
  .describe(
    "GitHub branch-protection settings (PUT payload). PUT replaces protection wholesale — GET the current protection first and merge to preserve existing settings. required_status_checks, enforce_admins, required_pull_request_reviews, and restrictions are sent as explicit null when omitted (GitHub requires all four keys present).",
  );

const inputSchema = {
  repo: z
    .string()
    .min(1)
    .describe("Repo name (no owner prefix; owner is GITHUB_OWNER)."),
  branch: z
    .string()
    .min(1)
    .describe("Branch name (no 'heads/' prefix)."),
  protection: protectionSchema,
};

export function registerGhSetBranchProtection(server: McpServer): void {
  server.tool(
    "gh_set_branch_protection",
    "Replace the branch protection settings for a branch on a GitHub repository owned by the configured GITHUB_OWNER. The PUT replaces protection wholesale — read the current settings with gh_get_branch_protection first and merge to preserve them. Omitted required-or-null keys (required_status_checks, enforce_admins, required_pull_request_reviews, restrictions) are sent as null, which disables them.",
    inputSchema,
    async ({ repo, branch, protection }) => {
      logger.info("gh_set_branch_protection", {
        repo,
        branch,
        protection_keys: Object.keys(protection),
      });

      try {
        const result = await setBranchProtection(repo, branch, protection);

        if (!result.success) {
          logger.error("gh_set_branch_protection failed", { repo, branch, error: result.error });
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
        logger.error("gh_set_branch_protection error", { repo, branch, error: msg });
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
