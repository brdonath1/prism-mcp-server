# PRISM MCP Server - context (stable)

Update only when something here becomes untrue. Full project instructions and tool catalogue: [../CLAUDE.md](../CLAUDE.md). Continuity records: [handoffs/](handoffs/), [model-bump.md](model-bump.md).

## What it is
Remote MCP server (TypeScript, Express 5, `@modelcontextprotocol/sdk`, stateless Streamable HTTP) that performs the GitHub-backed session-continuity operations of the PRISM framework plus Railway, Claude Code dispatch, GitHub and Supabase tools for Brian's projects. Owner brdonath1; version in `package.json`.

## Runtime and commands
Node 22.23.3 from `mise.toml` (`mise trust && mise install`; `.node-version` and `packageManager` npm@10.9.9 agree; the Dockerfile base `node:22.23.3-slim` is digest-pinned to the same version). One lockfile, `package-lock.json`.
```
npm ci
npm run lint | typecheck | build | test     # biome, tsc, tsc, vitest
scripts/check.sh                            # exactly the CI build-and-test job, on the pinned Node
npm start                                   # node dist/index.js; env per CLAUDE.md "Environment Variables"
```

## CI
`.github/workflows/ci.yml`: job `build-and-test` runs `scripts/check.sh` on the pinned Node; on pull requests a gate step skips the heavy steps when no build-affecting file changed (whitelist kept in sync in two places inside ci.yml) and still reports success. Required checks on `main`: `build-and-test` and `contract` (`harness-contract.yml`). Baseline run on the pins: pending.
`model-freshness.yml` (Mondays 09:00 UTC) diffs `src/models.ts` against the Anthropic Models API with the `ANTHROPIC_API_KEY` repository secret and opens a bump PR; it has failed every week since 2026-08-24 with HTTP 401 (the secret is invalid), so no bump PR has been opened since then.

## Deploy and roll back
Railway project `prism-mcp-server`, service `prism-mcp-server`, environment `production`; builder DOCKERFILE (the service setting; `railway.json` still names NIXPACKS and is not what runs). A merge to `main` deploys (deployment c56f305d followed the 2026-10-02 merge). Roll back by redeploying the previous Railway deployment. The Dockerfile runs `npm install`, `npm run build` and `npm prune --omit=dev` as a non-root user.

## Conventions
PRs to `main` only, one per unit; Claude branches `claude/<slug>` in `.claude/worktrees/<slug>`; Codex owns `AGENTS.md`, `.codex/`, `.agents/`. Tier C (CI, docs, tests, tooling) merges on green; deploy mechanics, credentials and production data are Tier A. Renaming a required check needs a separately authorized branch-protection change.
