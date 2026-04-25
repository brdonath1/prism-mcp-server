# Phase 1 Brief 1 — safeMutation primitive + Verdict C cluster fixes

> Originated as cc_dispatch `cc-1777145877069-bc71279d` on 2026-04-25 19:37 UTC; the async dispatch hit the 50-turn wrapper ceiling without producing any artifacts. Re-issued as a local Claude Code brief on prism-mcp-server (S63) for real-time visibility into reasoning and turn usage.

You are implementing Phase 1 Brief 1 of the PRISM Framework Stabilization Initiative. This brief extracts a reusable atomic-mutation primitive and fixes four documented bugs across the cluster identified in `audits/s62-phase1-root-pattern-audit.md`.

## Local Execution Workflow

You are running locally with full Bash access. Execute end-to-end, no turn budget — pace as needed but be efficient. Step list:

1. Create a feature branch from main: `git checkout -b feat/safe-mutation-phase1-brief1`.
2. Complete the Pre-Flight reads below before any code edit.
3. Implement Scope changes 1 through 8 in any order that makes sense.
4. Run the full Verification battery; iterate until green.
5. Commit with message: `feat: safeMutation primitive + Verdict C cluster bug fixes (Phase 1 Brief 1)`.
6. Push the branch: `git push -u origin feat/safe-mutation-phase1-brief1`.
7. Open the PR with `gh pr create` against `main`. Title: `feat: safeMutation primitive + Verdict C cluster bug fixes (Phase 1 Brief 1)`. Body must include: (a) audit deviations and rationale (if any), (b) actual grep verification counts, (c) explicit list of behaviors that changed (no fallback in migrated tools, null-safe HEAD comparison everywhere).
8. Do NOT merge. The operator merges after review.

If you find yourself uncertain about scope mid-stream, write a short note in your reasoning and continue rather than narrowing scope silently — operator preference is visible scope decisions over silent ones.

## Authoritative Design Document

Read `audits/s62-phase1-root-pattern-audit.md` on `main` HEAD FIRST and treat it as the design document. Do NOT deviate from its scoping decisions, primitive signature, or behavioral semantics without explicit justification documented in the PR body. Any deviation must cite the specific audit section being deviated from.

## Pre-Flight (mandatory READ-ONLY before any code changes)

1. Read the full audit document at `audits/s62-phase1-root-pattern-audit.md`.
2. Read all six source files at HEAD:
   - `src/tools/finalize.ts`
   - `src/tools/log-insight.ts`
   - `src/tools/log-decision.ts`
   - `src/tools/push.ts`
   - `src/tools/patch.ts`
   - `src/tools/fetch.ts` (for context only; not modified in this brief)
3. Read supporting files:
   - `src/github/client.ts` (note: `createAtomicCommit`, `getHeadSha`, `pushFile`, `deleteFile`)
   - `src/utils/diagnostics.ts` (note: existing `DiagnosticsCollector` API and currently-defined codes)
   - Any shared deadline/sentinel utility (e.g., the pattern used in `push.ts` lines 73-76 + 296-318)
4. Read existing tests for the migrated tools to understand test conventions:
   - `tests/log-decision*.test.ts` (or equivalent)
   - `tests/log-insight*.test.ts`
   - `tests/finalize*.test.ts`
   - `tests/patch*.test.ts`
   - `tests/github-client-timeouts.test.ts` (per INS-31, the reference for HTTP-routing test pattern)

## Scope (single PR — exactly what is in scope)

### Change 1: Extend `createAtomicCommit` with delete support

In `src/github/client.ts`, modify `createAtomicCommit` to accept an optional `deletes: string[]` parameter (an array of file paths to remove in the same commit).

For each path in `deletes`, include a tree entry in the Git Trees API payload with:
- `path`: the file path
- `mode`: `"100644"`
- `type`: `"blob"`
- `sha`: `null`

This is GitHub's documented mechanism for removing files via Git Trees API. The change must be backwards-compatible: existing callers that pass no `deletes` parameter must observe identical behavior.

### Change 2: Implement `safeMutation` primitive

Create `src/utils/safe-mutation.ts` exporting a `safeMutation` function with this signature (TypeScript types):

