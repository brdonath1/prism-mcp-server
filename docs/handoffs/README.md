<!-- harness-kit: v3.0.1 owned — this file is written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply -->

# Session handoffs — pickup protocol (applies to EVERY agent and human in this repo)

This file is the one continuity contract shared by every development harness that works on
**PRISM MCP Server** — **Claude** (Claude Code, and the Cowork/PRISM sessions) and **Codex** (the
Codex app) — and by the operator. Each harness keeps its own native plumbing (PRISM's
`.prism/handoff.md` for Claude; a Codex session's own checkpoint); that plumbing may add to this
protocol but may never contradict it. `CLAUDE.md` (read by Claude) and `AGENTS.md` (read by Codex)
both point here. Two operator phrases drive the whole thing in every harness — "Pick up with the
latest handoff" and "Finalize session" — see §8.

**The repo's `main` branch is the only integration line, and the newest dated handoff on it is the
only authoritative checkpoint.** Anything that is not merged to `main` or named by the newest
handoff is not "done" for the other harness.

## 0. `LATEST.md` — the pointer

`docs/handoffs/LATEST.md` is a short, fixed-field pointer to the newest handoff. It is updated in
the **same commit** as every new handoff file (never separately, never later). It exists so that
any agent, from any harness, can answer "what is the current state and who did the last work?"
with one command:

```bash
git fetch origin && git show origin/main:docs/handoffs/LATEST.md
```

Read it from `origin/main`, not from your local checkout — your checkout may be on a stale branch.

## 1. On session start

1. Find the newest handoff — **by git history on `origin/main`, not by filename sort**:
   ```bash
   git fetch origin
   git log origin/main --diff-filter=A --format='' --name-only -- 'docs/handoffs/handoff-*.md' | grep . | head -1
   ```
   **Do NOT use `ls docs/handoffs/handoff-*.md | sort | tail -1`.** A lexical sort is wrong the
   moment any filename departs from the `handoff-<YYYY-MM-DD-HHmm>.md` convention in §4 — e.g.
   `handoff-2026-08-06-S17.md` sorts *after* `handoff-2026-08-06-0350.md`, so the lexical command
   returns a superseded document. The git-based command orders by when the file was actually added,
   which is what "newest" means, and it agrees with the standing rule to trust the git log over
   filename timestamps.

   **When `LATEST.md` says `handoff: none`, `.prism/handoff.md` is the checkpoint, regardless of
   any pre-kit files under `docs/handoffs/` — those are history, not checkpoints. Only when
   `LATEST.md` names a file and the git-log lookup's newest handoff differs does git log win
   (`LATEST.md` was not updated; fix it in its own small PR first).**

   Cross-check whatever you get: a superseded handoff carries a `⛔ SUPERSEDED` banner or a
   `Supersedes:` chain. **If the file you opened has that banner, you are in the wrong document —
   follow it to the right one.**
2. Read that one file end to end. It is written to be self-contained — you should not need any
   other context to act, though it names its required reading. `docs/handoffs/TEMPLATE.md` explains
   what each section means.
3. **Cross-agent reconciliation (mandatory, both harnesses).** Handoffs describe the past, and the
   *other* harness may have worked since your own checkpoint was written:
   - If your harness holds its own checkpoint (PRISM's `.prism/handoff.md`, a Codex-native
     checkpoint commit, a paused worktree or branch), test whether `main` has moved past it:
     ```bash
     git merge-base --is-ancestor <your-checkpoint-commit> origin/main && echo "main contains my checkpoint"
     git rev-list --count <your-checkpoint-commit>..origin/main   # >0 means main is ahead of it
     ```
     If `main` contains your checkpoint **and** is ahead of it, `main` is newer than you are: start
     every new branch from `origin/main`, treat your checkpoint's "next action" as *possibly already
     done*, and confirm it against `LATEST.md`'s `next_action` and `in_flight` fields before
     implementing anything. Never fast-forward a stale branch and implement on it.
   - `gh pr list --state open` — an open PR touching your area is in-flight work. Do not duplicate
     it. Either take it over explicitly (comment on the PR saying so, then push to that branch) or
     pick a different unit.
   - `git status -sb`, `git worktree list`, `git ls-remote origin <branch named in the handoff>` —
     reconcile any drift the handoff did not predict before executing anything.
4. Execute the handoff's closing sentence (`Read <path> and <action>.`) unless the operator's
   opening message directs otherwise — the operator always outranks the handoff.

**One active primary per area at a time.** Before starting a session in one harness, the operator
pauses the other harness's scheduled automation. Two primaries editing the same files in the same
window is the one failure this protocol cannot repair after the fact.

## 2. Branches, PRs and merging

- Feature branches only, prefixed by harness: `claude/<session-label>-<slug>` and
  `codex/<session-label>-<slug>`. Never commit directly to `main`. (The PRISM MCP server's writes to
  `.prism/*` living documents are the one standing exception; they touch nothing outside `.prism/`.)
- One PR per unit of work, base `main`, **merge commit** by default — never squash or rebase-merge,
  so every session commit stays reachable.
- Required checks, if this repo has any, must be green before merge (`gh pr checks`). A self-reported
  PASS from any review lane is not CI green — check the PR's checks.
- The session merges its own docs-only handoff PR once those checks are green, **unless `CLAUDE.md`
  says a daemon or a human owns merges for this repo** — that instruction wins, and the handoff says
  the PR is left open and why.
- Stacked PRs are allowed *within* one session, but the stack lands on `main` before the session ends
  or is explicitly parked in the handoff with the reason. A stack the other harness has to finish is
  a handoff failure.
- After merge, delete the work branch. Do not delete a branch another harness's checkpoint still
  names until that harness has re-registered from `main`; the handoff lists those under
  `still_referenced_branches`.
- Never rewrite published history; never `reset --hard`, `checkout -- .`, `clean` or `stash` in a
  path you did not create.
- Coordinate lockfiles, generated outputs, ports, dev servers, databases, queues, caches and
  deployment targets before touching a checkout another session may use — worktrees do NOT isolate
  those resources. Agree one owner or sequence the work, and report the conflict instead of taking
  ownership.
- `git -c <key>=<value>`, never `git config`, in any shared checkout — a persisted config change
  breaks the other harness's session after yours.
- Never remove, prune or clean a worktree that another harness's session may be mid-turn in — check
  its continuity registry or last activity first.

## 3. Areas of the repo (so two harnesses do not collide)

This project's areas — which directories are the active feature line, which are archival, and which
CI guards each — are named in `CLAUDE.md` and `AGENTS.md`, not here; those two files are the area
map and this contract governs how sessions hand the areas off. A directory that is a **linked
worktree** of another clone says so in its area map, naming the main clone, because stash, refs,
config and worktree registrations are shared with it.

`.prism/` is PRISM's own area: living documents written by the PRISM MCP server at boot and
finalize. Do not hand-edit them outside a harness's finalize path.

A session that must touch two areas says so in its handoff. A session that finds the other harness's
open PR in its area stops and reconciles (§1.3) rather than racing it.

## 4. Session labels and numbering

Counters exist per harness and none of them is the ordering key. The **handoff filename timestamp**
is: `handoff-<YYYY-MM-DD-HHmm>.md`, 24h clock, Central Time (house convention). Each harness keeps
its own counter as a label only:

- Claude: `claude-S<N>` — N is the PRISM session number reported when `prism_bootstrap` ran this
  session; when PRISM is unavailable, N is the previous Claude label's number + 1.
- Codex: `codex-<NNN>` — the Codex session numbering.

Use the label in the handoff header, the branch name and the session title. **Never renumber the
other harness's sessions.**

## 5. On session end (or before compaction, or when switching machines or harnesses)

1. Write a new handoff to `docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md`. Never overwrite an old one —
   the trail is the history. Update `docs/handoffs/LATEST.md` in the same commit.
2. Start from `docs/handoffs/TEMPLATE.md` and fill **every** section (write "none" rather than
   deleting one; no length cap; never a secret value). Header block, identical for both harnesses:
   ```
   # <Title — what this session shipped or decided>
   Agent: claude | codex · Model: <model> · Session label: claude-S<N> | codex-<NNN>
   Supersedes: docs/handoffs/handoff-<previous>.md
   Branch / HEAD: <branch> @ <sha> (remote SHA verified) · main at exit: <sha>
   Merged: PR #<n> → main @ <merge sha> | PARKED: <reason>
   ```
   Then: **Source and implementation** (what changed, where, invariants), **Release and
   verification** (CI runs by ID, tests, deployments by ID, what was NOT verified), **Continuation**
   (next concrete action, in-flight/open PRs, pending operations, questions, authorizations still
   standing, landmines), and required reading with reasons.
3. It must let a fresh agent from *either* harness with zero prior context act: objective + why,
   exact git state (branch, HEAD, pushed-or-not, tags), done/verified vs in-progress vs open,
   invariants, environment notes, re-verification recipes.
4. End it with exactly one sentence of the form
   `Read docs/handoffs/<file>.md and <concrete next action>.` — never "continue the work".
5. Commit and push it on the working branch ("completed" is not "pushed"), and get it onto `main` —
   in the unit's PR, or in a docs-only PR immediately after that merge (§2).
6. Update your harness-native state **last** (Claude/PRISM: `prism_finalize`; Codex: its own
   checkpoint), pointing at the handoff you just wrote. Leave no worktree for a merged branch and no
   local-only artifact the next session would need in order to resume.

## 6. `LATEST.md` fields

```
handoff: docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md | none
agent: claude | codex | n/a
session_label: claude-S<N> | codex-<NNN> | n/a
main_sha_at_exit: <sha of origin/main when the handoff was written>
work_branch: <branch> | none
merged: PR #<n> @ <merge sha> | parked: <reason> | n/a
next_action: <one sentence — the same sentence that closes the handoff>
in_flight: <open PRs / branches / external operations another session must not duplicate> | none
still_referenced_branches: <branches a harness checkpoint still points at; do not delete> | none
```

Nine fields, always all nine, always in this order.

## 7. Standing rules that survive every handoff (both harnesses)

This repo's standing rules live in the STANDING RULE entries of `.prism/insights.md`, in `CLAUDE.md`
(Claude side) and in `AGENTS.md` (Codex side). Read them at pickup and honour them for the whole
session; a handoff records which ones applied (TEMPLATE §1) but never restates them as law. **This
README never overrides them, and they never override this README's continuity mechanics** — if a
standing rule and this contract genuinely collide, stop and ask the operator.

## 8. Operator phrases — the whole operator surface

Both harnesses map the same two phrases to this protocol, so the operator never has to remember
which application they are in or which model is running.

| Phrase | Means | Claude Code | Codex app |
|---|---|---|---|
| **"Pick up with the latest handoff"** (also "pick up", "resume", "where were we") | §1 in full, then start the handoff's closing action | `.claude/skills/pickup-handoff/SKILL.md` (auto-triggered by the phrase; also `/pickup`). A `SessionStart` hook (`.claude/hooks/session-start-latest.sh`) prints `LATEST.md`, the newest handoff path, PRISM identity, git state and open PRs at every session start, so the pointer is in context before the phrase is even said | `AGENTS.md` § Operator phrases → §1, including the `main`-freshness reconcile in §1.3. The same `SessionStart` hook runs under Codex too, wired in `.codex/hooks.json`, once the two trust steps in §9 are done |
| **"Finalize session"** (also "finalize", "wrap up", "end the session", "write the handoff") | §5 in full: dated handoff from `TEMPLATE.md` + `LATEST.md` in one commit, PR to `main`, merged when the required checks are green, harness-native state updated last | `.claude/skills/finalize-session/SKILL.md` (also `/finalize`) | `AGENTS.md` § Operator phrases → §5, then the Codex-native checkpoint |

## 9. Harness-native layers (they run *inside* the two phrases, never instead of them)

- **PRISM, for Claude.** Identity comes from `.prism/project-identity.md` — never from the clone
  path or a chat title. `prism_bootstrap(project_slug=…, client_surface="claude_code")` runs after
  the `LATEST.md` check, and `banner_text` is rendered inline. `.prism/handoff.md` is PRISM's own
  pointer; when it and the newest dated handoff disagree, **the dated handoff wins** and
  `.prism/task-queue.md` is patched to match (AmeriSack D-12). Trigger-dispatched brief runs are not
  sessions under this contract: they follow the brief, and they do not write dated handoffs unless
  the brief says so.
- **Codex hook trust.** The `SessionStart` entry in `.codex/hooks.json` only fires after two
  one-time operator steps on each machine: the project must be trusted (open the repo in Codex and
  accept the prompt, or add `[projects."<abs path>"]` + `trust_level = "trusted"` to
  `~/.codex/config.toml`), and the hook definition itself must be trusted once via `/hooks` in a
  Codex session in that repo. Until both are done the file sits inert and the phrases still work by
  hand; the per-machine trust hash covers the entire hook **definition** in `.codex/hooks.json` —
  command, timeout and statusMessage — not the script body, so edits to `session-start-latest.sh`
  never need a re-trust while a change to any of those three fields does, and
  `--dangerously-bypass-hook-trust` is never used.
- **The Codex lane.** If `AGENTS.md` carries the `codex-lane-managed block`, "Finalize session" also
  runs that block's finalize hook before the final commit, writing the Codex sidecar under
  `.prism/codex/`. That block is owned by the framework's `modules/codex-lane-enrollment.md`, not by
  this kit, and this contract never edits it.

<!-- EOF: README.md -->
