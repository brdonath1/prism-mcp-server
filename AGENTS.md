# AGENTS.md — PRISM MCP Server

<!-- BEGIN: harness-kit-managed block v3.0.1 — do not edit by hand; apply-harness-kit.sh replaces this span -->
### Rule 0 — Spawn routing (HARD RULE; PRISM D-34)

⛔ **Every spawned unit carries an explicit class-routed model pin; the host model is NEVER
the inherited default, whatever hosts the session.** Map: mechanical/seeding/stat-gathering →
`haiku` or `sonnet`; review-verified builds → `sonnet` (`opus` for the hardest);
reviews/specs → `opus`; binding verdicts at gates ONLY → `fable`, and a Fable host renders
those in-session, never by spawn. An unpinned spawn is a defect: stop and re-issue it pinned.
Full map + hook contract: `reference/spawn-routing.md` (prism-framework).

**Codex alias cross-walk (the same map on the Codex ladder):** mechanical / seeding /
stat-gathering → `gpt-5.6-luna`/low or `gpt-5.6-terra`/low; review-verified builds →
`gpt-5.6-terra`/medium (`gpt-5.6-sol` for the hardest); reviews / specs → `gpt-5.6-sol`/high;
binding verdicts at gates → `gpt-6-astra`/high, which on Codex is also the worker tier for
exceptionally difficult reasoning and substantial security/financial analysis; the host
(astra/ultra) renders the verdict itself where delegation adds no independent judgment. Every
Codex spawn supplies model and effort explicitly. For `collaboration.spawn_agent`, use
`fork_turns="none"` or bounded history — a full-history fork inherits the parent and rejects the
override, which is exactly the Rule 0 defect. A worker at `xhigh`/`max`/`ultra` needs a
task-specific justification. Source of
the ladder: `~/.codex/AGENTS.md` "Machine-wide Codex host and delegation policy — September 15, 2026".

Codex has no Claude `Agent`/`Workflow` tool, so no hook can catch this on the Codex side —
the rule binds you at authoring time instead. It governs **any brief, workflow script or
instruction you write for a Claude session** (every spawn you specify names its model
alias), and **your own sub-agent selection**: pick the minimum model that is fast and still
correct for the unit, per the same map. A Claude session running a brief you wrote will have
its unpinned spawns DENIED by `.claude/hooks/spawn-routing-guard.sh` — an unpinned spawn in
your brief becomes that session's blocked step, not a silent upgrade to the host model.

## Operator phrases — harness kit v3.0.1 (the same two phrases Claude uses; docs/handoffs/README.md §8)

This repository is co-developed by Codex (this file) and Claude (Claude Code and the Cowork/PRISM
sessions, `CLAUDE.md`). Both follow one contract, `docs/handoffs/README.md`, and `main` is the only
integration line. The operator's opening message outranks the handoff; the two phrases only remove
the need for them to say more.

- **"Pick up with the latest handoff"** (also "pick up", "resume", "where were we"): run
  `docs/handoffs/README.md` §1 in full — `git fetch origin`, read `origin/main:docs/handoffs/LATEST.md`
  and the newest dated handoff end to end (when `LATEST.md` says `handoff: none`, `.prism/handoff.md`
  is the checkpoint), reconcile against `origin/main`, the open PRs and your own checkpoint with the
  `main`-freshness test in §1.3 — then give a short opening report and start the handoff's closing
  action. The dated handoff wins over any harness-native record of the next action.
- **"Finalize session"** (also "finalize", "wrap up", "end the session", "write the handoff"): run
  `docs/handoffs/README.md` §5 in full — settle every unit (merged, or PARKED with the reason and the
  exact remaining steps), write `docs/handoffs/handoff-<YYYY-MM-DD-HHmm>.md` from
  `docs/handoffs/TEMPLATE.md` filling every section, update `docs/handoffs/LATEST.md` in the same
  commit, land it on `main` through a PR with the required checks green (merge commit, branch
  deleted), THEN update any Codex-native checkpoint of your own last.

- **The `SessionStart` hook** wired in `.codex/hooks.json` (the same script Claude Code runs,
  `.claude/hooks/session-start-latest.sh`) prints `LATEST.md`, the newest handoff, PRISM identity,
  git state and open PRs before the first turn — *once this project and that hook definition are
  trusted on this machine* (two one-time operator steps; `docs/handoffs/README.md` §9). Until they
  are, nothing is lost: "Pick up with the latest handoff" runs §1 by hand exactly as before; only
  the pre-loading is missing.
- Branches: `codex/<session-label>-<slug>`, one PR per unit into `main`. Never commit to `main`.
- Record decisions in the handoff's §4; the next Claude session ledgers them into `.prism/decisions/`.
- If this file also carries the `codex-lane-managed block`, "Finalize session" runs that block's
  finalize hook before the session's final commit.
- Never edit `.prism/` living documents outside that hook — they are the PRISM harness's state.
<!-- END: harness-kit-managed block -->

<!-- EOF: AGENTS.md -->
