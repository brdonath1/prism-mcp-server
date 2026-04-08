# Brief S33: Finalization Stability — Atomic Fallback + Dynamic Branch Detection + Draft Timeout Scaling

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- Run `git pull origin main` before starting
- Run `npm install && npm run build` to verify clean baseline
- Run `npm test` — all existing tests must pass before changes

## Problem Statement

Finalization has become critically unstable across multiple projects. A recent PF-v2 session (S133) required **four recovery attempts** before successfully finalizing, hitting three distinct failure modes in cascade:

1. **Draft phase timeout:** The Opus 4.6 draft call uses a fixed 45s timeout. For PF-v2's ~130KB doc set (even after filtering), this is marginal. When it fails, Claude manually composes the handoff, which introduces formatting errors (missing Meta fields), causing validation failures on the commit phase.

2. **Atomic commit has no fallback:** `createAtomicCommit` (introduced in S32, D-69) is all-or-nothing. If the Git Trees API ref lookup fails for ANY reason (transient GitHub 5xx, ref timing, etc.), the entire commit phase fails with no recovery path. The pre-D-69 approach (`pushFiles` with parallel Contents API calls) was removed entirely — there is no safety net.

3. **Hardcoded `heads/main` branch ref (KI-17):** `createAtomicCommit` hardcodes `heads/main` in two places (GET ref and PATCH ref). Repos with a different default branch (e.g., `master`) fail with a 404 on ref lookup. While current PRISM repos use `main`, this is a correctness bug that will surface eventually.

### Root Cause Analysis

The instability is a **design resilience gap**, not a single bug. S32 replaced the parallel `pushFiles` approach (which had 409 race conditions) with `createAtomicCommit` (which eliminates races but introduces a single point of failure). The correct architecture is: **atomic commit as primary, parallel push as fallback**.

## Changes

### 1. Add `getDefaultBranch()` to `src/github/client.ts`

Add a new exported function that queries the GitHub API for a repo's default branch and caches the result:

```typescript
/**
 * Cache for default branch lookups. Branch name won't change mid-session,
 * so we cache indefinitely per repo.
 */
const defaultBranchCache = new Map<string, string>();

/**
 * Get the default branch for a repo. Cached after first lookup.
 * Falls back to "main" if the API call fails.
 */
export async function getDefaultBranch(repo: string): Promise<string> {
  const cached = defaultBranchCache.get(repo);
  if (cached) return cached;

  try {
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}`;
    const res = await fetchWithRetry(url, { headers: headers() });
    if (!res.ok) {
      logger.warn("getDefaultBranch failed, falling back to 'main'", {
        repo,
        status: res.status,
      });
      return "main";
    }
    const data = (await res.json()) as { default_branch: string };
    const branch = data.default_branch ?? "main";
    defaultBranchCache.set(repo, branch);
    logger.debug("getDefaultBranch resolved", { repo, branch });
    return branch;
  } catch (error) {
    logger.warn("getDefaultBranch error, falling back to 'main'", {
      repo,
      error: (error as Error).message,
    });
    return "main";
  }
}
```

Place this function **before** `createAtomicCommit` in the file. Both the cache `Map` and the function should be at module scope.

### 2. Update `createAtomicCommit()` in `src/github/client.ts` to use dynamic branch

Replace the hardcoded `heads/main` with a call to `getDefaultBranch()`.

**Find this block** (around line 285-290):
```typescript
    // 1. Get current HEAD ref
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/main`;
```

**Replace with:**
```typescript
    // 1. Get current HEAD ref (dynamic branch detection — KI-17)
    const branch = await getDefaultBranch(repo);
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`;
```

The rest of the function remains unchanged — `refUrl` is already used for both the GET (step 1) and PATCH (step 5), so this single change fixes both.

### 3. Add `pushFiles` fallback to `commitPhase` in `src/tools/finalize.ts`

The current `commitPhase` calls `createAtomicCommit` and has no recovery path. Add a fallback to sequential `pushFiles` when atomic commit fails.

**Find this block** (around lines 420-440):
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

**Replace the entire block with:**
```typescript
  // 5. Push all files — atomic commit primary, parallel pushFiles fallback
  const guardedFiles = files.map((file, idx) => ({
    path: guardResults[idx].path,
    content: file.content,
  }));

  const isHandoff = files.some(f => f.path === "handoff.md" || f.path === ".prism/handoff.md");
  const commitMessage = isHandoff
    ? `prism: finalize session ${sessionNumber} [${today}]`
    : `prism: session ${sessionNumber} artifacts`;

  // 5a. Try atomic commit first (single Git Trees API commit — no race conditions)
  const atomicResult = await createAtomicCommit(projectSlug, guardedFiles, commitMessage);

  let results: Array<{
    path: string;
    success: boolean;
    size_bytes: number;
    verified: boolean;
    validation_errors: string[];
  }>;

  if (atomicResult.success) {
    // Atomic commit succeeded — build results from atomic outcome
    results = guardedFiles.map(f => ({
      path: f.path,
      success: true,
      size_bytes: new TextEncoder().encode(f.content).length,
      verified: true,
      validation_errors: [],
    }));
  } else {
    // 5b. Atomic commit failed — fall back to parallel pushFiles
    logger.warn("Atomic commit failed, falling back to parallel pushFiles", {
      repo: projectSlug,
      atomicError: atomicResult.error,
    });
    warnings.push(`Atomic commit failed (${atomicResult.error}). Fell back to individual file pushes.`);

    const pushInputs = guardedFiles.map(f => ({
      path: f.path,
      content: f.content,
      message: commitMessage,
    }));

    const pushResults = await pushFiles(projectSlug, pushInputs);

    results = pushResults.map(pr => ({
      path: pr.path,
      success: pr.success,
      size_bytes: pr.size,
      verified: pr.success,
      validation_errors: pr.success ? [] : [pr.error ?? "Push failed"],
    }));
  }
