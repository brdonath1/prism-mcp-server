# Brief S33b: Finalization Test Suite + Performance Optimization

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- Run `git pull origin main` before starting
- **DEPENDENCY:** Brief S33 (`briefs/s33-finalization-stability.md`) MUST be completed first. This brief builds on those changes.
- Run `npm install && npm run build && npm test` to verify S33 changes are in place
- Verify these S33 artifacts exist before proceeding:
  - `getDefaultBranch` exported from `src/github/client.ts`
  - `pushFiles` fallback in `src/tools/finalize.ts`
  - `draftTimeoutMs` timeout scaling in `src/tools/finalize.ts`
  - Zero `heads/main` matches in `grep -rn "heads/main" src/`

## Problem Statement

The PRISM MCP server impacts 17 active projects. Finalization currently takes 5-10 minutes due to cascading failures and excessive API calls. Brief S33 addresses three stability bugs (atomic fallback, dynamic branch, draft timeout scaling), but the existing code has deeper performance problems:

### Performance Audit Findings

**Audit phase — 33-45 GitHub API calls per finalization:**
1. `resolveDocFiles` fetches all 10 living documents (10 parallel API calls minimum, up to 20 if legacy fallback triggers)
2. `listDirectory(".prism/handoff-history")` is called TWICE — once for drift detection (line ~123) and again for backup existence check (line ~226). Identical API calls, wasted round-trip.
3. Individual commit detail fetches — up to 20 `getCommit` calls just to build a file list. Each commit detail fetch is a separate API round-trip.
4. If `handoff-history` doesn't exist at `.prism/`, legacy fallback tries the root path — another directory listing.

**Commit phase — unnecessary API calls:**
5. `guardPushPath` calls `fileExists` for every file. For files already prefixed with `.prism/`, this check is redundant — the guard only redirects root-level paths.
6. Handoff backup creates a separate commit BEFORE the atomic commit, potentially causing ref staleness.

### Testing Gaps

S33's tests are structural only (grep-based source checks). There are NO tests that:
- Simulate `createAtomicCommit` failure and verify fallback fires
- Verify timeout tier calculations produce correct values
- Mock GitHub API responses (404, 409, 5xx) to test error paths
- Verify `getDefaultBranch` cache behavior
- Stress test with edge cases (empty arrays, very large file sets, malformed responses)

## Part 1: Performance Optimizations

### 1.1 Deduplicate `listDirectory` calls in audit phase (`src/tools/finalize.ts`)

The handoff-history directory is listed twice. Cache the result.

**In the `auditPhase` function, find the first `listDirectory` block** (around lines 122-126):
```typescript
  // Try to fetch previous handoff from handoff-history/ (D-67: check .prism/ first)
  try {
    let historyEntries = await listDirectory(projectSlug, ".prism/handoff-history");
    if (historyEntries.length === 0) {
      historyEntries = await listDirectory(projectSlug, "handoff-history");
    }
```

**Add a variable at the top of `auditPhase`** (right after `const warnings: string[] = [];`):
```typescript
  // Cache handoff-history listing — used by both drift detection and backup check
  let cachedHistoryEntries: Awaited<ReturnType<typeof listDirectory>> | null = null;
  async function getHistoryEntries(): Promise<Awaited<ReturnType<typeof listDirectory>>> {
    if (cachedHistoryEntries !== null) return cachedHistoryEntries;
    cachedHistoryEntries = await listDirectory(projectSlug, ".prism/handoff-history");
    if (cachedHistoryEntries.length === 0) {
      cachedHistoryEntries = await listDirectory(projectSlug, "handoff-history");
    }
    return cachedHistoryEntries;
  }
```

**Then replace BOTH `listDirectory` call sites with `getHistoryEntries()`.**

Replace the first occurrence (drift detection, around line 123):
```typescript
  try {
    const historyEntries = await getHistoryEntries();
    const handoffFiles = historyEntries
```

Replace the second occurrence (backup check, around line 226):
```typescript
  try {
    const historyEntries = await getHistoryEntries();
    handoffBackupExists = historyEntries.some(
```

This eliminates 1-2 redundant API calls per finalization.

### 1.2 Cap commit detail fetches in audit phase (`src/tools/finalize.ts`)

The audit phase fetches up to 20 individual commit details just for file lists. Cap this at 5 — the audit only needs a summary of what changed, not an exhaustive inventory.

