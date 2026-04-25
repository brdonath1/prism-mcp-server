# Phase 1 Brief 1.5 — push.ts + finalize.ts commit-step full migration to safeMutation

> Originated as cc_dispatch `cc-1777154571699-69b87b3a` on 2026-04-25 22:02 UTC; pivoted to local CC mid-flight per the operator's standing preference for visibility. The async dispatch may still complete in parallel; if so, its branch and wrapper PR will be cleaned up unmerged after this local PR lands.

## Context

S62's Phase 1 audit (Verdict C, D-154) identified six call sites with manual atomic-commit-with-fallback machinery. Brief 1 (PR #12, squash `59265336c`, merged S63) introduced the `safeMutation` primitive in `src/utils/safe-mutation.ts` and migrated four call sites: log-decision, log-insight, finalize.ts prune step, patch.ts mutation. Brief 1 also patched the null-safe HEAD-comparison fix on push.ts and finalize.ts commit step in-place — but DEFERRED the full migration of those two atomic-commit blocks.

Brief 1.5 closes that defer. After this brief lands, push.ts and finalize.ts commit step both use safeMutation as their atomic-commit primitive.

This is consistency cleanup, not a correctness fix. The null-safe behavior is already correct in both files. The motivation is one architectural primitive instead of two duplicate inline implementations.

## Local Execution Workflow

You are running locally with full Bash access. Execute end-to-end, no turn budget — pace as needed but be efficient. Step list:

