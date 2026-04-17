# Brief S41-C1: finalize draft phase timeout + deadline + no-retry

> **Target repo:** `prism-mcp-server` (brdonath1/prism-mcp-server)
> **Audit source:** `reports/s39-observability-perf-audit.md` — FINDING-6 (HIGH) + FINDING-8 (HIGH)
> **Diagnosis session:** S41 (04-17-26)
> **HEAD at brief-draft time:** latest `origin/main` post-S40 C1-C4 (hang elimination, HEAD aa61153), archive lifecycle (c6d669a), and dispatch-store cleanup (54b5435). CC should `git pull` in Pre-Flight to sync to actual latest.

## Mission

The `draft` phase of `prism_finalize` has three compounding defects that cause silent draft failures on mature projects:

1. **Per-attempt timeout too tight.** Current code: `draftTimeoutMs = totalDocBytes > 50_000 ? MCP_SAFE_TIMEOUT : 45_000` — max 50s. Live empirical data (Railway logs, 04-16/04-17) shows single-attempt Opus calls for draft generation reaching ~100s on mature-project inputs (alterra-design-llc, platformforge-v2).
2. **Anthropic SDK retries stack cumulative wall-clock.** Default SDK `maxRetries=2` retries on 408/409/429/500/502/503/504/network/timeout. Each retry gets a fresh `timeout` budget. Observed: 48s (single attempt — success), 144s (3 attempts — last succeeded), 136–151s (retry storm — exhausted to failure). For `draft`, retry storms are worse than fast failure because the user sees a clean fallback response instead of a 2+ minute wait.
3. **No tool-level deadline wrapper on the draft phase.** Commit phase has `FINALIZE_COMMIT_DEADLINE_MS` (S40 C4) as a hard backstop via `Promise.race`. Draft phase does not.

Fix: raise per-attempt timeout, disable retries for draft only, add tool-level deadline, all env-configurable. Commit-phase deadline is untouched.

## Pre-Flight

Run these in order from `prism-mcp-server` repo root. STOP and report if any step fails.

1. `git status` — verify clean worktree, on `main`.
2. `git pull origin main` — sync to latest.
3. `git log --oneline -5` — capture starting HEAD (report this in the final summary).
4. `npm install` — confirm dependencies intact.
5. `npm test` — baseline must be **530 passing, 0 failing**. If the count is not exactly 530 passing OR any test fails, STOP and report exact counts. Pre-existing failures are NOT an acceptable baseline for this brief (INS-26).
6. Read these files FULLY before any edits (do not skim):
   - `src/config.ts` — note the exact pattern of `FINALIZE_COMMIT_DEADLINE_MS` (parseInt + env fallback + `|| N`). Mirror this exactly.
   - `src/tools/finalize.ts` — `draftPhase` function body, `registerFinalize` draft-action handler, and the existing commit-action deadline wrapper (look for `FINALIZE_COMMIT_DEADLINE_SENTINEL`).
   - `src/ai/client.ts` — `synthesize()` is small; read it all.
   - `src/ai/synthesize.ts` — confirm `generateIntelligenceBrief()` call site does NOT pass `maxRetries`. The non-draft call path must retain default SDK retries (retries are fine for background synthesis; this brief only changes draft-phase behavior).

## Changes

### Change 1 — `src/config.ts`

Add two new env-configurable constants. Insert immediately after the existing `FINALIZE_COMMIT_DEADLINE_MS` declaration. Do NOT reorder other exports.

```ts
/** Per-attempt timeout for the Opus call inside prism_finalize draft phase.
 *  Accommodates large-project single-attempt latency (S41 — observed ~100s
 *  ceiling on PF-v2-scale inputs). Configurable via env for per-deployment
 *  tuning. */
export const FINALIZE_DRAFT_TIMEOUT_MS =
  parseInt(process.env.FINALIZE_DRAFT_TIMEOUT_MS ?? "150000", 10) || 150_000;

/** Tool-level wall-clock deadline for the prism_finalize draft phase (S41).
 *  Hard backstop on top of the per-attempt timeout — prevents any retry logic
 *  or unexpected blocking from holding the MCP client connection
 *  indefinitely. Mirrors FINALIZE_COMMIT_DEADLINE_MS pattern. */
export const FINALIZE_DRAFT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_DRAFT_DEADLINE_MS ?? "180000", 10) || 180_000;
```

### Change 2 — `src/ai/client.ts`

Modify `synthesize()` to accept an optional `maxRetries` parameter and forward it to the Anthropic SDK. Default behavior must be preserved: if `maxRetries` is omitted, the SDK default applies (do NOT pass `maxRetries` in the request options in that case).

