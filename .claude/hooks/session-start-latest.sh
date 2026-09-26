#!/usr/bin/env bash
# harness-kit: v3.0.5 owned — written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply
# SessionStart hook — prints the cross-harness pointer (docs/handoffs/README.md §0–§1) so every
# session in this repo starts with LATEST.md, the newest handoff, PRISM identity, git state and
# open PRs already in context. ONE script, BOTH harnesses: Claude Code runs it from the
# SessionStart entry in .claude/settings.json (with CLAUDE_PROJECT_DIR set), the Codex app from
# the SessionStart entry in .codex/hooks.json (no CLAUDE_PROJECT_DIR, cwd may be a subdirectory —
# hence the git-toplevel fallback below, and the harness-aware pointer at the end).
# Read-only; never modifies the working tree; always exits 0.
# Portable: macOS ships no `timeout`, so bounded commands use git's own low-speed guard and a
# best-effort wrapper — GNU `timeout` → `gtimeout` → perl (ships with macOS and Ubuntu) → run
# unbounded. The perl rung FORKS the command into its own process group, keeps the alarm in the
# PARENT, and on the deadline sends TERM and then, 0.5 s later, KILL to that whole group: an
# exec-inherited alarm bounds nothing when the command ignores or absorbs SIGALRM (Go binaries
# such as `gh` register it as notify-only and run to completion), and killing only the direct
# child would leave a grandchild alive still holding this hook's stdout open. The parent then
# maps the child's wait status the way a shell does — signal N reports 128+N, a timeout reports
# 124 — so the `|| echo "(... failed or timed out ...)"` fallbacks below always fire.
# Project-specific checks belong in .claude/hooks/session-start-project.sh (run last, never fatal).
set -u
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
# Layer 3 — wrong-folder detection (bounded, read-only, never fails the exit-0 contract).
# The Codex app's experimental worktrees feature (operator-owned; /experimental or
# [features] worktrees in ~/.codex/config.toml) creates app-managed copies under
# ~/.codex/worktrees/<id>/<Project Name>. That is not the project: docs/handoffs/README.md
# § area map says every session works in the main clone under ~/development/<slug>. Detect
# it here, not gate it — the kit only instructs and detects; the feature flag is Codex's.
PHYS_CWD="$(pwd -P 2>/dev/null || pwd)"
COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
COMMON_DIR_ABS="$COMMON_DIR"
if [ -n "$COMMON_DIR" ]; then
  COMMON_DIR_ABS="$(cd "$COMMON_DIR" 2>/dev/null && pwd -P || true)"
  [ -n "$COMMON_DIR_ABS" ] || COMMON_DIR_ABS="$COMMON_DIR"
fi
MAIN_CLONE="$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
[ -n "$MAIN_CLONE" ] || MAIN_CLONE="${COMMON_DIR_ABS%/.git}"
HOME_P="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P || printf '%s' "${HOME:-}")"
case "$PHYS_CWD" in
  "$HOME_P/.codex/worktrees/"*)
    echo "!!! WRONG FOLDER — this session is running in a Codex app worktree: $PHYS_CWD"
    echo "    The project is the main clone at ${MAIN_CLONE:-<unknown>} — stop, push any commits to their codex/* branch, and reopen it from ~/development/<slug>. Worktrees should be OFF in the Codex app (/experimental). See docs/handoffs/README.md § area map."
    ;;
esac
tmo() { local s="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"; elif command -v perl >/dev/null 2>&1; then perl -e 'my $t = shift @ARGV; my $g = fork; if (!defined $g) { exec { $ARGV[0] } @ARGV; exit 127 } if ($g == 0) { eval { setpgrp(0, 0) }; exec { $ARGV[0] } @ARGV; exit 127 } $SIG{ALRM} = sub { kill("TERM", -$g) or kill("TERM", $g); select(undef, undef, undef, 0.5); kill("KILL", -$g) or kill("KILL", $g); waitpid($g, 0); exit 124 }; alarm $t; waitpid($g, 0); my $w = $?; alarm 0; exit(($w & 127) ? 128 + ($w & 127) : ($w >> 8))' "$s" "$@"; else "$@"; fi; }
digest() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; elif command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else cksum | awk '{print $1 ":" $2}'; fi; }
FETCH_STATE="refreshed"
if ! tmo 12 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 fetch origin --prune --quiet 2>/dev/null; then
  FETCH_STATE="failed or timed out — discovery below may be stale"
  echo "(git fetch failed or timed out — pointer below may be stale)"