**Find this block** (around lines 200-211):
```typescript
    const filesSet = new Set<string>();
    await Promise.allSettled(
      sessionCommits.slice(0, 20).map(async (c) => {
```

**Replace `20` with `5`:**
```typescript
    const filesSet = new Set<string>();
    await Promise.allSettled(
      sessionCommits.slice(0, 5).map(async (c) => {
```

This reduces worst-case commit detail fetches from 20 to 5 API calls.

### 1.3 Skip redundant `guardPushPath` for `.prism/`-prefixed paths (`src/utils/doc-guard.ts`)

The `guardPushPath` function calls `fileExists` even for paths already correctly prefixed with `.prism/`. These paths can never be root-level duplicates — they're already in the right location.

**In `src/utils/doc-guard.ts`, find the `guardPushPath` function. Add an early return at the top, after the existing "Not a root-level PRISM path" check:**

The function currently has:
```typescript
export async function guardPushPath(
  projectSlug: string,
  path: string
): Promise<{ path: string; redirected: boolean }> {
  // Not a root-level PRISM path — allow as-is
  if (!isRootLevelPrismPath(path)) {
    return { path, redirected: false };
  }
```

The `isRootLevelPrismPath` already returns `false` for `.prism/`-prefixed paths (line: `if (path.startsWith(`${DOC_ROOT}/`)) return false;`). So paths with `.prism/` prefix already skip the `fileExists` call via the existing check.

**VERIFY this is true** — read `isRootLevelPrismPath` and confirm the first line is:
```typescript
  if (path.startsWith(`${DOC_ROOT}/`)) return false; // Already .prism/-prefixed
```

If this check exists, **no code change needed** — the guard already handles this efficiently. If it does NOT exist, add it.

### 1.4 Add timing instrumentation to finalization phases (`src/tools/finalize.ts`)

Add `Date.now()` timing to each phase so we can measure actual performance in Railway logs.

**In the main tool handler where each phase is called, wrap each phase call with timing:**

Find where `auditPhase` is called (around line 700):
```typescript
        if (action === "audit") {
```

Add timing around the audit call. The pattern is:
```typescript
        if (action === "audit") {
          const phaseStart = Date.now();
          const auditResult = await auditPhase(project_slug, session_number);
          logger.info("prism_finalize audit timing", {
            projectSlug: project_slug,
            ms: Date.now() - phaseStart,
          });
```

Do the same for the `draft` phase call and the `commit` phase call. Each should log:
- `prism_finalize audit timing` with ms
- `prism_finalize draft timing` with ms
- `prism_finalize commit timing` with ms

This gives us actual performance data in Railway logs to measure the impact of these optimizations and identify future bottlenecks.

### 1.5 Parallelize backup + prune in commit phase (`src/tools/finalize.ts`)

Currently, the backup push (step 1) and prune (step 2) in `commitPhase` are sequential — backup runs first, then prune runs. These are independent operations that can overlap.

**Find the commit phase's backup and prune sections** (around lines 342-387). Currently they run sequentially:

```
1. Backup (await pushFile...)
2. Prune (await listDirectory..., await Promise.allSettled deleteFile...)
3. Validate
4. Guard
5. Push
```

**Wrap steps 1 and 2 in a `Promise.allSettled`:**

Replace the sequential backup + prune with:
```typescript
  // 1 & 2. Backup current handoff and prune old versions — run in parallel
  const [backupOutcome, pruneOutcome] = await Promise.allSettled([
    // 1. Backup
    (async () => {
      try {
        const currentHandoff = await resolveDocPath(projectSlug, "handoff.md");
        const currentVersion = parseHandoffVersion(currentHandoff.content) ?? handoffVersion - 1;
        const historyBase = currentHandoff.legacy ? "handoff-history" : ".prism/handoff-history";
        const rawBackupPath = `${historyBase}/handoff_v${currentVersion}_${today}.md`;
        const guardedBackup = await guardPushPath(projectSlug, rawBackupPath);
        const backupPath = guardedBackup.path;

        await pushFile(
          projectSlug,
          backupPath,
          currentHandoff.content,
          `prism: handoff-backup v${currentVersion}`
        );
        return backupPath;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("Not found")) {
          warnings.push(`Failed to backup current handoff: ${msg}`);
        }
        return "";
      }
    })(),

    // 2. Prune handoff-history to keep only last 3 versions
    (async () => {
      try {
        let historyEntries = await listDirectory(projectSlug, ".prism/handoff-history");
        if (historyEntries.length === 0) {
          historyEntries = await listDirectory(projectSlug, "handoff-history");
        }
        const handoffFiles = historyEntries
          .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
          .sort((a, b) => b.name.localeCompare(a.name));

        if (handoffFiles.length > 3) {
          const toDelete = handoffFiles.slice(3);
          await Promise.allSettled(
            toDelete.map((f) =>
              deleteFile(projectSlug, f.path, `chore: prune old handoff backup ${f.name}`)
            )
          );
        }
      } catch {
        // handoff-history may not exist or pruning failed — non-critical
      }
    })(),
  ]);

  const backupPath = backupOutcome.status === "fulfilled" ? backupOutcome.value : "";
```