New signature:

```ts
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
): Promise<SynthesisOutcome>
```

Inside the function, build request options conditionally:

```ts
const requestOptions: { timeout: number; maxRetries?: number } = {
  timeout: timeoutMs ?? MCP_SAFE_TIMEOUT,
};
if (maxRetries !== undefined) {
  requestOptions.maxRetries = maxRetries;
}

const response = await anthropic.messages.create(
  {
    model: SYNTHESIS_MODEL,
    max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  },
  requestOptions,
);
```

Do NOT change any other call sites. `synthesize.ts` (background `generateIntelligenceBrief`) continues calling with 4 args — retries preserved for background synthesis.

### Change 3 — `src/tools/finalize.ts` `draftPhase`

Two edits inside `draftPhase`:

(a) Replace the size-branching timeout logic with the new constant. Locate and remove:
```ts
// Scale timeout: 45s for small projects, 50s for large (capped at MCP_SAFE_TIMEOUT)
const draftTimeoutMs = totalDocBytes > 50_000 ? MCP_SAFE_TIMEOUT : 45_000;
```
Replace with:
```ts
// S41 — single env-configurable timeout. The prior size-branching was
// vestigial (both branches aimed under a 50s MCP_SAFE_TIMEOUT ceiling that
// no longer matches empirical client timeout behavior).
const draftTimeoutMs = FINALIZE_DRAFT_TIMEOUT_MS;
```

(b) Update the `synthesize()` call to disable retries:
```ts
// REMOVE:
const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, draftTimeoutMs);

// REPLACE WITH:
const result = await synthesize(
  FINALIZATION_DRAFT_PROMPT,
  userMessage,
  4096,
  draftTimeoutMs,
  0, // maxRetries — retry storms on draft are worse than fast failure (S41)
);
```

Add `FINALIZE_DRAFT_TIMEOUT_MS` to the existing `"../config.js"` import block in `finalize.ts` (the one that already imports `FINALIZE_COMMIT_DEADLINE_MS`). Do NOT remove `MCP_SAFE_TIMEOUT` from imports — other call sites still use it.

### Change 4 — `src/tools/finalize.ts` `registerFinalize` (draft action)

Add a new sentinel constant near the existing `FINALIZE_COMMIT_DEADLINE_SENTINEL` declaration:

```ts
/** Sentinel used to signal that the finalize-draft deadline fired (S41). */
const FINALIZE_DRAFT_DEADLINE_SENTINEL = Symbol("finalize.draft.deadline");
```

Replace the existing `if (action === "draft") { … }` block in `registerFinalize` with the deadline-wrapped version. Pattern mirrors the commit-phase deadline wrapper exactly — refer to the `raced === FINALIZE_COMMIT_DEADLINE_SENTINEL` block for structure.

```ts
if (action === "draft") {
  const phaseStart = Date.now();

  let draftDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const draftDeadlinePromise = new Promise<typeof FINALIZE_DRAFT_DEADLINE_SENTINEL>((resolve) => {
    draftDeadlineTimer = setTimeout(
      () => resolve(FINALIZE_DRAFT_DEADLINE_SENTINEL),
      FINALIZE_DRAFT_DEADLINE_MS,
    );
  });
  const draftWork = draftPhase(project_slug, session_number);
  const raced = await Promise.race([draftWork, draftDeadlinePromise]);
  if (draftDeadlineTimer) clearTimeout(draftDeadlineTimer);

  if (raced === FINALIZE_DRAFT_DEADLINE_SENTINEL) {
    const deadlineSec = Math.round(FINALIZE_DRAFT_DEADLINE_MS / 1000);
    logger.error("prism_finalize draft deadline exceeded", {
      project_slug,
      deadlineMs: FINALIZE_DRAFT_DEADLINE_MS,
      elapsedMs: Date.now() - phaseStart,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            project: project_slug,
            action: "draft",
            error: `prism_finalize draft deadline exceeded (${deadlineSec}s)`,
            fallback: "Compose finalization files manually.",
          }),
        },
      ],
      isError: true,
    };
  }
  const result = raced;

  logger.info("prism_finalize draft timing", {
    projectSlug: project_slug,
    ms: Date.now() - phaseStart,
  });
  logger.info("prism_finalize draft complete", {
    project_slug,
    success: result.success,
    ms: Date.now() - start,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}
```

Add `FINALIZE_DRAFT_DEADLINE_MS` to the same `"../config.js"` import block (along with `FINALIZE_DRAFT_TIMEOUT_MS` from Change 3).