fi
DEFAULT_BRANCH="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="main"
echo "=== startup discovery snapshot ==="
echo "observed_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "repository: $(git rev-parse --show-toplevel 2>/dev/null)"
echo "fetch: $FETCH_STATE"
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null) · HEAD: $(git rev-parse HEAD 2>/dev/null) · origin/$DEFAULT_BRANCH SHA: $(git rev-parse --verify -q "origin/$DEFAULT_BRANCH" 2>/dev/null || printf '<unavailable>')"
STATUS_PORCELAIN="$(git status --porcelain=v1 2>/dev/null || true)"
STATUS_COUNT="$(printf '%s\n' "$STATUS_PORCELAIN" | sed '/^$/d' | wc -l | tr -d ' ')"
STATUS_DIGEST="$(printf '%s' "$STATUS_PORCELAIN" | digest)"
if [ "$STATUS_COUNT" = "0" ]; then
  echo "status: clean · porcelain_sha256: $STATUS_DIGEST"
else
  echo "status: dirty ($STATUS_COUNT entries) · porcelain_sha256: $STATUS_DIGEST"
fi
WORKTREE_STATE="$(git worktree list --porcelain 2>/dev/null || true)"
WORKTREE_COUNT="$(printf '%s\n' "$WORKTREE_STATE" | grep -c '^worktree ' || true)"
echo "worktrees: $WORKTREE_COUNT · state_sha256: $(printf '%s' "$WORKTREE_STATE" | digest)"
echo "=== docs/handoffs/LATEST.md @ origin/$DEFAULT_BRANCH ==="
git show "origin/$DEFAULT_BRANCH:docs/handoffs/LATEST.md" 2>/dev/null || echo "(LATEST.md unavailable on origin/$DEFAULT_BRANCH)"
echo "=== newest handoff by git log @ origin/$DEFAULT_BRANCH ==="
NEWEST="$(git log "origin/$DEFAULT_BRANCH" --diff-filter=A --format='' --name-only -- 'docs/handoffs/handoff-*.md' 2>/dev/null | grep . | head -1 || true)"
if [ -n "$NEWEST" ]; then echo "$NEWEST"; else echo "(none under this contract yet — .prism/handoff.md is the checkpoint)"; fi
echo "=== PRISM identity ==="
if [ -f .prism/project-identity.md ]; then
  grep -E '^(Project Name|Project Slug|GitHub Repo):' .prism/project-identity.md 2>/dev/null || echo "(.prism/project-identity.md has no identity fields)"
else
  echo "(.prism/project-identity.md not present)"
fi
echo "=== startup discovery snapshot: open PRs ==="
if command -v gh >/dev/null 2>&1; then
  if tmo 8 gh pr list --state open --limit 15 --json number,title,headRefName --jq '.[] | "#\(.number) \(.headRefName) — \(.title)"' 2>/dev/null; then
    echo "open_prs: observed"
  else
    echo "open_prs: unavailable"
  fi
else
  echo "open_prs: unavailable (gh absent)"
fi
if [ -f .claude/hooks/session-start-project.sh ]; then
  echo "=== project checks ==="
  tmo 5 bash .claude/hooks/session-start-project.sh 2>&1 || echo "(project hook exited non-zero, timed out or was killed — ignored)"
fi
echo "=== operator phrases ==="
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "'Pick up with the latest handoff' → .claude/skills/pickup-handoff/SKILL.md (/pickup) · 'Finalize session' → .claude/skills/finalize-session/SKILL.md (/finalize) · contract: docs/handoffs/README.md"
else
  echo "'Pick up with the latest handoff' / 'Finalize session' → AGENTS.md § Operator phrases → docs/handoffs/README.md §1 / §5"
fi
exit 0
