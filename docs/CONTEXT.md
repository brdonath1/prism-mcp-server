# PRISM MCP Server - context (stable)

Update only when something here becomes untrue. Live state: [handoffs/CURRENT.md](handoffs/CURRENT.md); cross-harness pointer: [handoffs/LATEST.md](handoffs/LATEST.md). Decisions: [decisions/](decisions/README.md). The pre-2026-10-21 CLAUDE.md verbatim (env-var table, validation rules, protocols): [history/claude-md-2026-10-21.md](history/claude-md-2026-10-21.md).

## What it is
Remote MCP server (Streamable HTTP, stateless) doing the GitHub work for PRISM, Brian's session-continuity framework: it reads, validates and writes the ten living documents in each project repo's `.prism/`, synthesizes briefs, tracks decisions, and fronts Railway, GitHub, Supabase and Claude Code dispatch. Server v4.15.9; 37 MCP tools: 14 PRISM, 10 Railway, 2 Claude Code, 6 GitHub, 5 Supabase (optional groups need credentials). `tests/brief-466-docs-version.test.ts` guards these facts.

## Architecture
TypeScript on Node 22.23.3 (`mise.toml`, `.node-version`, npm 10.9.9; `engines.node` >=18 is documentation), Express 5, `@modelcontextprotocol/sdk`, Zod, plain `fetch` for GitHub. `src/index.ts` app and transport; `src/config.ts` env (`src/ai/`, `src/llm/` read their own); `src/ai/` synthesis (Anthropic default from `src/models.ts`); `src/llm/` route resolver, which can authorize live provider synthesis only when `LLM_ROUTING_ENABLED=true`, `LLM_ROUTING_DRY_RUN=false`, the provider is allowed and keyed, logs sanitized `LLM_ROUTE_OBSERVATION` lines and falls back to Anthropic; `cc_dispatch` remains Claude Code OAuth execution. Also `src/github/`, `src/railway/`, `src/supabase/`, `src/claude-code/` (Agent SDK dispatch), `src/tools/`, `src/middleware/` (Bearer auth, IP allowlist), `src/validation/`, `tests/` (vitest). Limits: ~25K-token responses, under 30 s, no server state.

## Environments
- Production: Railway, `prism-mcp-server-production.up.railway.app/mcp`; `main` auto-deploys with builder DOCKERFILE (the service setting; `railway.json` still says NIXPACKS); base `node:22.23.3-slim` by digest. Required env `GITHUB_PAT`, `MCP_AUTH_TOKEN` (`AUTH_REQUIRE_BEARER=true`); Supabase credentials force Bearer auth service-wide; the rest is optional (history file, `docs/supabase-management.md`, `docs/model-bump.md`). Secrets only in Railway env.
- Local: `mise trust && mise install` once per clone; `.env.example`; `npm run dev` on PORT 3000.

## Run and test
```
npm ci
npm run dev | lint | typecheck | build | test
scripts/check.sh     # exactly the CI build-and-test job on the pinned Node; stamps the commit gate
```
CI (`ci.yml`): one `build-and-test` job on the pin file runs `scripts/check.sh` for build-affecting paths (gate-step whitelist; docs-only PRs pass through) and lints CLAUDE.md on every PR; `harness-contract.yml` `contract` checks the managed-block markers, handoff files, hooks and identity. Both are the required checks (renamed from the 18/20 matrix with PR #159, 2026-10-21). `model-freshness.yml` has failed with HTTP 401 since 2026-08-24: the `ANTHROPIC_API_KEY` secret needs rotation.

## Deploy and roll back
Merge to `main` (merge commit, branch deleted) deploys on Railway; roll back by redeploying the previous deployment or a revert PR. Verify the runtime version and release commit before claiming a capability is live. The Dockerfile still runs `npm install` (follow-up).

## Conventions
- Branches `claude/<slug>` or `codex/...`; one PR per unit; required checks green; never commit to main. Commit prefixes `prism:|fix:|docs:|chore:|audit:|test:`. Trigger briefs live in `.prism/briefs/queue/` (`briefs` branch) and end in a PR. Decision IDs (D-N) are logged only by the claude.ai session.
- Do not edit AGENTS.md, `.codex/` or `.prism/` living documents from Claude.

## Gotchas
- `~/development/prism-mcp-supabase-management` is a linked worktree of this clone (shared refs): never `git checkout main` there or remove it.
- The repository stays archived by decision; it was unarchived on 2026-10-21 only to land PR #159 and the CLAUDE.md PR.
- Where Claude memory contradicts docs/decisions, decisions win.
