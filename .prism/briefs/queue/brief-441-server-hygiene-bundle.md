---
brief: 441
title: "Server hygiene — tool deadlines, slug guards, log-insight sanitize, marker-knob default, PDU provenance, finalize unlogged-ID warning"
parallel: false
depends_on: [440]
affects:
  - src/tools/bootstrap.ts
  - src/tools/finalize.ts
  - src/tools/analytics.ts
  - src/tools/search.ts
  - src/tools/status.ts
  - src/tools/fetch.ts
  - src/tools/log-insight.ts
  - src/validation/slug.ts
  - tests/
complexity: high
workflow: metaswarm
model: claude-opus-4-8
effort: max
---

# Brief 441 — server hygiene bundle

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 rows R5-c (CODE half only), R-deadlines, the
D-241 dead-marker-knob correction, PDU provenance, and the optional finalize
unlogged-ID warning. **Depends on brief-440** (touches finalize.ts + the marker
generator that may overlap bootstrap edits). **CODE.** Six independent sub-changes —
implement and test each; the full suite must stay green.

## Required Changes
**Investigate first.** Read each target before editing; confirm real file paths.

1. **R-deadlines:** add wall-clock deadlines to the `analytics`, `search`, `status`,
   and `fetch` tool handlers (only 4/23 tools currently have them — match the existing
   deadline pattern). Also make `prism_fetch` summarize/cap large file bodies by
   default (sane byte/line cap with opt-out) so large fetches don't blow context.
2. **R5-c guards:** in the slug validation module (`src/validation/slug.ts` or
   wherever it lives), wire-or-delete the dead slug guards — determine via call-graph
   whether they are reachable; wire them in if they should run, delete if truly dead.
   Report which.
3. **R5-c sanitize:** apply `sanitizeContentField()` to the user-supplied fields of
   `prism_log_insight` (title / description / procedure), matching the write-time
   U+200B sanitization already live in `prism_log_decision` / `prism_patch` (KI-26).
4. **D-241 marker-knob default:** in the bootstrap marker-generator (the code that
   emits `.prism/trigger.yaml`), default `intra_project_parallel: false` and
   `max_parallel_briefs: 1`, and rewrite the auto-generated comment so it no longer
   implies those fields gate parallelism (they are dead config; same-repo is serial).
5. **PDU provenance:** when pending-doc-updates are applied/rejected at boot/finalize,
   record applied/rejected provenance and archive consumed batches to
   `pending-doc-updates-archive.md` so the file does not silently accrete stale
   proposals.
6. **Finalize unlogged-ID warning (optional):** at finalize, warn (diagnostics,
   non-blocking) when the session text references a `D-N` / `INS-N` ID that was never
   logged via `prism_log_decision` / `prism_log_insight`.

## Verification (HARD BLOCK — land all evidence in the PR body)
1. Each sub-change has a test (deadlines fire on the 4 handlers; prism_fetch caps large
   bodies; slug guard wired-or-removed with rationale; log-insight sanitizes U+200B;
   marker-generator emits false/1 + corrected comment; PDU provenance recorded + batch
   archived; finalize warns on unlogged referenced IDs).
2. Full suite green; tsc + lint clean; report counts (N -> M).
3. Report the slug-guard disposition (wired vs deleted) explicitly.

## Out of Scope
- Deleting vestigial `prism-mcp-server/.prism/` state (CHECKPOINT — separate).
- Trigger-side R5 / R6 / state-reconcile (daemon changes — separate awake session).

## PR Title / Body Hint
Title: `prism(hygiene): tool deadlines + fetch caps + slug guards + log-insight sanitize + marker default + PDU provenance + finalize ID-warning (D-240 Phase B)`
Body: enumerate the six changes, the slug-guard disposition, red->green tests, counts
N->M, confirmation CC launched on claude-opus-4-8.

## Brief Author Notes
- Six independent edits bundled for pane economy; if one sub-change cannot be done
  cleanly, STILL complete the others, mark the blocked one in the PR body, and keep the
  suite green (do NOT leave a broken/failing test).
- Model pinning (R4): confirm CC launched on claude-opus-4-8 in the PR body.
- Tier: AUTO. CI gates the merge.

<!-- EOF -->
