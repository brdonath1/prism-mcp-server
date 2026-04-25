# S62 Phase 1 Root-Pattern Audit

## Executive Summary

- **Verdict: C (Hybrid)**
- Four of the six Phase 1 failures share a single root pattern: inconsistent application of atomic-commit-with-HEAD-comparison semantics across write-path GitHub mutations. A reusable `safeMutation` primitive extracted from `log-decision.ts`'s primary path (extended with null-safe HEAD comparison, content-refresh-on-retry, and delete support) would close all four. The remaining two failures (fetch.ts error classification and patch.ts missing deadline) are genuinely independent issues requiring targeted, small fixes.
- **Recommended next action:** Replace the queued six-brief sequence with a three-brief sequence: (1) architectural brief extracting the `safeMutation` primitive + migrating the four clustered tools, (2) fetch.ts error-classification quick fix, (3) patch.ts deadline quick fix. Estimated net savings: 2-3 sessions vs. the original six-brief queue.

---

## Per-Failure Analysis

### KI-23 -- finalize.ts deleteFile pruning

**Location at HEAD:** `src/tools/finalize.ts` lines 484-506, specifically the parallel `deleteFile` calls at lines 497-501.

```typescript
// Line 495-501 (finalize.ts)
if (handoffFiles.length > 3) {
  const toDelete = handoffFiles.slice(3);
  await Promise.allSettled(
    toDelete.map((f) =>
      deleteFile(projectSlug, f.path, `chore: prune old handoff backup ${f.name}`)
    )
  );
}
```

The outer `catch` at lines 503-505 swallows all errors with a comment `// handoff-history may not exist or pruning failed -- non-critical`. The `Promise.allSettled` results are never inspected. No diagnostic is emitted for individual delete failures.

**Root-cause categorization:**
1. **Concurrency-on-shared-SHA.** Each parallel `deleteFile` call (client.ts lines 486-514) fetches the file's blob SHA via `fetchSha` (line 492), then issues a DELETE. GitHub's Contents API internally advances the HEAD ref on each successful delete. When multiple deletes run concurrently, the first one advances HEAD, and all subsequent ones fail with HTTP 409 because the HEAD ref has moved. The known-issues.md confirms this: *"All four had the same expected/actual SHA pair, indicating a single batch where every parallel delete used a base SHA from before any of the deletes landed."*
2. **Silent-error-classification.** `deleteFile` returns `{ success: false, error }` on failure (client.ts lines 503-504), but the caller in finalize.ts never inspects `Promise.allSettled` results. Failures go only to Railway structured logs, invisible to the chat operator.

**Primitive cross-reference:** `push.ts` and `log-decision.ts` both use `createAtomicCommit` (client.ts lines 598-700) to batch multiple file writes into a single Git Trees API commit, eliminating the parallel-Contents-API 409 race. The prune step does NOT use this pattern. However, `createAtomicCommit` currently supports only file writes (adding/updating via tree entries with `content`). File deletes would require extending the Git Trees API call to include tree entries with `sha: null` or building a complete tree without the deleted files. The GitHub API supports both approaches.

**Hypothesis test: PARTIAL.** The root cause (parallel Contents API operations racing on HEAD) is identical to the pattern that `createAtomicCommit` was built to solve for writes. However, the current primitive does not support deletes. Migrating the prune step to the atomic-commit pattern requires extending `createAtomicCommit` with delete support. This is a natural extension of the same primitive, not a fundamentally different mechanism.

---

### log-insight.ts silent-data-loss race

**Location at HEAD:** `src/tools/log-insight.ts` lines 67-81 (fetch), lines 118-145 (content mutation), lines 148-153 (push).

```typescript
// Lines 67-75: fetch current content
const resolved = await resolveDocPath(project_slug, "insights.md");
content = resolved.content;  // <-- snapshot taken here

// Lines 139-145: mutate content in-memory
if (content.includes(formalizedMarker)) {
  content = content.replace(formalizedMarker, `${entry}\n\n${formalizedMarker}`);
} ...

// Lines 148-153: push with pre-computed content
const result = await pushFile(
  project_slug,
  insightsResolvedPath,
  content,          // <-- stale content used here
  `prism: ${id} ${title}`
);
```

**Root-cause categorization: Stale-precomputed-content-on-retry.** The tool fetches `insights.md` once (line 72-75), builds the new content locally (lines 118-145), then pushes via `pushFile`. If a concurrent write modifies `insights.md` between the fetch and the push, `pushFile`'s 409-retry path (client.ts lines 236-249) refreshes the file's blob SHA but reuses the **same pre-computed `content`**:

