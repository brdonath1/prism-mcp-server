# Fix Brief — FINDING-5: Decouple Synthesis from Commit Response (D-78)

> **Brief type:** IMPLEMENTATION. Change code. Push to main. Exit.
> **Source:** PRISM Session 39. Fixes FINDING-5 from `reports/s39-observability-perf-audit.md`. Implements decision D-78 (architecture domain).
> **Target repo:** `brdonath1/prism-mcp-server`
> **Target branch:** `main` (direct push; no PR).

---

## Mission

Make `prism_finalize commit` return immediately after the atomic commit push succeeds. Fire synthesis as a detached background promise, without awaiting. The commit response must no longer depend on synthesis completion.

This eliminates the client-timeout hang that occurs on mature projects where synthesis exceeds the claude.ai MCP client's timeout (~60s). Synthesis still runs; it just doesn't block the response.

---

## Launch Command

```bash
cd ~/Desktop/Development/prism-mcp-server && git fetch origin && git reset --hard origin/main && claude --dangerously-skip-permissions --model claude-opus-4-7 --effort max
```

Then paste: `Read briefs/s39-fix-1-decouple-synthesis.md and execute it fully. Make the code changes, run the test suite, verify all tests pass, commit, and push to main. Do not open a PR. Exit when push is confirmed.`

---

## Context — What's Being Fixed

`src/tools/finalize.ts:573-609` currently contains:

```ts
const synthPromise = generateIntelligenceBrief(projectSlug, sessionNumber);
const timeoutPromise = new Promise((resolve) =>
  setTimeout(() => resolve({ timedOut: true }), SYNTHESIS_TIMEOUT_MS)
);
const synthOutcome = await Promise.race([synthPromise, timeoutPromise]);
// ... response construction depends on synthOutcome
```

Measured: PRISM synthesis 82.5s, PF-v2 synthesis 99.6s. CLAUDE.md documents MCP client timeout at ~60s. `MCP_SAFE_TIMEOUT = 50_000` at `src/config.ts:53`. User confirmed behavior: "it hang/error out and you see no response in the claude.ai UI." Commit push happens BEFORE synthesis starts (`finalize.ts:475` atomic commit, synthesis begins at line 573), so the finalize succeeds server-side even when the client times out — the operator just doesn't know.

Fix shape: push commit as today, but fire synthesis as `void` (unawaited) background task and return the commit response immediately. Operator checks synthesis status via `prism_synthesize mode=status` if they want confirmation, or sees the refreshed brief on next session's bootstrap.

---

## Required Changes

### Change 1 — `src/tools/finalize.ts` `commitPhase` function (around lines 573-609)

**Current behavior:** inline await on `Promise.race([synthPromise, timeoutPromise])` before returning. Response includes `synthesis_banner_html`, `synthesis_warning`, `synthesis_outcome` fields populated from the awaited result.

**New behavior:**

1. Keep the existing `skip_synthesis === true` early-return path unchanged (lines 570-572).
2. Replace the inline-await block with a fire-and-forget invocation:
   ```ts
   // Fire synthesis in background; do not await. Failures are logged but do not affect the commit response.
   void generateIntelligenceBrief(projectSlug, sessionNumber)
     .then((result) => {
       logger.info("background synthesis complete", {
         projectSlug,
         sessionNumber,
         success: result.success ?? false,
         durationMs: result.durationMs,
       });
     })
     .catch((err) => {
       logger.error("background synthesis failed", {
         projectSlug,
         sessionNumber,
         err: err instanceof Error ? err.message : String(err),
       });
     });
   ```
3. Set the response's synthesis-related fields to indicate background mode:
   - `synthesis_outcome: "background"`
   - `synthesis_banner_html: null`
   - `synthesis_warning: null`
   - Add a new field: `synthesis_status_hint: "Synthesis running in background. Check via prism_synthesize mode=status or wait for next session bootstrap."`
4. Remove the `timeoutPromise` construction and the `SYNTHESIS_TIMEOUT_MS` import from this file — no longer needed. **Leave the `SYNTHESIS_TIMEOUT_MS` constant in `src/config.ts`** — it's still used inside `generateIntelligenceBrief` itself as a per-API-call safety net, and removing the export would be a separate breaking change.

### Change 2 — `src/tools/finalize.ts` response type

Update the `CommitPhaseResult` type (or equivalent) to:
- Add `synthesis_outcome: "completed" | "timed_out" | "skipped" | "background"` (widening the existing union).
- Add optional `synthesis_status_hint?: string`.
- Keep all other fields unchanged.

### Change 3 — Logging

Confirm `src/utils/logger.ts` is imported in `finalize.ts`. If not, add `import { logger } from "../utils/logger.js"` (or the equivalent path).

