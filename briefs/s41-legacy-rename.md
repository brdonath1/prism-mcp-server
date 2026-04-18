# Brief S41-C2: rename LEGACY_LIVING_DOCUMENTS → LIVING_DOCUMENT_NAMES (mechanical)

> **Target repo:** `prism-mcp-server` (brdonath1/prism-mcp-server)
> **Source:** S41 Phase 4 scope clarification — the list named `LEGACY_LIVING_DOCUMENTS` is NOT legacy. It's the canonical list of living-document filenames (no `.prism/` prefix) that `resolveDocPath()` consumes and prepends the prefix to. The fallback to root paths in `resolveDocPath` is also NOT just legacy migration — it's actively used by `prism_fetch` for arbitrary paths like `reports/*.md` and `briefs/*.md`. Current naming misleads.
> **Diagnosis session:** S41 (04-17-26), after verifying via Railway logs (filter `"using legacy path"` — only 3 hits in 6 days, all for non-living-doc paths).
> **HEAD at brief-draft time:** `510a8de` on origin/main (post-S41-C1 finalize draft timeout fix).

## Mission

Strictly mechanical rename + comment fix. Zero runtime behavior change. The goals:

1. Rename the export `LEGACY_LIVING_DOCUMENTS` → `LIVING_DOCUMENT_NAMES` in `src/config.ts`. Update its JSDoc to reflect actual purpose (canonical name list consumed by `resolveDocPath`-family functions, which handle `.prism/` prefix internally).
2. Update comments in `src/utils/doc-resolver.ts` that mischaracterize the fallback as "legacy migration" — the fallback is a live feature for arbitrary root-path fetches.
3. Update all import and usage sites to the new name.
4. Update any test that references the old name.

This is a rename, not a refactor. Do NOT change semantics, signatures, or call ordering. Do NOT remove the fallback in `resolveDocPath` — it is actively used.

## Pre-Flight

Run in order from `prism-mcp-server` repo root. STOP on any failure.

1. `git status` — verify clean worktree on `main`.
2. `git pull origin main` — sync. Starting HEAD should be `510a8de` or later.
3. `git log --oneline -3` — capture starting HEAD (report in final summary).
4. `npm install` — confirm deps intact.
5. `npm test` — baseline must be **533 passing, 0 failing** (post-S41-C1). If not, STOP and report counts.
6. `grep -rn "LEGACY_LIVING_DOCUMENTS" src/ tests/` — record every occurrence. Expected locations (verify with your grep; do not trust this list blindly):
   - `src/config.ts` — the `export const` declaration
   - `src/tools/finalize.ts` — import + usages (auditPhase, DRAFT_RELEVANT_DOCS)
   - `src/ai/synthesize.ts` — import + usage (docsToFetch)
   - potentially others
   Report the full list before making edits.

## Changes

### Change 1 — `src/config.ts`

Rename the export and rewrite its JSDoc:

Old:
```ts
/** @deprecated Legacy paths (pre-D-67 consolidation) for backward compatibility.
 *  Used by resolveDocPath() to find files in repos not yet migrated.
 *  REMOVE after all repos confirmed migrated to .prism/ structure.
 *  Prefer resolveDocFilesOptimized() which auto-detects .prism/ vs root. */
export const LEGACY_LIVING_DOCUMENTS = [
  "handoff.md",
  ...
] as const;
```

New:
```ts
/** Canonical list of living-document filenames WITHOUT the DOC_ROOT prefix.
 *  Consumed by resolveDocPath(), resolveDocFiles(), and
 *  resolveDocFilesOptimized() — all of which prepend `.prism/` internally.
 *  Distinct from LIVING_DOCUMENTS (which is the prefixed form used when
 *  calling GitHub APIs directly without the resolver). Keep both in sync
 *  when adding or removing a living document. */
export const LIVING_DOCUMENT_NAMES = [
  "handoff.md",
  "decisions/_INDEX.md",
  "session-log.md",
  "task-queue.md",
  "eliminated.md",
  "architecture.md",
  "glossary.md",
  "known-issues.md",
  "insights.md",
  "intelligence-brief.md",
] as const;
```

Do NOT also keep a re-export under the old name (breaks the "no stale name" goal). Any broken reference in the rest of the codebase is intended — Change 3 fixes them.

### Change 2 — `src/utils/doc-resolver.ts`

