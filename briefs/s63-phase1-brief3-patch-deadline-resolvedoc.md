# Phase 1 Brief 3 — patch.ts deadline + resolveDocPath fix

> Independent quick win per Verdict C / D-154. Reduced scope from original audit prescription because Brief 1's safeMutation migration of patch.ts (PR #12 merged at `59265336c`) already closed the stale-content-on-retry vulnerability and provides a `deadlineMs` parameter — so this brief becomes "wire up the deadline" + "differentiate resolveDocPath operational errors." Estimated scope: ~20 lines source + 3-4 tests.

You are implementing Phase 1 Brief 3. Two tightly scoped changes to `src/tools/patch.ts` plus one env-var definition in `src/config.ts`.

## Local Execution Workflow

You are running locally with full Bash access. Execute end-to-end:

1. Create a feature branch from main: `git checkout -b feat/patch-deadline-resolvedoc-brief3`.
2. Complete Pre-Flight reads below.
3. Implement Scope changes 1 and 2.
4. Run Verification battery.
5. Commit: `feat: patch.ts wall-clock deadline + resolveDocPath error classification (Phase 1 Brief 3)`.
6. Push: `git push -u origin feat/patch-deadline-resolvedoc-brief3`.
7. Open PR via `gh pr create` against `main`. Title: `feat: patch.ts wall-clock deadline + resolveDocPath error classification (Phase 1 Brief 3)`. Body must include: actual grep counts + behavior changes + test summary.
8. Do NOT merge. Operator merges after review.

## Authoritative Design Document

Read `audits/s62-phase1-root-pattern-audit.md` HEAD, specifically the section titled `patch.ts deadline/timeout + resolveDocPath silent fallback` (around line 186) and the `Brief 3` prescription section (around line 436). Treat as authoritative.

The audit's NOTE in the Brief 3 section is the key scope-reduction signal: stale-content-on-retry is closed by Brief 1; deadline is reduced to passing a parameter; only resolveDocPath differentiation is genuinely new code.

## Pre-Flight (read-only, before any edit)

1. `audits/s62-phase1-root-pattern-audit.md` — read the patch.ts section and Brief 3 prescription.
2. `src/tools/patch.ts` — entire file (~244 lines as of merge commit `59265336c`). The relevant blocks: resolveDocPath try/catch around lines 79-86 (bare catch is the bug); safeMutation call around lines 98-141 (no deadlineMs yet).
3. `src/config.ts` — confirm `PUSH_WALL_CLOCK_DEADLINE_MS` and `FINALIZE_COMMIT_DEADLINE_MS` exist as references for the pattern. Mirror that pattern exactly for `PATCH_WALL_CLOCK_DEADLINE_MS`.
4. `src/utils/safe-mutation.ts` — confirm the `deadlineMs` option and `DEADLINE_EXCEEDED` diagnostic semantics. Already verified live during PR #12 review; this is just for line-level reference.
5. `src/utils/doc-resolver.ts` (or wherever `resolveDocPath` is defined) — read it to understand what kinds of errors it throws. Specifically: does it throw a typed error for "not found", or does it always throw generic Error? The fix's classification logic depends on this.
6. `tests/patch*.test.ts` — understand test conventions for patch tool tests.

## Scope (single PR — exactly what is in scope)

### Change 1: Define `PATCH_WALL_CLOCK_DEADLINE_MS` env var in `src/config.ts`

Mirror the pattern from `PUSH_WALL_CLOCK_DEADLINE_MS` (and `FINALIZE_COMMIT_DEADLINE_MS`, and `CC_DISPATCH_SYNC_TIMEOUT_MS`). Add the constant:

- Read from `process.env.PATCH_WALL_CLOCK_DEADLINE_MS`
- Default = `60_000` (60 seconds)
- Parse as integer with the `parseInt(... ?? "...", 10) || default` pattern used by sibling constants
- JSDoc explaining it's the per-call wall-clock budget for `prism_patch`, why 60s default (covers fetch + N applyPatch + integrity validate + atomic commit), and that exceeding it causes `safeMutation` to return `{ ok: false, code: "DEADLINE_EXCEEDED" }`