1. Create a feature branch from main: `git checkout -b feat/push-finalize-safemutation-brief1.5`.
2. Complete the Pre-Flight reads below before any code edit.
3. Implement Change A (push.ts) and Change B (finalize.ts).
4. Update tests per the Test Updates section.
5. Run the full Verification battery; iterate until green.
6. Commit with a message starting `feat:` (suggestion: `feat: push.ts + finalize.ts commit-step migration to safeMutation (Phase 1 Brief 1.5)`).
7. Push the branch: `git push -u origin feat/push-finalize-safemutation-brief1.5`.
8. Open the PR with `gh pr create` against `main`. Title: `feat: push.ts + finalize.ts commit-step migration to safeMutation (Phase 1 Brief 1.5)`. Body must include the verification grep counts table (mirror PR #14's format).
9. Do NOT merge. The operator (S64) reviews and merges.

If you find scope uncertainty mid-stream, write a short note in your reasoning and continue rather than narrowing scope silently.

## Pre-Flight (read in order, do NOT skip)

1. `src/utils/safe-mutation.ts` — full file. Understand the contract: signature, return shape, retry/HEAD/deadline semantics. Pay attention to the `MUTATION_CONFLICT`, `MUTATION_RETRY_EXHAUSTED`, `HEAD_SHA_UNKNOWN`, `DEADLINE_EXCEEDED` diagnostic codes — `safeMutation` emits these itself, so the calling tools should NOT emit their own conflict diagnostics anymore.
2. `src/tools/push.ts` — full file. Migration target is the block from `// 4. Try atomic commit first` (~line 105) through the end of the if/else chain (~line 235). Note the outer `Promise.race([workPromise, deadlinePromise])` structure — that stays.
3. `src/tools/finalize.ts` — at minimum read `commitPhase` end-to-end and `registerFinalize`. The migration target is in `commitPhase`, the block labeled `// 5a. Capture HEAD SHA` through `// 5c. Atomic commit failed` and its else-branches. The prune step earlier in commitPhase ALREADY uses safeMutation — that's your in-file reference for the call shape. The `Promise.race([commitWork, commitDeadlinePromise])` in `registerFinalize` stays.
4. Look in `tests/` for files matching `push*` or `finalize*`. Identify which existing tests exercise the SEQUENTIAL-FALLBACK path (mocking `pushFile` to test the post-atomic-fail-HEAD-unchanged branch). Those tests will need updating because the sequential fallback is being removed.
5. Run `npm test 2>&1 | tail -20` to capture the pre-migration test baseline. The pre-existing `tests/cc-status.test.ts > lists recent dispatches` failure is acceptable (same env-stub bug as PR #12 / PR #13 / PR #14, S63–S64) — do not try to fix it; document it as the one pre-existing acceptable failure.

## Changes

### Change A: `src/tools/push.ts`

**Imports.** From `../github/client.js`, REMOVE `createAtomicCommit`, `getHeadSha`, and `pushFile` — all three become unused in push.ts after this change. ADD `import { safeMutation } from "../utils/safe-mutation.js";`.

**Body.** Replace the block from `// 4. Try atomic commit first` through the end of the `if (atomicResult.success) { ... } else { ... }` chain with a single `safeMutation` call:

```ts
// 4. Atomic commit via safeMutation (S64 Phase 1 Brief 1.5).
//    safeMutation handles: HEAD snapshot, atomic Git Trees commit, 409
//    retry with refreshed content, null-safe HEAD comparison. No
//    sequential pushFile fallback by design (S62 audit Verdict C).
const safeMutationResult = await safeMutation({
  repo: project_slug,
  commitMessage,
  readPaths: [],
  diagnostics,
  computeMutation: () => ({ writes: atomicFiles }),
});

let results: PushFileResult[];
if (safeMutationResult.ok) {
  results = files.map((file, idx) => ({
    path: guardResults[idx].path,
    original_path: guardResults[idx].redirected ? file.path : undefined,
    redirected: guardResults[idx].redirected,
    success: true,
    size_bytes: new TextEncoder().encode(file.content).length,
    sha: safeMutationResult.commitSha,
    verified: true,
    validation_errors: validationResults[idx].errors,
    validation_warnings: validationResults[idx].warnings,
  }));
} else {
  results = files.map((file, idx) => ({
    path: guardResults[idx].path,
    original_path: guardResults[idx].redirected ? file.path : undefined,
    redirected: guardResults[idx].redirected,
    success: false,
    size_bytes: 0,
    sha: "",
    verified: false,
    validation_errors: [
      ...validationResults[idx].errors,
      safeMutationResult.error,
    ],
    validation_warnings: validationResults[idx].warnings,
    error: safeMutationResult.error,
  }));
}
```

**Result object.** `commit_sha: safeMutationResult.ok ? safeMutationResult.commitSha : undefined`.

**Final logger.info.** Drop the `atomic: atomicResult.success` field — safeMutation's internal logs are already structured.

**Diagnostics.** Drop the `PUSH_RETRY_ON_CONFLICT` warn/error emissions in push.ts. safeMutation now emits `MUTATION_CONFLICT` (warn) and `MUTATION_RETRY_EXHAUSTED` (error) on its own. Drop the two `HEAD_SHA_UNKNOWN` diagnostic emissions in push.ts as well — safeMutation emits this code internally.

**Outer race.** Do NOT remove the `Promise.race([workPromise, deadlinePromise])` and `PUSH_DEADLINE_SENTINEL` machinery. The tool-level deadline still bounds the full tool. Do NOT pass `deadlineMs` to safeMutation.

### Change B: `src/tools/finalize.ts` `commitPhase`

**Imports.** From `../github/client.js`, REMOVE `createAtomicCommit` and `getHeadSha` — both become unused after this change (the prune step already uses safeMutation; the backup step uses `pushFile`, which stays). Verify `pushFiles` (plural — distinct from `pushFile`) is unused after the migration; if it is unused, remove it from the import too. `safeMutation` is already imported in finalize.ts (used by the prune step) — do NOT re-import.

**Body.** In `commitPhase`, replace the block from `// 5a. Capture HEAD SHA before atomic attempt for H-6 safety check` through the end of the `if (atomicResult.success) { ... } else { ... }` chain with:

```ts
// 5. Atomic commit via safeMutation (S64 Phase 1 Brief 1.5).
//    safeMutation handles: HEAD snapshot, atomic Git Trees commit, 409
//    retry with refreshed content, null-safe HEAD comparison. No
//    sequential pushFile fallback by design (S62 audit Verdict C).
const safeMutationResult = await safeMutation({
  repo: projectSlug,
  commitMessage,
  readPaths: [],
  diagnostics,
  computeMutation: () => ({ writes: guardedFiles }),
});

let results: Array<{
  path: string;
  success: boolean;
  size_bytes: number;
  verified: boolean;
  validation_errors: string[];
}>;

if (safeMutationResult.ok) {
  results = guardedFiles.map(f => ({
    path: f.path,
    success: true,
    size_bytes: new TextEncoder().encode(f.content).length,
    verified: true,
    validation_errors: [],
  }));
} else {
  warnings.push(`Atomic commit failed: ${safeMutationResult.error}`);
  results = guardedFiles.map(f => ({
    path: f.path,
    success: false,
    size_bytes: 0,
    verified: false,
    validation_errors: ["Atomic commit failed", safeMutationResult.error],
  }));
}
```

**Outer race.** Do NOT remove the `Promise.race([commitWork, commitDeadlinePromise])` and `FINALIZE_COMMIT_DEADLINE_SENTINEL` machinery in `registerFinalize`. Do NOT pass `deadlineMs` to safeMutation.

## Test Updates

Existing tests for prism_push and prism_finalize that exercise the SEQUENTIAL-FALLBACK path will need updating:

- If a test asserts that on atomic-fail + HEAD-unchanged, the tool falls back to per-file `pushFile` and returns success: that assertion is now wrong. Replace with an assertion that on atomic-fail with HEAD-unchanged, safeMutation's retry path runs (mock `createAtomicCommit` to fail once then succeed) — OR remove the test if safeMutation's own tests cover the equivalent path.
- If a test asserts that on atomic-fail + HEAD-changed, the tool refuses fallback and returns failure: that assertion is preserved. Update the mock to drive safeMutation through `MUTATION_RETRY_EXHAUSTED` (atomic always fails) rather than mocking the inline HEAD-comparison branch directly.
- If a test directly mocks `pushFile` for prism_push: those mocks become irrelevant because `pushFile` is no longer called from push.ts. Remove the mock or convert to a `createAtomicCommit` mock.
- For prism_finalize commit-phase tests: `pushFile` is still called by the BACKUP step, so a `pushFile` mock there may still be relevant — but the commit-itself path no longer uses `pushFile`. Be precise about which step a test is exercising.

Add NO new tests beyond what's needed to update the existing ones.

## Verification (run all and report counts in the PR body)

1. `npm run build` — must complete with no errors.
2. `npm test 2>&1 | tail -30` — relevant tests pass; only the pre-existing `cc-status.test.ts > lists recent dispatches` failure should remain (acceptable).
3. `grep -c "createAtomicCommit\|getHeadSha\|pushFile" src/tools/push.ts` — must be **0**.
4. `grep -c "createAtomicCommit\|getHeadSha" src/tools/finalize.ts` — must be **0** (`pushFile` remains for backup).
5. `grep -c "safeMutation" src/tools/push.ts` — must be **≥2** (import + call).
6. `grep -c "safeMutation" src/tools/finalize.ts` — must be **≥3** (import + prune call + commit call).
7. `grep -c "PUSH_RETRY_ON_CONFLICT" src/tools/push.ts` — must be **0**.
8. `grep -c "HEAD_SHA_UNKNOWN" src/tools/push.ts` — must be **0**.
9. `grep -c "HEAD_SHA_UNKNOWN" src/tools/finalize.ts` — must be **0**.
10. `grep -nE "[Ss]equential pushFile" src/tools/push.ts src/tools/finalize.ts` — must show no production code paths (comments referring to the removed fallback are OK; prefer removing them).

Report counts as a markdown table in the PR body, mirroring PR #14's format.

## Constraints

- Do not change `safeMutation` itself.
- Do not change `createAtomicCommit`, `getHeadSha`, or `pushFile` in `src/github/client.ts` — they're still used by other call sites and the backup step.
- Do not change the tool-level deadline machinery (the outer Promise.race in push.ts and the one in registerFinalize).
- Do not introduce a `deadlineMs` parameter to either safeMutation call — the outer races handle the wall-clock bounding.
- Do not add new diagnostic codes; safeMutation already emits the relevant ones.