```typescript
// client.ts lines 236-249 -- pushFile 409 retry
if (res.status === 409) {
  try {
    const freshSha = await fetchSha(repo, path);  // fresh SHA...
    body.sha = freshSha;
  } catch { delete body.sha; }
  res = await fetchWithRetry(url, {
    ...putOptions,
    body: JSON.stringify(body),  // ...but same stale content
  });
}
```

The retry succeeds (SHA now matches current file), but the pushed content was built from the pre-409 file state. Any concurrent write (e.g., insight A written by another call) is silently overwritten. The known-issues.md accurately describes this as: *"The second's `pushFile` 409s, retries with the refreshed SHA -- but the retry pushes its OWN pre-computed `content` (built from the pre-409 fetch), which overwrites the first insertion. Result: insight A is silently destroyed."*

**Primitive cross-reference:** `log-decision.ts` lines 183-192 use `createAtomicCommit` with HEAD comparison. If the atomic commit fails due to a concurrent write, the HEAD-comparison check (lines 202-206) detects the change and either aborts or falls back with awareness. `log-insight.ts` has NONE of this infrastructure -- no `createAtomicCommit`, no `getHeadSha`, no HEAD comparison. It relies entirely on bare `pushFile`, which has the stale-content-on-retry bug.

**Hypothesis test: YES.** Migrating `log-insight.ts` to atomic-commit-with-HEAD-comparison would close this completely. When HEAD changes between the initial read and the atomic commit attempt, the tool would detect the conflict and either (a) reject with a diagnostic, or (b) re-read `insights.md`, re-run dedup, rebuild content, and retry the atomic commit with fresh data.

---

### fetch.ts non-404 error classification

**Location at HEAD:** `src/tools/fetch.ts` lines 69-97 (Promise.allSettled with inner try/catch), lines 99-149 (result mapping), lines 152-155 (diagnostic emission).

The inner try/catch at lines 88-95 correctly differentiates 404 from other errors:

```typescript
// Lines 88-95 (fetch.ts)
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("Not found")) {
    return { path: filePath, exists: false, content: "", sha: "", size: 0 };
  }
  throw error;  // <-- non-404 errors re-thrown
}
```

Non-404 errors (5xx, timeout, rate limit) are correctly re-thrown and become `rejected` outcomes in `Promise.allSettled`. But the result mapping at lines 140-149 collapses ALL rejected outcomes into the "file not found" shape:

```typescript
// Lines 140-149 (fetch.ts)
// Failed to fetch
return {
  path: files[idx],
  exists: false,       // <-- indistinguishable from genuinely missing file
  size_bytes: 0,
  content: null,
  summary: null,
  is_summarized: false,
};
```

The diagnostic emission at lines 152-155 then emits `FILE_NOT_FOUND` for ALL `!exists` results, regardless of whether the file is genuinely absent or the fetch errored:

```typescript
// Lines 152-155 (fetch.ts)
for (const fr of fileResults) {
  if (!fr.exists) {
    diagnostics.warn("FILE_NOT_FOUND", `File not found: ${fr.path}`, { path: fr.path });
  }
}
```

**Root-cause categorization: Silent-error-classification.** Operational errors (5xx, timeout, rate limit, network failure) are collapsed into the "file not found" diagnostic. The operator sees `FILE_NOT_FOUND` but cannot distinguish "file genuinely doesn't exist" from "GitHub API is down." This is the exact Phase 0b coverage leak the known-issues.md describes.

**Primitive cross-reference:** This is a **read-only tool** -- it performs no GitHub writes. It has no need for atomic-commit semantics, HEAD comparison, or mutation coordination. The fix is purely diagnostic: differentiate rejected outcomes from fulfilled-but-missing outcomes, and emit a distinct code (e.g., `FILE_FETCH_ERROR`) for operational failures.

**Hypothesis test: NO.** This failure has nothing to do with atomic-commit-with-HEAD-comparison semantics. It is a read-path error-classification issue. No amount of write-path primitive extraction would address it.

---

### log-decision.ts atomic fallback partial-state

**Location at HEAD:** `src/tools/log-decision.ts` lines 183-244.

The primary path (lines 183-200) correctly uses `createAtomicCommit` with HEAD comparison:

```typescript
// Lines 183-192 (log-decision.ts)
const headShaBefore = await getHeadSha(project_slug);
const atomicResult = await createAtomicCommit(
  project_slug,
  [
    { path: indexResolvedPath, content: indexContent },
    { path: domainResolvedPath, content: domainContent },
  ],
  commitMessage,
);
```

When the atomic commit fails AND HEAD is unchanged (the "safe to retry" branch), the tool falls back to sequential `pushFile` at lines 218-244:

```typescript
// Lines 224-235 (log-decision.ts) -- sequential fallback
const indexResult = await pushFile(
  project_slug,
  indexResolvedPath,
  indexContent,       // <-- pre-computed content, not refreshed
  commitMessage,
);
const domainResult = await pushFile(
  project_slug,
  domainResolvedPath,
  domainContent,      // <-- pre-computed content, not refreshed
  commitMessage,
);
```

**Root-cause categorization:**
1. **Partial-state-on-fallback.** If the `_INDEX.md` pushFile succeeds (line 224-229) but the domain file pushFile fails (line 230-235), the state is inconsistent: `_INDEX.md` references decision D-N, but the domain file entry doesn't exist. Phase 0b diagnostics surface the failure (`INDEX_WRITE_FAILED` at line 223, `DOMAIN_WRITE_FAILED` at line 242), but the partial state is still present in the repo.
2. **Stale-precomputed-content-on-retry.** The fallback uses `indexContent` and `domainContent` computed at lines 131-174, before the atomic attempt. If a concurrent write landed between content computation and the fallback execution, the `pushFile` 409-retry uses stale content (same pattern as log-insight.ts).

**Primitive cross-reference:** The primary path IS the reference implementation for atomic-commit-with-HEAD-comparison. The fallback path is the deviation. The known-issues.md correctly identifies this: *"either remove the sequential fallback (treat any atomic failure as partial-state error) or atomically retry with a refreshed SHA after re-running dedup."*

**Hypothesis test: YES.** The fix is to either (a) eliminate the sequential fallback entirely (treat any atomic failure with unchanged HEAD as a retriable error -- re-read files, re-run dedup, retry atomic commit), or (b) extract the atomic-commit pattern into a primitive that handles retry-with-refresh internally. Both approaches reinforce the atomic-commit pattern rather than deviating from it.

---

### patch.ts deadline/timeout + resolveDocPath silent fallback

**Location at HEAD:** `src/tools/patch.ts` lines 28-141 (entire handler).

**Issue 1 -- Missing deadline (lines 28-141):**

The tool handler has no wall-clock deadline. Compare:
- `push.ts` lines 73-76: `PUSH_WALL_CLOCK_DEADLINE_MS` with sentinel pattern
- `finalize.ts` lines 1040-1055: `FINALIZE_COMMIT_DEADLINE_MS` with sentinel pattern
- `patch.ts`: No deadline, no sentinel, no `Promise.race`

The tool calls `fetchFile` (line 50), applies patches sequentially (lines 56-64), validates (line 84), then calls `pushFile` (lines 100-105). Each individual GitHub API call has a 15s per-request timeout (client.ts `GITHUB_REQUEST_TIMEOUT_MS`), but there is no overall wall-clock deadline. A slow sequence of fetch + N patches + validate + push could exceed the MCP client timeout (~60s) without the tool detecting it.

**Issue 2 -- resolveDocPath silent fallback (lines 37-43):**

```typescript
// Lines 37-43 (patch.ts)
try {
  const resolved = await resolveDocPath(project_slug, baseName);
  resolvedPath = resolved.path;
} catch {
  // Not a living doc or doesn't exist at either location -- use original path
  resolvedPath = file;
}
```

The bare `catch` swallows ALL errors -- not just "file not found" but also 5xx, rate limit, timeout, and network errors. When `resolveDocPath` fails due to a transient API error, the tool silently falls back to the unresolved path and proceeds. The subsequent `fetchFile` on the wrong path may 404 (confusing the operator) or succeed on a different file than intended (silent misdirection). Phase 0b added `PATCH_REDIRECTED` (line 46) for successful redirects, but there is no diagnostic for resolution FAILURE.

**Uncovered issue -- stale-content-on-retry (lines 50-105):**

Not listed in the Phase 1 findings but present in the code. patch.ts follows the same fetch-mutate-pushFile pattern as log-insight.ts:

```typescript
// Line 50-51: fetch
const fileResult = await fetchFile(project_slug, resolvedPath);
let content = fileResult.content;  // <-- snapshot

// Lines 56-64: mutate
for (const patch of patches) {
  content = applyPatch(content, ...);
}

// Lines 100-105: push with pre-computed content
const pushResult = await pushFile(
  project_slug, resolvedPath, content, ...  // <-- stale content on 409 retry
);
```

This is the identical stale-precomputed-content-on-retry vulnerability as log-insight.ts. If a concurrent write modifies the file between the fetch and the push, `pushFile`'s 409-retry will overwrite the concurrent change.