### Change 2: Wire the deadline into the existing safeMutation call in `src/tools/patch.ts`

In the existing `safeMutation({ ... })` invocation (around lines 98-141), add the `deadlineMs` field:

```typescript
const safeMutationResult = await safeMutation({
  repo: project_slug,
  commitMessage: `prism: patch ${resolvedPath} (${patches.length} ops)`,
  readPaths: [resolvedPath],
  diagnostics,
  deadlineMs: PATCH_WALL_CLOCK_DEADLINE_MS,  // <-- ADD THIS
  computeMutation: (files) => { ... },
});
```

Update the import at the top of patch.ts to pull `PATCH_WALL_CLOCK_DEADLINE_MS` from `../config.js`.

### Change 3: Differentiate operational errors in resolveDocPath catch

The current bare catch (lines 80-86 approx):

```typescript
let resolvedPath: string;
try {
  const resolved = await resolveDocPath(project_slug, baseName);
  resolvedPath = resolved.path;
} catch {
  // Not a living doc or doesn't exist at either location — use original path
  resolvedPath = file;
}
```

Replace with classification logic. Required behavior:

(a) Capture the error: `} catch (err) {`.
(b) Inspect the error to decide if it's "genuinely not found / not a living doc" (the legitimate fallback case) or an operational error (5xx, timeout, rate limit, network).
(c) On "not found": preserve current behavior — silent fallback to original path. No diagnostic emission (this is the documented use case for resolveDocPath returning "didn't match anything").
(d) On operational error: emit `PATCH_RESOLVE_FAILED` diagnostic with the error message and original path in the detail object: `{ original: file, error: <message> }`. Then either:
   - **Option A (preferred):** still fall back to the original path, but with the diagnostic now visible to the operator. This preserves the tool's operational continuity — the patch may still succeed against the original path, and even if it doesn't, the operator now knows resolution failed.
   - **Option B:** abort the patch with a clear error response. Choose this if the resolveDocPath module's contract is that the path MUST resolve correctly for safety.

Pick the option after reading `doc-resolver.ts` and understanding what error shapes it throws. Document the choice in the PR body.

The "not found" detection should match resolveDocPath's actual error semantics — read the module to determine the correct match. If resolveDocPath throws a typed error like `DocNotFoundError` or sets a `.code` property, use that. If it throws generic Error with a message like `"not found"`, message-substring match (similar to fetch.ts's `Not found` pattern). Avoid heuristics that could misclassify operational errors as "not found."

The existing `PATCH_REDIRECTED` diagnostic emission must be preserved. The existing comment ("// Not a living doc or doesn't exist...") may stay or be updated to describe the new classification.

### Out of scope

- No changes to safeMutation primitive or `src/utils/safe-mutation.ts`.
- No changes to `resolveDocPath` itself in `src/utils/doc-resolver.ts`.
- No changes to other tools that call `resolveDocPath`.
- No new retry logic for resolveDocPath operational errors — `fetchWithRetry` covers transient errors at the HTTP-client layer.

## Tests (mandatory)

Add at least these scenarios. Place tests near existing patch tests (likely `tests/patch*.test.ts` or `tests/patch-integration.test.ts`):