```typescript
type SafeMutationOpts = {
  repo: string;
  commitMessage: string;
  readPaths: string[];
  computeMutation: (currentFiles: Map<string, FileContent>) => {
    writes: Array<{ path: string; content: string }>;
    deletes?: string[];
  };
  diagnostics: DiagnosticsCollector;
  maxRetries?: number;  // default 1
  deadlineMs?: number;  // optional wall-clock deadline
};

type SafeMutationResult =
  | { ok: true; commitSha: string; retried: boolean }
  | { ok: false; error: string; code: string };

async function safeMutation(opts: SafeMutationOpts): Promise<SafeMutationResult>;
```

Behavioral requirements:

1. Snapshot HEAD SHA via `getHeadSha(repo)` BEFORE reading files. Call this `headShaBefore`.
2. Read all files in `readPaths` in parallel via `fetchFile` (or equivalent). Pass the resulting `Map<path, FileContent>` to `computeMutation`.
3. Compute mutation by calling `computeMutation(currentFiles)`. The callback returns `{ writes, deletes }`.
4. Atomic commit via `createAtomicCommit(repo, writes, commitMessage, deletes)`. If it succeeds, return `{ ok: true, commitSha, retried: false }`.
5. On 409 conflict (atomic commit failed due to HEAD change):
   - If retry budget remaining (`maxRetries > 0`):
     - Snapshot `headShaAfter` via `getHeadSha(repo)`.
     - If either `headShaBefore` or `headShaAfter` is null/undefined: emit `HEAD_SHA_UNKNOWN` diagnostic and return `{ ok: false, error, code: "HEAD_SHA_UNKNOWN" }`. Do NOT retry. Do NOT fall back to sequential pushFile.
     - Emit `MUTATION_CONFLICT` diagnostic noting the retry.
     - Decrement `maxRetries`, re-read all files, re-call `computeMutation` with FRESH data, retry atomic commit.
   - If retry budget exhausted: emit `MUTATION_RETRY_EXHAUSTED` and return `{ ok: false, error, code: "MUTATION_RETRY_EXHAUSTED" }`.
6. Deadline enforcement: if `deadlineMs` provided, wrap the entire operation in `Promise.race` against a deadline timer. Mirror the sentinel pattern from `push.ts` lines 73-76 + 296-318. On deadline expiry, return `{ ok: false, error, code: "DEADLINE_EXCEEDED" }`.
7. No sequential-pushFile fallback exists in this primitive. Atomic-only. This is intentional per the audit's design.
8. Diagnostic codes emitted by this primitive: `MUTATION_CONFLICT` (warn, on retry), `MUTATION_RETRY_EXHAUSTED` (error, on final failure), `HEAD_SHA_UNKNOWN` (warn, on null SHA), `DEADLINE_EXCEEDED` (error, on deadline).

### Change 3: Migrate `src/tools/log-decision.ts`

Replace the existing primary atomic-commit + sequential-pushFile fallback (currently at lines ~183-244 per the audit; verify actual current location) with a single `safeMutation` call.

The dedup check (currently at lines ~131-174) must move INTO the `computeMutation` callback so it runs against fresh data on every retry. Specifically:

```
safeMutation({
  repo: project_slug,
  commitMessage: ...,
  readPaths: [indexResolvedPath, domainResolvedPath],
  computeMutation: (files) => {
    // Re-run dedup check using files.get(indexResolvedPath).content
    // Re-build indexContent and domainContent here
    return { writes: [{path: indexResolvedPath, content: indexContent}, {path: domainResolvedPath, content: domainContent}] };
  },
  ...
})
```

Remove the sequential-pushFile fallback entirely. The `INDEX_WRITE_FAILED` and `DOMAIN_WRITE_FAILED` diagnostic emissions in the fallback path are removed; replaced by the `MUTATION_CONFLICT` / `MUTATION_RETRY_EXHAUSTED` semantics from the primitive.

Existing emit behavior for `DEDUP_TRIGGERED` must be preserved (emit when dedup rejects a duplicate ID).

### Change 4: Migrate `src/tools/log-insight.ts`

Replace the existing fetch + mutate-in-memory + bare-pushFile pattern (currently at lines ~67-153 per the audit) with a single `safeMutation` call.

The dedup check must move INTO the `computeMutation` callback. The `STANDING_RULE_DUPLICATE_ID` emission must be preserved.

### Change 5: Migrate `src/tools/finalize.ts` prune step

