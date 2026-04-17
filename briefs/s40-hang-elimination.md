# S40 Brief — Hang Elimination + Observability

**Session:** PRISM S40 (04-17-26)
**Type:** IMPLEMENTATION (pushes to main)
**Scope:** 4 bundled changes — see Scope section below
**Background reading (required):** `reports/s39-observability-perf-audit.md`

---

## Context

S39 audit identified 18 findings in the MCP server. S40 reproduced a live `prism_push` hang in the Claude.ai UI that ran >10 minutes on a retry for 2 files. Diagnosis (verified against code, not theorized):

1. Primary GitHub rate limit is NOT the cause (checked live: 262/5000 used, 4738 remaining).
2. `fetchWithRetry` in `src/github/client.ts` retries on 429 with exponential backoff up to 120s per retry × 3 retries, and **none of the underlying `fetch()` calls have a timeout signal**. A stuck socket hangs forever.
3. `prism_push` uses parallel `pushFile` calls (3× the API-point cost of an atomic commit) and has no tool-level deadline.
4. Railway GraphQL log queries in `src/railway/client.ts` only select `{ message, timestamp, severity }`, discarding all structured fields written by `logger.error(msg, { ...context })`. Every PRISM investigation using `railway_logs` sees error headlines without stack traces or structured context (FINDING-1 from S39 audit).

This brief lands four fixes in a single CC run. Each change has its own commit; all share one final push. Per INS-20, the finishing command is chained to prevent exit-before-push.

---

## Scope (4 changes, independently committed)

1. **Change 1:** Add `fetch()` timeouts to every HTTP call in `src/github/client.ts`.
2. **Change 2 (FINDING-1 + FINDING-3):** Widen Railway log GraphQL selection to include structured payload fields. Update `RailwayLog` type. Thread through `railway_logs` tool response.
3. **Change 3:** Refactor `prism_push` to use `createAtomicCommit` by default, falling back to sequential `pushFile` only on non-partial-write failures. Mirrors the pattern already in `finalize.ts` commit phase.
4. **Change 4:** Add tool-level wall-clock deadlines to `prism_push` and `prism_finalize` commit phase.

Execute in order. Each change is isolated — a failure in later changes does not invalidate earlier ones.

---

## Pre-Flight

1. Verify clean working tree on `main`: `git status` → empty; `git log --oneline -3` → matches origin/main.
2. `npm ci` → clean install.
3. `npm test` → baseline pass (expected: ~466 tests, 0 failures). Record the exact count; final run must be ≥ this number.
4. `npm run build` → TypeScript clean.
5. Read `reports/s39-observability-perf-audit.md` sections on FINDING-1, FINDING-3, FINDING-6, FINDING-8 for original analysis context.

If any pre-flight step fails, STOP and report. Do not proceed with changes.

---

## Change 1 — fetch() timeouts in src/github/client.ts

**Problem:** No fetch() in `src/github/client.ts` has an AbortSignal, except `fileExists`. A hung socket blocks indefinitely. This is the #1 cause of the S40 reproduced hang.

**Fix:**

1. Add a module-level constant near the other constants:
   ```ts
   /** Per-request timeout for GitHub API calls. A stuck socket aborts after this. */
   const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
   ```
2. Modify `fetchWithRetry` to apply `AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)` to every inner `fetch()` call. If the caller already passed a signal in `options`, combine them using `AbortSignal.any([callerSignal, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)])` so both can abort.
3. Distinguish AbortError from other errors in the retry logic:
   - `res.status === 429` → existing exponential backoff (keep as-is).
   - `AbortError` (timeout) → **do not retry within fetchWithRetry**. Throw a clear error: `throw new Error(\`GitHub API request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms: ${url}\`);`
   - All other errors → propagate as before.
4. Audit `src/github/client.ts` for any **direct** `fetch()` calls that bypass `fetchWithRetry`. There is at least one in the HEAD SHA check inside `createAtomicCommit` fallback logic (see `src/tools/finalize.ts` commitPhase — headShaBefore/headShaAfter checks use raw `fetch`). Add `AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)` to each.

**Tests to add (in `test/` or wherever existing github client tests live):**