1. **Genuine "not found" still falls back silently.** Mock `resolveDocPath` to throw the not-found error shape. Run a patch against a non-living-doc path. Assert: tool proceeds with original path, no `PATCH_RESOLVE_FAILED` diagnostic, no `PATCH_REDIRECTED` diagnostic (since path didn't change). The patch attempt against the original path may succeed or 404 — that's not what we're asserting; we're asserting the diagnostic shape.

2. **Operational error emits PATCH_RESOLVE_FAILED.** Mock `resolveDocPath` to throw a 5xx-class error (e.g., `new Error("HTTP 503: Service Unavailable")`). Run a patch. Assert: diagnostics array contains `PATCH_RESOLVE_FAILED` with the error message and original path in the detail. Behavior follows whichever option (A or B) was chosen — assert accordingly.

3. **Deadline exceeded surfaces as DEADLINE_EXCEEDED.** Mock `safeMutation` (or its underlying primitives — `fetchFile`, `createAtomicCommit`) to take longer than the deadline. Set `PATCH_WALL_CLOCK_DEADLINE_MS` to a small value via env-var manipulation (use Vitest's `vi.resetModules()` + env setup pattern, similar to the cc_dispatch sync-timeout tests). Assert: response contains `DEADLINE_EXCEEDED` code and the diagnostic is emitted.

4. **Default deadline value test.** When `PATCH_WALL_CLOCK_DEADLINE_MS` is unset, assert the constant equals 60000.

Per INS-30: any grep count assertions in this brief should be computed from post-edit code.

## Verification (must pass before opening PR)

1. `npm run build` — clean.
2. `npm test` — all tests pass (existing + new). The pre-existing `cc-status.test.ts > lists recent dispatches` failure is acceptable (same env-stub bug as PR #12).
3. `grep -c "PATCH_WALL_CLOCK_DEADLINE_MS" src/config.ts` — must be at least 1 (the definition).
4. `grep -c "PATCH_WALL_CLOCK_DEADLINE_MS" src/tools/patch.ts` — must be at least 2 (the import + the safeMutation usage).
5. `grep -c "PATCH_RESOLVE_FAILED" src/tools/patch.ts` — must be at least 1 (the diagnostic emission).
6. `grep -c "deadlineMs" src/tools/patch.ts` — must be at least 1 (the safeMutation option).
7. `grep -n "} catch {" src/tools/patch.ts` — should return ZERO matches in the resolveDocPath block (must be `} catch (err) {` or similar). May still return matches elsewhere; what matters is the resolveDocPath catch is no longer bare.

State the actual count for each grep above in the PR body.

## Hard Constraints

- Single PR. One feature branch.
- The default `PATCH_WALL_CLOCK_DEADLINE_MS` must be 60000 (60s). Mirror the env-var parse pattern from sibling constants exactly.
- "Not found" must continue to fall back silently — do not emit a diagnostic for the legitimate use case.
- Operational errors must NOT silently fall back unannotated — that's the bug.
- No changes to safeMutation or doc-resolver source files.
- Per INS-20: PR opened, NOT merged.
- Per INS-29: behavioral claims about runtime semantics backed by passing tests.
- Per INS-39 / INS-40: read doc-resolver.ts before deciding how to classify "not found" — do not infer the error shape.

## Completion Criteria

- All three changes implemented per spec.
- Tests pass: `npm test`. Build clean: `npm run build`.
- All grep verification counts pass with actual values stated in PR body.
- PR opened against `main`, titled `feat: patch.ts wall-clock deadline + resolveDocPath error classification (Phase 1 Brief 3)`.
- PR body documents: (a) audit deviations and rationale (if any), (b) actual grep verification counts, (c) explicit list of behaviors that changed, (d) which option (A or B) was chosen for resolveDocPath operational-error handling, with rationale citing doc-resolver.ts's contract.
- PR not merged.

## Notes

This is the smallest brief in the Phase 1 sequence. Most of the structural work was done by Brief 1 (safeMutation migration of patch.ts mutation portion). Brief 3 is purely "wire up what Brief 1 enabled" + "fix the one remaining error-classification bug." Estimated complete scope: ~20-30 lines source + ~80-150 lines test.

If during implementation you discover that resolveDocPath has a richer error-shape than message-substring-based ("not found") detection — e.g., it throws a typed error or sets `.code` — prefer the structural detection and note the choice in the PR body. Avoid heuristics that could misclassify.