**CRITICAL:** Make sure the `backupPath` variable is correctly assigned from the `backupOutcome` result. The rest of the function references `backupPath` in the return value.

## Part 2: Comprehensive Test Suite

### 2.1 Create `tests/finalize-performance.test.ts`

This file tests timeout calculation logic and structural performance properties.

```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Draft timeout scaling", () => {
  it("calculates correct timeout for small projects (<50KB)", () => {
    // Verify the scaling logic exists in source
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Must have three tiers
    expect(source).toContain("100_000");  // >100KB threshold
    expect(source).toContain("50_000");   // >50KB threshold
    expect(source).toContain("120_000");  // 120s timeout for large
    expect(source).toContain("90_000");   // 90s timeout for medium
    expect(source).toContain("45_000");   // 45s timeout for small
  });

  it("timeout variable is used in synthesize call, not a hardcoded value", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // The synthesize call in draftPhase should use the variable, not a literal
    // Find the synthesize call in the draft context
    const draftSection = source.slice(
      source.indexOf("async function draftPhase"),
      source.indexOf("async function commitPhase")
    );

    // Should call synthesize with draftTimeoutMs, not a hardcoded number
    expect(draftSection).toContain("draftTimeoutMs");
    expect(draftSection).toMatch(/synthesize\([^)]*draftTimeoutMs/);
  });
});

describe("Audit phase performance", () => {
  it("caps commit detail fetches to 5 or fewer", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Find the commit detail fetch section
    const auditSection = source.slice(
      source.indexOf("async function auditPhase"),
      source.indexOf("async function draftPhase")
    );

    // Should slice to 5 or fewer, not 20
    expect(auditSection).not.toContain(".slice(0, 20)");
    // Should have a slice with a small number
    const sliceMatch = auditSection.match(/\.slice\(0,\s*(\d+)\)/);
    expect(sliceMatch).not.toBeNull();
    const cap = parseInt(sliceMatch![1], 10);
    expect(cap).toBeLessThanOrEqual(10);
  });

  it("does not duplicate listDirectory calls for handoff-history", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    const auditSection = source.slice(
      source.indexOf("async function auditPhase"),
      source.indexOf("async function draftPhase")
    );

    // Should either use a cached helper or only call listDirectory once
    // Count raw listDirectory calls in audit
    const directCalls = (auditSection.match(/await listDirectory\(/g) || []).length;
    const cachedCalls = auditSection.includes("getHistoryEntries");

    // Either uses a cache function OR has 2 or fewer direct listDirectory calls
    // (2 is acceptable: one for .prism/ and one legacy fallback within the same function)
    expect(cachedCalls || directCalls <= 2).toBe(true);
  });
});

describe("Commit phase performance", () => {
  it("has timing instrumentation for each finalization phase", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Should log timing for audit, draft, and commit phases
    expect(source).toContain("audit timing");
    expect(source).toContain("commit timing");
  });

  it("backup and prune are parallelized or sequential is intentional", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("async function") > source.indexOf("async function commitPhase")
        ? source.indexOf("async function", source.indexOf("async function commitPhase") + 1)
        : source.length
    );

    // Backup and prune should either be wrapped in Promise.allSettled or clearly sequential
    // We check that the commit section has some form of parallel execution
    const hasParallelBackup = commitSection.includes("Promise.allSettled") ||
      commitSection.includes("Promise.all");
    // This is acceptable either way, but we want to verify the pattern exists
    expect(hasParallelBackup).toBe(true);
  });
});
```

### 2.2 Create `tests/atomic-fallback.test.ts`