- `fetchWithRetry` aborts after GITHUB_REQUEST_TIMEOUT_MS when the server hangs. Use a mock server or `setTimeout(() => never, ...)` pattern. Assert the thrown error message contains "timed out".
- `fetchWithRetry` still retries on 429 (regression check — don't break rate limit handling while adding timeouts).

**Commit after Change 1:**
```
git add -A && git commit -m "fix(github): add 15s fetch() timeouts to prevent socket hangs (S40 C1)"
```

---

## Change 2 — Railway log structured payload (FINDING-1 + FINDING-3)

**Problem:** `src/railway/client.ts` queries `deploymentLogs` and `environmentLogs` with GraphQL selection `{ message, timestamp, severity }` only. Structured fields written by the logger (`logger.error(msg, { err, stack, repo, path, ... })`) are silently discarded. PRISM investigations see error headlines without context.

**Step A — Live GraphQL introspection (REQUIRED before editing):**

Before changing any code, run an introspection query against Railway's GraphQL endpoint to determine the exact structured-field accessor on the `Log` type. Do NOT guess. Likely candidates: `attributes`, `tags`, `payload`, `structuredPayload`. Confirm which one (or multiple) exist.

Introspection query:
```graphql
query { __type(name: "Log") { name fields { name type { name kind ofType { name kind } } } } }
```

Run it via curl with `$RAILWAY_API_TOKEN` from the local environment or Railway CLI-exposed token. Paste the response into the brief execution notes. **Document the exact field name and type** — this drives the TypeScript changes.

If introspection returns no structured-field accessor on `Log`, the finding is **invalid as stated** — STOP Change 2, report the introspection result, and skip to Change 3. Do NOT invent a field name.

**Step B — Update GraphQL selections in `src/railway/client.ts`:**

There are two functions that select from `Log`: `getDeploymentLogs` and `getEnvironmentLogs`. Both have the selection `... on Log { message timestamp severity }`. Extend both to include the confirmed structured field, e.g.:

```graphql
... on Log {
  message
  timestamp
  severity
  attributes { key value }   # or whatever introspection revealed
}
```

If the accessor returns an arbitrary JSON object (not a key/value array), select accordingly. Pin the shape to whatever introspection confirmed.

**Step C — Update `RailwayLog` type in `src/railway/types.ts`:**

Current shape:
```ts
export interface RailwayLog {
  message: string;
  timestamp: string;
  severity: string;
}
```

Extend to include the structured payload with the correct type. Examples (pick the one that matches introspection):
- If attributes is `[{key, value}]`: `attributes?: Array<{ key: string; value: string }>;`
- If it's an arbitrary JSON object: `attributes?: Record<string, unknown>;`
- If multiple fields: add each separately.

Make the new field OPTIONAL (`?`) to avoid breaking callers that don't expect it.

**Step D — Thread structured fields through `src/tools/railway-logs.ts`:**

Find the tool handler (search for `railway_logs` or `railwayLogs` tool registration). The response currently maps logs to `{ message, timestamp, severity }` for output. Extend the output shape to include the structured field. Preserve backward compatibility: if the field is absent, omit it from the output rather than serializing `undefined`.

**Tests to add:**

- Integration test (mocked Railway response) asserting that structured fields pass through `getEnvironmentLogs` → tool response unchanged.
- Unit test for the types/serialization — a `RailwayLog` with `attributes` roundtrips through the tool.

**Commit after Change 2:**
```
git add -A && git commit -m "feat(railway): include structured payloads in log queries (S40 C2, FINDING-1/3)"
```

---

## Change 3 — prism_push uses atomic commits by default

**Problem:** `src/tools/push.ts` runs parallel `pushFile` calls, which (a) hit the 409 race condition when pushing sibling files in the same repo, (b) cost ~13 GitHub rate-limit points per file (GET+PUT+verify), and (c) have no atomicity — partial failure leaves inconsistent state.

**Fix:** Mirror the pattern already in `src/tools/finalize.ts` commitPhase. Atomic commit first, fall back to sequential pushFile only when atomic commit fails AND HEAD hasn't moved.

**Specific changes to `src/tools/push.ts`:**

1. After validation and `guardPushPath`, derive a single commit message:
   - If all files share the same message, use it directly.
   - If messages differ, use the first file's message. (Atomic commit is one commit; it can only have one message.)
   - Log a warning if messages differed: `logger.warn("prism_push received differing messages; using first", { count, used: msg });`
2. Capture `headShaBefore` via `getDefaultBranch` + `GET /git/ref/heads/{branch}` before attempting atomic commit. Use the same pattern as `finalize.ts:commitPhase` (copy the helper if needed; do not duplicate implementation — extract a shared helper if appropriate).
3. Call `createAtomicCommit(project_slug, guardedFiles, commitMessage)`.
4. On atomic success: populate results array with `success: true`, `verified: true`, `sha: atomicResult.sha` for each file (atomic commit guarantees consistency — verification fetch is no longer needed; **remove** the per-file verification fetchFile calls).
5. On atomic failure: capture `headShaAfter`. If `headShaAfter !== headShaBefore`, HEAD moved → partial write occurred. Do NOT fall back. Return results with `success: false`, `validation_errors: ["Partial atomic commit — state may be inconsistent"]`.
6. On atomic failure with HEAD unchanged: fall back to sequential `pushFile` (NOT parallel — parallel was the 409 cause). Loop through files one at a time.

**Important constraint (INS-13):** The input `files` array shape stays the same (`{ path, content, message }[]`). The tool schema does not change. Only the internal implementation changes. Tests that exercise the tool's public behavior should still pass.

**Tests to add/update:**

- Multi-file prism_push returns all results with the same `sha` (atomic commit signature).
- Prism_push with a forced atomic-commit failure AND HEAD moved returns partial-state warning.
- Prism_push with forced atomic failure AND HEAD unchanged falls back and succeeds.

**Commit after Change 3:**
```
git add -A && git commit -m "refactor(push): use atomic commits by default, eliminate 409 race (S40 C3)"
```

---

## Change 4 — Tool-level deadlines

**Problem:** `prism_push` and `prism_finalize` commit phase have no overall wall-clock deadline. Even with Change 1's per-request timeouts, a long chain of retries could theoretically exceed user expectations. We want a hard backstop.

**Fix:**

1. In `src/tools/push.ts`, wrap the tool handler body in an `AbortController`-backed timeout:
   - Deadline: 60 seconds.
   - Implementation: `Promise.race([handlerLogic, new Promise((_, reject) => setTimeout(() => reject(new Error("prism_push deadline exceeded (60s)")), 60_000))])`.
   - On deadline exceeded, return a structured tool response (NOT throw): `{ error: "prism_push deadline exceeded (60s)", partial_state_warning: "Atomic commit may have partially succeeded — verify repo state manually" }`.
2. In `src/tools/finalize.ts` commitPhase, apply the same pattern with a 90-second deadline (finalize has more work: backup, prune, validate, guard, commit).
3. Do NOT add deadlines to the `audit` or `draft` phases of finalize — the draft phase already has its own Opus-scaled timeout (`MCP_SAFE_TIMEOUT`), and audit should be fast enough not to need one.

**Design note:** The tool deadline is a safety backstop. With Change 1's 15s per-request timeouts and Change 3's atomic commits, normal `prism_push` should complete in <5s. Hitting the 60s deadline indicates a serious problem that deserves a user-visible error, not a silent UI hang.

**Tests to add:**

- prism_push with mocked slow GitHub (fetch hangs forever) returns the deadline error within ~60-62s. Do NOT write a test that actually waits 60s in CI — use a smaller mocked deadline via a configurable constant.
- Finalize commit deadline test analogous.

**Commit after Change 4:**
```
git add -A && git commit -m "feat(tools): add wall-clock deadlines to prism_push and finalize commit (S40 C4)"
```

---

## Verification (run after all four changes are committed)

1. `npm test` → all tests pass, count ≥ baseline from Pre-Flight step 3.
2. `npm run build` → TypeScript clean, no warnings introduced.
3. `git log --oneline -6` → shows 4 new commits (C1, C2, C3, C4) on top of baseline.
4. Lint/format check if the repo has one (likely `npm run lint` or similar — check `package.json`).

---

## Finishing Up — SINGLE CHAINED COMMAND (per INS-20)

After all four commits are made AND verification passes locally, run this single chained command. **Do not stop short. Do not run the steps individually.** If any step fails, the chain aborts and nothing is pushed.

```
npm test && npm run build && git push origin main && git log --oneline -6 origin/main
```

This command gives no opportunity to exit before push. Do not deviate from it. Do not replace `&&` with `;`.

If `npm test` or `npm run build` fails: STOP, report the failure, do NOT attempt to push. Roll back if needed with `git reset --hard origin/main`.

---

## Post-Deploy Operator Action

After CC pushes to main, the operator will:

1. Wait for Railway auto-deploy to complete (visible via Railway dashboard or `railway_deploy` MCP tool).
2. Reconnect the PRISMv2 MCP Server connector in Claude.ai Settings → Connectors (required per INS-11 — tool schema may have changed).
3. Start a NEW conversation (required per INS-10 — deferred tool list is frozen at conversation start).
4. Smoke-test in the new session:
   - `prism_push` a trivial file → confirm single commit SHA, <5s total wall clock.
   - `railway_logs` fetch → confirm structured fields now present in response.
   - Deliberately force a long operation → confirm deadline fires at ~60s, not infinite hang.

Brief persists at this path as documentation of what changed and why.

<!-- EOF: s40-hang-elimination.md -->
