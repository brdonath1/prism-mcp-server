# Brief S34b: GitHub Client Resilience + Timeout Architecture

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- **DEPENDENCY:** Brief S34a must be completed first
- `git pull origin main && npm install && npm run build && npm test`
- All tests must pass before starting
- Reference: `docs/audit-s33c.md` for full finding details

## Findings Addressed

| ID | Title | Severity | File(s) |
|----|-------|----------|--------|
| C-3 | MCP client timeout (60s) vs synthesis timeout (120s) mismatch | CRITICAL | `src/tools/finalize.ts`, `src/ai/client.ts` |
| H-1 | 6 GitHub API functions missing retry logic | HIGH | `src/github/client.ts` |
| H-4 | Silent synthesis failure path | HIGH | `src/ai/client.ts`, `src/tools/finalize.ts` |
| H-7 | fileExists has no timeout | HIGH | `src/github/client.ts` |
| H-8 | deleteFile swallows all errors | HIGH | `src/github/client.ts` |
| H-11 | Response body leak in fetchWithRetry on 429 | HIGH | `src/github/client.ts` |
| M-8 | No GitHub 422 validation error handling | MEDIUM | `src/github/client.ts` |
| L-3 | fileExists doesn't consume body on success | LOW | `src/github/client.ts` |
| L-4 | Rate limit retry caps Retry-After at 10s | LOW | `src/github/client.ts` |

## Changes Required

### C-3: Timeout Architecture Fix

**The core problem:** The MCP client (Claude.ai) enforces a ~60s hard timeout on tool calls. But `draftPhase` sets timeouts up to 120s, and post-commit synthesis uses a 120s `Promise.race`. When these exceed 60s, the MCP connection drops, leaving orphaned API calls.

**Fix all synthesis/draft timeouts to stay under 50s** (10s buffer for MCP transport overhead):

1. In `src/tools/finalize.ts`, `draftPhase`: Cap `draftTimeoutMs` at 50,000ms max regardless of doc size. The current tiers (45s/90s/120s from S33) should become (45s/50s/50s):
```typescript
const draftTimeoutMs = totalDocBytes > 50_000 ? 50_000 : 45_000;
```

2. In `src/tools/finalize.ts`, post-commit synthesis: Change the 120s `Promise.race` timeout to 50s:
```typescript
setTimeout(() => resolve({ success: false, error: "Synthesis timed out after 50s" }), 50_000)
```

3. In `src/ai/client.ts`: Change the default timeout from 60s to 50s:
```typescript
timeout: timeoutMs ?? 50_000, // Must stay under MCP's 60s client timeout
```

4. Add a constant in `src/config.ts` documenting the constraint:
```typescript
/** MCP client timeout is ~60s. All server-side operations must complete within 50s
 *  to leave 10s buffer for transport overhead. This constrains synthesis, draft,
 *  and any long-running operations. */
export const MCP_SAFE_TIMEOUT = 50_000;
```

Then use `MCP_SAFE_TIMEOUT` in the relevant files instead of hardcoded values.

### H-1: Add Retry Logic to 6 Functions (`src/github/client.ts`)

These 6 functions use plain `fetch()` instead of `fetchWithRetry()`. Each one needs to be updated:

1. `getFileSize()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`
2. `listDirectory()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`
3. `listCommits()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`
4. `getCommit()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`
5. `fileExists()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`
6. `deleteFile()` — change `fetch(url, ...)` to `fetchWithRetry(url, ...)`

This is a mechanical change — `fetchWithRetry` has the same signature as `fetch` plus optional `maxRetries`.

### H-4: Structured Synthesis Error Returns (`src/ai/client.ts`)

Currently `synthesize()` returns `null` on any failure. Change to return a structured error:

Add new types:
```typescript
export interface SynthesisError {
  success: false;
  error: string;
  error_code: "TIMEOUT" | "AUTH" | "API_ERROR" | "DISABLED";
}

export type SynthesisOutcome = (SynthesisResult & { success: true }) | SynthesisError;
```

Update `synthesize()` to return `SynthesisOutcome` instead of `SynthesisResult | null`. Update all callers to handle the new return type.

### H-7: Add Timeout to fileExists (`src/github/client.ts`)

Add `AbortSignal.timeout(10_000)` to the fetch call. Handle `AbortError` in catch — treat timeout as "file does not exist."

### H-8: Structured deleteFile Returns (`src/github/client.ts`)

Change return type from `boolean` to `{ success: boolean; error?: string }`. Update callers.

### H-11: Response Body Leak on 429 Retry (`src/github/client.ts`)

Add `await res.body?.cancel()` before retry continues in `fetchWithRetry()`.

### L-3: fileExists Body Consumption

Add `await res.body?.cancel()` after the `res.ok` check in `fileExists()`.

### L-4: Respect Full Retry-After Value

Change to `Math.min(retryAfter * 1000 * Math.pow(2, attempt), 120_000)`.

### M-8: Handle 422 Validation Errors

Add 422 case to `handleApiError()` with validation detail extraction from response body.

## Tests Required

Create `tests/client-resilience-s34b.test.ts`:
- Verify all 6 functions reference `fetchWithRetry` in source
- Verify `fileExists` has `AbortSignal.timeout`
- Verify `deleteFile` returns structured object
- Verify 429 body cancellation
- Verify 422 handling in `handleApiError`

Create `tests/timeout-architecture.test.ts`:
- Verify `MCP_SAFE_TIMEOUT` exists in config
- Verify no timeout exceeds 50,000ms in finalize.ts
- Verify `synthesize()` return type includes `success` field

## Verification

```bash
npm run build && npm test

for fn in getFileSize listDirectory listCommits getCommit fileExists deleteFile; do
  echo "--- $fn ---"
  grep -A5 "export async function $fn" src/github/client.ts | grep -c "fetchWithRetry"
done

grep "MCP_SAFE_TIMEOUT" src/config.ts
```

## Post-Flight

```bash
git add -A && git commit -m 'fix: GitHub client resilience + timeout architecture (S34b)' && git push origin main
```

<!-- EOF: s34b-client-resilience.md -->
