# Brief: Fix Synthesis API Timeout Mismatch

## Pre-Flight
- Read `src/ai/synthesize.ts` — the `generateIntelligenceBrief` function
- Read `src/ai/client.ts` — the `synthesize` function signature (note the optional `timeoutMs` param)
- Read `src/config.ts` — find `SYNTHESIS_TIMEOUT_MS` and `MCP_SAFE_TIMEOUT`
- Run `npm test` to confirm baseline passes

## Problem
Synthesis has a 100% failure rate. The `generateIntelligenceBrief` function calls `synthesize(prompt, message)` without passing a timeout. The client defaults to `MCP_SAFE_TIMEOUT` (50s). For large projects like PF-v2 (~80KB+ input docs), Opus 4.6 can't finish in 50s, causing every synthesis to time out.

The finalization pipeline wraps synthesis in a 120s race timeout (`SYNTHESIS_TIMEOUT_MS`), but the inner API call times out at 50s before the outer timeout is ever reached.

## Changes

### 1. `src/ai/synthesize.ts` — Pass timeout to API call
In the `generateIntelligenceBrief` function, find the line:
```typescript
const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage);
```
Change it to:
```typescript
const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage, undefined, SYNTHESIS_TIMEOUT_MS);
```
And add `SYNTHESIS_TIMEOUT_MS` to the existing import from `../config.js` at the top of the file.

Do NOT change SYNTHESIS_MODEL — it stays as Opus 4.6.

## Verification
1. `npm test` — all tests pass, no regressions
2. Verify the `synthesize()` call in `generateIntelligenceBrief` now passes 4 arguments
3. Verify `SYNTHESIS_TIMEOUT_MS` is imported in `src/ai/synthesize.ts`
4. Verify `SYNTHESIS_MODEL` in `src/config.ts` is still `claude-opus-4-6` (unchanged)

## Post-Flight
1. Commit with message: `fix: pass SYNTHESIS_TIMEOUT_MS to API call in generateIntelligenceBrief`
2. Push to main

<!-- EOF: s35-fix-synthesis-timeout.md -->