Replace the parallel `Promise.allSettled` over `deleteFile` calls (currently at lines ~495-501 per the audit) with a single `safeMutation` call using the `deletes` parameter.

The `safeMutation` call has empty `readPaths` (no reads needed), and `computeMutation` returns `{ writes: [], deletes: toDelete.map(f => f.path) }`.

The outer `try/catch` that swallows errors with comment `// handoff-history may not exist or pruning failed -- non-critical` is removed. The new behavior: if pruning fails, emit `DELETE_FILE_FAILED` diagnostic and continue (non-fatal — finalize still succeeds), but the failure is now visible.

If safeMutation returns `{ ok: false }`, emit `DELETE_FILE_FAILED` diagnostic with the error details.

### Change 6: Migrate `src/tools/patch.ts` mutation portion

Replace the fetch + mutate + pushFile pattern (currently at lines ~50-105 per the audit) with a single `safeMutation` call. The patch operations themselves (the `applyPatch` calls) move INTO the `computeMutation` callback so they re-run on retry against fresh content.

This closes the bonus stale-content-on-retry vulnerability identified in the audit.

NOTE: This migration does NOT add a wall-clock deadline (Brief 3's job). It does NOT change the resolveDocPath silent fallback (also Brief 3's job). The `PATCH_REDIRECTED` and `PATCH_PARTIAL_FAILURE` diagnostic emissions must be preserved.

### Change 7: Direct null-safe fix to push.ts and finalize.ts commit step

These two files have the same buggy `getHeadSha-null = headChanged remains false` pattern but ARE NOT being fully migrated to safeMutation in this PR (deferred to Brief 1.5).

Apply a direct null-safe fix to each:

In `src/tools/push.ts` at the HEAD comparison (currently lines ~176-181 per the audit) and in `src/tools/finalize.ts` commit step (currently lines ~639-645 per the audit):

CHANGE FROM (current buggy pattern):
```
let headChanged = false;
if (headShaBefore) {
  const headShaAfter = await getHeadSha(project_slug);
  if (headShaAfter) headChanged = headShaAfter !== headShaBefore;
}
```

CHANGE TO (null-safe pattern):
```
let headChanged = true;  // default to "unknown -- refuse fallback"
if (headShaBefore) {
  const headShaAfter = await getHeadSha(project_slug);
  if (headShaAfter) {
    headChanged = headShaAfter !== headShaBefore;
  } else {
    diagnostics.warn("HEAD_SHA_UNKNOWN", "getHeadSha returned null after atomic failure -- treating as HEAD changed (refuse fallback)", { phase: "post-atomic-check" });
  }
} else {
  diagnostics.warn("HEAD_SHA_UNKNOWN", "getHeadSha returned null before atomic commit -- treating as HEAD changed (refuse fallback)", { phase: "pre-atomic-snapshot" });
}
```

This treats null as "HEAD state unknown -- refuse to fall back to sequential pushFile" per the audit's safeMutation design.

### Change 8: Add new diagnostic codes (if explicit allowlist exists)

If `DiagnosticsCollector` has an explicit allowlist or enum of valid codes, add: `MUTATION_CONFLICT`, `MUTATION_RETRY_EXHAUSTED`, `HEAD_SHA_UNKNOWN`, `DELETE_FILE_FAILED`, `DEADLINE_EXCEEDED`. If diagnostic codes are free-form strings (no allowlist), no change needed.

## Tests (mandatory)

### Unit tests for `safeMutation` primitive

Create `tests/safe-mutation.test.ts` (or follow project naming convention). Required test cases — at minimum these specific scenarios, more are welcome:

1. Atomic commit success path: mocks `getHeadSha`, `fetchFile`, `createAtomicCommit`. Verifies the call sequence and that `computeMutation` is called exactly once.
2. 409 conflict triggers re-read and recompute: mock `createAtomicCommit` to return 409 on first call and success on second. Verify that `fetchFile` is called TWICE (once originally, once on retry) and `computeMutation` is called TWICE with potentially different file contents.
3. maxRetries=0 with 409: produces `MUTATION_RETRY_EXHAUSTED` diagnostic and returns `{ ok: false }`.
4. `getHeadSha` returns undefined: emits `HEAD_SHA_UNKNOWN` and returns `{ ok: false, code: "HEAD_SHA_UNKNOWN" }`. Verify NO writes are attempted (no `createAtomicCommit` call).
5. Delete support: `computeMutation` returns `{ writes: [], deletes: ["a.md", "b.md"] }`. Verify `createAtomicCommit` is called with the deletes parameter and the Git Trees payload includes tree entries with `sha: null`.
6. Deadline enforcement: pass a small `deadlineMs`, mock operations to take longer. Verify return is `{ ok: false, code: "DEADLINE_EXCEEDED" }` and diagnostic emitted.
7. Per INS-31: HTTP-routing assertions must mock fetch and assert URL + method. The test for delete support specifically must assert the Git Trees API call includes `sha: null` in the body.

