# Phase 1 Brief 2 — fetch.ts non-404 error classification

> Independent quick win per Verdict C / D-154. Read-only tool, pure diagnostic fix — no atomic semantics needed. Estimated scope: ~20 lines + 2-3 tests. Authored S63 against `main` post Brief 1 merge (commit `59265336c`).

You are implementing Phase 1 Brief 2. The fix differentiates GitHub operational failures (5xx, timeout, rate limit, network errors) from genuine 404 file-not-found results in `prism_fetch`, and emits a distinct diagnostic code for the operational class.

## Local Execution Workflow

You are running locally with full Bash access. Execute end-to-end:

1. Create a feature branch from main: `git checkout -b feat/fetch-error-classification-brief2`.
2. Complete Pre-Flight reads below.
3. Implement Scope changes.
4. Run Verification battery.
5. Commit: `feat: differentiate fetch.ts operational errors from FILE_NOT_FOUND (Phase 1 Brief 2)`.
6. Push: `git push -u origin feat/fetch-error-classification-brief2`.
7. Open PR via `gh pr create` against `main`. Title: `feat: differentiate fetch.ts operational errors from FILE_NOT_FOUND (Phase 1 Brief 2)`. Body: actual grep counts + behavior changes + test summary.
8. Do NOT merge. Operator merges after review.

## Authoritative Design Document

Read `audits/s62-phase1-root-pattern-audit.md` HEAD, specifically the `fetch.ts non-404 error classification` section (search for that heading). Treat its prescription as authoritative.

## Pre-Flight (read-only, before any edit)

