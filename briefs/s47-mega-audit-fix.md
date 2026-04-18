# Brief S47 — Mega Audit Follow-Up

## Metadata

- **Target repo:** `brdonath1/prism-mcp-server`
- **Source audit:** PR #3 (`audit/s46-framework-audit` → `main`, commit `99a563f`, report `reports/s46-framework-audit.md`)
- **Branch model:** main + feature branch (INS-35 — NOT staging like platformforge-v2)
- **Working branch:** `fix/s47-audit-followup` cut from `main`
- **Mode:** `cc_dispatch(execute)` or operator-run Claude Code locally (INS-7 brief-on-repo workflow)
- **Expected effort:** max; **max_turns:** 120 (this brief covers ~20 discrete code changes + multiple test suites + a root-cause investigation phase)
- **Exactly one push directive** (INS-20): `git push origin fix/s47-audit-followup` at end of Phase 4. Do not push any intermediate phase. Do not open the PR inside CC — leave that to the operator.

## Scope

This brief addresses every actionable A-finding and X-finding from the S46 audit report, PLUS one new finding surfaced during S47 session planning that the audit missed. Out of scope and explicitly deferred:

- **B-1** (alterra-design-llc session-log prose-pattern scrub) — different repo (`brdonath1/prism`), handled by a separate mini-brief.
- **B-5** (client-side audit-trail instrumentation) — a framework-architectural proposal, not a fix. Will be decided via a D-N in a subsequent session.
- **A-13** (hand-rolled .env loader) — dev-mode only, low value vs. the test-burden of covering edge cases.
- **A-15** (`resolveDocFiles` deprecated but used) — a larger deprecation-migration effort; separate initiative.
- **A-19** (token-length leak in `safeTokenCompare`) — theoretical only, MCP_AUTH_TOKEN is fixed-length. Include only if time permits in Phase 4.

## Pre-Flight

Before modifying any file, execute and record output for all of:

1. `git rev-parse HEAD` — must equal `d172ce6` or a commit after the S46 audit merge if the audit has been merged. If the audit PR is still open, diverge from `main` first, then rebase `audit/s46-framework-audit` later. **Do not base this branch on the audit branch.**
2. `git checkout main && git pull origin main`.
3. `git checkout -b fix/s47-audit-followup`.
4. `node --version` — must be >= 18. `npm --version` — record.
5. `npm ci` — must succeed.
6. `npm run build` — `tsc` must be clean, no errors.
7. `npm test` — record pass/fail/skip counts. Baseline from S46 audit: **578 passed / 0 failed / 0 skipped across 48 files**. Any regression from this baseline is a pre-existing problem, not caused by this brief — investigate before proceeding.
8. `wc -l src/**/*.ts tests/**/*.ts` — record for later sanity check.

Write the captured output to `PRE_FLIGHT.txt` in the branch root (gitignored or deleted before final push — it is scratch evidence, not a deliverable).

## Phase 0 — Atomic commit investigation (BLOCKING for Phase 2)

### Context (must read before starting)

Railway log review on 2026-04-18 surfaced a pattern the audit did not flag. Over the 48 hours preceding the audit, the atomic-commit code path (`createAtomicCommit` in `src/github/client.ts`) has been failing at high frequency with the error shape `"Not found: updateRef {repo}"`. Representative samples:

| Timestamp (UTC) | Repo | Error |
|---|---|---|
| 2026-04-16T23:02:32Z | alterra-design-llc | `Atomic commit failed, falling back to sequential pushFile` — `atomicError: "Not found: updateRef alterra-design-llc"` |
| 2026-04-17T02:39:21Z | platformforge-v2 | same shape — `Not found: updateRef platformforge-v2` |
| 2026-04-17T16:57:20Z | prism | same shape — `Not found: updateRef prism` |
| 2026-04-17T20:14:50Z | prism-mcp-server | `prism_push atomic failed; falling back to sequential pushFile` — `Not found: updateRef prism-mcp-server` |
| 2026-04-18T00:10:45Z | prism-mcp-server | same shape |

In some follow-on fallback paths, sequential pushes then 409'd terminally. Most notable: **2026-04-17T18:55:57Z — alterra's `insights.md` AND `session-log.md` both returned 409 in the same push cycle after atomic fallback.** That is a real in-the-wild partial-state incident.

