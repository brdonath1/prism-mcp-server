# Brief S32b: Fix Synthesis Timeout for Large Projects

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- Run `git pull origin main` before starting

## Problem Statement

`prism_synthesize` and post-finalization synthesis both fail on PF-v2 with "Synthesis API returned null". Root cause: the `synthesize()` function in `src/ai/client.ts` has a 30-second timeout, but PF-v2's full document set is ~130KB (~50K tokens). Opus 4.6 cannot process that input and generate 4K output tokens in 30 seconds.

S32 made `timeoutMs` configurable but only updated the `draftPhase` caller. Two other callers still use the 30s default:
1. `generateIntelligenceBrief()` in `src/ai/synthesize.ts` — called by `prism_synthesize` tool
2. Post-finalization synthesis race in `src/tools/finalize.ts` commitPhase — has an even worse 25s race timeout

Synthesis tracker confirms: 4 attempts, 0 successes, 100% failure rate. Last failure: 91857ms duration.

## Changes

### 1. Update `generateIntelligenceBrief` in `src/ai/synthesize.ts`

Find the `synthesize()` call (around line 67):
```typescript
    const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage);
```

Change to:
```typescript
    const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage, undefined, 120000);
```

120 seconds gives Opus plenty of time for large document sets. The synthesis call is already async and non-blocking to the user.

### 2. Update post-finalization synthesis timeout in `src/tools/finalize.ts`

In the `commitPhase` function, find the synthesis race timeout (search for `25000` or `"Synthesis timed out after 25s"`):
```typescript
      const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: "Synthesis timed out after 25s" }), 25000)
      );
```

Change to:
```typescript
      const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: "Synthesis timed out after 120s" }), 120000)
      );
```

Note: The original comment said "Race synthesis against a 25-second timeout to stay within MCP's 60s limit." This constraint is no longer accurate — MCP tool calls can take longer than 60s (the server streams keep-alive). Update the comment to reflect the new timeout.

### 3. Increase default timeout in `src/ai/client.ts`

The default 30s timeout is too aggressive for any synthesis operation. Change the default:

Find:
```typescript
      timeout: timeoutMs ?? 30000,
```

Change to:
```typescript
      timeout: timeoutMs ?? 60000, // Default 60s; callers can override
```

Also update the comment `// B.4: 30 second timeout` if it still exists near this line.

## Verification

1. `npm run build` must succeed with zero errors
2. `grep -n 'timeout' src/ai/client.ts` — should show `timeoutMs ?? 60000`
3. `grep -n 'timeout' src/ai/synthesize.ts` — should show `120000`
4. `grep -n 'timed out' src/tools/finalize.ts` — should show `120s` not `25s`
5. No other references to the old 30000 or 25000 timeout values in synthesis-related code

## Post-Flight

- `git add -A && git commit -m 'fix: synthesis timeout too aggressive for large projects (S32b)' && git push origin main`
- Railway auto-deploys on push to main

<!-- EOF: s32b-synthesis-timeout-fix.md -->
