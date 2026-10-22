# PRISM MCP Server - Claude instructions

Budget: 3 KB. Rules only; what and why live in docs/. Lint: `scripts/claude-md-lint.sh CLAUDE.md`.

## Runtime (2026-10-21, docs/decisions/0002-runtime-pins.md)
- Node 22.23.3 from `mise.toml` (`.node-version`, `packageManager` npm@10.9.9 and the digest-pinned `Dockerfile` agree). Once per clone: `mise trust && mise install`.
- Never install a runtime, a global package or a version manager. A missing command means the repo is wrong; fix `mise.toml`, not the host.
- Package manager: the npm bundled with that Node; lockfile `package-lock.json`, installed with `npm ci`.

## Commands (exact; nothing else is documented)
- Install: `npm ci`
- Run: `npm run dev` (watch build and server on PORT 3000; env from `.env.example`)
- Test: `npm test` (vitest; CI's placeholder env is set by `scripts/check.sh`)
- Lint and types: `npm run lint && npm run typecheck` (biome, tsc)
- Check (CI parity): `scripts/check.sh` (the CI `build-and-test` job on the pinned Node; audit only with `CHECK_AUDIT=1`; on success writes `.claude/check-ok`, which the commit gate requires; gitignored)

## Verification gate (2026-10-21, docs/decisions/0001-claude-md-budget-and-check.md)
- Before any commit: `scripts/check.sh` green on the pinned runtime (hook-enforced: the commit gate refuses a commit without a fresh stamp).
- Before any PR: the same, plus the CI run id in the PR body once green.
- Never change CI, pins or the lockfile to make a failing local run pass; find the host dependency and fix it in the repo.

## Boundaries
- Do not edit `AGENTS.md`, `.codex/`, `.agents/` (Codex owns them) or `.prism/` living documents. Do not read `.env*`.
- Local only: tests use placeholder tokens; never point scripts at production Railway or real repos.
- Decisions go in `docs/decisions/`, state in `docs/handoffs/CURRENT.md`; this file holds neither.

<!-- BEGIN: harness-kit-managed block v3.0.5 — do not edit by hand; apply-harness-kit.sh replaces this span -->
Rule 0 (every spawn pins a model; `.claude/hooks/spawn-routing-guard.sh` enforces it) and the continuity contract (`docs/handoffs/README.md`) hold; full text: `docs/history/claude-md-2026-10-21.md` (2026-10-21, decisions/0001).
<!-- END: harness-kit-managed block -->

## Autonomy (standing rule, 2026-10-17)
Claude works in this repository autonomously and agentically to the fullest extent possible and involves Brian only when a step is impossible without him; then it asks for the smallest assist that unblocks the work, with everything else already prepared. Hard stops only: money or paid services, credentials or secrets, irreversible production data loss, external communication on his behalf, security or account settings, decisions he reserved, information only he has. Full rule: `~/.claude/CLAUDE.md` and claude-config `docs/decisions/2026-10-17-autonomy-standing-rule.md`.

## Pointers
- What this is, where it runs, CI and deploy: `docs/CONTEXT.md`. Current objective and next step: `docs/handoffs/CURRENT.md`.
