# Brief 404 — Add `gh_delete_tag` tool + fix doc-comment drift in tool-registry.ts

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-mcp-server (this repo)
**Origin:** PRISM session S101 (2026-05-01), follow-on to S100 D-185

## Context

S100 D-185 added three GitHub utility tools to prism-mcp-server: `gh_delete_branch`, `gh_create_release`, `gh_update_release`. The PR (#29) introduced:

- A new `github` category in `TOOL_REGISTRY` (`src/tool-registry.ts`)
- A third post-boot tool-search query (`POST_BOOT_TOOL_SEARCHES`)
- REST wrappers `deleteRef` / `createRelease` / `updateRelease` in `src/github/client.ts`
- Per-tool files in `src/tools/github/` (or wherever the existing `github` tools live — verify via `grep -rn "gh_delete_branch" src/`)

S101 calls for two follow-ons in a single PR:

1. **New tool `gh_delete_tag`** — thin wrapper over the existing `deleteRef` primitive. Pairs ergonomically with `gh_create_release` (which creates tags as a side effect of release creation; complementary lifecycle).
2. **Cosmetic doc-comment fix** — JSDoc on `POST_BOOT_TOOL_SEARCHES` in `src/tool-registry.ts` (lines 91-92 per the S100 handoff) still says "Together these two queries empirically load all 18 registered tools" — should be "three queries" and "all 22 registered tools" post-PR #29.

## Required Changes

### 1. New tool: `gh_delete_tag`

Investigate first: read the existing `deleteRef` implementation in `src/github/client.ts`. The wrapper may already be ref-prefix-agnostic (accepts a full ref like `tags/v1.0.0` or `heads/feature-x`), or it may be hardcoded to `heads/`. Adapt accordingly:

- **If `deleteRef` accepts arbitrary refs:** the tool just calls it with `tags/<tag_name>`.
- **If `deleteRef` is hardcoded to `heads/`:** either (a) generalize it to take a ref-type parameter, or (b) add a sibling `deleteTag` wrapper. Pick the option that minimizes diff against existing patterns.

**Tool surface contract:**

```
gh_delete_tag:
  tag: string (required, no 'refs/tags/' prefix; just the tag name e.g. 'v1.0.0')
  repo: string (required, no owner prefix; owner is GITHUB_OWNER per existing pattern)
```

**Behavior:**
- 422 "Reference does not exist" → idempotent success (matches `gh_delete_branch` 422 ref-absent handling).
- 422 other → propagate as error.
- No "default tag" guardrail (tags don't have a default-vs-non-default distinction). No open-PR guardrail (tags don't have PRs).

**No safety override flag needed** — there's no equivalent to `allow_with_open_prs` for tags. Keep the schema minimal.

### 2. Register the new tool

- Add to the `github` category in `TOOL_REGISTRY` (alongside `gh_delete_branch` etc.).
- The third post-boot search query (`"github branch release delete create update"`) should already surface `gh_delete_tag` since "delete" is in the keyword set. Verify by running `npm test` against the tool-surface tests; if the test asserts an exact tool count or list, update accordingly.

### 3. Doc-comment fix in `src/tool-registry.ts` (lines 91-92)

Replace the stale "two queries / 18 tools" wording with "three queries / 22 tools" (or "23 tools" after this brief lands — adjust to whatever the post-this-PR count is). The exact prose isn't load-bearing; just make it accurate.

### 4. Tests

- Unit tests for `gh_delete_tag`: success path, 422 ref-absent idempotency, 422 other propagation. Mirror the `gh_delete_branch` test layout.
- Update `tests/tool-surface.test.ts` (or equivalent) if it asserts tool count.

## Verification

Before opening the PR, confirm:

1. `npm test` — all tests pass (current count is 818 per the S100 close; new tests will increase that).
2. `npm run lint` — biome clean.
3. `npm run build` — `tsc --noEmit` clean.
4. Tool surface: `grep -c gh_delete_tag dist/tool-registry.js` ≥ 1 (the registration is in dist after build).

**Verification asymmetry note (INS-227):** the new tool will register server-side at deploy but won't surface in the dispatching session's `tool_search` due to MCP session-boot caching. Operator-side fresh-session verification is the gate. Don't try to verify by calling `tool_search` from inside CC — that surface was loaded at CC's own session boot and won't include the new tool.

## Out of Scope

- Do NOT add `gh_delete_release` or other release-lifecycle tools in this PR. If the operator wants those, they're separate briefs.
- Do NOT touch the `github-mcp-proxy` repo or the upstream binary version — D-187 already pinned `:v1.0.3`.
- Do NOT add a "default tag protection" feature — there is no such concept in Git.

## PR Title / Body Hint

Title: `feat(github): add gh_delete_tag + fix tool-registry.ts doc comment (S101 brief-404)`

Body should reference: brief-404, S100 PR #29 as the predecessor, and the doc-comment drift this PR closes.

## Brief Author Notes

This brief was authored from PRISM session S101 (Claude.ai chat session) with cc_dispatch suspended per INS-223 — the Trigger daemon is the dispatch path. If for any reason the daemon refuses (preflight blocker, rate limit, etc.), the operator can dispatch this brief manually via local CC using INS-7 brief-on-repo workflow.

<!-- EOF: brief-404-add-gh-delete-tag.md -->
