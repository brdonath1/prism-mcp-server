---
name: pickup-handoff
description: Resume work in this repository from the newest cross-harness handoff (Claude ⇄ Codex contract). Use when the operator says "Pick up with the latest handoff", "pick up", "resume", "where were we", "continue from the handoff", or at the start of any session in this repo before other work.
---
<!-- harness-kit: v3.0.1 owned — this file is written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply -->

# Pick up with the latest handoff (Claude Code)

This is the Claude Code implementation of `docs/handoffs/README.md` §1 — the contract shared with
the Codex harness. The README is authoritative; if this skill and the README ever disagree, follow
the README and fix this skill in the same session.

## 1. Sync and locate the checkpoint

Run in the repo root:

```bash
git fetch origin --prune
git show origin/main:docs/handoffs/LATEST.md
git log origin/main --diff-filter=A --format='' --name-only -- 'docs/handoffs/handoff-*.md' | grep . | head -1
```

- When `LATEST.md` says `handoff: none`, **`.prism/handoff.md` is the checkpoint** — read it and
  its § Next Steps. Any pre-kit files under `docs/handoffs/` are history, not checkpoints, and the
  git-log lookup does not override `none`.
- When `LATEST.md` names a file and the git-log lookup's newest handoff differs, **git log wins**:
  open that file, and fix `LATEST.md` in its own small PR before anything else.
- Read the newest handoff **end to end** — never skim it. `docs/handoffs/TEMPLATE.md` explains what
  each section means. A document carrying a `⛔ SUPERSEDED` banner is the wrong one; follow it to
  the right one.

## 2. Reconcile reality (handoffs describe the past)

```bash
git status -sb
git worktree list
gh pr list --state open
git log --oneline <main-at-exit-sha-from-the-handoff>..origin/main
```

- If the local checkout is not on `main` or is behind it: `git checkout main && git pull --ff-only`.
  Never `reset --hard`, `checkout -- .`, `clean` or `stash` in a path you did not create.
- Commits after the handoff's `main at exit` were made by someone else — the other harness, the
  PRISM MCP server, the operator, a dispatched brief run. Read them and factor them in before
  planning; treat the checkpoint's next action as *possibly already done* until `LATEST.md`
  confirms it.
- Open `codex/*` or `claude/*` PRs touching the area you are about to work in are in-flight work.
  Do not duplicate one — take it over explicitly (comment on the PR saying so, then push to that
  branch) or pick a different unit.

## 3. PRISM — Claude harness state (only if the `prism_bootstrap` tool is available)

Identity comes from `.prism/project-identity.md` (Project Name / Project Slug / GitHub Repo) —
never from the clone path, a chat title or prior conversation.

```
prism_bootstrap(project_slug=<Project Slug>, opening_message=<the operator's message>,
                client_model=<your model>, client_surface="claude_code")
```

Follow the returned `behavioral_rules`. Render `banner_text` inline (there is no widget in Claude
Code). Where PRISM's Next Steps disagree with the newest dated handoff, **the dated handoff wins** —
it is newer and cross-harness; say so in the opening report and patch `.prism/task-queue.md` if the
difference matters.

If the newest handoff's §4 "Decisions made this session" lists decisions that are not yet in
`.prism/decisions/_INDEX.md`, log them now with `prism_log_decision` (next free D-N, crediting the
originating session). This is how Codex-made decisions enter the PRISM ledger.

If the tool is not available, continue without PRISM and say so in one line — registration is per
machine, not per project (`CLAUDE.md` § PRISM in Claude Code has the command).

## 4. Opening report — short; the operator may read it on a phone

One paragraph: which checkpoint you resumed; `origin/main` sha; anything that moved since it was
written; what you are about to do (the handoff's closing sentence unless the operator directs
otherwise); any blocker or operator action owed. Then **start the work** — do not wait for
confirmation on work the handoff already authorized. Ask exactly one question only if the next
action is ambiguous or crosses a boundary (credentials, spend, live services, external
communications, destructive operations).

## 5. While working — so that Finalize is cheap

- Branch `claude/S<N>-<slug>` from `origin/main` (N per `docs/handoffs/README.md` §4); commit early,
  push often, verify with `git ls-remote origin <branch>`.
- Every unit lands through a PR into `main` with this repo's required checks green (`gh pr checks`);
  delete the branch after merge. If `main` is strict-protected, update the branch before merging.
- Follow this project's `CLAUDE.md` (routing table and conventions) and the STANDING RULE entries in
  `.prism/insights.md`; `AGENTS.md` governs the Codex lane. None of them override the README.
- Keep a running list of decisions made (with reasoning), verification evidence (run IDs, counts,
  verdicts), what was NOT verified, and landmines hit — these become the handoff.