**Root-cause categorization:**
1. **Missing-deadline** -- no wall-clock timeout (independent of atomic-commit semantics)
2. **Silent-error-classification** -- resolveDocPath failure silently falls back (error-classification issue)
3. **Stale-precomputed-content-on-retry** -- same as log-insight (atomic-commit-related, uncovered by Phase 1 audit)

**Primitive cross-reference:** `push.ts`'s deadline pattern (lines 73-76, 296-318) is the reference for the missing deadline. `log-decision.ts`'s atomic-commit primary path is the reference for the stale-content issue.

**Hypothesis test: PARTIAL.** The deadline issue (Issue 1) is genuinely independent of atomic-commit semantics. The resolveDocPath fallback (Issue 2) is an error-classification issue more aligned with fetch.ts. But the stale-content-on-retry issue (Issue 3, uncovered) IS part of the atomic-commit pattern cluster. Migrating patch.ts to the `safeMutation` primitive would close Issue 3 and could incorporate a deadline (closing Issue 1 as a bonus), but Issue 2 needs a separate targeted fix.

---

### push.ts + log-decision.ts getHeadSha-null shared gap

**Location at HEAD:**

`push.ts` lines 156, 176-181:
```typescript
// Line 156
const headShaBefore = await getHeadSha(project_slug);

// Lines 176-181 -- HEAD comparison after atomic failure
let headChanged = false;
if (headShaBefore) {                                    // <-- skips if null
  const headShaAfter = await getHeadSha(project_slug);
  if (headShaAfter) headChanged = headShaAfter !== headShaBefore;  // <-- defaults to false if null
}
```

`log-decision.ts` lines 184, 202-206:
```typescript
// Line 184
const headShaBefore = await getHeadSha(project_slug);

// Lines 202-206 -- identical pattern
let headChanged = false;
if (headShaBefore) {                                    // <-- skips if null
  const headShaAfter = await getHeadSha(project_slug);
  if (headShaAfter) headChanged = headShaAfter !== headShaBefore;  // <-- defaults to false if null
}
```

`finalize.ts` lines 615, 639-645 (same pattern, not listed as a separate failure but also affected):
```typescript
// Line 615
const headShaBefore = await getHeadSha(projectSlug);

// Lines 639-645
let headChanged = false;
if (headShaBefore) {
  const headShaAfter = await getHeadSha(projectSlug);
  if (headShaAfter) {
    headChanged = headShaAfter !== headShaBefore;
  }
}
```

**Root-cause categorization: Silent-error-classification.** `getHeadSha` (client.ts lines 563-577) returns `undefined` on any failure:

```typescript
// client.ts lines 563-577
export async function getHeadSha(repo: string): Promise<string | undefined> {
  try {
    ...
    return refData.object.sha;
  } catch {
    // Non-critical -- caller proceeds without the safety check.
  }
  return undefined;
}
```

When `getHeadSha` returns `undefined` (because the API call failed), the callers treat this as "HEAD unchanged" (`headChanged` remains `false`) and proceed to the fallback path. But the actual state is "unknown" -- HEAD may have changed but we couldn't verify. The safer semantic is "unknown -> possibly changed -> do NOT fall back." The known-issues.md describes this exactly: *"A genuinely-failed getHeadSha could mask a concurrent write and route to the partial-state-prone fallback."*

**Primitive cross-reference:** This is the HEAD-comparison component of the same pattern used by `log-decision.ts`, `push.ts`, and `finalize.ts`. All three have identical code with the identical null-safety gap. A reusable primitive would implement the correct null-handling once.

**Hypothesis test: PARTIAL.** This is specifically about the HEAD-comparison contract within the atomic-commit pattern, not about atomic commits themselves. However, if the atomic-commit-with-HEAD-comparison pattern were extracted as a reusable primitive, the null-handling bug would be fixed once in the primitive rather than patched three times. The fix is small (change `headChanged = false` default to `headChanged = true` when either SHA is null, or surface a "HEAD_UNKNOWN" diagnostic and refuse to fall back), but it's architecturally part of the atomic-commit safety check.

---

## Hypothesis Test Summary

**Hypothesis:** *"All six failures stem from inconsistent application of atomic-commit-with-HEAD-comparison semantics across multi-step GitHub mutations. log-decision's primary path implements this correctly. log-insight, finalize's prune step, patch.ts, fetch.ts's error path, push.ts's getHeadSha-null default, and log-decision's own fallback all deviate. ONE architectural change -- extracting log-decision's pattern into a reusable primitive and migrating all multi-step mutations to use it -- would close all six."*

