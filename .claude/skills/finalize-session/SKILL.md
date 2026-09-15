---
name: finalize-session
description: End the working session by writing the cross-harness handoff and leaving the repository pristine (Claude ⇄ Codex contract). Use when the operator says "Finalize session", "finalize", "wrap up", "end the session", "write the handoff", or when context is nearly exhausted.
---
<!-- harness-kit: v3.0.0 owned — this file is written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply -->

# Finalize session (Claude Code)

Implements `docs/handoffs/README.md` §5. The README is authoritative; if this skill and the README
ever disagree, follow the README and fix this skill in the same session. The handoff you write is
the ONLY thing the next session will have — and that session may run in Claude Code, in a
Cowork/PRISM chat, or in the Codex app on a different model. Write for a reader with zero memory:
exhaustive on facts, IDs, paths and commands; terse on prose. There is no length cap. Never include
secret values.

## 1. Settle the work

- Every unit is either **merged** to `main` (PR, required checks green, branch deleted) or
  explicitly **PARKED** with the reason and the exact remaining steps. Never leave a unit "almost
  done" without saying so in the handoff.
- `git status -sb` is clean (no uncommitted work); `git worktree list` shows nothing for merged
  branches; `gh pr list --state open` shows only what you intend to leave, and the handoff names
  each item.
- Collect verification evidence now: `gh run list --branch <branch> --limit 5` for run IDs and
  results, test counts (run / passed / skipped / failed with reasons), review verdicts, deployment
  IDs, and the honest "not verified" list.

## 2. Write the handoff and LATEST in ONE commit

```bash
TZ=America/Chicago date +%Y-%m-%d-%H%M        # → handoff-<this>.md, never overwrite an existing file
git checkout -b claude/S<N>-handoff origin/main
cp docs/handoffs/TEMPLATE.md docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md
```

- Fill **every** section of the template (write "none" rather than deleting a section); header per
  README §5; closing line is exactly one sentence:
  `Read docs/handoffs/<this file>.md and <concrete next action>.`
- Rewrite `docs/handoffs/LATEST.md` with all nine README §6 fields: `handoff`, `agent: claude`,
  `session_label: claude-S<N>`, `main_sha_at_exit`, `work_branch`, `merged`, `next_action` (the
  closing sentence), `in_flight`, `still_referenced_branches`.
- Commit both files together; push; verify `git ls-remote origin claude/S<N>-handoff` equals HEAD.

## 3. Land it on `main`

```bash
gh pr create --base main --head claude/S<N>-handoff \
  --title "claude-S<N>: session handoff + LATEST pointer" \
  --body "Docs-only, per docs/handoffs/README.md §5."
gh pr checks --watch          # only if this repo has required checks
gh pr merge --merge --delete-branch
git checkout main && git pull --ff-only
git show origin/main:docs/handoffs/LATEST.md   # must name the new handoff
```

Merge this docs-only PR yourself once the required checks (if the repo has any) are green — unless
this project's `CLAUDE.md` says a daemon or a human owns merges, in which case that wins and you
leave the PR open and say so. If `main` moved while checks ran (strict protection),
`gh pr update-branch` and watch again. If a required check fails on a docs-only PR,
`gh run rerun --failed` once and diagnose; never bypass protection.

## 4. PRISM — Claude harness state (only if `prism_finalize` is available)

1. Log any decision from this session that is not yet in `.prism/decisions/_INDEX.md`
   (`prism_log_decision`, next free D-N).
2. `prism_finalize(action="audit", session_number=N)` and follow the returned `session_end_rules`.
3. `prism_finalize(action="draft", …)` is optional; if it times out, compose manually.
4. `prism_finalize(action="commit", session_number=N, handoff_version=<current + 1>, files=[…], banner_data=…)`
   with `.prism/handoff.md` (Meta · Critical Context ≤ 5 items, item 1 pointing at the dated handoff
   and `docs/handoffs/LATEST.md` · Where We Are · Next Steps · Session History) and
   `.prism/session-log.md` (append a `### Session N` entry). Render `banner_text` inline.

If PRISM is unavailable, say so in the closing report; the dated handoff is complete without it.

## 5. Closing report — short

Handoff path; `origin/main` sha; what merged; what is parked; operator actions owed; the next
action sentence; and which automation to resume if this session paused one. Nothing else — the
handoff carries the detail.
