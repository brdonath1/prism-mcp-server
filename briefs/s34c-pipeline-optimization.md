# Brief S34c: Finalization Pipeline Optimization + Observability

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- **DEPENDENCY:** Briefs S34a and S34b must be completed first
- `git pull origin main && npm install && npm run build && npm test`
- All tests must pass before starting
- Reference: `docs/audit-s33c.md` for full finding details

## Findings Addressed

| ID | Title | Severity | File(s) |
|----|-------|----------|--------|
| H-2 | N+1 fileExists pattern in guardPushPath | HIGH | `src/utils/doc-guard.ts`, `src/tools/finalize.ts` |
| H-3 | Partial failure masking in Promise.allSettled | HIGH | `src/github/client.ts`, `src/tools/finalize.ts` |
| H-6 | Atomic commit fallback risks partial state | HIGH | `src/tools/finalize.ts` |
| H-9 | Synthesis tracker cross-project state leak | HIGH | `src/ai/synthesis-tracker.ts` |
| H-10 | Sequential resolveDocPath — double API fetches | HIGH | `src/utils/doc-resolver.ts` |
| M-4 | LEGACY_LIVING_DOCUMENTS not deprecated | MEDIUM | `src/config.ts` |
| M-5 | No request tracing / correlation ID | MEDIUM | `src/middleware/request-logger.ts`, all tools |
| M-7 | Response size not monitored | MEDIUM | `src/tools/bootstrap.ts` |
| L-1 | defaultBranchCache has no size limit | LOW | `src/github/client.ts` |
| L-2 | MemoryCache doesn't evict expired entries | LOW | `src/utils/cache.ts` |
| L-5 | Response inconsistency across tools | LOW | All `src/tools/*.ts` |
| L-6 | extractJSON array path not fully tested | LOW | `tests/` |

## Changes Required

### H-2: Eliminate N+1 fileExists in guardPushPath

**The problem:** `guardPushPath()` calls `fileExists()` per file to check if `.prism/` version exists. With 10 files in finalize, that's 10 sequential GitHub API calls (~300ms each = 3 seconds).

**Fix:** Add a batch path resolution function to `src/utils/doc-guard.ts`:

```typescript
/**
 * Pre-check which .prism/ paths exist via a single listDirectory call.
 * Returns a Set of existing .prism/ paths for fast lookup.
 */
export async function preloadPrismPaths(projectSlug: string): Promise<Set<string>> {
  try {
    const entries = await listDirectory(projectSlug, DOC_ROOT);
    const paths = new Set<string>();
    for (const entry of entries) {
      paths.add(`${DOC_ROOT}/${entry.name}`);
      if (entry.type === "dir") {
        const subEntries = await listDirectory(projectSlug, `${DOC_ROOT}/${entry.name}`);
        for (const sub of subEntries) {
          paths.add(`${DOC_ROOT}/${entry.name}/${sub.name}`);
        }
      }
    }
    return paths;
  } catch {
    return new Set();
  }
}
```

Then add a `guardPushPathBatch()` that uses the preloaded set instead of calling `fileExists()` per file. Update `commitPhase` in `finalize.ts` to call `preloadPrismPaths()` once, then pass the set to batch guard resolution.

### H-3: Partial Failure Flagging

In `src/github/client.ts`, update `fetchFiles()` and `pushFiles()` to include failure metadata:

For `fetchFiles()`, return:
```typescript
{ files: fileMap, failed: failedPaths, incomplete: failedPaths.length > 0 }
```

For `pushFiles()`, add a summary:
```typescript
{ results: batchResults, failed_count: N, incomplete: boolean }
```

**NOTE:** This changes return types. All callers (bootstrap, finalize, push) must be updated to handle the new shape.

### H-6: Safer Atomic Commit Fallback

In `src/tools/finalize.ts`, when atomic commit fails:
1. Before falling back, check if HEAD SHA changed (partial atomic write)
2. If HEAD changed — do NOT fall back, report partial state
3. If HEAD unchanged — proceed with fallback using sequential `pushFile` calls (not parallel `pushFiles`) to avoid 409 conflicts

### H-9: Scope Synthesis Tracker by Project

In `src/ai/synthesis-tracker.ts`:
1. Change events array to `Map<string, SynthesisEvent[]>` keyed by project slug
2. Accept `projectSlug` parameter in `recordSynthesisEvent()` and `getSynthesisHealth()`
3. Add TTL: drop events older than 24 hours
4. Cap per-project events at 20

### H-10: Batch resolveDocPath with Pre-Check

In `src/utils/doc-resolver.ts`, add `resolveDocFilesOptimized()`:
1. Call `listDirectory(projectSlug, ".prism/")` once
2. For each document, check listing — if present, fetch from `.prism/` directly
3. For documents NOT in listing, fetch from root (legacy)
4. Reduces 20 worst-case API calls to 1 listing + 10 targeted fetches = 11 calls

Mark existing `resolveDocFiles()` as deprecated.

### M-5: Request Correlation ID

In `src/middleware/request-logger.ts`:
1. Generate UUID per request via `crypto.randomUUID()`
2. Attach to request and logger context
3. Include in MCP response for traceability

### M-7: Response Size Monitoring

In `src/tools/bootstrap.ts`:
1. After building response, check `JSON.stringify()` byte length
2. >80KB: log warning; >100KB: log error

### L-1: Cap defaultBranchCache

In `src/github/client.ts`, clear cache if >100 entries before `.set()`.

### L-2: MemoryCache Proactive Eviction

In `src/utils/cache.ts`, add `setInterval` cleanup every 5 minutes with `.unref()`.

### L-5: Response Contract Documentation

Add a comment block in `src/tools/bootstrap.ts` documenting standard response shapes.

### L-6: extractJSON Array Test

Add test case for array extraction with surrounding prose to `tests/finalize-edge-cases.test.ts`.

## Tests Required

Create `tests/pipeline-optimization.test.ts`:
- Verify batch path resolution function exists
- Verify optimized doc resolution exists
- Verify synthesis tracker is project-scoped
- Verify defaultBranchCache has size cap
- Verify response size monitoring in bootstrap

Create `tests/observability.test.ts`:
- Verify correlation ID generation
- Verify partial failure flagging in return types

## Verification

```bash
npm run build && npm test

grep -rn "preloadPrismPaths\|guardPushPathBatch\|resolveDocFilesOptimized" src/
grep -n "randomUUID\|requestId\|correlationId" src/middleware/request-logger.ts
grep -n "setInterval\|evict\|cleanup" src/utils/cache.ts
```

## Post-Flight

```bash
git add -A && git commit -m 'fix: finalization pipeline optimization + observability (S34c)' && git push origin main
```

After all three briefs land:
1. Reconnect PRISMv2 MCP Server connector in Claude.ai Settings → Connectors
2. Start a new conversation and verify via `tool_search("prism")`
3. Trigger a finalization on any project and check Railway logs for timing data + correlation IDs

**Expected cumulative impact of S34a + S34b + S34c:**
- Security: path traversal, timing-safe auth, input validation all hardened
- Performance: 5-10 seconds removed from finalization critical path
- Resilience: all GitHub API calls have retry logic, timeouts, structured errors
- Observability: correlation IDs, response size monitoring, scoped synthesis tracking
- Stability: no more MCP timeout disconnects from oversized synthesis operations

<!-- EOF: s34c-pipeline-optimization.md -->
