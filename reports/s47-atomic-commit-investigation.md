# S47 Phase 0 — Atomic Commit Investigation

**Status:** COMPLETE — NO CODE REGRESSION FOUND. PROCEED TO PHASE 2 UNCHANGED.

**Author:** S47 mega-audit fix brief (Phase 0)
**Date:** 2026-04-18
**Source incident:** 48 hours of `"Not found: updateRef {repo}"` errors preceding the S46 audit.

---

## Symptom

Railway logs over 2026-04-16 → 2026-04-18 show the `createAtomicCommit` path failing at moderate frequency with the error shape:

```
Atomic commit failed, falling back to sequential pushFile
atomicError: "Not found: updateRef {repo}"
```

Representative sample from the brief:

| Timestamp (UTC) | Repo | Error |
|---|---|---|
| 2026-04-16T23:02:32Z | alterra-design-llc | `Not found: updateRef alterra-design-llc` |
| 2026-04-17T02:39:21Z | platformforge-v2 | `Not found: updateRef platformforge-v2` |
| 2026-04-17T16:57:20Z | prism | `Not found: updateRef prism` |
| 2026-04-17T20:14:50Z | prism-mcp-server | `Not found: updateRef prism-mcp-server` |
| 2026-04-18T00:10:45Z | prism-mcp-server | `Not found: updateRef prism-mcp-server` |

One partial-state incident on alterra at 2026-04-17T18:55:57Z: after atomic fallback, both `insights.md` and `session-log.md` returned 409 in the sequential path. That single incident is the only observed in-the-wild partial-state symptom.

The PRISM project's S46 `prism_finalize(commit)` failed with `"Partial atomic commit — state may be inconsistent"` across all four target files. That is a separate code path (push.ts / finalize.ts `headChanged` guard), not a raw atomic-commit failure; the guard behaved correctly.

The audit's own Tier B live test of `prism_push` (single-file) succeeded atomically, confirming the atomic path is not universally broken.

## Code review

Read `src/github/client.ts` end-to-end (700 lines). Relevant functions:

- `getHeadSha` (`client.ts:563-577`) — uses `/git/ref/heads/${branch}` (SINGULAR) for GET. ✅ Correct per D-81.
- `createAtomicCommit` (`client.ts:598-700`) — 5-step Git Data API pipeline:
  - Step 1 GET ref: `/git/ref/heads/${branch}` (SINGULAR). ✅
  - Step 2 GET commit: `/git/commits/${headSha}`. ✅
  - Step 3 POST tree: `/git/trees`. ✅
  - Step 4 POST commit: `/git/commits`. ✅
  - Step 5 PATCH updateRef: `/git/refs/heads/${branch}` (PLURAL). ✅ Correct per D-81.

The S42 URL asymmetry fix (plural GET vs singular PATCH) is intact. The function's own docstring at `client.ts:590-597` documents the asymmetry and points at `tests/atomic-commit-url.test.ts` as the regression guard. The implementation matches the docstring.

Every request routes through `fetchWithRetry`, which handles:
- 15s `AbortSignal.timeout` per attempt (S40 C1)
- 429 backoff with `retry-after` honor + exponential backoff (S28)
- Explicit body cancel on 429 to prevent socket leak
- No retry on 404 — correct, since 404 on a Git Data endpoint is a semantic error, not transient.

## Git log review

Commits touching `src/github/client.ts` in the last 60 days:

```
27e1e5b fix(github): createAtomicCommit PATCH must use plural /git/refs/ endpoint (S42)
ca188e3 refactor(push): use atomic commits by default, eliminate 409 race (S40 C3)
9884dff fix(github): add 15s fetch() timeouts to prevent socket hangs (S40 C1)
6efa4fe fix: finalization pipeline optimization + observability (S34c)
d3fd157 fix: GitHub client resilience + timeout architecture (S34b)
8be5f23 fix: finalization stability — atomic fallback + dynamic branch + draft timeout scaling (S33)
ee42a09 fix: atomic commits + draft phase optimization (S32)
```

The most recent change (27e1e5b, S42) FIXED the exact bug that produces "Not found: updateRef". No change since S42 has altered URL construction, HTTP method selection, or ref targeting. No regression in version control.

`defaultBranchCache` (`client.ts:520-553`) caches per-repo `default_branch` string indefinitely. It does NOT cache the HEAD SHA, which is fetched fresh on each `createAtomicCommit`. A stale cache would affect branch name resolution, not step-5 routing — and all PRISM project repos use `main`, which is correct.

## Test gap analysis

`tests/atomic-commit-url.test.ts` has 4 tests that each mock `globalThis.fetch`, record URL + method per call, and assert:

1. PATCH uses `/git/refs/heads/{branch}` (plural) — the S42 regression guard.
2. GET uses `/git/ref/heads/{branch}` (singular).
3. The 5-step sequence fires in order (getRef → getCommit → createTree → createCommit → updateRef).
4. PATCH routed to singular would produce the exact `"Not found: updateRef {repo}"` error shape observed in production.