### Change 5 — Test coverage

Create a NEW test file `tests/finalize-draft-timeout.test.ts`. Do NOT modify existing test files — this brief is strictly additive. Follow the existing test conventions in the `tests/` directory (vitest, same mock patterns). Cross-reference `tests/cc-dispatch.test.ts` (rewritten in S40) or any existing `*-deadline*` / `*-timeout*` test if present.

Exactly three test cases (no more, no less — count is asserted in Verification):

**Test 1:** `draftPhase passes FINALIZE_DRAFT_TIMEOUT_MS and maxRetries=0 to synthesize()`
- Override `process.env.FINALIZE_DRAFT_TIMEOUT_MS = "5000"` BEFORE importing the config module (use `vi.resetModules()` + dynamic import or equivalent — match existing patterns).
- Mock `synthesize()` to capture its args.
- Trigger `draftPhase()` with a stubbed `docMap` and `sessionCommits`.
- Assert `synthesize` was called with `timeoutMs === 5000` and `maxRetries === 0`.
- Reset env after the test.

**Test 2:** `synthesize() forwards maxRetries to Anthropic SDK when provided, omits it otherwise`
- Mock `@anthropic-ai/sdk` so `messages.create` captures its second argument (request options).
- Call `synthesize(sys, user, 100, 10000, 0)` — assert captured options include `maxRetries: 0`.
- Call `synthesize(sys, user, 100, 10000)` (no `maxRetries`) — assert captured options do NOT have a `maxRetries` key (use `expect(options).not.toHaveProperty("maxRetries")`).

**Test 3:** `draft-action deadline wrapper returns structured timeout error on expiry`
- Override `process.env.FINALIZE_DRAFT_DEADLINE_MS = "50"` before import.
- Mock `draftPhase` to return a Promise that never resolves within the test window (e.g., `new Promise(() => {})` — the deadline will resolve the race).
- Simulate an MCP tool call to `registerFinalize` with `action: "draft"`.
- Assert the response has `isError: true` and the text content parses to JSON containing `error: /draft deadline exceeded/`.
- Reset env after the test.

## Verification

Each step MUST pass. If any step fails, STOP and report exact output. Do NOT proceed to Finishing Up if any step fails.

1. `npm run build` — TypeScript compiles with zero errors.
2. `npm test` — count must be **exactly 533 passing, 0 failing** (530 baseline + 3 new tests from Change 5). If the count is not exactly 533 passing, OR any test fails, OR more than 3 new tests were added, STOP and report exact numbers (INS-27: validation claims must be computed explicitly, not eyeballed).
3. `grep -rn "FINALIZE_DRAFT_TIMEOUT_MS" src/` — must show at least 2 hits: export in `config.ts` and usage in `finalize.ts`.
4. `grep -rn "FINALIZE_DRAFT_DEADLINE_MS" src/` — must show at least 2 hits: export in `config.ts` and usage in `finalize.ts`.
5. `grep -n "FINALIZE_DRAFT_DEADLINE_SENTINEL" src/tools/finalize.ts` — exactly 2 hits (declaration + usage in race).
6. `grep -n "maxRetries" src/ai/client.ts` — must show the new parameter in the signature and the conditional request-option assignment.
7. `grep -n "maxRetries: 0" src/tools/finalize.ts` — must show the draft-phase call-site explicitly passing `0`.
8. `grep -c "FINALIZE_COMMIT_DEADLINE_SENTINEL" src/tools/finalize.ts` — count must be exactly 2 (same as before your changes — commit-phase path is untouched).
9. `grep -n "totalDocBytes > 50_000 ? MCP_SAFE_TIMEOUT" src/tools/finalize.ts` — must show ZERO hits. The old size-branching timeout logic must be fully removed.

## Finishing Up

EXACTLY ONE push directive (INS-20). After all Verification steps pass, run this chained command from `prism-mcp-server` repo root. Do NOT split it — no opportunity to exit before push:

```
npm test && npm run build && git add -A && git commit -m "fix: finalize draft phase timeout + deadline + no-retry (S41 FINDING-6/8)" && git push origin main && git log --oneline -3 origin/main
```

After push completes, report:
- Starting HEAD SHA (captured in Pre-Flight step 3)
- Final commit SHA on `origin/main`
- Test count (must be exactly 533)
- Total CC runtime

Do NOT attempt to reconnect the MCP connector, restart the conversation, or verify post-deploy behavior on Railway — those are operator steps per INS-10/INS-11.

<!-- EOF: s41-finalize-draft-timeout.md -->