| # | Failure | Verdict | Evidence (file:line) |
|---|---------|---------|---------------------|
| 1 | KI-23 (finalize prune) | **PARTIAL** | finalize.ts:497-501 -- parallel `deleteFile` races on HEAD, same root cause as pre-atomic-commit pushFile races. Fix requires extending `createAtomicCommit` (client.ts:598-700) to support deletes via Git Trees API. Same primitive, needs extension. |
| 2 | log-insight race | **YES** | log-insight.ts:148-153 -- bare `pushFile` with pre-computed content. No `createAtomicCommit`, no `getHeadSha`, no HEAD comparison. Direct migration to the atomic-commit pattern closes this. |
| 3 | fetch.ts error classification | **NO** | fetch.ts:140-149 -- rejected `Promise.allSettled` outcomes mapped to `exists: false`. Read-only tool with zero GitHub writes. No mutation, no atomic-commit relevance. Needs distinct `FILE_FETCH_ERROR` diagnostic. |
| 4 | log-decision fallback | **YES** | log-decision.ts:224-235 -- sequential `pushFile` fallback uses stale content. Primary path (lines 183-192) is the reference implementation. Eliminating the fallback or retrying atomic-with-refresh closes this. |
| 5 | patch.ts deadline/timeout | **PARTIAL** | patch.ts:28-141 -- missing deadline is independent of atomic-commit semantics. resolveDocPath silent fallback (lines 37-43) is error-classification. BUT: uncovered stale-content-on-retry at lines 50-105 IS the atomic-commit pattern. Two of three sub-issues are independent; one is clustered. |
| 6 | getHeadSha-null gap | **PARTIAL** | push.ts:176-181 + log-decision.ts:202-206 + finalize.ts:639-645 -- null treated as "unchanged" instead of "unknown." Part of the HEAD-comparison mechanism within the atomic-commit pattern. Fixed naturally by extracting the pattern into a primitive with correct null semantics. |

**Hypothesis result: REJECTED as stated.** The hypothesis claims all six share one root cause. Evidence shows: 2 YES, 3 PARTIAL, 1 NO. However, 4 of the 6 failures (KI-23, log-insight, log-decision fallback, getHeadSha-null) strongly cluster around the write-mutation-atomicity pattern. The remaining 2 (fetch.ts, patch.ts deadline) are genuinely independent. The hypothesis is directionally correct but overstates its scope.

---

## Verdict and Rationale

**VERDICT C: Hybrid -- 4 share the write-mutation-atomicity pattern; 2 are independent.**

### The cluster (4 failures)

Four failures share a single root architectural pattern: **write-path GitHub mutations that either bypass or inconsistently apply the atomic-commit-with-HEAD-comparison mechanism that `log-decision.ts`'s primary path implements correctly.**

| Failure | How it deviates from the reference pattern |
|---------|-------------------------------------------|
| KI-23 (finalize prune) | Uses parallel `deleteFile` instead of atomic commit. Same HEAD-racing mechanism, different operation type (delete vs. write). |
| log-insight race | Uses bare `pushFile` with no atomic commit, no HEAD comparison, no conflict detection. Complete absence of the pattern. |
| log-decision fallback | Has the atomic primary path but falls back to sequential `pushFile` with stale content on failure. Undermines its own safety. |
| getHeadSha-null gap | HEAD comparison (used by push.ts, log-decision.ts, finalize.ts) treats `getHeadSha` failure as "safe to retry" instead of "unable to verify." |

One architectural change -- extracting a reusable `safeMutation` primitive -- would close all four. The primitive encapsulates: (1) atomic Git Trees commit with write AND delete support, (2) HEAD SHA comparison with null-safe semantics (null = "unknown" = refuse to fall back), (3) content-refresh-on-retry (re-read affected files and recompute content before retry), (4) diagnostic emission for all failure modes.

### The independents (2 failures)

| Failure | Why it's independent |
|---------|---------------------|
| fetch.ts error classification | Read-only tool. No GitHub writes. The issue is purely about diagnostic emission for non-404 errors in the read path. |
| patch.ts missing deadline | Missing wall-clock timeout infrastructure. Independent of write-mutation semantics (though patch.ts ALSO has the stale-content-on-retry issue -- see below). |

### Bonus finding: patch.ts stale-content-on-retry (uncovered by Phase 1 audit)

The Phase 1 audit listed patch.ts's issues as "deadline/timeout + resolveDocPath silent fallback." However, patch.ts also exhibits the **same stale-precomputed-content-on-retry vulnerability as log-insight.ts** (patch.ts lines 50-105). This was not identified in the S60-S61 audit passes. If the `safeMutation` primitive migration includes patch.ts, this uncovered issue is closed as a side effect.

### Why not Verdict A?