```

**IMPORTANT:** Verify that `pushFiles` is imported at the top of `finalize.ts`. Check the existing import block from `"../github/client.js"`. If `pushFiles` is NOT listed, add it alongside the existing imports:
```typescript
import {
  fetchFile,
  fetchFiles,
  pushFile,
  pushFiles,
  listDirectory,
  listCommits,
  getCommit,
  deleteFile,
  createAtomicCommit,
} from "../github/client.js";
```

### 4. Scale draft phase timeout based on document size in `src/tools/finalize.ts`

In the `draftPhase` function, calculate total doc size and scale the timeout accordingly.

**Find this block** (around lines 283-298):
```typescript
  // 3. Build prompt and call Opus 4.6
  const userMessage = buildFinalizationDraftMessage(
    projectSlug,
    sessionNumber,
    docMap,
    sessionCommits
  );

  logger.info("Finalization draft: calling Opus", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
  });

  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, 45000);
```

**Replace with:**
```typescript
  // 3. Build prompt and call Opus 4.6
  const userMessage = buildFinalizationDraftMessage(
    projectSlug,
    sessionNumber,
    docMap,
    sessionCommits
  );

  // Calculate total doc size for timeout scaling
  let totalDocBytes = 0;
  for (const [, doc] of docMap) {
    totalDocBytes += new TextEncoder().encode(doc.content).length;
  }

  // Scale timeout: 45s for small projects, 90s for medium, 120s for large
  const draftTimeoutMs = totalDocBytes > 100_000 ? 120_000
    : totalDocBytes > 50_000 ? 90_000
    : 45_000;

  logger.info("Finalization draft: calling Opus", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
    totalDocKB: (totalDocBytes / 1024).toFixed(1),
    timeoutMs: draftTimeoutMs,
  });

  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, draftTimeoutMs);
```

**NOTE:** The `docMap` variable is a `Map<string, { content: string; legacy: boolean }>` returned by `resolveDocFiles`. Each entry has a `.content` property containing the file text. Make sure you access `doc.content` (not just `doc`) when calculating bytes.

### 5. Bump version in `src/config.ts` and `package.json`

In `src/config.ts`, change:
```typescript
export const SERVER_VERSION = "2.12.0";
```
To:
```typescript
export const SERVER_VERSION = "2.13.0";
```

In `package.json`, change:
```json
"version": "2.10.0",
```
To:
```json
"version": "2.13.0",
```

## Verification

Run these checks IN ORDER. All must pass.

### Build & Lint
```bash
npm run build
```
Must complete with zero errors.

### Existing Tests
```bash
npm test
```
All existing tests must still pass.

### Structural Verification
```bash
# 1. getDefaultBranch exists and is exported
grep -n "export async function getDefaultBranch" src/github/client.ts
# Expected: exactly 1 match

# 2. createAtomicCommit uses getDefaultBranch, NOT hardcoded heads/main
grep -n "heads/main" src/github/client.ts
# Expected: ZERO matches — this is the KI-17 fix

# 3. createAtomicCommit uses dynamic branch
grep -n "getDefaultBranch" src/github/client.ts
# Expected: at least 2 matches (function definition + usage in createAtomicCommit)

# 4. Fallback pushFiles in finalize.ts commit phase
grep -n "falling back to parallel pushFiles" src/tools/finalize.ts
# Expected: exactly 1 match

# 5. pushFiles is imported in finalize.ts
grep -n "pushFiles" src/tools/finalize.ts
# Expected: at least 2 matches (import + usage)

# 6. Draft timeout scaling exists
grep -n "draftTimeoutMs" src/tools/finalize.ts
# Expected: at least 3 matches (calculation + log + synthesize call)

# 7. Version bumped
grep -n "SERVER_VERSION" src/config.ts
# Expected: shows "2.13.0"

# 8. No remaining hardcoded heads/main anywhere in src/
grep -rn "heads/main" src/
# Expected: ZERO matches
```

### New Tests

Create `tests/branch-detection.test.ts`:
```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

describe("getDefaultBranch", () => {
  it("is exported from github/client", async () => {
    const client = await import("../src/github/client.js");
    expect(typeof client.getDefaultBranch).toBe("function");
  });
});

describe("createAtomicCommit does not hardcode branch", () => {
  it("source code does not contain heads/main", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/github/client.ts", "utf-8");
    expect(source).not.toContain("heads/main");
    expect(source).toContain("getDefaultBranch");
  });
});
```

Create `tests/finalize-fallback.test.ts`:
```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

describe("finalize commitPhase fallback", () => {
  it("finalize.ts imports pushFiles for fallback", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("pushFiles");
    expect(source).toContain("falling back to parallel pushFiles");
    expect(source).toContain("createAtomicCommit");
  });

  it("finalize.ts has draft timeout scaling", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("totalDocBytes");
    expect(source).toContain("draftTimeoutMs");
  });
});
```

Run all tests including new ones:
```bash
npm test
```

### Final Build
```bash
npm run build
```
Must complete with zero errors after all changes.

## Post-Flight

```bash
git add -A && git commit -m 'fix: finalization stability — atomic fallback + dynamic branch + draft timeout scaling (S33)' && git push origin main
```

Railway auto-deploys on push to main. After deploy completes:
1. Reconnect PRISMv2 MCP Server connector in Claude.ai Settings → Connectors
2. Verify in a new conversation via `tool_search("prism")`

<!-- EOF: s33-finalization-stability.md -->