1. `audits/s62-phase1-root-pattern-audit.md` — read the fetch.ts section in full.
2. `src/tools/fetch.ts` — read the entire file (~189 lines as of base commit).
3. `src/utils/diagnostics.ts` — confirm DiagnosticsCollector accepts free-form codes (already verified in PR #12 — no allowlist enforcement).
4. `tests/fetch*.test.ts` (any existing fetch tests) — understand test conventions.
5. `src/github/client.ts` — note `fetchFile` and how it surfaces non-404 errors (timeout sentinel pattern, status codes, error messages).

## Scope (single PR — exactly what is in scope)

### Change 1: Differentiate operational errors from FILE_NOT_FOUND in result mapping

In `src/tools/fetch.ts`, the inner try/catch (currently lines ~88-95) already correctly differentiates 404 from other errors and re-throws non-404. The bug is downstream: the result mapping (currently lines ~140-149) collapses ALL `Promise.allSettled` rejected outcomes into the same `exists: false` shape, and the diagnostic emission (currently lines ~152-155) emits `FILE_NOT_FOUND` for all `!exists` results.

Required changes:

(a) When mapping a `rejected` outcome from `Promise.allSettled`, distinguish it from `fulfilled-but-not-found`. Capture the error message (or a sanitized form). Suggested shape: add a property like `fetch_error: string | null` to the result object. Genuine 404 keeps `exists: false, fetch_error: null`. Operational error gets `exists: false, fetch_error: <message>`.

(b) In the diagnostic loop, branch on `fetch_error`:
- If `fetch_error === null` and `!exists`: emit `FILE_NOT_FOUND` as today (genuine 404).
- If `fetch_error !== null`: emit a NEW code `FILE_FETCH_ERROR` with the error message in the diagnostic detail object (`{ path: fr.path, error: fr.fetch_error }`).

(c) Preserve `FILE_NOT_FOUND` semantics for genuine 404 — existing callers and tests that check for `FILE_NOT_FOUND` against missing files must continue to pass.

(d) The user-facing response shape for prism_fetch should also surface the operational vs 404 distinction. If the existing response type already has a place for error info per file, populate it. If not, add a minimal `fetch_error?: string | null` field to the per-file result object. Keep the change additive — do not break existing consumers.

### Change 2: New diagnostic code

Add `FILE_FETCH_ERROR` to the diagnostic codes used by fetch.ts. Severity: `warn` (operational failures don't crash the request — partial results may still be useful). If diagnostics.ts maintains JSDoc/inline docs of known codes for the fetch tool, add the new code there.

### Out of scope

- No changes to `fetchFile` in `src/github/client.ts` — the inner try/catch already classifies correctly.
- No retry logic for operational errors — that's `fetchWithRetry`'s job, already in place.
- No changes to other tools that use `fetchFile` — they have their own handling.

## Tests (mandatory)

Add at least these scenarios to `tests/fetch.test.ts` (or follow project naming convention):

1. **Genuine 404 still emits FILE_NOT_FOUND, not FILE_FETCH_ERROR.** Mock `fetchFile` to throw an error with message containing "Not found" for one path and succeed for another. Assert: response has `exists: false, fetch_error: null` for the missing path; diagnostics array contains `FILE_NOT_FOUND` for it; does NOT contain `FILE_FETCH_ERROR` for it.

2. **5xx error emits FILE_FETCH_ERROR with the error message.** Mock `fetchFile` to throw an error like `new Error("HTTP 503: Service Unavailable")`. Assert: response has `exists: false, fetch_error: "HTTP 503: Service Unavailable"` (or whatever the chosen field name is); diagnostics array contains `FILE_FETCH_ERROR` with the path and error message in the detail object.

3. **Mixed batch — one missing, one operational error, one success.** Mock three `fetchFile` calls to: throw "Not found", throw "HTTP 500", and succeed. Assert: response has the three results in order, `FILE_NOT_FOUND` emitted for the first, `FILE_FETCH_ERROR` for the second, no diagnostic for the third. The successful fetch's content is intact.

Per INS-31: HTTP-routing assertions where applicable. Per INS-30: any grep verification counts in the brief should be computed from the post-edit code.

## Verification (must pass before opening PR)

1. `npm run build` — clean, no TypeScript errors.
2. `npm test` — all tests pass (existing + new). The pre-existing `cc-status.test.ts > lists recent dispatches` failure is acceptable per Brief 1 PR — verify it's the same `test-owner/prism-dispatch-state` env-stub bug, not a new failure.
3. `grep -c "FILE_FETCH_ERROR" src/tools/fetch.ts` — must be at least 1 (the emission).
4. `grep -c "FILE_NOT_FOUND" src/tools/fetch.ts` — must be at least 1 (preserved emission for genuine 404).
5. `grep -c "fetch_error" src/tools/fetch.ts` — must be at least 2 (the field initialization for both genuine-404 path and operational-error path, plus the conditional check).
6. State the actual count for each grep above in the PR body.

## Hard Constraints

- Single PR. One feature branch.
- Genuine 404 path must continue emitting `FILE_NOT_FOUND` — do not regress existing callers.
- Operational errors must NOT be classified as `FILE_NOT_FOUND` — that's the bug being fixed.
- No changes to `fetchFile` in client.ts.
- No retry logic added in fetch.ts — `fetchWithRetry` already covers transient errors at the GitHub-client layer.
- Per INS-20: PR opened, NOT merged.
- Per INS-29: behavioral claims about runtime semantics backed by passing tests.

## Completion Criteria

- Both changes implemented per spec above.
- Tests pass: `npm test`. Build clean: `npm run build`.
- All grep verification counts pass with actual values stated in PR body.
- PR opened against `main`, titled `feat: differentiate fetch.ts operational errors from FILE_NOT_FOUND (Phase 1 Brief 2)`.
- PR body documents: (a) audit deviations and rationale (if any), (b) actual grep verification counts, (c) explicit list of behaviors that changed (FILE_FETCH_ERROR for operational errors, FILE_NOT_FOUND preserved for genuine 404, fetch_error field in per-file response).
- PR not merged.

## Notes

This brief is much smaller than Brief 1 (one file edit, one new diagnostic code, three tests). Estimated complete scope: ~20-40 lines source + ~50-100 lines test. Should fit comfortably in any reasonable agent budget.

If during implementation you discover the audit's diagnosis is wrong about current behavior (e.g., `fetch.ts` has been modified post-Brief-1 in ways that change the classification), STOP, document the divergence, and re-scope before continuing. Do not silently expand scope.