In parallel, the PRISM project's S46 `prism_finalize(commit)` failed with `"Partial atomic commit — state may be inconsistent"` across all 4 target files, forcing the session to recover via `prism_push` fallback. That failure is documented in `brdonath1/prism/.prism/handoff.md` (v52) Critical Context item 4.

The audit's own Tier B live test of `prism_push` (single-file test-artifact create) succeeded atomically, so `createAtomicCommit` is not universally broken — it is failing under some condition the audit did not exercise.

### Investigation tasks

1. Read `src/github/client.ts` end-to-end, focusing on `createAtomicCommit` and surrounding helpers (`getHeadSha`, `getRef`, `updateRef` or whatever exists) — approximately `github/client.ts:598-700` per audit DD8.
2. `git log --oneline --all -- src/github/client.ts | head -40` — identify every commit touching this file in the past 60 days. Particular attention to: any change to URL construction, method selection (PATCH vs POST), ref targeting, or error wrapping.
3. Cross-check against D-81 (recorded in `brdonath1/prism-mcp-server/.prism/decisions/architecture.md` if present, else the repo's `.prism/decisions/_INDEX.md`) — the documented S42 fix where the plural `/git/refs/heads/` vs singular `/git/ref/heads/` endpoint mismatch was the regression. Verify the current code is still correct per D-81 (GET uses singular, PATCH uses plural).
4. Read `tests/github-client-timeouts.test.ts` and any other github-client tests. Per INS-31, the existing test pattern asserts on URL + method for atomic-commit steps. Does the currently-passing test cover the scenario that is failing in production?
5. Write findings to `reports/s47-atomic-commit-investigation.md` — new file. Structure: Symptom | Code review | Git log review | Test gap analysis | Root-cause hypothesis | Recommended fix (if any) | Risk assessment for adding MORE atomic-commit call sites in Phase 2.

### Gate

Phase 0 MUST commit the investigation report before Phase 2 begins. Commit prefix: `docs:` — this report is not a code fix. Commit title: `docs: s47 phase 0 — atomic commit investigation`.

**If Phase 0 identifies a regression:** Phase 2 begins with fixing the regression as P2.0 *before* the A-5/A-6 atomicity work. Add a regression test that would have caught the bug (mocked fetch asserting on URL + method per INS-31, recorded-calls pattern per INS-31 step 4).

**If Phase 0 identifies the failures as expected/recoverable behavior** (e.g., the error is a normal race-condition signal that the fallback handles cleanly and no data is lost): document this explicitly in the investigation report and proceed to Phase 2 unchanged. Include a follow-up task in the report recommending `@level:error` filtering changes so these noisy benign errors do not obscure real incidents.

**If Phase 0 is inconclusive:** Do NOT proceed to Phase 2. Commit the investigation report with a `status: INCONCLUSIVE — blocked pending operator review` header. Phases 1, 3, 4 still proceed because they are independent of the atomic-commit path.

## Phase 1 — High-confidence fixes with CONFIRMED-LIVE evidence

These 8 items all have direct live-verified evidence in the audit report. They are low-risk and well-scoped. One commit for the whole phase:

- **Branch name:** continue on `fix/s47-audit-followup`
- **Commit prefix:** `prism:`
- **Commit title:** `prism: s47 phase 1 — analytics repair + dedup guard + doc coherence + security + commit prefix`

### P1.1 — A-1 `prism_analytics(session_patterns)` rewrite

**Evidence:** Live calls returned `total_sessions: 21` (actual PRISM count 45), `first_session_date: 2026-04-18`, `last_session_date: 2026-04-01`, `average_gap_days: -0.8`. For `platformforge-v2`: `total_sessions: 0` (actual 172).

**Root cause per audit:** `src/tools/analytics.ts:109` regex `/^###\s+(?:CC\s+)?Session\s+(\d+)\s*\(([^)]+)\)/i` is too strict — platformforge-v2 uses `## S{N} — MM-DD-YY` format. Plus `analytics.ts:131-140` iterates in document order, not date order, producing inverted `first_date`/`last_date` when session-log is most-recent-top.

**Fix:**

1. Extend the header regex to accept both formats. Suggested:
   - `/^#{2,3}\s+(?:CC\s+)?(?:Session|S)\s*[—-]?\s*(\d+)\s*(?:[—\-—]\s*|\(|\s+)?([0-9]{1,4}[-\/][0-9]{1,2}[-\/][0-9]{1,4})/i`
   - Verify against both formats using a new test file with real-world headers sampled from `brdonath1/prism/.prism/session-log.md` and `brdonath1/platformforge-v2/.prism/session-log.md` (fetch the first 500 lines of each via GitHub API during test setup OR embed representative headers as fixtures in the test file).
2. After parsing sessions, **sort by parsed date ascending** before computing gaps. Do not trust document order.
3. Also read `session-log-archive.md` if present (path derived via `resolveDocPath`) and merge its sessions into the set before computing totals and gaps. PRISM's `session-log.md` currently holds S25-S45; S1-S24 are in the archive. Without reading the archive `session_patterns` under-counts.

**Test:** new file `tests/analytics-session-patterns.test.ts`. Minimum assertions:
- PRISM-style `### Session 25 (2026-03-15)` format parses to `{ session: 25, date: '2026-03-15' }`.
- PF2-style `## S162 — 03-15-26` format parses to `{ session: 162, date: '2026-03-15' }`.
- Dates are correctly ordered after sort (oldest first).
- `average_gap_days` is non-negative when sessions span multiple days.
- With session-log + archive supplied together, totals equal the sum.

### P1.2 — A-1 `prism_analytics(decision_graph)` rewrite

**Evidence:** Live call returned `total_edges: 0.5, connected_count: 1, isolated_count: 84` for 85 decisions.

**Root cause per audit:** `analytics.ts:253-272` scans only `.prism/decisions/_INDEX.md`, which is a lookup table with no cross-references. Actual D-N → D-N references live in the domain files (`.prism/decisions/architecture.md`, `.prism/decisions/operations.md`, etc.). Plus the `/2` divisor (assumes undirected graph) is wrong — "D-77 supersedes D-58" is a directional edge, not symmetric.

**Fix:**

1. List all files under `.prism/decisions/` via `github.listDirectory` (or equivalent helper in the codebase). Include `_INDEX.md` only as a source for the D-N → domain mapping, not as the edge source.
2. For each domain file, scan its content for `D-\d+` references. For each found `D-X` inside a decision entry `### D-Y`, record an edge `Y → X` (directional).
3. Drop the `/2` divisor. Report `total_edges` as the literal count of directed edges.
4. Optionally (not required): classify edge types by pattern ("supersedes", "refines", "depends on", "rejects") for richer graph data.

**Test:** new file `tests/analytics-decision-graph.test.ts`. Fixture: synthetic `_INDEX.md` + 2 domain files with known cross-references. Assert edge count and edge direction match the fixture.

### P1.3 — A-11 `handoff_size_history` sort by parsed version

**Evidence:** Live output showed versions sorted `v49, v50, v7, v8, v9` (alphabetic) and `trend: "growing"` comparing v49 (6.2KB) to v9 (6.4KB) — meaningless.

**Fix:** `analytics.ts:167-168` — replace `.sort((a,b) => a.name.localeCompare(b.name))` with numeric version sort:

```typescript
.sort((a, b) => {
  const va = parseInt(a.name.match(/v(\d+)/)?.[1] ?? '0', 10);
  const vb = parseInt(b.name.match(/v(\d+)/)?.[1] ?? '0', 10);
  return va - vb;
})
```

And at `analytics.ts:194-198`, change the trend calculation from `first vs last version` to a more meaningful `last-3 mean vs prior-3 mean` comparison, OR at minimum `versions[versions.length-1] vs versions[versions.length-2]` (most recent delta). Document the choice in a code comment.

**Test:** extend `tests/analytics-session-patterns.test.ts` (or add `tests/analytics-handoff-size.test.ts`) asserting that `v7, v8, v9, v49, v50` input yields ascending numeric order and a plausible trend.

### P1.4 — A-20 filename date regex extension

**Evidence:** PRISM has `handoff_v8_03-02-26.md` (MM-DD-YY). Current regex `/(\d{4}-\d{2}-\d{2})/` does not match; live output showed 3 of 5 versions with `date: "unknown"`.

**Fix:** In the same block as P1.3 (around `analytics.ts:171-179`), extend the date regex to accept both `YYYY-MM-DD` and `MM-DD-YY`:

```typescript
const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})/) ??
                  name.match(/_(\d{2}-\d{2}-\d{2})\.md$/);
```

Normalize the MM-DD-YY form to a full ISO date (`20` + YY) before returning.

**Test:** assert both filename forms produce a valid `date` field.

### P1.5 — A-4 `prism_log_insight` dedup guard

**Evidence:** Live test — `prism_log_insight(id=INS-9999)` accepted twice silently.

**Fix:** Mirror the pattern in `src/tools/log-decision.ts:28-53` (function `parseExistingDecisionIds` or similar). In `src/tools/log-insight.ts`:

1. Add a `parseExistingInsightIds(content: string): Set<string>` helper that scans for `^### INS-\d+:` markers.
2. Before the write path (around `log-insight.ts:13-120`), fetch current `insights.md`, parse existing IDs, reject if the new ID already exists with a clear error message mirroring the decision-log error: `"Insight ID INS-N already exists in insights.md. Use a different ID or update the existing entry via prism_patch."`

**Test:** new file `tests/log-insight-dedup.test.ts`. Mock fetch to return an `insights.md` with `INS-9999` already present; call `log-insight.ts` with `id: INS-9999`; assert the tool rejects with the expected error and does NOT push. Also assert that a fresh ID (e.g., `INS-10000`) is accepted. Per INS-30: count existing insights in the fixture explicitly; the rejection test should confirm the file was NOT written (assert no `pushFile` call was made).

### P1.6 — A-3 CLAUDE.md dispatch-state repo correction

**Evidence:** CLAUDE.md L76 says `brdonath1/prism-mcp-server/.dispatch/{id}.json`. Live `cc_status()` returns `state_repo: "brdonath1/prism-dispatch-state"`. `src/config.ts:283` confirms `CC_DISPATCH_STATE_REPO = "prism-dispatch-state"`.

**Fix:** Open CLAUDE.md. Two changes:

1. Line ~76 (the "Claude Code orchestration (brief-104)" paragraph). Change `brdonath1/prism-mcp-server/.dispatch/{id}.json` to `brdonath1/prism-dispatch-state/.dispatch/{id}.json`. Add one sentence explaining the decoupling: "The separate repo avoids Railway auto-deploy loops that would kill in-flight dispatches when state writes commit to this repo."
2. Line ~184 (the "Brief Status Tracking" section). Change `via its .dispatch/{id}.json records in this repo` to `via its records in brdonath1/prism-dispatch-state`.

### P1.7 — A-7 CLAUDE.md project count drift

**Evidence:** CLAUDE.md says "serving 17 PRISM projects" and "Brian manages 17 active PRISM projects". Live health_summary shows 22.

**Fix:** Replace both occurrences of "17" with language that does not encode a count:

- `Status: Production — deployed on Railway, serving all active PRISM projects` (remove the count).
- `Brian manages all active PRISM projects; current count is visible via prism_analytics(health_summary).`

Also update the stale framework version reference on the same page:

- `**Framework:** PRISM v2.9.0` → `**Framework:** PRISM — current version pinned by the framework repo's core-template; fetched dynamically at bootstrap.`

(Justification: hardcoded version numbers drift; the framework already reports `template_version` in every bootstrap response.)

### P1.8 — A-8 PAT sensitive pattern

**Evidence:** Live `railway_env(list)` sensitive_keys did not include `GITHUB_PAT`.

**Fix:** `src/railway/client.ts:538-547` — extend `SENSITIVE_KEY_PATTERNS` (or the array by whatever name) to add:

- `/\bPAT\b/i`
- `/^GITHUB_/i` (belt-and-suspenders)

Per INS-30, after the change run `grep -c "GITHUB_PAT" src/railway/client.ts` against the reference to verify the pattern applies. Then add a test in the appropriate Railway test file (or create `tests/railway-sensitive-patterns.test.ts`) asserting `classifyKeySensitive("GITHUB_PAT") === true` and `classifyKeySensitive("LOG_LEVEL") === false`.

### P1.9 — A-16 commit prefix allowlist extension

**Evidence:** The S46 audit brief itself specified `audit:` and `test:` prefixes that `src/validation/common.ts:validateCommitMessage` rejects because `VALID_COMMIT_PREFIXES = ["prism:", "fix:", "docs:", "chore:"]`.

**Fix:** `src/config.ts` — extend the array:

```typescript
export const VALID_COMMIT_PREFIXES = [
  "prism:", "fix:", "docs:", "chore:",
  "audit:", // audit reports and audit-trail commits
  "test:",  // test artifacts and test-scope fixtures
] as const;
```

**Test:** extend the existing validation test (likely in `tests/push-validation.test.ts` or similar — grep for `validateCommitMessage`). Assert `audit: some message` and `test: some message` both pass validation.

Update CLAUDE.md's "Commit Prefixes" table to include the two new entries with their semantic descriptions.

### Phase 1 verification

1. `npm run build` — tsc clean.
2. `npm test` — all prior tests plus new tests pass. Net additions: 3-5 new test files, ~30-50 new test cases.
3. Spot-diff CLAUDE.md — three edits only (A-3, A-7, A-16 table update).
4. Commit with the message above.

## Phase 2 — Atomic commit hardening (CONDITIONAL on Phase 0)

### P2.0 — Phase 0 regression fix (conditional)

If Phase 0's `reports/s47-atomic-commit-investigation.md` identified a regression with a concrete fix, apply it FIRST. Commit separately: `fix: s47 atomic commit regression — {one-line description}`. Include a regression test per INS-31: mock fetch, record URL + method for every call in the atomic sequence, assert the sequence matches expectations (the S42 pattern from `tests/github-client-timeouts.test.ts`).

If Phase 0 found no regression, skip P2.0 and proceed directly.

### P2.1 — A-5 `prism_log_decision` atomic commit

**Evidence:** Docstring at `src/tools/log-decision.ts:11` claims atomicity. Implementation at lines 168-180 uses two sequential `pushFile` calls. Production logs (see Phase 0 context table) show atomic-commit path is actively exercised and sometimes fails terminally — making the theoretical partial-state risk real.

**Fix:** Replace the two sequential `pushFile` calls with a single `createAtomicCommit([index, domain], commitMessage)` call. Mirror the pattern from `src/tools/push.ts:151-200`:

1. Capture `headShaBefore = await getHeadSha(...)`.
2. Attempt `createAtomicCommit(...)` with both files.
3. On failure, `headShaAfter = await getHeadSha(...)`. If `before !== after` → HEAD moved, surface a clear error `"Concurrent write during log_decision atomic commit; please retry"` and DO NOT fall back. If `before === after` → fall back to SEQUENTIAL `pushFile` (not parallel — mirrors push.ts).

**Test:** new file `tests/log-decision-atomicity.test.ts`. Use the recorded-calls fetch-mock pattern from `tests/github-client-timeouts.test.ts`. Assert:

1. Happy path: calls go through the atomic sequence (get ref → get commit → create tree → create commit → update ref), and the URL pattern for each call is as expected (INS-31 positive assertion AND negative assertion — `/git/refs/` not `/git/ref/` for PATCH).
2. HEAD-moved path: mock the updateRef step to fail with a 409-or-similar; mock the subsequent `getHeadSha` to return a different SHA; assert the tool surfaces the expected error and DOES NOT call sequential `pushFile`.
3. HEAD-unchanged fallback: similar to (2) but `getHeadSha` returns the same SHA; assert the two sequential `pushFile` calls happen in order.

### P2.2 — A-6 `prism_scale_handoff` atomic commit

**Evidence:** `src/tools/scale.ts:788-832` pushes destination files via `Promise.all(pushFile)`. Then lines 1134-1138 push the reduced handoff separately. If any destination push fails but the handoff push succeeds, content has been extracted from the handoff to nowhere — data loss.

**Fix:** In `executeScaling` (lines 788-832), collect all files (destinations + reduced handoff) into a single array. Call `createAtomicCommit(allFiles, commitMessage)` once. Apply the same HEAD-SHA guard + sequential fallback as P2.1.

**Test:** new file `tests/scale-handoff-atomicity.test.ts`. Fixture: synthetic analyze plan with 3 destination sections + 1 handoff reduction. Mock fetch; assert atomic commit URL sequence; assert fallback behavior parallels P2.1.

### Phase 2 commit

- Commit prefix: `fix:`
- Commit title: `fix: s47 phase 2 — atomic commit hardening for log_decision + scale_handoff`
- If P2.0 was needed: two commits (the regression fix, then this one). Otherwise: one commit.

## Phase 3 — Performance + observability

### P3.1 — A-9 `prism_status` caching

**Evidence:** Audit DD-level analysis: multi-project status makes ~O(N × 14) GitHub API calls with 22 projects live. Not measured in wall-clock time during the audit.

**Fix:** Two caches in `src/tools/status.ts` (or a new `src/utils/status-cache.ts` if cleaner):

1. `listReposCache` with 5-min TTL — caches the result of `github.listRepos()`.
2. `handoffExistenceCache` with 10-min TTL, keyed by repo slug — caches whether `.prism/handoff.md` and `handoff.md` exist for a given repo.

Use the existing `MemoryCache` class from `src/utils/cache.ts` — same pattern as `templateCache`. Invalidate the repo-list cache when a new repo is created (low-frequency event, but add a cache-clear helper exported from status.ts that bootstrap.ts can call after successful repo creation).

**Test:** new file `tests/status-cache.test.ts`. Mock `github.listRepos` to count call invocations. Assert:

1. Two back-to-back `prism_status()` calls within 5 min result in exactly ONE `listRepos` invocation.
2. A `prism_status()` call after the cache expires invokes `listRepos` again.
3. Handoff-existence cache: same pattern for `fileExists('.prism/handoff.md', repo)`.

### P3.2 — A-10 Railway logs stdio-bridge INFO demotion

**Evidence:** Live `railway_logs(filter=@level:error, limit=20)` returned 20 `severity: "error"` entries that were all INFO-level stdio-bridge messages (`level=INFO msg="server session connected"` pattern).

**Fix:** `src/railway/client.ts:413-426` (`filterLogs` function). Before applying the severity filter, detect messages matching the stdio-bridge INFO pattern and reclassify:

```typescript
const STDIO_INFO_PATTERN = /level=INFO msg=/;
// Inside filterLogs, before the severity comparison:
for (const log of logs) {
  if (log.severity === "error" && STDIO_INFO_PATTERN.test(log.message ?? "")) {
    log.severity = "info"; // reclassify
  }
}
```

Add a code comment explaining why: "Railway maps all stderr output to severity=error regardless of application log level. The github-mcp-server stdio bridge writes its INFO messages to stderr. Reclassify them locally so @level:error filters return real errors only."

**Test:** new file `tests/railway-log-filter.test.ts`. Fixture: 5 log entries — 2 are stdio-bridge INFO-as-error, 2 are real errors, 1 is a normal info. Assert filter=`@level:error` returns exactly the 2 real errors.

### P3.3 — A-12 Railway mutation schema guard (OPTIONAL)

Include only if P3.1 and P3.2 complete with budget remaining. The value is lower than other phases and the fix requires a boot-time schema-introspection against Railway's GraphQL API which is out-of-session-scope for this brief's test budget.

**If included:** add a one-time boot probe in `src/railway/client.ts` that sends an introspection query for `deploymentRedeploy` and `deploymentRestart` mutations. Log a warning if either is missing or has changed signature. Do not fail boot — log-only.

### Phase 3 commit

- Commit prefix: `prism:`
- Commit title: `prism: s47 phase 3 — status caching + railway log demotion`

## Phase 4 — Cleanup batch

Minor fixes, one commit:

- Commit prefix: `chore:`
- Commit title: `chore: s47 phase 4 — dead code + minor hardening`

### P4.1 — A-17 remove dead `idKey` variable

`src/tools/analytics.ts:47` — declared but never read. Delete the line.

### P4.2 — A-18 remove dead `- 0` math

`src/tools/cc-dispatch.ts:423` — `new Date(Date.now() - 0).toISOString()` → `new Date().toISOString()`. Remove the obsolete comment about the `- 0` since it no longer has anything to explain.

### P4.3 — A-14 wrap `createPullRequest` in `fetchWithRetry`

`src/tools/cc-dispatch.ts:480-514`. Replace plain `fetch` with the existing `fetchWithRetry` wrapper (import from `src/github/client.ts`). Ensure the retry preserves the POST body and Authorization header. Keep the existing AbortSignal construction if any.

**Test:** if a cc-dispatch test file exists, extend it with one test asserting that a 429 response triggers a retry. If not, skip the test and note this in the commit body as a known test-coverage gap.

### P4.4 — A-19 token-length comparison (OPTIONAL)

Only if budget remaining. `src/middleware/auth.ts:10-13` — the short-circuit on `a.length !== b.length` is theoretical-only per the audit. A safer form: compare against a fixed-length hash of both strings first. If you modify this, add a test asserting constant-time behavior across several length classes. If not modified, leave the finding documented in the PR body as accepted-as-is with rationale.

## Verification (final)

After ALL phases complete:

1. `npm run build` — tsc clean, no warnings beyond pre-existing.
2. `npm test` — record new pass count. Baseline was 578; expected new total depends on how many tests you added, but must be ≥ 578 + 15 (rough minimum: 5 analytics tests + 3 dedup tests + 2 atomic tests + 2 status-cache tests + 1 railway-filter test + a few misc). If the count is ≤ baseline, something was removed or skipped — investigate.
3. `git log --oneline origin/main..HEAD` — expected commit graph (varies by Phase 0 outcome):
   - 1 docs commit (Phase 0 investigation report)
   - 0 or 1 fix commit (P2.0 regression fix, conditional)
   - 1 prism commit (Phase 1)
   - 1 fix commit (Phase 2)
   - 1 prism commit (Phase 3)
   - 1 chore commit (Phase 4)
   - **Total: 5-7 commits.**
4. Re-read CLAUDE.md end-to-end to confirm A-3, A-7, A-16 edits are coherent in context.
5. Verify scratch file `PRE_FLIGHT.txt` is deleted or gitignored before final push.

## Post-Flight (push + PR)

Exactly one push (INS-20):

```bash
git push origin fix/s47-audit-followup
```

Then open the PR via the `gh` CLI or leave a comment instructing the operator:

```bash
gh pr create \
  --base main \
  --head fix/s47-audit-followup \
  --title "S47 Mega Audit Fix — Analytics + Atomicity + Docs + Cleanup" \
  --body "$(cat briefs/s47-mega-audit-fix.md | head -40)"
```

**Do NOT merge the PR inside CC.** The operator will review commits individually, confirm test results, review the Phase 0 investigation report, and merge manually.

**Do NOT push `main` directly.** All changes flow through the PR.

## Completion Criteria

- [ ] `PRE_FLIGHT.txt` captured and then removed from the working tree before final push
- [ ] `reports/s47-atomic-commit-investigation.md` committed (Phase 0 deliverable)
- [ ] All four phase commits present on `fix/s47-audit-followup`
- [ ] `npm test` passes locally with new test count ≥ 578 + 15
- [ ] `npm run build` clean
- [ ] Branch pushed to `origin/fix/s47-audit-followup`
- [ ] PR opened (or command provided to operator to open)
- [ ] CC exits WITHOUT any further git commands after the single push

Per INS-20: the Finishing Up and Completion Criteria are in explicit agreement. The single push is the final git write this brief authorizes.

## Post-deploy operator checklist (not CC's responsibility)

This is for the operator's reference when the PR is merged:

1. Merge PR. Railway auto-deploys `main`.
2. Wait for deploy completion (check Railway dashboard or run `railway_deploy(status, prism-mcp-server)` from any active PRISM session).
3. Reconnect the PRISMv2 MCP Server connector in Claude.ai Settings → Connectors (required per INS-11 because tool schemas may have changed).
4. Start a NEW conversation (deferred-tools list is frozen at conversation start).
5. Smoke tests in the new conversation:
   - `prism_analytics(session_patterns, prism)` — confirm plausible session count and positive `average_gap_days`.
   - `prism_analytics(session_patterns, platformforge-v2)` — confirm non-zero `total_sessions`.
   - `prism_analytics(decision_graph, prism)` — confirm non-zero edge count matching known supersedes-chains.
   - `prism_log_insight(id=INS-X)` with a fresh ID, then retry same ID — second call should reject.
   - `prism_status()` multi-project twice back-to-back — second call should be noticeably faster (cache hit).

## Non-scope reminders

- B-1 (alterra session-log scrub) is a separate brief for `brdonath1/prism`. Do not touch `.prism/` files under that repo from this brief.
- B-5 (client-side audit-trail) is a decision-first item; this brief does not build any new framework instrumentation.
- `cc_dispatch(max_turns)` cap: if you hit the turn limit mid-phase, commit what you have with a `WIP:` or `chore: s47 partial — {phase name}` message, push, and stop. The operator will resume in a follow-up dispatch. Do not delete work, do not skip phases silently.

<!-- EOF: s47-mega-audit-fix.md -->
