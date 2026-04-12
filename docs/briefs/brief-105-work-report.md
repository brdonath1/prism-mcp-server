# Brief 105 — Work Report: Fix Decision Dedup + Multi-Table Parser Bug

> **Brief:** `brief-105-fix-dedup-parser.md`
> **Executor:** Claude Code (Opus 4.6, 1M context)
> **Date:** 2026-04-11
> **Target repo:** `brdonath1/prism-mcp-server`
> **Commit prefix:** `fix:`
> **Priority:** HIGH — server-side dedup was non-functional

## TL;DR

`parseExistingDecisionIds()` and `validateDecisionIndex()` both delegated to
`parseMarkdownTable()`, which read every pipe-containing line in the file as
a single table. In a real `_INDEX.md` the first table is the Domain Files
reference (columns: `File | Decisions | Scope`), so neither caller ever saw
the Decision Summary table — dedup silently returned an empty map and push
validation crashed with a spurious "missing required column: ID".

Fixed both call sites without touching the shared `parseMarkdownTable`
utility. Added four new regression tests that model the real production
`_INDEX.md` shape (Domain Files table leading, Decision Summary following).

## Changes

### 1. `src/tools/log-decision.ts` — regex-based dedup scan (Fix 1)

Replaced the `parseMarkdownTable()`-backed implementation of
`parseExistingDecisionIds()` with a streaming regex scan:

```ts
const rowPattern = /^\|\s*(D-?\d+)\s*\|\s*([^|]*)\|/gm;
```

Highlights:

- Scans every line of the file independently, so Domain Files / Decision
  Summary / scratch tables can all coexist without poisoning the parser.
- Accepts the legacy hyphenless `D101` form and normalizes the map key to
  the canonical `D-101` — required because Zod enforces hyphenated IDs on
  incoming `prism_log_decision` requests, so the `has()` lookup has to
  compare against the canonical form.
- Keeps the first occurrence so the stored title tracks the canonical
  row rather than being clobbered by repeated mentions elsewhere.
- Dropped the now-unused `parseMarkdownTable` import.

### 2. `src/validation/decisions.ts` — extract "Decision Summary" first (Fix 2)

`validateDecisionIndex()` now calls `extractSection(content, "Decision
Summary")` before parsing. If the section is present, only its body is
handed to `parseMarkdownTable()`; if it is absent (bare-table fixtures,
older files), we fall back to the whole content so existing single-table
callers keep working. Added a doc comment explaining the rationale and
linking back to brief 105.

### 3. Tests (Fix 3)

**`tests/log-decision-dedup.test.ts`** — added:

- A `MULTI_TABLE_INDEX` fixture that mirrors production `_INDEX.md`
  (Domain Files table leading, Decision Summary following).
- `parseExistingDecisionIds` unit test: must find `D-115`/`D-116` in the
  second table and must NOT confuse Domain Files rows for decisions.
- `parseExistingDecisionIds` unit test for legacy `D116` → normalized to
  `D-116`.
- Integration test: handler rejects `D-116` when it exists in the
  Decision Summary table of a multi-table index.
- Integration test: handler accepts a new `D-117` against the same
  multi-table index and pushes both files.

**`tests/validation-extended.test.ts`** — added:

- A full multi-table `_INDEX.md` fixture and a test asserting
  `validateDecisionIndex` returns zero errors.
- A multi-table fixture with a duplicate `D-1` in the Decision Summary
  table; asserts the "Duplicate decision ID" error still fires.

### 4. Fix 4 (optional) — deferred

The brief marked this as optional. I considered making
`parseMarkdownTable()` table-boundary-aware (splitting on non-pipe
gaps), but all remaining callers (`finalize.ts`, `bootstrap.ts`,
`analytics.ts`) would still receive rows from whichever table appears
*first*, which in a real `_INDEX.md` is the Domain Files table — so
the change would swap one kind of wrong output for another without
fully fixing them. The right fix for those callers is the same
"extract `## Decision Summary` first" pattern used here, but that is
out of scope for brief 105 and not currently paging. Leaving the
utility alone avoids a behavior change on callers that happen to work
correctly today (single-table inputs).

Known follow-up: wrap the `analytics.ts`/`bootstrap.ts`/`finalize.ts`
decision-count paths in the same section extraction. Suggested as a
separate brief.

## Verification

```
npm run build   # clean
npm test        # 477 passed across 38 files (Duration 1.79s)
```

Relevant tests:

- `tests/log-decision-dedup.test.ts` — 8 tests (was 5)
- `tests/validation-extended.test.ts` — 27 tests (was 25)
- `tests/summarizer.test.ts` — unchanged, still green

## Success criteria (from brief)

- [x] `parseExistingDecisionIds` correctly identifies D-N IDs in a
  multi-table `_INDEX.md`
- [x] `prism_log_decision` rejects duplicate IDs with a clear error
  message
- [x] Push validation accepts valid `_INDEX.md` files without "missing
  required column" errors
- [x] All tests pass including new multi-table regression tests
- [x] Work report committed at `docs/briefs/brief-105-work-report.md`

## Coordination

- No decision logged — PRISM session owns decision IDs (INS-69).
- No platformforge-v2 living documents touched.
- Fix committed directly to `main` per brief direction (bugfix, not a
  feature).

<!-- EOF: brief-105-work-report.md -->
