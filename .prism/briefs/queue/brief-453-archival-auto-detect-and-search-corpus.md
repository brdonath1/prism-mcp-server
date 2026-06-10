---
brief: 453
title: "Session-log archival layout auto-detection + standing-rules.md in prism_search corpus + doc-guard registry path"
parallel: false
affects:
  - src/utils/archive.ts
  - src/tools/finalize.ts
  - src/tools/search.ts
  - src/utils/doc-guard.ts
  - tests/
complexity: medium
workflow: metaswarm
---

# Brief 453 — archival auto-detect + search corpus

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** S166 source-verified mechanisms (prism registry INS-316 / INS-317). The S165 session-log "truncation" was commitPhase step 3b archival running `SESSION_LOG_ARCHIVE_CONFIG.mostRecentAt: "top"` (keep FIRST 20 entries) against prism's CHRONOLOGICAL session-log (newest LAST) — it archived the newest entries, twice (commits 2b54810c, e8c07739). Separately, prism_search cannot reach standing-rules.md rule bodies because the file is in neither fetch list (INS-312). **CODE only** — the prism-repo data repair is brief-705 on brdonath1/prism.

## Required Changes
**Investigate first.** Read each target before editing; confirm current shapes.

1. **archive.ts — `"auto"` orientation.** Extend `ArchiveConfig.mostRecentAt` with `"auto"`. In `splitForArchive`, after `parseEntriesWithBounds` and before the eligible slice, resolve `"auto"` from the parsed entries in document order: `first.number < last.number` → behave as `"bottom"` (newest last); `first.number > last.number` → `"top"`; single entry or equal endpoints → `"bottom"` (moot — the `entries.length <= retentionCount` early-return covers small files). Fix the ArchiveConfig doc comment that asserts "session-log.md is reverse-chronological" — that false assumption caused the incident.
2. **finalize.ts —** `SESSION_LOG_ARCHIVE_CONFIG.mostRecentAt: "top"` → `"auto"`. Do NOT touch `INSIGHTS_ARCHIVE_CONFIG` (its `"bottom"` is correct for the append-at-bottom Active section).
3. **search.ts —** add `.prism/standing-rules.md` to the Step-2 fetch fan-out (same try/catch-null graceful-absence pattern as the living-doc fetches). Archives stay excluded. `files_searched` rises by 1 when the file exists.
4. **doc-guard.ts —** add `"standing-rules.md"` to `KNOWN_PRISM_PATHS`.

## Verification (HARD BLOCK — land all evidence in the PR body)
1. New tests: (a) auto-detect on a chronological fixture mirroring the prism incident shape (over threshold, >retentionCount ascending `### Session N` entries) archives the OLDEST and keeps the NEWEST retentionCount; (b) auto-detect on a reverse-chronological fixture keeps the first/newest retentionCount; (c) explicit `"top"`/`"bottom"` behavior unchanged (regression); (d) search corpus includes standing-rules.md content when present, degrades gracefully when absent; (e) doc-guard redirects a root-level `standing-rules.md` push when `.prism/standing-rules.md` exists.
2. Record baseline `npm test` BEFORE changes; only NEW failures block. Full suite green after; tsc + lint clean; report counts N -> M.
3. PR body: grep evidence that SESSION_LOG_ARCHIVE_CONFIG carries `"auto"`; name the incident-replay test; show the search-corpus test asserting standing-rules.md inclusion.

## Out of Scope
- The prism repo data repair (brief-705 on brdonath1/prism — dedupe + live restructure + topics backfill).
- `LIVING_DOCUMENT_NAMES` / `LIVING_DOCUMENTS` — do NOT add standing-rules.md there; it would ripple the 10-doc contract through finalize/status/bootstrap.
- prism_load_rules code changes (reachability is handled data-side by brief-705's topics backfill).

## PR Title / Body Hint
Title: `prism(archival+search): session-log archival layout auto-detect; standing-rules.md in search corpus + doc-guard (INS-312/INS-316)`
Body: the four changes, incident-replay test name, red->green counts N->M, SESSION_LOG_ARCHIVE_CONFIG grep.

## Brief Author Notes
- model/effort deliberately UNPINNED — daemon panes inherit the current CC user default (Fable 5 + max effort today; Opus 4.8 after the 2026-06-22 swap) per INS-309.
- Merging deploys automatically (Railway from main, INS-303).
- Sequencing-independent of brief-705: the prism repair leaves live session-log at <= 20 entries, so archival early-returns under old or new code.

<!-- EOF -->