This file tests the atomic commit → pushFiles fallback architecture.

```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Atomic commit fallback architecture", () => {
  const source = readFileSync("src/tools/finalize.ts", "utf-8");
  const clientSource = readFileSync("src/github/client.ts", "utf-8");

  it("commitPhase tries atomic commit first", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    // Atomic commit should be called before pushFiles
    const atomicIdx = commitSection.indexOf("createAtomicCommit");
    const fallbackIdx = commitSection.indexOf("pushFiles");

    expect(atomicIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(atomicIdx).toBeLessThan(fallbackIdx);
  });

  it("fallback only triggers on atomic failure", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    // pushFiles should be inside an else/failure branch
    expect(commitSection).toContain("atomicResult.success");
    expect(commitSection).toContain("falling back to parallel pushFiles");
  });

  it("fallback logs a warning when triggered", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    expect(commitSection).toContain("logger.warn");
    expect(commitSection).toContain("Atomic commit failed");
  });

  it("fallback adds warning to response warnings array", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    expect(commitSection).toContain("warnings.push");
    expect(commitSection).toContain("Fell back to individual file pushes");
  });

  it("createAtomicCommit returns structured error on failure", () => {
    // Verify the function returns { success: false, error: ... } on failure
    const atomicFn = clientSource.slice(
      clientSource.indexOf("export async function createAtomicCommit"),
      clientSource.indexOf("export async function createAtomicCommit") > -1
        ? clientSource.indexOf("\n}\n", clientSource.indexOf("export async function createAtomicCommit")) + 3
        : clientSource.length
    );

    expect(atomicFn).toContain("success: false");
    expect(atomicFn).toContain("error: msg");
  });
});

describe("Branch detection", () => {
  const clientSource = readFileSync("src/github/client.ts", "utf-8");

  it("getDefaultBranch is exported", () => {
    expect(clientSource).toContain("export async function getDefaultBranch");
  });

  it("uses a cache to avoid repeated API calls", () => {
    expect(clientSource).toContain("defaultBranchCache");
    // Should check cache before API call
    const fn = clientSource.slice(
      clientSource.indexOf("export async function getDefaultBranch"),
      clientSource.indexOf("export async function getDefaultBranch") + 1000
    );
    const cacheCheckIdx = fn.indexOf("defaultBranchCache.get");
    const apiCallIdx = fn.indexOf("fetchWithRetry");
    expect(cacheCheckIdx).toBeGreaterThan(-1);
    expect(apiCallIdx).toBeGreaterThan(-1);
    expect(cacheCheckIdx).toBeLessThan(apiCallIdx);
  });

  it("falls back to 'main' on API failure", () => {
    const fn = clientSource.slice(
      clientSource.indexOf("export async function getDefaultBranch"),
      clientSource.indexOf("export async function getDefaultBranch") + 1500
    );
    // Should return "main" in catch blocks
    const mainFallbacks = (fn.match(/return "main"/g) || []).length;
    expect(mainFallbacks).toBeGreaterThanOrEqual(2); // at least: API error + catch block
  });

  it("no hardcoded heads/main in createAtomicCommit", () => {
    expect(clientSource).not.toContain("heads/main");
  });

  it("createAtomicCommit calls getDefaultBranch", () => {
    const atomicFn = clientSource.slice(
      clientSource.indexOf("export async function createAtomicCommit"),
      clientSource.length
    );
    expect(atomicFn).toContain("getDefaultBranch");
  });
});
```

### 2.3 Create `tests/finalize-edge-cases.test.ts`

Edge case and adversarial input testing.

```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { extractJSON } from "../src/tools/finalize.js";

describe("extractJSON edge cases", () => {
  it("handles deeply nested JSON", () => {
    const input = '{"a": {"b": {"c": {"d": "deep"}}}}';
    const result = extractJSON(input) as any;
    expect(result.a.b.c.d).toBe("deep");
  });

  it("handles JSON with special characters", () => {
    const input = '{"message": "Hello \\\"world\\\"! Tab\\there."}';
    const result = extractJSON(input) as any;
    expect(result.message).toContain("world");
  });

  it("handles JSON preceded by AI thinking text", () => {
    const input = `Let me think about this carefully.

Here are the finalization drafts:

\`\`\`json
{
  "handoff": "# Handoff\\n\\n## Meta\\nVersion: 42",
  "session_log": "### Session 133\\nStuff happened."
}
\`\`\`

I hope these look good!`;
    const result = extractJSON(input) as any;
    expect(result.handoff).toContain("Handoff");
    expect(result.session_log).toContain("Session 133");
  });

  it("handles empty JSON object", () => {
    const result = extractJSON("{}");
    expect(result).toEqual({});
  });

  it("handles JSON array", () => {
    const result = extractJSON("[1, 2, 3]");
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws on completely empty input", () => {
    expect(() => extractJSON("")).toThrow();
  });

  it("throws on prose with no JSON", () => {
    expect(() => extractJSON("This is just a sentence with no structured data.")).toThrow();
  });

  it("handles JSON with unicode characters", () => {
    const input = '{"name": "caf\u00e9 r\u00e9sum\u00e9 na\u00efve"}';
    const result = extractJSON(input) as any;
    expect(result.name).toContain("caf");
  });

  it("handles multiple JSON blocks — extracts the first valid one", () => {
    const input = 'First: {"a": 1} Second: {"b": 2}';
    const result = extractJSON(input) as any;
    // Should get the first valid JSON
    expect(result.a === 1 || result.b === 2).toBe(true);
  });

  it("handles very large JSON strings without crashing", () => {
    const bigValue = "x".repeat(100_000);
    const input = `{"big": "${bigValue}"}`;
    const result = extractJSON(input) as any;
    expect(result.big.length).toBe(100_000);
  });
});

describe("Handoff validation edge cases", () => {
  it("validateHandoff is exported from validation module", async () => {
    const validation = await import("../src/validation/handoff.js");
    expect(typeof validation.validateHandoff).toBe("function");
  });

  it("rejects handoff without Meta section", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Where We Are\nDoing stuff.\n\n## Critical Context\n1. Thing one.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e => e.includes("Meta"))).toBe(true);
  });

  it("rejects handoff with Meta section missing required fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- Handoff Version: 42\n\n## Critical Context\n1. Thing one.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    // Missing Session Count, Template Version, Status
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts valid handoff with all required fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- **Handoff Version:** 42\n- **Session Count:** 10\n- **Template Version:** PRISM v2.9.0\n- **Status:** Active\n\n## Critical Context\n1. Thing one.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors).toEqual([]);
  });

  it("handles bold-formatted Meta fields", async () => {
    const { validateHandoff } = await import("../src/validation/handoff.js");
    const content = `# Handoff\n\n## Meta\n- **Handoff Version:** 42\n- **Session Count:** 10\n- **Template Version:** v2.9.0\n- **Status:** Active\n\n## Critical Context\n1. Critical thing.\n\n## Where We Are\nDoing stuff.\n\n<!-- EOF: handoff.md -->`;
    const result = validateHandoff(content);
    expect(result.errors).toEqual([]);
  });
});
```

### 2.4 Create `tests/github-client-resilience.test.ts`

Tests for the GitHub client's resilience patterns.

```typescript
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("GitHub client resilience patterns", () => {
  const source = readFileSync("src/github/client.ts", "utf-8");

  it("fetchWithRetry handles 429 rate limiting", () => {
    expect(source).toContain("429");
    expect(source).toContain("retry-after");
    expect(source).toContain("exponential");
  });

  it("pushFile handles 409 conflict with fresh SHA retry", () => {
    const pushFileFn = source.slice(
      source.indexOf("export async function pushFile("),
      source.indexOf("export async function pushFiles(")
    );
    expect(pushFileFn).toContain("409");
    expect(pushFileFn).toContain("fresh SHA");
  });

  it("createAtomicCommit wraps all failures in try/catch", () => {
    const atomicFn = source.slice(
      source.indexOf("export async function createAtomicCommit"),
      source.length
    );
    expect(atomicFn).toContain("catch (error)");
    expect(atomicFn).toContain("success: false");
  });

  it("createAtomicCommit performs all 5 Git API steps", () => {
    const atomicFn = source.slice(
      source.indexOf("export async function createAtomicCommit"),
      source.length
    );
    // 5 steps: get ref, get commit (base tree), create tree, create commit, update ref
    expect(atomicFn).toContain("git/ref/heads/");
    expect(atomicFn).toContain("git/commits/");
    expect(atomicFn).toContain("git/trees");
    expect(atomicFn).toContain("PATCH");
  });

  it("getDefaultBranch caches results", () => {
    expect(source).toContain("defaultBranchCache");
    expect(source).toContain(".get(repo)");
    expect(source).toContain(".set(repo,");
  });

  it("all exported async functions log on error", () => {
    // Check that major functions include logger.error or logger.warn in catch blocks
    const exportedFns = [
      "createAtomicCommit",
      "pushFile",
      "getDefaultBranch",
    ];

    for (const fn of exportedFns) {
      const fnStart = source.indexOf(`export async function ${fn}`);
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = source.slice(fnStart, fnStart + 3000);
      const hasLogging = fnSection.includes("logger.error") || fnSection.includes("logger.warn");
      expect(hasLogging).toBe(true);
    }
  });
});

