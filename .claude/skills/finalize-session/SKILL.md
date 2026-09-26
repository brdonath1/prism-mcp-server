---
name: finalize-session
description: End the working session by writing the cross-harness handoff and leaving the repository pristine (Claude ⇄ Codex contract). Use when the operator says "Finalize session", "finalize", "wrap up", "end the session", "write the handoff", or when context is nearly exhausted.
---
<!-- harness-kit: v3.0.5 owned — this file is written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply -->

# Finalize session (Claude Code)

Implements `docs/handoffs/README.md` §5. The README is authoritative; if this skill and the README
ever disagree, follow the README and fix this skill in the same session. The handoff you write is
the ONLY thing the next session will have — and that session may run in Claude Code, in a
Cowork/PRISM chat, or in the Codex app on a different model. Write for a reader with zero memory:
exhaustive on facts, IDs, paths and commands; terse on prose. There is no length cap. Never include
secret values.

## 1. Settle the work

- Every earlier unit is either **merged** to `main` (PR, required checks green) or
  explicitly **PARKED** with the reason and exact remaining steps. The final validated
  implementation unit may remain in its open PR while these close-out documents are
  added; report it as pending publication until that PR actually merges.
- Identify ownership of every `git status -sb` change; commit only this unit’s files. After publication the checkout must be clean; `git worktree list` shows nothing for merged
  branches; `gh pr list --state open` shows only what you intend to leave, and the handoff names
  each item.
- Collect verification evidence now: `gh run list --branch <branch> --limit 5` for run IDs and
  results, test counts (run / passed / skipped / failed with reasons), review verdicts, deployment
  IDs, and the honest "not verified" list.

## 2. Write the handoff and LATEST in ONE commit

```bash
TZ=America/Chicago date +%Y-%m-%d-%H%M        # → handoff-<this>.md, never overwrite an existing file
cp docs/handoffs/TEMPLATE.md docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md
```

- Choose one publication route before writing: add both files to the still-open
  implementation PR when it is the session's last unit; otherwise, after that
  unit has merged, create one `claude/S<N>-handoff` docs-only branch from
  `origin/main`. Never open a second docs-only publication PR for the same handoff.
- Fill **every** section of the template (write "none" rather than deleting a section); header per
  README §5; closing line is exactly one sentence:
  `Read docs/handoffs/<this file>.md and <concrete next action>.`
- Rewrite `docs/handoffs/LATEST.md` with all nine README §6 fields: `handoff`, `agent: claude`,
  `session_label: claude-S<N>`, `main_sha_at_exit`, `work_branch`, `merged`, `next_action` (the
  closing sentence), `in_flight`, `still_referenced_branches`.
- When sharing an open implementation PR, `main_sha_at_exit` records the actual
  main revision observed while writing (label it "before final publication").
  List the final PR and its observed head in `in_flight`; `merged` lists only
  already verified merges. Never predict the merge SHA. Pickup resolves publication
  from Git history and current PR state, so no timestamp-only correction PR is needed.
- Commit both files together on the selected publication branch; push; verify its
  remote SHA equals HEAD. Reuse the final unit’s open PR when selected above.

## 3. Land it on `main`

For a new docs-only branch, create the PR below. If using the final unit’s
existing PR, skip creation and watch that exact PR instead.

```bash
gh pr create --base main --head claude/S<N>-handoff \
  --title "claude-S<N>: session handoff + LATEST pointer" \
  --body "Docs-only, per docs/handoffs/README.md §5."
gh pr checks --watch --interval 10  # only if this repo has required checks
gh pr merge --merge --delete-branch
git checkout main && git pull --ff-only
git show origin/main:docs/handoffs/LATEST.md   # must name the new handoff
```

The watch is completion-aware: it returns when checks finish, and a failed/error
result is surfaced rather than being hidden behind a fixed sleep. Run the watcher
in a bounded background tool call; do independent work while it runs. Absent checks
are not success: reconcile the required-check contract and exact PR/head before merge. Merge the selected
publication PR yourself once the required checks (if the repo has any) are green — unless
this project's `CLAUDE.md` says a daemon or a human owns merges, in which case that wins and you
leave the PR open and say so. If `main` moved while checks ran (strict protection),
`gh pr update-branch` and watch again. If a required check fails on a docs-only PR,
`gh run rerun --failed` once and diagnose; never bypass protection.

## 4. PRISM — Claude harness state (only if `prism_finalize` is available)

1. Log any decision from this session that is not yet in `.prism/decisions/_INDEX.md`
   (`prism_log_decision`, next free D-N).
2. `prism_finalize(action="audit", session_number=N)` and follow the returned `session_end_rules`.
3. `prism_finalize(action="draft", …)` is optional. Skip it when the commit input
   is already known; if it times out, compose manually and do not retry a known
   slow draft.
4. Before `prism_finalize(action="commit", …)`, prevalidate the audit's required
   structure: the named EOF sentinels, every required section, and the Critical
   Context entry/byte budget. Correct a known invalid payload before calling commit. Include the required session-log entry in the same payload
   rather than discovering it only after a second audit or publication. A timed-out
   write is uncertain: read back its state before retrying, never blindly repeat it.
5. `prism_finalize(action="commit", session_number=N, handoff_version=<current + 1>, files=[…], banner_data=…)`
   with `.prism/handoff.md` (Meta · Critical Context ≤ 5 items, item 1 pointing at the dated handoff
   and `docs/handoffs/LATEST.md` · Where We Are · Next Steps · Session History) and
   `.prism/session-log.md` (append a `### Session N` entry). Save `banner_text` as harness publication evidence; it does not establish
   native session closure. Render a full-session finalization banner only after the
   native close-out/readback below, or explicitly report the pending lifecycle stage.

If PRISM is unavailable, say so in the closing report; the dated handoff is complete without it.

## 5. Claude Desktop continuity — when its installed continuity adapter is active

After publication, verify the exact final pushed PR head is merged with its
required checks green and record its merge SHA in the private close-out receipt.
After PRISM finalization, follow the installed Desktop continuity skill/runbook
for the current verified native session.

- **Normal finalize:** publish first, then create exactly ONE fresh successor in
  the same verified Claude Desktop profile. Before sending its acknowledgment,
  read back that it is ready and CURRENT, is attached to the same signed-in
  account/profile, inherited the predecessor's model and reasoning effort, and
  preserved the saved service preference and permissions. Fast remains a manual
  choice. Acknowledge that verified successor once. Only then set and read back
  the predecessor's CLOSED state and archive it. Record each observed native ID
  and state transition in the private closure receipt.
- **Explicit `close-only`:** publish and close/archive the current predecessor
  without creating a successor. State `close-only` in the receipt so recovery
  never invents one later.
- **Recovery:** a CLOSED predecessor accepts lifecycle recovery only. Do not do
  further product work in it. A later substantive user request after explicit
  `close-only` authorizes one fresh same-profile successor; status or protocol
  discussion does not. Never reopen the predecessor. Preserve existing receipts
  and inspect them before any retry. Never create a second successor for an
  uncertain or partially completed close-out.

If a required readback, archival, or successor action is unavailable or refused,
preserve the receipt and report `FINALIZATION PENDING`; never fabricate a
finalized result. Codex finalization remains its own checkpoint flow and never
creates a Claude successor.

## 6. Closing report — short

Handoff path; `origin/main` sha; what merged; what is parked; operator actions owed; the next
action sentence; which automation to resume if this session paused one; and, for
Desktop, the successor/CLOSED/archive receipt states. Nothing else — the handoff
carries the detail.
