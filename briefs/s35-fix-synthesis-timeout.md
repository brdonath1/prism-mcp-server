# Brief: Fix Synthesis Timeout + Switch to Sonnet

## Pre-Flight
- Read `src/ai/synthesize.ts` — the `generateIntelligenceBrief` function
- Read `src/ai/client.ts` — the `synthesize` function signature (note the optional `timeoutMs` param)
- Read `src/config.ts` — find `SYNTHESIS_TIMEOUT_MS`, `MCP_SAFE_TIMEOUT`, `SYNTHESIS_MODEL`
- Run `npm test` to confirm baseline passes

## Problem
Two bugs causing synthesis to always time out:

1. **API timeout mismatch:** `generateIntelligenceBrief` calls `synthesize(prompt, message)` without passing a timeout. The client defaults to `MCP_SAFE_TIMEOUT` (50s). For large projects like PF-v2 (~80KB+ input), Opus 4.6 can't finish in 50s.

2. **Model overkill:** Opus 4.6 is slow and expensive for brief generation. Sonnet 4.6 is sufficient for synthesis tasks and completes much faster.

## Changes

### 1. `src/config.ts` — Change default synthesis model
Change the `SYNTHESIS_MODEL` default from `claude-opus-4-6` to `claude-sonnet-4-6`:
```typescript
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-sonnet-4-6";
```

### 2. `src/ai/synthesize.ts` — Pass timeout to API call
In the `generateIntelligenceBrief` function, find the line:
```typescript
const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage);
```
Change it to:
```typescript
const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage, undefined, SYNTHESIS_TIMEOUT_MS);
```
And add the import at the top of the file:
```typescript
import { LEGACY_LIVING_DOCUMENTS, SYNTHESIS_ENABLED, SYNTHESIS_TIMEOUT_MS } from "../config.js";
```
(Add `SYNTHESIS_TIMEOUT_MS` to the existing import from config.js)

### 3. Tests — Update any tests that assert on SYNTHESIS_MODEL
Search for any test that checks the model string. If found, update to expect `claude-sonnet-4-6`. Run:
```bash
grep -rn 'claude-opus-4-6\|SYNTHESIS_MODEL' tests/
```
Update any matches.

## Verification
1. `npm test` — all tests pass, no regressions
2. Verify in `src/config.ts` that SYNTHESIS_MODEL default is now `claude-sonnet-4-6`
3. Verify in `src/ai/synthesize.ts` that the `synthesize()` call passes `SYNTHESIS_TIMEOUT_MS` as the 4th argument
4. Grep for any remaining `claude-opus-4-6` references in config — should only exist in non-synthesis contexts

## Post-Flight
1. Commit with message: `fix: switch synthesis to Sonnet 4.6 + pass correct timeout to API call`
2. Push to main

<!-- EOF: s35-fix-synthesis-timeout.md -->
