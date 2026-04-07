# Brief S32: Atomic Commits + Draft Phase Fix

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- Run `git pull origin main` before starting

## Problem Statement

Two finalization failures observed in PF-v2 S123:

1. **Draft phase timeout:** `draftPhase` sends ALL 10 living documents (~110KB for PF-v2) to Opus 4.6 with a hard 30s timeout. PF-v2's architecture.md (37KB) and glossary.md (32KB) are irrelevant to drafting session log / handoff updates — they burn input tokens and time for zero value.

2. **Parallel push 409 conflicts:** `commitPhase` pushes 3+ files via parallel `pushFile` calls, each creating a separate Git commit on the same branch. GitHub's Contents API returns 409 when two commits race on HEAD. The single-retry logic isn't sufficient when 3+ files race simultaneously.

## Changes

### 1. Add `createAtomicCommit` to `src/github/client.ts`

Add a new exported function that uses the Git Trees API to push multiple files in a single commit:

```typescript
/**
 * Push multiple files as a single atomic commit using Git Trees API.
 * Eliminates 409 race conditions from parallel Contents API pushes.
 * 
 * Steps:
 * 1. GET /repos/{owner}/{repo}/git/ref/heads/main → current HEAD SHA
 * 2. GET /repos/{owner}/{repo}/git/commits/{sha} → base tree SHA  
 * 3. POST /repos/{owner}/{repo}/git/trees → create tree with all files
 * 4. POST /repos/{owner}/{repo}/git/commits → create commit pointing to new tree
 * 5. PATCH /repos/{owner}/{repo}/git/ref/heads/main → update HEAD
 */
export async function createAtomicCommit(
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<{ success: boolean; sha: string; files_committed: number; error?: string }> {
  const start = Date.now();
  logger.debug("github.createAtomicCommit", { repo, fileCount: files.length });

  try {
    // 1. Get current HEAD ref
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/main`;
    const refRes = await fetchWithRetry(refUrl, { headers: headers() });
    if (!refRes.ok) {
      throw handleApiError(refRes.status, await refRes.text(), `getRef ${repo}`);
    }
    const refData = await refRes.json() as { object: { sha: string } };
    const headSha = refData.object.sha;

    // 2. Get base tree from HEAD commit
    const commitUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/commits/${headSha}`;
    const commitRes = await fetchWithRetry(commitUrl, { headers: headers() });
    if (!commitRes.ok) {
      throw handleApiError(commitRes.status, await commitRes.text(), `getCommit ${repo}/${headSha}`);
    }
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // 3. Create new tree with all files
    const treeUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/trees`;
    const treePayload = {
      base_tree: baseTreeSha,
      tree: files.map(f => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        content: f.content,
      })),
    };
    const treeRes = await fetchWithRetry(treeUrl, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(treePayload),
    });
    if (!treeRes.ok) {
      throw handleApiError(treeRes.status, await treeRes.text(), `createTree ${repo}`);
    }
    const treeData = await treeRes.json() as { sha: string };

    // 4. Create commit
    const newCommitUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/commits`;
    const newCommitRes = await fetchWithRetry(newCommitUrl, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [headSha],
      }),
    });
    if (!newCommitRes.ok) {
      throw handleApiError(newCommitRes.status, await newCommitRes.text(), `createCommit ${repo}`);
    }
    const newCommitData = await newCommitRes.json() as { sha: string };

    // 5. Update HEAD ref
    const updateRefRes = await fetchWithRetry(refUrl, {
      method: "PATCH",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommitData.sha }),
    });
    if (!updateRefRes.ok) {
      throw handleApiError(updateRefRes.status, await updateRefRes.text(), `updateRef ${repo}`);
    }

    logger.info("github.createAtomicCommit complete", {
      repo,
      files: files.length,
      sha: newCommitData.sha,
      ms: Date.now() - start,
    });

    return {
      success: true,
      sha: newCommitData.sha,
      files_committed: files.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("github.createAtomicCommit failed", { repo, error: msg, ms: Date.now() - start });
    return {
      success: false,
      sha: "",
      files_committed: 0,
      error: msg,
    };
  }
}
```

IMPORTANT: The `fetchWithRetry` and `handleApiError` functions are file-private (not exported). The new `createAtomicCommit` function MUST be placed in the same file (`src/github/client.ts`) so it can call them directly. Do NOT try to import them from another file.

Also add the `AtomicCommitResult` type to `src/github/types.ts`:

```typescript
/** Result of an atomic multi-file commit via Git Trees API */
export interface AtomicCommitResult {
  success: boolean;
  sha: string;
  files_committed: number;
  error?: string;
}
```

