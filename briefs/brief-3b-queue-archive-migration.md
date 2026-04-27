# Brief 3b — prism-mcp-server queue/archive layout migration

> **Repo:** `brdonath1/prism-mcp-server`
> **Pairs with:** Brief 3a on `brdonath1/prism`.
> **Decisions:** D-163 (queue/archive split, S77), D-164 (standardize all projects on `.prism/briefs/queue/`, S78)
> **Brief id:** `brief-3b-queue-archive-migration` — has numeric `3` substring per INS-191 (defensive — this brief lives in `briefs/`, which is NOT polled by the current marker pointing at `docs/briefs/`, so it won't be daemon-dispatched).
>
> **REVISION (S78, post-initial-pre-flight):** The original draft of this brief expected `.prism/briefs/` to be empty (only `trigger.yaml` adjacent). Pre-flight on the live repo discovered 18 historical session briefs already present at `.prism/briefs/*.md`. Brief amended to migrate those into `archive/` alongside the 2 from `docs/briefs/`. Same pattern Brief 3a applied to prism's 4 phase2 briefs.

## Goal

Migrate `brdonath1/prism-mcp-server` from `brief_dir: docs/briefs/` (legacy) to `brief_dir: .prism/briefs/queue/` (D-164 standard). After this brief lands:

- `.prism/trigger.yaml` points `brief_dir` at `.prism/briefs/queue/` and includes `archive` in `post_merge`.
- `.prism/briefs/queue/` exists (empty placeholder `.gitkeep`).
- `.prism/briefs/archive/` exists, populated with **20 historical briefs**:
  - **2 from `docs/briefs/`:**
    - `brief-105-auto-enroll-bootstrap-marker.md` (status: merged via PR #24)
    - `brief-trigger-marker-template-queue-archive.md` (status: merged via PR #25; daemon's `detectPr` couldn't match it due to non-numeric brief id — see INS-191; daemon's stale-active-recovery moved it to history with status `abandoned_daemon_restart` on its next restart)
  - **18 from `.prism/briefs/*.md`** (S22–S30 era session briefs, never daemon-dispatched because they don't match `brief-*.md`):
    - `ci-pipeline.md`, `d35-html-banner.md`, `ki10-scale-handoff-timeout.md`, `ki11-scale-logic-fix.md`, `ki15-slug-resolution.md`, `s22-intelligence-layer.md`, `s23-efficiency-tools.md`, `s24-finalization-banner.md`, `s25-bootstrap-optimization.md`, `s25-standing-rules-fix.md`, `s27-boot-banner-html.md`, `s27-full-audit-brief.md`, `s28-ip-allowlist.md`, `s28-mega-audit-remediation.md`, `s29-full-stack-context-audit.md`, `s29-full-stack-remediation.md`, `s30-brief-staleness-detection.md`, `s30-patch-integrity-fix.md`
- `docs/briefs/` becomes empty. Git does not track empty directories — once both `.md` files are moved, the path effectively disappears from the repo.
- `.prism/briefs/` root no longer contains any `.md` files — only the `queue/` and `archive/` subdirectories.

## Out of scope

- Source code, tests, application docs.
- The 30+ historical files in `briefs/` (legacy directory, never daemon-polled, kept as-is).
- The orphan file `briefs/auto-enroll-bootstrap-marker.md` (superseded by `docs/briefs/brief-105-auto-enroll-bootstrap-marker.md`, which IS being archived in this brief). Cleanup of the orphan can be a follow-up.
- This brief itself (`briefs/brief-3b-queue-archive-migration.md`) — leave it where it is.

## Pre-flight (do not skip)

Verify the marker matches the expected baseline before mutating. STOP if anything diverges.

```bash
cat .prism/trigger.yaml
```

The marker may or may not include the comment header lines (cosmetic; full rewrite in Step 1 normalizes either way). The functional fields must match exactly:

```
enabled: true
brief_dir: docs/briefs/
brief_pattern: "brief-*.md"
branch_strategy: main-only
intra_project_parallel: false
max_parallel_briefs: 1
post_merge:
  - notify
```

If any functional field diverges (different `brief_dir`, additional `post_merge` actions, etc.), STOP and surface.

Verify the 2 briefs are present in `docs/briefs/` and nothing else (no other `.md` files):

```bash
ls -1 docs/briefs/
```

Expected output (alphabetically sorted):

```
brief-105-auto-enroll-bootstrap-marker.md
brief-trigger-marker-template-queue-archive.md
```

Verify the 18 historical session briefs at `.prism/briefs/*.md`:

```bash
ls -1 .prism/briefs/ | sort
```

Expected output (18 lines, alphabetically):

```
ci-pipeline.md
d35-html-banner.md
ki10-scale-handoff-timeout.md
ki11-scale-logic-fix.md
ki15-slug-resolution.md
s22-intelligence-layer.md
s23-efficiency-tools.md
s24-finalization-banner.md
s25-bootstrap-optimization.md
s25-standing-rules-fix.md
s27-boot-banner-html.md
s27-full-audit-brief.md
s28-ip-allowlist.md
s28-mega-audit-remediation.md
s29-full-stack-context-audit.md
s29-full-stack-remediation.md
s30-brief-staleness-detection.md
s30-patch-integrity-fix.md
```

Sanity check — none should match the daemon's polling pattern:

```bash
ls -1 .prism/briefs/brief-*.md 2>/dev/null | wc -l | tr -d ' '
```

Expected: 0

If `.prism/briefs/` already contains `queue/` or `archive/` subdirectories, STOP — that's a sign of incomplete prior work. Otherwise, proceed.

## Steps

### 1. Update marker

Replace the entire content of `.prism/trigger.yaml` with:

```
# Trigger enrollment marker — auto-generated by prism_bootstrap.
# Presence of this file (with enabled: true) enrolls this repo in Trigger.
#
# Layout:
#   brief_dir/  — pending briefs Trigger should poll and dispatch
#   archive/    — completed briefs (auto-moved by post_merge: [archive] after PR merge)
#
# Edit values below to customize per-project behavior; set enabled: false to opt out.
enabled: true
brief_dir: .prism/briefs/queue/
brief_pattern: "brief-*.md"
branch_strategy: main-only
intra_project_parallel: false
max_parallel_briefs: 1
post_merge:
  - notify
  - archive
```

Mirrors the new template content from PR #25 verbatim (this is the same content the marker template now generates for newly-enrolled projects).

### 2. Create queue/ and archive/ directories with placeholders

```bash
mkdir -p .prism/briefs/queue .prism/briefs/archive
touch .prism/briefs/queue/.gitkeep .prism/briefs/archive/.gitkeep
```

### 3. Move the 2 briefs from `docs/briefs/` into `.prism/briefs/archive/`

Use `git mv` to preserve history:

```bash
git mv docs/briefs/brief-105-auto-enroll-bootstrap-marker.md     .prism/briefs/archive/brief-105-auto-enroll-bootstrap-marker.md
git mv docs/briefs/brief-trigger-marker-template-queue-archive.md .prism/briefs/archive/brief-trigger-marker-template-queue-archive.md
```

After both moves, `docs/briefs/` should be empty. Git automatically drops empty directories from tracking; no explicit `rmdir` step needed.

### 4. Move the 18 historical session briefs from `.prism/briefs/*.md` into `.prism/briefs/archive/`

These files are session-era artifacts (S22–S30) that don't match the daemon's `brief-*.md` polling pattern, so they were never daemon-dispatched. Moving them to `archive/` aligns the directory with the queue/archive semantic ("queue = pending, archive = done, root = empty").

```bash
git mv .prism/briefs/ci-pipeline.md                  .prism/briefs/archive/ci-pipeline.md
git mv .prism/briefs/d35-html-banner.md              .prism/briefs/archive/d35-html-banner.md
git mv .prism/briefs/ki10-scale-handoff-timeout.md   .prism/briefs/archive/ki10-scale-handoff-timeout.md
git mv .prism/briefs/ki11-scale-logic-fix.md         .prism/briefs/archive/ki11-scale-logic-fix.md
git mv .prism/briefs/ki15-slug-resolution.md         .prism/briefs/archive/ki15-slug-resolution.md
git mv .prism/briefs/s22-intelligence-layer.md       .prism/briefs/archive/s22-intelligence-layer.md
git mv .prism/briefs/s23-efficiency-tools.md         .prism/briefs/archive/s23-efficiency-tools.md
git mv .prism/briefs/s24-finalization-banner.md      .prism/briefs/archive/s24-finalization-banner.md
git mv .prism/briefs/s25-bootstrap-optimization.md   .prism/briefs/archive/s25-bootstrap-optimization.md
git mv .prism/briefs/s25-standing-rules-fix.md       .prism/briefs/archive/s25-standing-rules-fix.md
git mv .prism/briefs/s27-boot-banner-html.md         .prism/briefs/archive/s27-boot-banner-html.md
git mv .prism/briefs/s27-full-audit-brief.md         .prism/briefs/archive/s27-full-audit-brief.md
git mv .prism/briefs/s28-ip-allowlist.md             .prism/briefs/archive/s28-ip-allowlist.md
git mv .prism/briefs/s28-mega-audit-remediation.md   .prism/briefs/archive/s28-mega-audit-remediation.md
git mv .prism/briefs/s29-full-stack-context-audit.md .prism/briefs/archive/s29-full-stack-context-audit.md
git mv .prism/briefs/s29-full-stack-remediation.md   .prism/briefs/archive/s29-full-stack-remediation.md
git mv .prism/briefs/s30-brief-staleness-detection.md .prism/briefs/archive/s30-brief-staleness-detection.md
git mv .prism/briefs/s30-patch-integrity-fix.md      .prism/briefs/archive/s30-patch-integrity-fix.md
```

## Verification (all seven predicates must hold)

Run each command verbatim and capture output. Include the output in the PR body.

```bash
# P1: marker brief_dir is the new value
grep -c '^brief_dir: \.prism/briefs/queue/$' .prism/trigger.yaml
# Expected: 1

# P2: marker post_merge contains both notify and archive (exactly two `  - X` lines)
grep -cE '^  - (notify|archive)$' .prism/trigger.yaml
# Expected: 2

# P3: queue/ exists with .gitkeep
test -f .prism/briefs/queue/.gitkeep && echo "P3 OK"
# Expected: P3 OK

# P4: archive/ contains exactly 21 entries (.gitkeep + 18 legacy from .prism/briefs/ + 2 from docs/briefs/)
ls -1A .prism/briefs/archive/ | wc -l | tr -d ' '
# Expected: 21

# P5a: docs/briefs/ no longer contains any .md files
ls -1 docs/briefs/*.md 2>/dev/null | wc -l | tr -d ' '
# Expected: 0

# P5b: .prism/briefs/ root no longer contains any .md files (all 18 legacy briefs moved into archive/)
ls -1 .prism/briefs/*.md 2>/dev/null | wc -l | tr -d ' '
# Expected: 0

# P6: legacy briefs/ directory untouched (sanity — confirm we didn't accidentally touch it)
ls -1 briefs/ | wc -l | tr -d ' '
# Expected: a number greater than 0 (currently ~30+ files; exact count irrelevant — just confirms the directory still exists and was not modified)
```

If any predicate fails, do NOT commit or push. Surface the failure and the actual output.

## Build / test gates

This brief touches no source code, but the repo has tests and CI. Confirm clean build + test:

```bash
npx tsc --noEmit
```

Expected: 0 errors (no source touched, but defensive sanity check).

```bash
npm test 2>&1 | tail -8
```

Expected: tests pass at the same baseline as before this brief — no new failures introduced. (Pre-existing failures in `tests/cc-status.test.ts` may be present per S77 PR #24/#25 history; those are unrelated to this brief and should reproduce on `main` without the changes.)

`npm run lint` is not currently defined in `package.json` — fall back to `tsc` only. Per S78 task queue, adding a lint script is a separate follow-up.

## PR

- **Branch name:** `feat/queue-archive-migration` (any name OK — daemon doesn't poll this brief from `briefs/`; no `detectPr` involvement)
- **Title:** `feat: migrate prism-mcp-server to queue/archive brief layout (Brief 3b, D-163/D-164)`
- **Body:**

```markdown
## Summary

Migrates `brdonath1/prism-mcp-server` to the queue/archive brief layout per D-163 (S77) and D-164 (S78). Pairs with Brief 3a on `brdonath1/prism`.

Changes:

- `.prism/trigger.yaml`: `brief_dir` → `.prism/briefs/queue/` (was `docs/briefs/`); `post_merge` adds `archive`. Comment header normalized to current template.
- `.prism/briefs/queue/.gitkeep` and `.prism/briefs/archive/.gitkeep` created.
- 2 briefs moved from `docs/briefs/` to `.prism/briefs/archive/` via `git mv`:
  - `brief-105-auto-enroll-bootstrap-marker.md` (merged via PR #24)
  - `brief-trigger-marker-template-queue-archive.md` (merged via PR #25; INS-191 case)
- 18 historical session briefs (S22–S30 era) moved from `.prism/briefs/*.md` to `.prism/briefs/archive/` via `git mv`. None match the `brief-*.md` polling pattern, so they were never daemon-dispatched; this is a tidiness migration aligning the directory with queue/archive semantics.
- `docs/briefs/` becomes empty (git auto-drops it).

## Verification

All seven predicates from `briefs/brief-3b-queue-archive-migration.md` §Verification pass:

[paste P1–P6 output verbatim]

`npx tsc --noEmit` clean. `npm test` shows no new failures vs. main baseline.

## Risk / rollback

Low risk. The Trigger daemon's poller reads `brief_dir` from the marker on every poll, so the marker change takes effect on the next poll cycle (within ~5 min). After this lands, the daemon will:

1. Stop polling `docs/briefs/` (now empty anyway).
2. Start polling `.prism/briefs/queue/` (also empty post-merge).

`brief-105` and `brief-trigger-marker-template-queue-archive` are already in the daemon's history with terminal statuses (`merged` and `abandoned_daemon_restart` respectively); per KI-21 §Q3, the poller's `knownBriefIds` will skip them regardless of file location. The 18 S22–S30 era briefs were never in the daemon's history (never matched the polling pattern), so `git mv` of them is purely a working-tree change with no daemon-state implication. No re-dispatch risk for any of the 20 archived files.

Rollback = revert this PR; daemon resumes polling `docs/briefs/`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Finishing up

1. After all 7 verification predicates pass + `tsc` clean + `npm test` baseline, run:
   ```bash
   git status
   ```
   Expected: 23 changes (1 modified `.prism/trigger.yaml`, 2 new `.gitkeep` files, 2 renames `docs/briefs/` → `.prism/briefs/archive/`, 18 renames `.prism/briefs/*.md` → `.prism/briefs/archive/`).
2. `git add -A && git commit -m "feat: migrate prism-mcp-server to queue/archive brief layout (Brief 3b, D-163/D-164)"`.
3. `git push origin feat/queue-archive-migration`.
4. Open PR with the body above.
5. STOP. Do NOT merge. Operator reviews and merges manually.