The two new `logger.info` / `logger.error` calls from Change 1 are the only new log sites. They will write to stderr (error) or stdout (info) per the existing routing. These logs will NOT be surfaced properly via the current `railway_logs` tool because of FINDING-1 (structured payloads stripped) — but that's being fixed separately. Write the structured fields anyway; they're correct for future readers and will surface once FINDING-1 is addressed.

### Change 4 — NOT required: do NOT touch

- `src/ai/synthesize.ts` — `generateIntelligenceBrief` function itself is fine. Its internal timeout on the Anthropic API call (`SYNTHESIS_TIMEOUT_MS`) is correct and should stay.
- `src/tools/synthesize.ts` — the `prism_synthesize` tool is unaffected.
- `src/tools/bootstrap.ts` — no change; bootstrap already loads intelligence-brief.md whatever its freshness.
- Any other finalize phase (`auditPhase`, `draftPhase`) — out of scope for this brief. FINDING-6, 7, 8, 9 are separate fixes.

---

## Tests Required

Add tests to the appropriate existing test file (`test/finalize.test.ts` or similar — find it; name matches the pattern of other tool tests). If no such file exists, create `test/tools/finalize-commit.test.ts`.

### Test 1 — Commit returns immediately without waiting for synthesis

- Mock `generateIntelligenceBrief` to return a promise that resolves after 5 seconds.
- Call `commitPhase` with normal args.
- Assert: response returns in under 1 second (well under the 5-second mock synthesis).
- Assert: response `synthesis_outcome` equals `"background"`.
- Assert: response `synthesis_banner_html` is null.

### Test 2 — Synthesis still runs after commit returns

- Mock `generateIntelligenceBrief` with a spy.
- Call `commitPhase`.
- After the commit response returns, wait 100ms (or use test framework's flush-promises helper).
- Assert: the spy was called with the correct `(projectSlug, sessionNumber)` arguments.

### Test 3 — Synthesis failure does not affect commit response

- Mock `generateIntelligenceBrief` to reject with an error.
- Call `commitPhase`.
- Assert: response returns success.
- Assert: response `synthesis_outcome` equals `"background"` (not `"failed"` — the commit response has no visibility into the eventual synthesis outcome).
- Assert: logger.error was called (verify via logger spy if the test framework permits).

### Test 4 — `skip_synthesis: true` path unchanged

- Regression test. With `skip_synthesis: true`, synthesis is NOT invoked, `synthesis_outcome` equals `"skipped"`, behavior matches pre-fix.

### Test 5 — Integration: full finalize cycle

- If the existing test suite has an end-to-end finalize test, update it to assert the new `synthesis_outcome: "background"` field appears in the final response shape.
- If no such integration test exists, do not create one — unit tests above are sufficient.

**All existing tests must continue to pass.** Run the full suite with `npm test` (or whatever the project uses) and verify zero regressions before committing.

---

## Completion Criteria

You are done when ALL of the following are true:

1. `src/tools/finalize.ts` is updated per Changes 1, 2, 3.
2. New tests added per Tests 1-5.
3. `npm test` passes with no failures.
4. `npm run build` (or equivalent compile step) passes with no type errors.
5. `git diff` shows changes ONLY in `src/tools/finalize.ts` and the relevant test file(s). No other files modified.
6. Changes committed with message: `fix: decouple synthesis from finalize commit response path (D-78, FINDING-5)`
7. Pushed to `origin/main`.
8. Verify push succeeded: `git log --oneline -3 origin/main` shows your commit at HEAD.

### Finishing Command

Run exactly this sequence at the end:

```bash
npm test && npm run build && git add -A && git status && git commit -m "fix: decouple synthesis from finalize commit response path (D-78, FINDING-5)" && git push origin main && git log --oneline -3 origin/main
```

If any step fails, STOP and report the error. Do not push broken code. Do not skip tests.

After successful push, exit.

---

## Railway Deployment Note

After `git push origin main` completes, Railway will auto-deploy. The operator will verify deployment success separately via Railway status. No action required from you post-push beyond confirming the push landed.

This change does NOT modify the tool surface (no new tools, no renamed tools, no schema changes). Per INS-11, a connector reconnect is NOT required for this deploy.

---

## Out of Scope

- All other S39 audit findings (FINDING-1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18). Those are separate briefs.
- Any refactor, cleanup, or "while I'm in there" changes to `finalize.ts`.
- Anthropic SDK updates, MCP SDK updates, dependency bumps.
- Documentation updates beyond inline code comments.
- CLAUDE.md updates. The operator will handle those after verification.

<!-- EOF: s39-fix-1-decouple-synthesis.md -->
