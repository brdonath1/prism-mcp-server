# Brief 403 — Add GitHub utility tools (gh_delete_branch, gh_create_release, gh_update_release)

**Project:** brdonath1/prism-mcp-server
**Origin:** PRISM S100 — close INS-226 MCP-gap for branch deletion + release management
**Scope:** Add three new MCP tools that wrap stable GitHub REST endpoints not exposed by GitHub's official MCP server.
**Mode:** execute. Single PR.
**Brief id:** 403 (numeric, ≥ 300 per INS-211 safety threshold).

---

## 1. Background and grounding

The deployed `github-mcp-server` MCP (Railway service `github-mcp-server` under project `prism-mcp-server`, source repo `brdonath1/github-mcp-proxy`) is a Caddy reverse-proxy in front of `ghcr.io/github/github-mcp-server` (GitHub's official Go binary). PRISM S100 verified that branch deletion (`DELETE /repos/{owner}/{repo}/git/refs/heads/{name}`) and release management (`POST/PATCH /repos/{owner}/{repo}/releases`) are NOT implemented in upstream — searches for `delete_branch`, `Refs.Delete`, `git/refs/heads`, and `create_release` against `github/github-mcp-server@926d04913d` returned zero matches.

Operator preference (PRISM INS-226, S99): handle all GitHub tasks via MCP, never redirect to GitHub UI for things the API can do. The current 16 stale feature branches on `brdonath1/trigger` cannot be deleted via MCP today. This brief closes that gap by adding the missing tools to `prism-mcp-server` (which already has a hand-rolled GitHub fetch wrapper at `src/github/client.ts` and an established tool registration pattern). No new repo, no new Railway service, no new auth scaffolding.

The issues-feature-flag side of the S100 work landed separately on `brdonath1/github-mcp-proxy` at commits `21205215` (Caddyfile) and `a2949977` (README) — that surfaces upstream `create_issue` / `update_issue_*` granular tools via the `X-MCP-Features: issues_granular` header. NOT in scope for this brief.

## 2. Required reading before any code is written

Read these files end-to-end before authoring any change. The brief depends on patterns established in each.

1. `src/github/client.ts` — pay special attention to: header construction (`headers()`), URL construction patterns, `fetchWithRetry` retry/timeout semantics, `handleApiError` status-code translation, `getDefaultBranch` cache, the URL asymmetry note in `createAtomicCommit` (singular `git/ref/{ref}` for GET vs plural `git/refs/{ref}` for PATCH — DO NOT collapse).
2. `src/tools/cc-status.ts` — small, recent example of the canonical tool registration pattern: zod input schema, `server.tool(name, desc, schema, handler)`, `{ content: [{ type: "text" as const, text: JSON.stringify(...) }] }` response shape, `isError: true` on failure, structured `logger.info` / `logger.error` calls.
3. `src/tool-registry.ts` — read entirely. The `TOOL_REGISTRY` array, `ToolCategory` union, `getExpectedToolSurface` derivation, and `POST_BOOT_TOOL_SEARCHES` are coupled. The drift-guard test in `tests/tool-surface.test.ts` will fail if these fall out of sync with `src/index.ts`.
4. `src/index.ts` — the `createServer()` function and its register call sequence. Tool registration happens in fixed order; new registrations append to the end of the relevant section.
5. `tests/tool-surface.test.ts` — read whatever tests it contains. The brief assumes there is at least one test that asserts every tool name in `TOOL_REGISTRY` matches at least one keyword in `POST_BOOT_TOOL_SEARCHES`. Confirm before editing.
6. `src/middleware/auth.ts` — confirm the new tools inherit the existing bearer-token + IP-allowlist middleware automatically (they will, because middleware is mounted on `app.use` before the `/mcp` handler). No auth code needed in the new tools themselves.

## 3. Implementation

### 3.1 Extend `src/github/client.ts` with three new functions

Add these as new exports following the existing function patterns in the same file. Use `headers()`, `fetchWithRetry`, `handleApiError`, the `GITHUB_API_BASE` / `GITHUB_OWNER` config, and structured `logger.debug` / `logger.error` calls consistent with neighboring functions.

**Function 1: `deleteRef(repo: string, ref: string): Promise<{ success: boolean; error?: string }>`**

- `ref` is a fully-qualified ref like `heads/feature-branch` or `tags/v1.2.3`. Caller is responsible for the prefix; this function does not validate or assume the ref type.
- Endpoint: `DELETE ${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/refs/${ref}` — note plural `refs`, not singular `ref`. The URL asymmetry documented in `createAtomicCommit` (singular for GET, plural for PATCH/DELETE) applies here.
- A successful delete returns 204 No Content. Treat any 2xx as success.
- 422 ("Reference does not exist") is treated as success with a `note` field ("ref already absent"). Idempotent — callers re-running cleanup do not error on already-deleted branches.
- 404 is a hard error — repo or owner is wrong.
- Other status codes route through `handleApiError`.
- Match the error-handling shape of `deleteFile` (try/catch returning `{ success: false, error }` rather than throwing).

**Function 2: `createRelease(repo: string, params): Promise<ReleaseResult>`** where `params` is `{ tag_name: string; target_commitish?: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; generate_release_notes?: boolean }` and `ReleaseResult` is `{ success: boolean; release_id?: number; html_url?: string; tag_name?: string; error?: string }`.

- Endpoint: `POST ${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/releases`
- Request body: pass-through of the `params` object as JSON, omitting undefined fields.
- 201 Created on success; extract `id`, `html_url`, `tag_name` from the response.
- 422 with body containing `"already_exists"` → return `{ success: false, error: "Release with tag X already exists" }` (do not throw — caller may want to call `updateRelease` instead).
- Other errors via `handleApiError`.

**Function 3: `updateRelease(repo: string, releaseId: number, params): Promise<ReleaseResult>`** where `params` is the same shape as `createRelease` but all fields optional.

- Endpoint: `PATCH ${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/releases/${releaseId}`
- Request body: only fields explicitly set in `params`. Do not send fields the caller did not provide.
- 200 OK on success; same response shape as `createRelease`.
- 404 → `{ success: false, error: "Release not found" }`.
- Other errors via `handleApiError`.

Add a corresponding type to `src/github/types.ts`:
```ts
export interface ReleaseResult {
  success: boolean;
  release_id?: number;
  html_url?: string;
  tag_name?: string;
  note?: string;
  error?: string;
}
```

### 3.2 Create `src/tools/gh-delete-branch.ts`

Tool name: `gh_delete_branch`.
Description: "Delete a branch from a GitHub repository owned by the configured GITHUB_OWNER. Refuses to delete the repository's default branch. Optionally refuses if the branch has any open pull requests against it."

Input schema (zod):
- `repo: string` — repo name (no owner prefix; owner is `GITHUB_OWNER`).
- `branch: string` — branch name (no `heads/` prefix).
- `allow_with_open_prs?: boolean` — default `false`. When true, skips the open-PR safety check.

Handler logic:
1. Resolve the default branch via `getDefaultBranch(repo)`. If `branch === defaultBranch` (case-sensitive match, since git refs are case-sensitive), return `isError: true` with message `"Refusing to delete default branch '${branch}' on ${repo}"`. Do not call the API.
2. If `allow_with_open_prs !== true`, query `GET ${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/pulls?state=open&head=${GITHUB_OWNER}:${branch}` (use `headers()` + `fetchWithRetry`). If the response array length > 0, return `isError: true` with message naming the PR numbers. Cap the named PRs at 5 to keep output bounded.
3. Call `deleteRef(repo, "heads/" + branch)`.
4. On `success: true`, return a JSON body of `{ repo, branch, deleted: true, note: <if present> }`.
5. On `success: false`, return `isError: true` with the wrapped error.

Apply the same response shape as `cc-status.ts`: `{ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] }` for success, same shape with `isError: true` for failures. Wrap in try/catch following the cc-status pattern.

### 3.3 Create `src/tools/gh-create-release.ts`

Tool name: `gh_create_release`.
Description: "Create a new release on a GitHub repository owned by the configured GITHUB_OWNER."

Input schema (zod): pass through the `createRelease` params (`tag_name` required; everything else optional). Add a `.describe()` on each field.

Handler: call `createRelease(repo, params)`, return JSON shape `{ repo, release_id, html_url, tag_name }` on success; `isError: true` with the error on failure.

### 3.4 Create `src/tools/gh-update-release.ts`

Tool name: `gh_update_release`.
Description: "Update an existing release on a GitHub repository owned by the configured GITHUB_OWNER."

Input schema (zod): `repo: string`, `release_id: number`, plus optional `tag_name`, `name`, `body`, `draft`, `prerelease`, `target_commitish`. Reject if no update fields are provided (return `isError: true` with explanation — do not silently call PATCH with empty body).

Handler: call `updateRelease(repo, release_id, params)`, return JSON shape `{ repo, release_id, html_url, tag_name }` on success.

### 3.5 Update `src/tool-registry.ts`

1. Extend `ToolCategory` to include `"github"`: `export type ToolCategory = "prism_core" | "railway" | "claude_code" | "github";`.
2. Append three new entries to `TOOL_REGISTRY` after the `claude_code` block, in registration order:
   - `{ name: "gh_delete_branch", category: "github" }`
   - `{ name: "gh_create_release", category: "github" }`
   - `{ name: "gh_update_release", category: "github" }`
3. Update the comment counts (`// PRISM core (13)` etc.) to add `// GitHub (3)` for the new section.
4. Extend `getExpectedToolSurface(railwayEnabled, ccDispatchEnabled)`:
   - Update the function signature to accept a third boolean: `githubEnabled: boolean`. Default to `true` at all call sites where `GITHUB_PAT` is required for the server to function — confirm by reading `src/config.ts` and the bootstrap module to find every call site.
   - Add `github: githubEnabled ? filterByCategory("github") : []` to the returned record.
   - Update the return type annotation accordingly.
5. Append a third entry to `POST_BOOT_TOOL_SEARCHES`:
   - `{ query: "github branch release delete create update", limit: 20 }`

### 3.6 Update `src/index.ts`

Import the three new register functions and the `GITHUB_PAT` config (confirm `GITHUB_PAT` exists in `src/config.ts`; if not, derive `GITHUB_ENABLED` from whatever the server already conditions GitHub access on).

Wire the new tools after the existing register block, gated on `GITHUB_PAT` being set (which it already must be for any other tool to function — but the explicit gate matches the railway / claude_code pattern):

```ts
import { registerGhDeleteBranch } from "./tools/gh-delete-branch.js";
import { registerGhCreateRelease } from "./tools/gh-create-release.js";
import { registerGhUpdateRelease } from "./tools/gh-update-release.js";

// inside createServer(), after the existing CC_DISPATCH_ENABLED block:
if (GITHUB_PAT) {
  registerGhDeleteBranch(server);
  registerGhCreateRelease(server);
  registerGhUpdateRelease(server);
}
```

Update the `bootstrap.ts` call to `getExpectedToolSurface` so the third boolean is passed through. Same for any logger.info "started" line that enumerates feature flags.

### 3.7 Update `tests/tool-surface.test.ts`

Read the test file in full first. The expected changes:
- If a test asserts the count of tools in TOOL_REGISTRY, bump it by 3.
- If a test enumerates tool names, add the three new ones.
- If a coverage test maps tool names to keyword queries, the new query (`"github branch release delete create update"`) must contain at least one substring matching each new tool name (`branch` for `gh_delete_branch`, `release` for `gh_create_release` and `gh_update_release`). The above query satisfies this. Verify by re-reading the coverage test logic.

Add no new tests in this brief. Test additions for the new tool handlers themselves are out of scope (deferred follow-up).

## 4. Verification (mandatory before opening PR)

Run from the repo root after all code changes:

1. `npm install` — should be no-op if package.json unchanged.
2. `npm run build` — must succeed with zero TypeScript errors. If any error references a missing config export (e.g., `GITHUB_PAT` not exported), confirm by reading `src/config.ts` and adjust the import to whatever `GITHUB_ENABLED`-style flag the server already uses.
3. `npm test` — must pass. The drift-guard tests in `tests/tool-surface.test.ts` are the most likely failure point; if they fail, fix by aligning `TOOL_REGISTRY` / `POST_BOOT_TOOL_SEARCHES` / `src/index.ts` exactly.
4. Mirror-pattern grep counts (record output in PR body):
   - `grep -rn "gh_delete_branch\|gh_create_release\|gh_update_release" src/ | wc -l` — expect ≥ 7 (3 tool name strings inside the 3 tool files, 3 in `tool-registry.ts`, 3 import lines + 3 register calls in `src/index.ts` = 12 minimum, but exact count depends on doc comments).
   - `grep -n "github" src/tool-registry.ts` — expect ≥ 5 hits (category union, 3 entries, comment line, surface key).
   - `grep -n "deleteRef\|createRelease\|updateRelease" src/github/client.ts` — expect ≥ 3 (one per export).
5. Confirm no lint regressions: `npm run lint` if a lint script is defined; otherwise skip.

## 5. PR

Branch name: `feat/gh-utility-tools-brief-403` (numeric brief id in the slug per INS-211 anchored matcher).

PR title: `feat: add gh_delete_branch, gh_create_release, gh_update_release MCP tools (brief-403)`

PR body (Markdown):
```
Implements brief-403 from PRISM S100. Adds three GitHub utility MCP tools
that wrap stable REST endpoints not exposed by github/github-mcp-server.

## Changes
- src/github/client.ts: add deleteRef, createRelease, updateRelease
- src/github/types.ts: add ReleaseResult
- src/tools/gh-delete-branch.ts (new): refuses default branch, refuses
  open-PR by default
- src/tools/gh-create-release.ts (new)
- src/tools/gh-update-release.ts (new)
- src/tool-registry.ts: new "github" category, 3 entries, third
  POST_BOOT_TOOL_SEARCH query
- src/index.ts: gated registration block
- tests/tool-surface.test.ts: drift-guard updates

## Verification
- npm run build: clean
- npm test: passing
- Mirror-pattern grep counts: <paste actual numbers from §4.4>

## Closes
- PRISM INS-226 MCP gap for branch deletion (16 stale branches on
  brdonath1/trigger pending sweep — happens in a follow-up session).
```

## 6. Out of scope (do NOT touch in this PR)

- Tests for the new tool handler logic (separate brief if desired).
- The `issues_granular` feature flag work — already shipped on `brdonath1/github-mcp-proxy` at `21205215` (Caddyfile) and `a2949977` (README).
- The actual sweep of 16 stale branches on `brdonath1/trigger` — happens manually after this PR merges and Railway redeploys.
- Adding a `delete_tag` tool. The `deleteRef` primitive supports it (pass `tags/v1.0.0`), but exposing `gh_delete_tag` is a separate brief.
- Any change to authentication / middleware. Inherits unchanged.

## 7. Finishing up

- Open the PR. Do NOT auto-merge.
- Operator merges manually after review. The post_merge `archive` action will move this brief from `.prism/briefs/queue/` to `.prism/briefs/archive/`.

## 8. Acceptance

In the next PRISM session after this PR merges + Railway redeploys prism-mcp-server:
- `tool_search("github branch release")` returns the three new tools.
- `gh_delete_branch` deletes a stale branch on `brdonath1/trigger` (e.g., `fix/sigterm-cancellable-sleep`) successfully, and `list_branches` confirms the deletion.
- The 16-branch sweep completes without operator-side action.

<!-- EOF: brief-403-github-utility-tools.md -->
