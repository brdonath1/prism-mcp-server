<!--
harness-kit: v3.0.1 owned — this file is written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply
HOW TO USE THIS TEMPLATE (delete this comment block when filling it in)
- This file is the ONLY context the next session will have, and that session may run in a
  different application (Claude Code, Cowork/PRISM, or the Codex app) on a different model.
  Write for a reader with zero memory: exhaustive on facts, IDs, paths and commands; terse on prose.
- Fill EVERY section. Write "none" rather than deleting a section. There is no length cap.
- Never include secret values (tokens, passwords, connection strings, OAuth material). Name the
  file or variable that holds them, never the contents.
- Record failures, dead ends and things you were not able to verify — they save the next session
  more time than the successes do.
- Update docs/handoffs/LATEST.md in the SAME commit (fields in docs/handoffs/README.md §6).
- The last line of the file is exactly one sentence of the form
  "Read docs/handoffs/<this file>.md and <concrete next action>." — never "continue the work".
-->
# <Title — what this session shipped or decided, in one line>
Agent: claude | codex · Model: <model and surface, e.g. "Claude Opus 5 (Claude Code, macOS)" or "GPT-6 Astra Ultra (Codex app)"> · Session label: claude-S<N> | codex-<NNN>
Supersedes: docs/handoffs/handoff-<previous YYYY-MM-DD-HHmm>.md
Branch / HEAD: <branch @ short-sha, remote SHA verified> | none open · main at exit: <full sha of origin/main when this file was written>
Merged: PR #<n> → main @ <merge sha> [, PR #<n> → …] | PARKED: <branch — reason> | none

## 0. Read this first
- Objective this session: <one line>
- Outcome: <one line — shipped / partially shipped / blocked, with the PR numbers>
- Next concrete action: <the same sentence as the closing line>
- Blocked, unverified or dangerous right now: <one line each, or "none">

## 1. Operator direction and authorizations
- What the operator asked for this session (close to verbatim) and any decisions they made or declined.
- Standing authorizations that applied (from `CLAUDE.md` / `AGENTS.md` / the STANDING RULE entries in `.prism/insights.md`) — name each one and what it permitted or forbade this session.
- Anything the operator must approve before the next session can proceed.

## 2. Source and implementation
- What changed and where — file paths, modules, migrations, workflows, config; the design in two or three sentences; invariants and limits chosen and why.
- What was deliberately NOT changed, and why.
- Dependencies added/removed, image/runtime changes, feature flags, opt-ins.

## 3. Release and verification
- CI: workflow name + run ID + result for every head that mattered (`gh run list --branch <branch>`), or "this repo has no CI" if it has none.
- Tests: run / passed / skipped / failed, with the reason for every skip or failure; which suites did not run locally and why.
- Reviews: who/what reviewed (model, lane), verdicts, blocking findings and how they were fixed, findings deferred.
- Deployments: environment, deployment IDs, image digests, migrations applied — or "none performed".
- NOT verified: the honest list.

## 4. Decisions made this session
For each: **D — <title>** · decision · reasoning · alternatives rejected · reversibility.
(A Claude session logs these into the PRISM ledger with `prism_log_decision`; a Codex session records them here and the next Claude session ledgers them. Write "none" if none.)

## 5. State of the world at exit
- Git: `origin/main` sha; open PRs (yours and others', with what each is); branches another harness's checkpoint still references (do not delete); worktrees left on purpose.
- Environments: migration head; staging/production release IDs; credentials/tokens status by NAME only (exists / expired / unknown).
- Other harness: what Codex (or Claude) must know to resume without conflict — e.g. "the Codex checkpoint <sha> is an ancestor of main; bootstrap from origin/main", "PRISM handoff v<N> points here".
- Automations: which schedulers or dispatch daemons are paused or running.

## 6. Continuation
- **Next concrete action** — detailed enough to start cold: files to open first, commands to run, acceptance criteria, boundaries (what needs the operator's go).
- **Then** — the ordered queue of the next 2–5 units, one line each with the source of the requirement.
- **Operator actions owed** — each with why and what it unblocks.
- **Open questions for the operator** — each with the default you would pick if unanswered.

## 7. Landmines and environment notes
- Gotchas hit this session (with the fix), flaky tests and how to tell flake from regression, tool paths (`/usr/bin/…` vs `/opt/homebrew/bin/…`), ports, env files BY PATH ONLY, protected-branch behaviour (strict updates), things that cost time.

## 8. Required reading, in order
1. `docs/handoffs/README.md` — the cross-harness contract.
2. `docs/handoffs/LATEST.md` — the pointer (must name this file).
3. <this file>
4. `CLAUDE.md` / `AGENTS.md` — the area map, routing and standing rules for the harness you are in.
5. <the previous handoff(s) still needed and why; specs / READMEs for the active area>

Read docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md and <concrete next action>.