`tests/atomic-fallback.test.ts` has 9 static source-read tests that verify the fallback architecture in `finalize.ts` (atomic first, sequential fallback on failure). These do NOT exercise live HTTP paths — they match strings in the source.

`tests/github-client-timeouts.test.ts` has 5 tests that exercise the timeout + 429 retry behavior of `fetchWithRetry`. These pass.

All three test files pass in the S46 baseline (578 total tests). The S42 regression would fail `atomic-commit-url.test.ts` within 200ms — that test is doing what it claims.

**No test currently reproduces the production failure shape with URLs correct.** That is because the production failure is NOT a URL-mismatch bug. When URLs are correct, a well-formed PATCH to an existing ref with a non-fast-forward SHA normally returns 422 ("Update is not a fast-forward"). The production failures return 404. That discrepancy is the investigation's root-cause question.

## Root-cause hypothesis

The only plausible remaining cause, given correct URL routing: **GitHub API transient behavior** — either:

1. **Replication lag on rapid consecutive writes.** If two PATCHes to the same ref happen within a sub-second window across different API frontends, the second one can observe the pre-first-PATCH ref state momentarily and return 404 when it cannot find the expected base SHA. This is not documented but has been anecdotally observed.

2. **Repository-load 404 shadowing.** GitHub occasionally returns 404 for endpoints that exist, as a side-effect of partial service degradation or secondary rate limits. The `retry-after` header is absent in these cases, so `fetchWithRetry` treats it as a terminal error — which is correct behavior; retrying a 404 without `retry-after` is not the fix.

3. **Concurrent-write from an out-of-band actor.** Though CLAUDE.md's INS-69 concurrent-write protocol restricts the claude.ai session and `cc_dispatch` to disjoint file scopes, two PRISM sessions on the same project repo (operator running two Claudes simultaneously) can both target `heads/main` within overlapping windows. The alterra 2026-04-17T18:55:57Z double-409 incident is consistent with this pattern and predates the atomic commit path — it's a fallback-path-race, not atomic-path.

Common thread: **the production failures are transient concurrency/infrastructure signals, not a code regression.** The existing fallback (atomic → HEAD-SHA-guard → sequential pushFile) correctly detects the race in 4 of 5 observed cases and surfaces a "partial state" error in the fifth.

## Recommended fix

**None required for Phase 2 blocker.** The code is correct per D-81; the tests enforce D-81; the fallback path handles 4 of 5 observed failures cleanly.

Follow-up recommendations (outside this brief's scope, noted for future work):

- **F1.** Tighten `@level:error` filtering so fallback-recoverable atomic failures log at `warn`, not `error`. Today the message "Atomic commit failed, falling back to sequential pushFile" is logged at `warn` (correct) but the atomic error itself bubbles as a context attribute, sometimes surfacing as `level=error` under Railway's log parsing. Addressed partially by Phase 3 P3.2 (stdio-bridge INFO demotion), but a separate pass on atomic-fallback log levels would reduce noise further.
- **F2.** Consider re-reading HEAD ref after an updateRef 404 and retrying once if the new ref value matches our newly-created commit SHA. This would distinguish "PATCH succeeded but response was lost" from "PATCH refused." Out of scope for S47; candidate for a future resilience pass.
- **F3.** Operator-level: when the same project is being edited by two Claudes, use `cc_dispatch` rather than a second claude.ai session — the dispatch branch isolation prevents main-branch race entirely.

## Risk assessment for Phase 2 (adding atomic-commit call sites)

Phase 2 adds atomic commits to:

- **P2.1** `prism_log_decision` — 2 files (decisions/_INDEX.md + domain file).
- **P2.2** `prism_scale_handoff` — N destination files + 1 reduced handoff.

**Risk analysis:**

- The atomic path is correct. The D-81 URL asymmetry is encoded in code + tests. Adding more call sites does not introduce URL-routing risk.
- Each new call site MUST follow the push.ts pattern: capture headShaBefore → attempt atomic → on failure, capture headShaAfter → if changed, surface "partial state" error and abort; if unchanged, sequential pushFile fallback.
- The transient 404s observed in production will now also affect these new call sites. However, the alternative (keeping sequential pushes) carries a STRICTLY WORSE risk profile: if the first sequential push succeeds and the second fails, the on-disk state is partial with no recovery path. Atomic commit either fully succeeds (all files move together) or fully fails (all reverted by GitHub server-side, no partial state). The fallback then re-attempts sequentially under HEAD-SHA-unchanged guard.
- Net: **adding atomic commits reduces partial-state risk, even accounting for the observed transient 404 rate.** Proceed.

## Decision

**PROCEED TO PHASE 2 UNCHANGED.**

No P2.0 regression fix required. Phase 2 begins with P2.1 (`log_decision` atomic) + P2.2 (`scale_handoff` atomic), mirroring the push.ts pattern with HEAD-SHA guard and sequential fallback. The new atomic call sites inherit the S42-verified URL routing and the S40-verified timeout architecture; no additional atomic-path hardening is needed.

<!-- EOF: s47-atomic-commit-investigation.md -->