Verdict A would require all six failures to share one root cause. fetch.ts's error-classification issue is categorically different -- it's a read-path problem with no write-mutation component. No amount of atomic-commit primitive extraction addresses it. Additionally, patch.ts's missing deadline is genuinely independent infrastructure, not a mutation-semantics issue.

### Why not Verdict B?

Verdict B would mean six independent fixes. The evidence shows otherwise: four failures exhibit the same deviation from the same reference pattern (log-decision's atomic primary path). Fixing them independently would mean reimplementing the same atomic-commit-with-HEAD-comparison-with-null-safety-with-content-refresh logic in four different tools. That's the definition of a pattern that should be extracted once and reused.

---

## Brief Skeleton (Verdict C -- Architectural Fix for Cluster + Independent Briefs)

### Brief 1: `safeMutation` primitive + clustered tool migration

**Primitive name:** `safeMutation` (or `atomicGitMutation`)

**Conceptual signature:**
```
safeMutation({
  repo: string,
  commitMessage: string,
  readPaths: string[],
  computeMutation: (currentFiles: Map<string, FileContent>) => {
    writes: Array<{ path: string; content: string }>;
    deletes?: string[];
  },
  diagnostics: DiagnosticsCollector,
  maxRetries?: number,      // default 1
  deadlineMs?: number,      // optional wall-clock deadline
}) => Promise<SafeMutationResult>
```

**Key design properties:**
1. Reads all affected files, computes mutations, then executes as a single atomic commit via `createAtomicCommit`.
2. On 409/conflict: re-reads ALL files, re-runs `computeMutation` with fresh data, retries atomic commit. Content is NEVER stale on retry.
3. HEAD comparison uses null-safe semantics: if `getHeadSha` returns `undefined`, treats as "HEAD state unknown -- refuse to fall back to sequential writes."
4. No sequential-pushFile fallback. Atomic-only. If atomic commit fails after retries, surface a structured error with diagnostics.
5. Delete support via Git Trees API: tree entries with `sha: null` to remove files from the tree.
6. Optional wall-clock deadline (mirroring push.ts/finalize.ts sentinel pattern).

**`createAtomicCommit` extension required:** Add optional `deletes: string[]` parameter. For each deleted path, include a tree entry with `sha: null` and `mode: "100644"` in the Git Trees API payload. This is a backwards-compatible extension -- existing callers pass no deletes and behavior is unchanged.

**Files to migrate:**

| Tool file | Current pattern | Migration |
|-----------|----------------|-----------|
| `log-decision.ts` | Atomic primary + sequential fallback | Replace lines 183-244 with `safeMutation` call. Remove fallback entirely. Dedup check moves into `computeMutation`. |
| `log-insight.ts` | Bare `pushFile` | Replace lines 67-153 with `safeMutation` call. Dedup check moves into `computeMutation`. |
| `finalize.ts` prune step | Parallel `deleteFile` | Replace lines 495-501 with `safeMutation` call using `deletes` parameter. |
| `push.ts` | Atomic primary + sequential fallback | Replace lines 156-241 with `safeMutation` call. Remove fallback entirely. |
| `finalize.ts` commit step | Atomic primary + sequential fallback (lines 615-681) | Replace with `safeMutation` call. Remove fallback. |
| `patch.ts` | Bare `pushFile` | Replace lines 50-105 with `safeMutation` call. Add deadline via primitive's `deadlineMs` parameter. |

**Test footprint:**
- Unit tests for `safeMutation` primitive: mock GitHub API, verify atomic-commit path, verify retry-with-refresh on 409, verify null-safe HEAD comparison, verify delete support, verify deadline enforcement.
- Integration tests per migrated tool: verify tool behavior is unchanged on success path, verify conflict detection on concurrent-write path, verify diagnostic emission.
- Estimated: ~15-20 new test cases.

**Rollout sequence:**
- **Option A (single PR):** Extract primitive + migrate all 6 tool callsites. Higher per-PR complexity but ships the complete fix atomically. Preferred if test coverage is comprehensive.
- **Option B (staged, 2 PRs):**
  - PR 1: Extract `safeMutation` + migrate `log-decision.ts` (lowest risk -- already has the pattern, this is primarily extraction). Also extend `createAtomicCommit` with delete support.
  - PR 2: Migrate remaining 5 callsites (`log-insight.ts`, `push.ts`, `finalize.ts` prune + commit, `patch.ts`).

**Risk profile:** Medium. Touches 6 hot-path tool files and the core GitHub client. Mitigated by: (a) the reference implementation already exists and is production-proven in log-decision.ts, (b) comprehensive test coverage of the primitive isolates tool-specific regressions, (c) staged rollout option limits blast radius.

**Complexity vs. six-brief sequence:** The six-brief sequence would produce 6 PRs, each touching 1-2 files, over 4-6 sessions. The architectural approach produces 1-2 PRs over 1-2 sessions, with a single well-tested primitive replacing duplicated logic in 6 files. Net savings: 2-4 sessions and elimination of the root pattern (preventing future recurrence in new tools).

### Brief 2: fetch.ts error-classification fix (independent)

**Scope:** `src/tools/fetch.ts` lines 99-155.

**Change:** In the result mapping (lines 140-149), differentiate rejected `Promise.allSettled` outcomes from fulfilled-but-missing results. Add an `error` field to the response for rejected outcomes. In the diagnostic emission (lines 152-155), emit `FILE_FETCH_ERROR` (with the rejection reason) for operational failures, reserving `FILE_NOT_FOUND` for genuinely missing files.

**Estimated size:** ~20 lines changed. 2-3 test cases.

### Brief 3: patch.ts deadline + resolveDocPath fix (independent)

**Scope:** `src/tools/patch.ts` lines 28-43.

**Changes:**
1. Add wall-clock deadline mirroring `push.ts`'s sentinel pattern. Configurable via env var `PATCH_WALL_CLOCK_DEADLINE_MS` (default 60s).
2. In the resolveDocPath catch (lines 40-43), differentiate "not found" from operational errors. On operational errors, emit `PATCH_RESOLVE_FAILED` diagnostic and either abort or fall back with explicit warning.

**Note:** If Brief 1 migrates patch.ts to `safeMutation`, the deadline is handled by the primitive's `deadlineMs` parameter and the resolveDocPath fallback moves into the `computeMutation` function. In that case, Brief 3 reduces to just the resolveDocPath diagnostic fix.

**Estimated size:** ~30 lines changed. 3-4 test cases.

---

## Confirmed/Reordered Brief Priority (for independent briefs)

The original Phase 1 priority order was:
1. KI-23 -> 2. log-insight -> 3. fetch.ts -> 4. log-decision fallback -> 5. patch.ts -> 6. getHeadSha-null

**Revised priority order under Verdict C:**

1. **Brief 1: `safeMutation` primitive + cluster migration** (closes original items 1, 2, 4, 6 + bonus patch.ts stale-content fix). Highest leverage. 1-2 sessions.
2. **Brief 2: fetch.ts error-classification** (original item 3). Quick win, ~1 hour of work. Bundle into the same session as Brief 1 if time permits.
3. **Brief 3: patch.ts deadline + resolveDocPath** (original item 5, minus the stale-content issue closed by Brief 1). Quick win, ~1 hour of work. Bundle or standalone.

**Justification for reorder:** The original priority order optimized for "most-ready first" -- KI-23 had the clearest fix path. Under Verdict C, the cluster is addressed as a unit, so individual readiness is less relevant. The architectural brief is prioritized because it closes 4 failures (67% of the Phase 1 list) in one shot. The two independent briefs are trivially small and can be bundled into the architectural brief's session or the following one.

---

## Appendix

### HEAD SHAs read for each file

All files read at HEAD commit `a0b7483ab75ef226272cdf32f4f559283533f605` (`prism: Phase 0a + INS-174 bundle (#10)`).

| File | Blob SHA at HEAD |
|------|-----------------|
| `src/tools/finalize.ts` | `65689078a1f6edd24cef8d9385034bb5b87a3a01` |
| `src/tools/log-insight.ts` | `4f61032e996deed094af242d28f3b5f38ae12d74` |
| `src/tools/log-decision.ts` | `10f4f1dec281f8b0f628bbcf9528954048c2e415` |
| `src/tools/fetch.ts` | `bbed6af16ebfe7b24ccc187357ebf9d08d17b306` |
| `src/tools/patch.ts` | `f683ef195ad2ff9a445a1671b31acdfd1ccaf902` |
| `src/tools/push.ts` | `e8caac0da9df70988249052bc78234fe911440f1` |
| `src/github/client.ts` | `c072f1bcebd3195fdaa2f213a345a4a162f2407d` |
| `src/utils/diagnostics.ts` | `769364d61af92967144f0fb84460763f88504866` |

Note: Blob SHAs for `finalize.ts`, `log-insight.ts`, `log-decision.ts`, and `fetch.ts` match the SHAs recorded in the S60-S61 audit findings in `known-issues.md`. `push.ts` and `patch.ts` blob SHAs differ from the S60 audit (SHAs `4e2426dc...` and `9a347ff6...` respectively) because Phase 0a modified these files.

### Per-file primitives inventory

| Primitive | Used in | Purpose |
|-----------|---------|---------|
| `createAtomicCommit` | push.ts, finalize.ts (commit step), log-decision.ts, scale.ts | Multi-file atomic write via Git Trees API |
| `getHeadSha` | push.ts, finalize.ts, log-decision.ts | HEAD SHA snapshot for conflict detection |
| `pushFile` (with 409 retry) | log-insight.ts, patch.ts, finalize.ts (backup), log-decision.ts (fallback), push.ts (fallback) | Single-file write via Contents API |
| `deleteFile` | finalize.ts (prune step) | Single-file delete via Contents API |
| `fetchWithRetry` | All GitHub operations | Rate-limit retry + per-request timeout |
| `DiagnosticsCollector` | All tool handlers | Structured diagnostic emission |
| Deadline sentinel pattern | push.ts, finalize.ts (commit + draft) | Wall-clock timeout via `Promise.race` |

### Existing diagnostic codes (from DiagnosticsCollector usage across tools)

| Code | Level | Tool(s) | Description |
|------|-------|---------|-------------|
| `SYNTHESIS_TIMEOUT` | error | finalize.ts, synthesize.ts | Synthesis/draft deadline exceeded |
| `SYNTHESIS_RETRY` | error | synthesize.ts | Synthesis API call failed |
| `SYNTHESIS_SKIPPED` | warn | finalize.ts | Post-finalization synthesis skipped |
| `STANDING_RULE_DUPLICATE_ID` | warn | log-insight.ts | Duplicate insight ID rejected |
| `DEDUP_TRIGGERED` | warn | log-decision.ts | Duplicate decision ID rejected |
| `INDEX_WRITE_FAILED` | error/warn | log-decision.ts | _INDEX.md write failed (atomic or fallback) |
| `DOMAIN_WRITE_FAILED` | error | log-decision.ts | Domain file write failed (fallback) |
| `PATCH_REDIRECTED` | warn | patch.ts | Path resolved to different location |
| `PATCH_PARTIAL_FAILURE` | error | patch.ts | One or more patch operations failed |
| `FILE_NOT_FOUND` | warn | fetch.ts | File not found (or fetch error -- the bug) |
| `SUMMARY_MODE_TRIGGERED` | info | fetch.ts | Summary mode applied to large files |
| `VALIDATION_WARNING` | warn | push.ts | Validation failure or message mismatch |
| `PUSH_RETRY_ON_CONFLICT` | error/warn | push.ts | Atomic commit conflict (HEAD changed or fallback) |
| `PARTIAL_COMMIT` | error | finalize.ts | Not all files pushed successfully |
| `SLUG_RESOLVED_DYNAMICALLY` | warn | bootstrap.ts | Project slug resolved via fuzzy match |
| `HANDOFF_SCALING_RECOMMENDED` | warn | bootstrap.ts | Handoff exceeds size threshold |
| `PREFETCH_FAILED` | warn | bootstrap.ts | Living document prefetch failed |
| `BRIEF_STALE` | warn | bootstrap.ts | Intelligence brief is stale |
| `BOOT_TEST_FAILED` | warn | bootstrap.ts | Boot-test write probe failed |
| `BOOTSTRAP_OVERSIZE` | error/warn | bootstrap.ts | Response exceeds size threshold |
| `NO_RESULTS_BUT_QUERY_NONEMPTY` | warn | search.ts | Search returned no results |
| `METRIC_PARTIAL_DATA` | warn | analytics.ts | Health metrics incomplete |
| `HEALTH_NEEDS_ATTENTION` | warn | status.ts | Project health degraded |
| `STATUS_PARTIAL` | warn | status.ts | Some projects unhealthy |
| `MIGRATION_FAILED` | error/warn | scale.ts | Scale/migration operation failed |
| `SCALE_PLAN_INCOMPLETE` | warn | scale.ts | Scale operation incomplete |

### Missing diagnostic codes (identified by this audit)

| Proposed Code | Tool | Purpose |
|---------------|------|---------|
| `DELETE_FILE_FAILED` | finalize.ts | Individual deleteFile failure in prune step (KI-23) |
| `FILE_FETCH_ERROR` | fetch.ts | Non-404 operational error distinguished from missing file |
| `PATCH_RESOLVE_FAILED` | patch.ts | resolveDocPath operational failure (not just redirect) |
| `HEAD_SHA_UNKNOWN` | push.ts, log-decision.ts, finalize.ts | getHeadSha returned null -- HEAD state unverifiable |
| `MUTATION_CONFLICT` | safeMutation primitive | Atomic commit conflict detected, retrying with fresh content |
| `MUTATION_RETRY_EXHAUSTED` | safeMutation primitive | Max retries exceeded on atomic commit |

<!-- EOF: s62-phase1-root-pattern-audit.md -->