### Integration tests per migrated tool

For each migrated tool (`log-decision`, `log-insight`, `finalize.prune`, `patch.ts`):
- Existing tests should continue to pass on the success path (no behavior change for non-conflict scenarios).
- ADD at least one new test per tool that simulates a concurrent-write scenario (mock first `createAtomicCommit` call to 409, second to succeed) and verifies the tool produces correct end-state.

For the direct null-safe fixes to push.ts and finalize.ts commit step:
- ADD tests verifying that `getHeadSha` returning null causes `headChanged = true` (refuse fallback) and emits `HEAD_SHA_UNKNOWN`.

## Verification (must pass before opening PR)

1. `npm run build` — clean, no TypeScript errors.
2. `npm test` — all tests pass (existing + new).
3. `grep -c "Promise.allSettled" src/tools/finalize.ts` — count must DECREASE compared to main HEAD (the prune-step `Promise.allSettled` is removed; other uses may remain). Compute the expected count from the post-edit code.
4. `grep -c "safeMutation" src/utils/safe-mutation.ts` — must be at least 1 (the export).
5. `grep -c "safeMutation" src/tools/` (recursive) — must be at least 4 (one call per migrated tool: log-decision, log-insight, finalize, patch).
6. `grep -c "MUTATION_CONFLICT\|MUTATION_RETRY_EXHAUSTED\|HEAD_SHA_UNKNOWN" src/utils/safe-mutation.ts` — must be at least 3 (each new code emitted).
7. `grep -rn "headChanged = false" src/tools/push.ts src/tools/finalize.ts` — must return ZERO matches (the buggy default is replaced).

Per INS-30: each grep count target above must be computed against your actual post-edit code, not estimated. State the expected count in the PR body for each.

## Hard Constraints

- ONE PR. All changes in a single branch.
- NO sequential-pushFile fallback paths in migrated tools (log-decision, log-insight, patch.ts mutation portion). Atomic-only. push.ts and finalize.ts commit step KEEP their existing fallback paths in this brief — they get only the null-safety fix.
- All HEAD comparisons in migrated tools must be null-safe (null = unknown = refuse fallback).
- Test coverage MUST include both success AND conflict paths for every migrated callsite (4 tools).
- Per INS-20: PR is opened but NOT merged. Operator reviews and merges after CI passes.
- Per INS-29: behavioral claims about runtime semantics must be backed by passing tests, not source-read-only reasoning.
- Per INS-39 / INS-40: do not assert behavior of any helper without reading its current implementation.

## Completion Criteria

- All 8 changes implemented per spec above.
- All tests passing locally (`npm test`).
- Build clean (`npm run build`).
- All 7 grep verification counts pass with actual values stated in PR body.
- PR opened against `main` titled `feat: safeMutation primitive + Verdict C cluster bug fixes (Phase 1 Brief 1)`.
- PR body documents: (a) which audit deviations occurred and why (if any), (b) the actual grep verification counts, (c) explicit list of behaviors that changed (no fallback in migrated tools, null-safe HEAD comparison everywhere).
- PR is NOT merged — operator merges after review.

## Note on push.ts / finalize.ts commit step (deferred work)

The audit's brief skeleton recommends migrating push.ts and finalize.ts commit step fully to safeMutation as part of this brief. This brief intentionally scopes those down to the null-safety fix and defers full migration to a future Brief 1.5. Rationale: those two paths currently work correctly (atomic primary + sequential fallback); migrating them is consistency cleanup without bug-fix value. Risk-managed scoping per operator preference.

If during implementation you find that the null-safety fix interacts non-trivially with the existing fallback logic (e.g., the fallback assumes `headChanged = false` and changing the default breaks it), STOP and document the issue in the PR body rather than expanding scope to fix it. Brief 1.5 will resolve any such interaction.
