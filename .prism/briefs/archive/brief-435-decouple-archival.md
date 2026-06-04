---
brief: 435
title: "R2-A — decouple insights/session-log archival from the finalize files-array"
parallel: true
depends_on: []
affects:
  - src/tools/finalize.ts
  - tests/tools/finalize.test.ts
complexity: high
workflow: metaswarm
model: claude-opus-4-8
effort: max
---

# Brief 435 — R2-A: decouple archival from the finalize files-array

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 §6.3.1 + §6.5(A), table row R2-A. Brief 1 of the archival chain (R2-A → R2-B → R3-imm → R3-dur).

## Context

The D-80 retention policy is implemented but has **never once fired** for `insights.md`: `insights-archive.md` does not exist even though `insights.md` has grown to ~461KB. Root cause, confirmed in current source:

`applyArchive` (`src/tools/finalize.ts`, ~838–892) operates entirely on the in-memory finalize `files` array — `const liveIdx = files.findIndex(...)` then `if (liveIdx === -1) return;`, bailing before it ever fetches or splits the live doc; only for in-array docs does it fetch the existing archive and run `splitForArchive(files[liveIdx].content, ...)`.

But `prism_log_insight` commits `insights.md` **out-of-band during the session** (push-immediately), so at finalize time it is already committed and **absent from the `files` array** → `applyArchive("insights.md", …)` returns immediately, every session. Call sites at the function's end: `applyArchive("session-log.md", …)` and `applyArchive("insights.md", …)`. (`session-log.md` rides the finalize commit today, so it is in `files` and works — the counter-example.)

`splitForArchive` / `ArchiveConfig` in `src/utils/archive.ts` are correct and tested. **The bug is purely the files-array gating — do not touch the splitter.**

## Required Changes

**Investigate first.** Read in `src/tools/finalize.ts`: the `applyArchive` inner function, its two call sites, `INSIGHTS_ARCHIVE_CONFIG`/`SESSION_LOG_ARCHIVE_CONFIG` (~71–84), the `fetchFile(projectSlug, path)` helper it already uses for the existing-archive fetch, `DOC_ROOT`, how the assembled `files` array is committed (atomic), and whether finalize's **audit/validation reconciliation** inspects `files` (declared-vs-committed) — your change must not trip it. Read `src/utils/archive.ts` `splitForArchive` + `ArchiveConfig` (reference only). Match existing finalize/archive test patterns.

**Change.** Generalize `applyArchive` so a retention-eligible doc **not** in `files` is still archived:
- When `liveIdx === -1`, fetch the live doc via `fetchFile(projectSlug, ${DOC_ROOT}/${liveFileName})` instead of returning. If it doesn't exist / fetch fails → skip (genuinely nothing to archive), preserving fail-open.
- Run `splitForArchive(liveContent, existingArchive, config)` on the fetched content.
- If `archivedCount > 0`, add **both** the pruned live doc and the archive file to `files` so they land in the **same atomic finalize commit** (create the live entry if absent; update in place if present).
- The in-array path (e.g. `session-log.md` riding finalize) must remain **byte-identical** to today.
- Keep all fail-open semantics: errors logged + skipped; a finalize that commits live docs without archiving is still a success.

If injecting fetched docs into `files` would break finalize's reconciliation, prefer the smallest change that keeps archival atomic with the finalize commit, and document the choice in the PR.

## Verification (hard block — land all evidence in the PR body)

1. **New regression test (audit §9(d) gap):** a finalize-level test where a >20KB `insights.md` exists in the repo but is **absent from `files`** → assert `insights-archive.md` is produced (`archivedCount > 0`) and live `insights.md` shrinks. Must FAIL against current `main`, PASS with the change.
2. Existing finalize + archive tests still pass; in-array path byte-identical (assert via the session-log / in-files cases).
3. Full suite green; `tsc` + lint clean. Report before/after test counts (N → M).
4. Confirm zero diff to `src/utils/archive.ts`.
5. **Fixtures only — do NOT run against real data.** Synthetic large insights.md, never the live `prism/insights.md`. Code change only; first real prune deferred (Out of Scope).

## Out of Scope

- STANDING-RULE 78%-protection (→ R2-B). R2-A only needs archival to **fire**, not to hit 20KB.
- Pruning the live `prism/insights.md` (→ R3-imm, deferred until after R2-B).
- Bounding synthesis inputs (→ R3-dur); pending-doc-updates provenance (§6.4).
- Any change to `splitForArchive` / `ArchiveConfig`.

## PR Title / Body Hint

Title: `prism(R2-A): archival fires regardless of finalize files-array (D-240 Phase B)`
Body: the gating bug, the fix (fetch-unconditionally, atomic with finalize), the new red→green regression test, test counts N→M, confirmation splitter untouched + in-array path byte-identical, reconciliation decision if relevant.

## Brief Author Notes

- Grounded against `finalize.ts` @ `132a8e1`: `applyArchive` 838–892, `INSIGHTS_ARCHIVE_CONFIG` 71–84, `splitForArchive` from `../utils/archive.js` (line 30), call sites 891–892.
- Tier: **CHECKPOINT** in the audit, but this brief is **code + fixture tests only** — no live-memory mutation.
- **First brief to exercise R4 model pinning.** Confirm in the PR body that CC launched on `claude-opus-4-8`. If CC rejects the `--model` string, report it — do not silently fall back.

<!-- EOF -->
