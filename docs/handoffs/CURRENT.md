Overwrite at every logical boundary; never append; ≤3 KB; history lives in git.

## Objective
Keep the PRISM MCP server (4.15.9 on Railway) correct for the claude.ai PRISM sessions and Codex, and land the pending cross-harness items. Seeded 2026-10-21 from `docs/handoffs/LATEST.md` (Claude S214, 2026-10-02) and git history. The GitHub repository is kept archived by decision; Brian unarchived it on 2026-10-21 for two pull requests and re-archives it after they land.

## Done
- 4.15.9: finalize split F3 (PR #155), S203 audit disposition (PR #156), S214 handoff (PRs #157, #158); main c892850, CI green 2026-10-03.
- 2026-10-21: PR #159 d63233e (Node 22.23.3 pins, one `build-and-test` job on the pin file, scripts/check.sh, Dockerfile digest; decision 0002; required contexts renamed). This PR: CLAUDE.md cut from 38 KB to 3 KB with a verbatim copy in docs/history/, CLAUDE.md lint in CI, docs/CONTEXT.md, docs/decisions/, this file (decision 0001).

## In flight
- Codex PR #147 (codex/sonnet-55-prism-compat) needs a rebase over 4.15.9 (LATEST.md next_action).
- Linked worktree `~/development/prism-mcp-supabase-management` on codex/supabase-management.

## Next
1. Re-archive the repository once this PR is merged (Brian's decision; the parent session does it).
2. Rebase Codex PR #147 over 4.15.9 and run the suite.
3. Rotate the `ANTHROPIC_API_KEY` Actions secret (Model Freshness 401 since 2026-08-24), then `gh workflow run model-freshness.yml`.

## Open decisions
- Brian: the repository stays archived after these two PRs (decided 2026-10-21); the secret rotation above is the one open item.
- Brian: provision `MODEL_BUMP_PAT` so weekly model-freshness bump PRs trigger CI (docs/model-bump.md).