### 2. Refactor `commitPhase` in `src/tools/finalize.ts`

Replace the parallel `pushFile` + per-file verify pattern with `createAtomicCommit`.

The current commit phase flow is:
1. Backup handoff (keep as-is — this is a separate commit intentionally)
2. Prune handoff-history (keep as-is)
3. Validate all files (keep as-is)
4. Guard all paths (keep as-is)
5. **Push all files in parallel** ← REPLACE with `createAtomicCommit`
6. **Verify each file individually** ← REPLACE with single SHA verification

Replace steps 5-6 (the `// 5. Push all files in parallel` section through building the `results` array from `pushResults`) with:

```typescript
    // 5. Push all files in a single atomic commit (eliminates 409 race conditions)
    const guardedFiles = files.map((file, idx) => ({
      path: guardResults[idx].path,
      content: file.content,
    }));

    const isHandoff = files.some(f => f.path === "handoff.md" || f.path === ".prism/handoff.md");
    const commitMessage = isHandoff
      ? `prism: finalize session ${sessionNumber} [${today}]`
      : `prism: session ${sessionNumber} artifacts`;

    const atomicResult = await createAtomicCommit(projectSlug, guardedFiles, commitMessage);

    // 6. Build results array from atomic commit outcome
    const results = guardedFiles.map(f => ({
      path: f.path,
      success: atomicResult.success,
      size_bytes: new TextEncoder().encode(f.content).length,
      verified: atomicResult.success, // atomic commit is all-or-nothing
      validation_errors: atomicResult.success ? [] : [atomicResult.error ?? "Atomic commit failed"],
    }));
```

Update the import at the top of `finalize.ts` to include `createAtomicCommit`:
```typescript
import {
  fetchFile,
  fetchFiles,
  pushFile,
  listDirectory,
  listCommits,
  getCommit,
  deleteFile,
  createAtomicCommit,
} from "../github/client.js";
```

### 3. Make synthesis timeout configurable in `src/ai/client.ts`

Change the `synthesize` function signature to accept an optional timeout:

```typescript
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number
): Promise<SynthesisResult | null> {
```

And update the timeout line:
```typescript
    }, {
      timeout: timeoutMs ?? 30000,
    });
```

### 4. Filter docs in `draftPhase` in `src/tools/finalize.ts`

In the `draftPhase` function, after fetching all living documents via `resolveDocFiles`, filter out the heavy docs that aren't relevant to drafting:

Replace the current doc fetching block:
```typescript
  // 1. Fetch all living documents with backward-compatible resolution
  const docMap = await resolveDocFiles(projectSlug, [...LEGACY_LIVING_DOCUMENTS]);
```

With:
```typescript
  // 1. Fetch only draft-relevant living documents (skip architecture.md and glossary.md — 
  //    they're large and irrelevant to session log / handoff / task queue drafting)
  const DRAFT_RELEVANT_DOCS = LEGACY_LIVING_DOCUMENTS.filter(
    d => d !== "architecture.md" && d !== "glossary.md" && d !== "intelligence-brief.md"
  );
  const docMap = await resolveDocFiles(projectSlug, [...DRAFT_RELEVANT_DOCS]);
```

Also, update the `synthesize` call in `draftPhase` to use a longer timeout (45s):

Change:
```typescript
  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096);
```
To:
```typescript
  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, 45000);
```

### 5. Bump version in `src/config.ts`

Change:
```typescript
export const SERVER_VERSION = "2.11.0";
```
To:
```typescript
export const SERVER_VERSION = "2.12.0";
```

## Verification

1. `npm run build` must succeed with zero errors
2. Verify `createAtomicCommit` is exported from `src/github/client.ts`
3. Verify `commitPhase` in `finalize.ts` calls `createAtomicCommit` instead of parallel `pushFile`
4. Verify `draftPhase` filters out `architecture.md`, `glossary.md`, and `intelligence-brief.md`
5. Verify `synthesize` accepts optional `timeoutMs` parameter
6. Verify `SERVER_VERSION` is `"2.12.0"`
7. Run `grep -rn 'pushFile' src/tools/finalize.ts` — should only appear in backup/prune logic, NOT in the main commit flow
8. Run `grep -rn 'Promise.allSettled' src/tools/finalize.ts` — the commit-phase allSettled for pushing files should be gone (the backup/prune allSettled for deleting old history files is fine to keep)

## Post-Flight

- `git add -A && git commit -m 'fix: atomic commits + draft phase optimization (S32)' && git push origin main`
- Railway auto-deploys on push to main

<!-- EOF: s32-atomic-commits-and-draft-fix.md -->