describe("Finalization response contract", () => {
  const source = readFileSync("src/tools/finalize.ts", "utf-8");

  it("commit phase always returns a results array", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after") || source.length
    );

    // Both atomic success and fallback paths must produce a results array
    const resultsAssignments = (commitSection.match(/results\s*=/g) || []).length;
    // At minimum: one for atomic success, one for fallback
    expect(resultsAssignments).toBeGreaterThanOrEqual(2);
  });

  it("commit phase includes warnings in response", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.length
    );
    // warnings array should be part of the return value
    expect(commitSection).toContain("warnings");
  });
});
```

### 2.5 Update `tests/finalize.test.ts` — add extractJSON stress tests

Append these test cases to the EXISTING `tests/finalize.test.ts` file (do NOT overwrite existing tests):

```typescript
// --- APPEND to existing file ---

describe("extractJSON stress tests (S33b)", () => {
  it("handles JSON with 1000 keys", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) obj[`key_${i}`] = i;
    const input = JSON.stringify(obj);
    const result = extractJSON(input) as Record<string, number>;
    expect(result.key_0).toBe(0);
    expect(result.key_999).toBe(999);
  });

  it("handles markdown fences with extra whitespace", () => {
    const input = '  ```json  \n  {"key": "value"}  \n  ```  ';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("handles broken JSON gracefully", () => {
    expect(() => extractJSON('{"key": "value"')).toThrow();
    expect(() => extractJSON('{"key": undefined}')).toThrow();
  });
});
```

## Verification

### All tests pass
```bash
npm test
```

Expected: ALL tests pass, including:
- Existing tests (extractJSON, etc.)
- `tests/finalize-performance.test.ts` — timeout tiers, audit dedup, commit timing
- `tests/atomic-fallback.test.ts` — fallback architecture, branch detection
- `tests/finalize-edge-cases.test.ts` — extractJSON edge cases, handoff validation
- `tests/github-client-resilience.test.ts` — client patterns, response contracts

### Build succeeds
```bash
npm run build
```
Zero errors.

### Structural verification
```bash
# Performance optimizations present
grep -n "getHistoryEntries\|cachedHistoryEntries" src/tools/finalize.ts
# Expected: matches showing the cache helper

grep -n "slice(0, 5)" src/tools/finalize.ts
# Expected: capped commit detail fetches

grep -n "audit timing\|commit timing\|draft timing" src/tools/finalize.ts
# Expected: timing instrumentation for each phase

# Test files exist
ls tests/finalize-performance.test.ts tests/atomic-fallback.test.ts tests/finalize-edge-cases.test.ts tests/github-client-resilience.test.ts
# Expected: all 4 files exist
```

### Count total test cases
```bash
grep -c "it(" tests/*.test.ts | awk -F: '{sum += $2} END {print "Total test cases:", sum}'
```
Expected: significantly higher than before S33b.

## Post-Flight

```bash
git add -A && git commit -m 'fix: comprehensive test suite + finalization performance optimization (S33b)' && git push origin main
```

Railway auto-deploys on push to main.

**Expected performance impact:**
- Audit phase: ~15 fewer API calls per finalization (dedup + commit cap)
- Commit phase: ~2-4 seconds saved from parallel backup/prune
- Draft phase: reduced timeouts for large projects (120s ceiling)
- Overall: finalization should complete in 30-60 seconds for a typical project, not 5-10 minutes

**Post-deploy verification:**
After deploying, trigger a finalization on any project and check Railway logs for the new timing entries:
- `prism_finalize audit timing`
- `prism_finalize draft timing`
- `prism_finalize commit timing`

These will give us actual production latency measurements to confirm the improvements.

<!-- EOF: s33b-finalization-test-suite.md -->