Rewrite the top-of-file doc comment and the affected function comments to reflect actual purpose. Exact edits:

(a) File header — replace the existing top-of-file block:

Old:
```ts
/**
 * doc-resolver — Backward-compatible document path resolution (D-67).
 * Tries .prism/ path first, falls back to legacy root path.
 * REMOVE fallback after all repos confirmed migrated.
 */
```

New:
```ts
/**
 * doc-resolver — Document path resolution with `.prism/`-first, root-fallback.
 *
 * Prefers `.prism/{docName}`; falls back to `{docName}` at repo root. The
 * fallback serves two purposes: (1) belt-and-suspenders safety for any repo
 * whose living docs are still at the root level, and (2) explicit support for
 * arbitrary non-living-doc paths (e.g. `reports/*.md`, `briefs/*.md`) passed
 * through prism_fetch — those files legitimately live at the root and rely on
 * the fallback to resolve. Do NOT remove the fallback without first replacing
 * (2) with an explicit "arbitrary-path" code path.
 */
```

(b) `resolveDocPath` function JSDoc — remove any wording that frames the fallback as legacy-only. Update the existing docstring. Use minimal edits to keep the diff scoped.

### Change 3 — all usages

Replace every `LEGACY_LIVING_DOCUMENTS` with `LIVING_DOCUMENT_NAMES` across `src/` and `tests/`. This includes:
- import statements (`import { LEGACY_LIVING_DOCUMENTS, ... } from "../config.js"`)
- variable references (`[...LEGACY_LIVING_DOCUMENTS]`, `LEGACY_LIVING_DOCUMENTS.filter(...)`, etc.)
- any type references (e.g., `typeof LEGACY_LIVING_DOCUMENTS`)
- any test assertions that include the string `"LEGACY_LIVING_DOCUMENTS"` as a source-grep target

Do NOT change the array contents. Do NOT change the order of imports. Do NOT change any function signatures.

### Change 4 — no new tests

This brief is a rename. Do NOT add tests. Do NOT add or remove any test files. The existing test suite should pass with exactly the same count after the rename.

## Verification

Stop on first failure. Do NOT proceed to Finishing Up if any step fails.

1. `npm run build` — zero TypeScript errors.
2. `npm test` — count must be **exactly 533 passing, 0 failing** (same as Pre-Flight baseline). Any deviation → STOP and report.
3. `grep -rn "LEGACY_LIVING_DOCUMENTS" src/ tests/` — must show **zero hits**. Old name must be fully gone.
4. `grep -rn "LIVING_DOCUMENT_NAMES" src/ tests/` — must show at least as many hits as the Pre-Flight step 6 count (each old reference replaced).
5. `grep -n "LIVING_DOCUMENT_NAMES" src/config.ts` — must show exactly 1 hit (the export declaration).
6. `grep -c "LIVING_DOCUMENTS" src/config.ts` — must show at least 1 hit (the pre-existing prefixed form stays; this is a safety check that you didn't accidentally rename BOTH constants). The count should match the pre-change count exactly — record it before editing if uncertain.
7. `grep -n "REMOVE after" src/utils/doc-resolver.ts` — must show **zero hits**. The stale "REMOVE after migrated" comment must be gone.
8. `grep -n "REMOVE after" src/config.ts` — must show **zero hits**. Same stale-comment cleanup.
9. `git diff --stat origin/main` — report the summary; should touch `src/config.ts`, `src/utils/doc-resolver.ts`, `src/tools/finalize.ts`, `src/ai/synthesize.ts`, and possibly test files. Should NOT touch any file outside that set without a strong reason (report if it does).

## Finishing Up

Exactly one push directive (INS-20). After all verification passes, run this chained command from `prism-mcp-server` repo root:

```
npm test && npm run build && git add -A && git commit -m "chore: rename LEGACY_LIVING_DOCUMENTS to LIVING_DOCUMENT_NAMES (S41 Phase 4 scope-clarified)" && git push origin main && git log --oneline -3 origin/main
```

Report:
- Starting HEAD SHA
- Final commit SHA on origin/main
- Test count (must still be 533)
- Number of files changed
- Total CC runtime

Do NOT reconnect MCP, restart conversation, or verify post-deploy — those are operator steps (INS-10/INS-11).

<!-- EOF: s41-legacy-rename.md -->
