---
brief: 446
title: "Add gh_get_branch_protection + gh_set_branch_protection (general branch-protection tools)"
parallel: false
depends_on: []
affects:
  - src/github/client.ts
  - src/tools/gh-get-branch-protection.ts
  - src/tools/gh-set-branch-protection.ts
  - src/tool-registry.ts
  - tests/
complexity: high
workflow: direct
model: claude-opus-4-8
effort: max
---

# Brief 446 — gh_get_branch_protection + gh_set_branch_protection

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** PRISM S152. The chat session can manage repo files / branches / PRs via the GitHub MCP surface, but neither that proxy nor this server's `gh_*` tools expose **branch protection**. That gap forced a manual `gh api` drop/restore dance when landing a config-only PR on a protected `main` (PR #64, the briefs-off-main cutover). These two tools close the gap so protection can be read and modified programmatically. **CODE.**

## Context
This server's GitHub `gh_*` tools each live in their own `src/tools/gh-*.ts` file, register via a `registerGh<Name>(server)` export wired into `src/tool-registry.ts`, and call thin REST helpers in `src/github/client.ts`. Auth + requests use the raw `fetchWithRetry` helper with headers `Authorization: Bearer ${GITHUB_PAT}`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: prism-mcp-server/${SERVER_VERSION}`, scoped to `GITHUB_OWNER` (repo params carry NO owner prefix). `src/tools/gh-delete-branch.ts` is the closest existing template — mirror its structure, logging (`../utils/logger.js`), and `{ content:[{type:"text", text: JSON.stringify(...,null,2)}], isError }` return shape.

GitHub branch-protection REST endpoints to wrap:
- GET `/repos/{owner}/{repo}/branches/{branch}/protection`
- PUT `/repos/{owner}/{repo}/branches/{branch}/protection`

## Required Changes
**Investigate first.** Read `src/tools/gh-delete-branch.ts` end-to-end for the tool/auth/error pattern, `src/github/client.ts` for the existing REST-helper conventions (how `deleteRef`, `getDefaultBranch`, `fetchWithRetry` are written and exported), and `src/tool-registry.ts` for how `registerGh*` functions are imported and called. Mirror those exactly — do not invent a new pattern or introduce octokit.

1. **Client helpers in `src/github/client.ts`:**
   - `getBranchProtection(repo, branch)` → GET the protection JSON, return the parsed object. On 404 (branch not protected) return a structured `{ protected: false }` rather than throwing, so callers can distinguish "no protection" from a real error.
   - `setBranchProtection(repo, branch, protection)` → PUT the supplied payload. **GitHub PUT quirk (most likely thing to get wrong):** the keys `required_status_checks`, `enforce_admins`, `required_pull_request_reviews`, and `restrictions` are REQUIRED in the PUT body and must be sent explicitly as `null` when the caller does not provide them, or the API returns 422. Normalize the payload so any of those four absent from the caller's input are sent as `null`; pass all other documented fields through when present.
   - Follow the existing `fetchWithRetry` + headers pattern and return a discriminated success/error result consistent with the other helpers.

2. **Tool `gh_get_branch_protection` in `src/tools/gh-get-branch-protection.ts`:** inputs `repo` (string, required, no owner prefix) and `branch` (string, required); returns the current protection JSON (or the `{ protected:false }` shape) as text content. Export `registerGhGetBranchProtection(server)`.

3. **Tool `gh_set_branch_protection` in `src/tools/gh-set-branch-protection.ts`:** inputs `repo` (required), `branch` (required), and `protection` — a Zod object mirroring GitHub's PUT payload. Model the known fields: `required_status_checks` as `{ strict?, contexts?, checks? }` (nullable), `enforce_admins` (boolean, nullable), `required_pull_request_reviews` (object, nullable), `restrictions` (nullable), plus `required_linear_history`, `allow_force_pushes`, `allow_deletions`, `block_creations`, `required_conversation_resolution`, `lock_branch`, `allow_fork_syncing` as optional booleans. Document each field's GitHub meaning via `.describe()`. Handler assembles the payload (filling the four required-or-null keys), calls `setBranchProtection`, returns the resulting protection JSON (or error) in the `{ content, isError }` shape. Export `registerGhSetBranchProtection(server)`.
   - **INS-6 (HARD RULE):** do NOT use `.default()` anywhere in the Zod schemas — use `.optional()` and apply any fallback in the handler body with `?? value`. NOTE: `gh-delete-branch.ts` currently uses `.optional().default(false)` for `allow_with_open_prs`; that is a latent INS-6 violation — do NOT copy it (do not propagate `.default()`).

4. **Register** both tools in `src/tool-registry.ts` following the existing `registerGh*` wiring.

## Verification (HARD BLOCK — land all evidence in the PR body)
1. `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` ALL green. Paste the total test count (N, all passing).
2. Unit tests (mirror existing `gh_*` tool/client tests, mocking the REST layer / `fetchWithRetry` as they do) covering: get returns parsed protection; get on an unprotected branch returns `{ protected:false }` (not a throw); set normalizes the four required-or-null keys (assert a payload omitting e.g. `restrictions` sends `restrictions: null`); set surfaces API errors via `isError: true`.
3. Confirm both tools register and appear in the server's tool list (registry test or count assertion).
4. Confirm CC launched on `claude-opus-4-8` in the PR body.

## Out of Scope
- Any change to existing `gh_*` tools (do not refactor them; the INS-6 `.default()` in gh-delete-branch.ts is noted only so you don't copy it).
- An octokit migration — keep the raw `fetchWithRetry` pattern.
- Calling these tools against any live repo as part of this brief (no real protection changes here — that is the chat session's job afterward).

## PR Title / Body Hint
Title: `feat(gh): add gh_get_branch_protection + gh_set_branch_protection (general branch-protection tools, PRISM S152)`
Body: the access-gap origin (PR #64 manual drop/restore), the two tools + client helpers, the GitHub PUT required-or-null-keys handling, INS-6 compliance (no `.default()`), tests + total count, confirmation CC launched on claude-opus-4-8.

## Brief Author Notes
- Mirror `gh-delete-branch.ts` for tool shape, auth headers, logging, and `{content,isError}` returns.
- The PUT required-or-null-keys quirk is the single most likely bug; the V2 test guards it explicitly.
- Keep `gh_set_branch_protection` a faithful pass-through to GitHub's PUT (a true "general setter") — do not add opinionated guards that would block legitimate protection changes; the caller decides intent. A one-line inline doc ("PUT replaces protection wholesale; GET first and merge") is enough.
- Tier: AUTO. CI gates the merge.

<!-- EOF -->
