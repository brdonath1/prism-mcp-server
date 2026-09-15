#!/usr/bin/env bash
# harness-kit: v2.0.0 owned — written by apply-harness-kit.sh (brdonath1/prism-framework/_templates/harness-kit); hand edits are overwritten on the next apply
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
tmo() { local s="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$s" "$@"; elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$s" "$@"; elif command -v perl >/dev/null 2>&1; then perl -e 'my $t = shift @ARGV; my $g = fork; if (!defined $g) { exec { $ARGV[0] } @ARGV; exit 127 } if ($g == 0) { eval { setpgrp(0, 0) }; exec { $ARGV[0] } @ARGV; exit 127 } $SIG{ALRM} = sub { kill("TERM", -$g) or kill("TERM", $g); select(undef, undef, undef, 0.5); kill("KILL", -$g) or kill("KILL", $g); waitpid($g, 0); exit 124 }; alarm $t; waitpid($g, 0); my $w = $?; alarm 0; exit(($w & 127) ? 128 + ($w & 127) : ($w >> 8))' "$s" "$@"; else "$@"; fi; }
tmo 12 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 fetch origin --prune --quiet 2>/dev/null || echo "(git fetch failed or timed out — pointer below may be stale)"
DEFAULT_BRANCH="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="main"
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
echo "=== local git state ==="
echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null) · HEAD: $(git rev-parse --short HEAD 2>/dev/null) · origin/$DEFAULT_BRANCH: $(git rev-parse --short "origin/$DEFAULT_BRANCH" 2>/dev/null)"
git status -sb 2>/dev/null | head -1
echo "worktrees: $(git worktree list 2>/dev/null | wc -l | tr -d ' ')"
if command -v gh >/dev/null 2>&1; then
  echo "=== open PRs ==="
  tmo 8 gh pr list --state open --limit 15 --json number,title,headRefName --jq '.[] | "#\(.number) \(.headRefName) — \(.title)"' 2>/dev/null || echo "(gh unavailable or not logged in)"
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
