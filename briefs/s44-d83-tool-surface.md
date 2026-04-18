# S44 — D-83: Bootstrap tool-surface preloading

> **Session:** 44 (PRISM framework)
> **Decision:** D-83 — Bootstrap response delivers post-boot tool_search queries + expected tool surface
> **Mode:** IMPLEMENTATION (push to main)
> **Repo:** `prism-mcp-server`
> **Prior context:** S43 diagnosed that default `tool_search("prism")` in PRISM Project Instructions loads only 5 of 18 registered tools due to MCP relevance ranking. Verified live with `limit=20` still returning only 7. Two targeted queries together load all 18: `"prism log patch scale synthesize analytics"` + `"railway deploy environment status dispatch"`. This brief ships the server-side fix.

---

## Push directive (INS-20 — stated ONCE, unambiguously)

**PUSH TO MAIN.** Single commit with all changes. Finishing command is the chained form at the bottom of this brief. No intermediate commits. No stop-before-push branch. If any Verification step fails, stop and report — do not push partial work.

---

## Pre-Flight (read and confirm before editing)

1. Working tree is clean. `git status` shows no uncommitted changes.
2. Current test count baseline: run `npm test 2>&1 | tail -20` and record the passing count. Expected: 545 passing. **If baseline differs from 545, note the delta in your run log — do not silently proceed if tests are broken pre-edit.** Pre-existing failures must be identified and flagged; they are not your responsibility to fix in this brief but they MUST be called out.
3. Confirm `src/index.ts` currently registers exactly 18 tools via `register*()` calls:
   - 12 PRISM core: `registerBootstrap`, `registerFetch`, `registerPush`, `registerStatus`, `registerFinalize`, `registerAnalytics`, `registerScaleHandoff`, `registerSearch`, `registerSynthesize`, `registerLogDecision`, `registerLogInsight`, `registerPatch`
   - 4 Railway (gated by `RAILWAY_ENABLED`): `registerRailwayLogs`, `registerRailwayDeploy`, `registerRailwayEnv`, `registerRailwayStatus`
   - 2 Claude Code (gated by `CC_DISPATCH_ENABLED`): `registerCCDispatch`, `registerCCStatus`
   - Verify with: `grep -E "^  register[A-Z]" src/index.ts | wc -l` — expected count is **18**.
4. Confirm `src/tools/bootstrap.ts` builds its response as `const result: Record<string, unknown> = { ... }` around line 370. The new fields will be added inside this object.

If any precondition fails, STOP and report before making changes.

---

## Changes

### Change 1 — NEW FILE: `src/tool-registry.ts`

**Purpose:** Single source of truth for the PRISM MCP tool surface. Both the bootstrap response and the drift-guard tests import from this file, so adding/removing a tool requires exactly one edit.

**Full file content:**

```typescript
/**
 * Tool registry — single source of truth for the PRISM MCP tool surface.
 *
 * D-83 (S44): This file powers two things:
 *  1. The `expected_tool_surface` and `post_boot_tool_searches` fields in
 *     the prism_bootstrap response (src/tools/bootstrap.ts).
 *  2. The drift-guard tests in tests/tool-surface.test.ts that verify the
 *     registry matches what src/index.ts actually registers.
 *
 * When adding a new tool: update TOOL_REGISTRY here, register it in
 * src/index.ts, and (if it doesn't already match an existing query's
 * keywords) extend POST_BOOT_TOOL_SEARCHES so Claude's client-side
 * tool_search surfaces it during boot. The coverage test in
 * tests/tool-surface.test.ts will fail if a tool is added without
 * corresponding keyword coverage.
 */

export type ToolCategory = "prism_core" | "railway" | "claude_code";

export interface ToolRegistryEntry {
  name: string;
  category: ToolCategory;
}

/**
 * All tools registered by the MCP server, in registration order.
 * Mirrors the register*() call order in src/index.ts.
 *
 * Category `prism_core` = always registered.
 * Category `railway` = registered only when RAILWAY_ENABLED.
 * Category `claude_code` = registered only when CC_DISPATCH_ENABLED.
 */
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  // PRISM core (12)
  { name: "prism_bootstrap", category: "prism_core" },
  { name: "prism_fetch", category: "prism_core" },
  { name: "prism_push", category: "prism_core" },
  { name: "prism_status", category: "prism_core" },
  { name: "prism_finalize", category: "prism_core" },
  { name: "prism_analytics", category: "prism_core" },
  { name: "prism_scale_handoff", category: "prism_core" },
  { name: "prism_search", category: "prism_core" },
  { name: "prism_synthesize", category: "prism_core" },
  { name: "prism_log_decision", category: "prism_core" },
  { name: "prism_log_insight", category: "prism_core" },
  { name: "prism_patch", category: "prism_core" },
  // Railway (4)
  { name: "railway_logs", category: "railway" },
  { name: "railway_deploy", category: "railway" },
  { name: "railway_env", category: "railway" },
  { name: "railway_status", category: "railway" },
  // Claude Code (2)
  { name: "cc_dispatch", category: "claude_code" },
  { name: "cc_status", category: "claude_code" },
] as const;

/**
 * Derive the expected tool surface by category, respecting feature flags.
 * Returned shape is suitable for direct inclusion in the bootstrap response.
 */
export function getExpectedToolSurface(
  railwayEnabled: boolean,
  ccDispatchEnabled: boolean,
): Record<ToolCategory, string[]> {
  const filterByCategory = (cat: ToolCategory) =>
    TOOL_REGISTRY.filter((t) => t.category === cat).map((t) => t.name);

  return {
    prism_core: filterByCategory("prism_core"),
    railway: railwayEnabled ? filterByCategory("railway") : [],
    claude_code: ccDispatchEnabled ? filterByCategory("claude_code") : [],
  };
}

/**
 * Post-boot tool_search queries that Claude executes after receiving the
 * bootstrap response. Together these two queries empirically load all 18
 * registered tools (verified live S43). Each query's limit is intentionally
 * set to 20 to defeat the relevance-ranking cap that causes
 * `tool_search("prism", limit=20)` to still return only 7 results.
 *
 * When adding a new tool: verify at least one of these queries contains a
 * keyword that matches the tool's name or description. The coverage test
 * in tests/tool-surface.test.ts enforces this.
 */
export interface PostBootToolSearch {
  query: string;
  limit: number;
}

export const POST_BOOT_TOOL_SEARCHES: readonly PostBootToolSearch[] = [
  { query: "prism log patch scale synthesize analytics finalize", limit: 20 },
  { query: "railway deploy environment status dispatch claude code", limit: 20 },
] as const;

<!-- EOF: tool-registry.ts -->
```

**Notes:**
- Delete the `<!-- EOF: ... -->` HTML comment from the final file — that's a markdown sentinel, not TS syntax. (Kept in this brief for copy-paste clarity; strip during write.)
- `as const` on both arrays makes them deeply readonly in the type system.
- Export `ToolRegistryEntry` and `PostBootToolSearch` interfaces for test use.

**CORRECTION:** Do NOT include the `<!-- EOF: tool-registry.ts -->` line in the final file. TypeScript will fail to parse it. The actual file ends after the closing `] as const;` and a trailing newline.

---

### Change 2 — EDIT: `src/tools/bootstrap.ts`

**Purpose:** Wire the registry into the bootstrap response.

**Edit 2a — add import near the other imports at the top of the file:**

Find the existing import block (roughly lines 18–30). Add this import after the banner import:

```typescript
import { getExpectedToolSurface, POST_BOOT_TOOL_SEARCHES } from "../tool-registry.js";
```

**Edit 2b — add feature-flag imports.** The registry's gating depends on `RAILWAY_ENABLED` and `CC_DISPATCH_ENABLED`. Check the existing config import at the top of bootstrap.ts. It currently imports:

```typescript
import { DOC_ROOT, FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, resolveProjectSlug } from "../config.js";
```

Extend it to also import the two flags:

```typescript
import { CC_DISPATCH_ENABLED, DOC_ROOT, FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, RAILWAY_ENABLED, resolveProjectSlug } from "../config.js";
```

(These flags are already exported from `config.ts` — verify with `grep -E "export.*RAILWAY_ENABLED|export.*CC_DISPATCH_ENABLED" src/config.ts`; if either is missing, STOP and report rather than proceeding — this brief assumes both exist.)

**Edit 2c — add the two new fields to the response object.**

Find the response construction inside the handler. It starts with:

```typescript
        const result: Record<string, unknown> = {
          project: resolvedSlug,
          handoff_version: handoffVersion,
          template_version: handoffTemplateVersion,
          ...
```

and ends with:

```typescript
          warnings,
        };
```

Inside this object, add the two new fields immediately after the existing `context_estimate` field and before `warnings`. The insertion preserves alphabetical-ish ordering among the new additions and keeps warnings last (existing convention):

```typescript
          expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED),  // D-83 (S44)
          post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES,                                     // D-83 (S44)
```

Resulting snippet:

```typescript
          context_estimate: {
            bootstrap_tokens: bootstrapTokens,
            platform_overhead_tokens: platformOverheadTokens,
            tool_schema_tokens: toolSchemaTokens,
            total_boot_tokens: totalBootTokens,
            total_boot_percent: totalBootPercent,
          },
          expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED),  // D-83 (S44)
          post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES,                                     // D-83 (S44)
          warnings,
        };
```

No other edits to bootstrap.ts. No changes to the banner renderer, no changes to log statements, no changes to error paths.

---

### Change 3 — NEW FILE: `tests/tool-surface.test.ts`

**Purpose:** Four guard rails:
1. Shape check — registry has the expected 18 entries and categorization.
2. `getExpectedToolSurface` correctly gates railway/cc by flags.
3. Drift guard — `src/index.ts` calls a `register*()` for every registry entry.
4. Coverage guard — every tool name has keyword overlap with at least one `POST_BOOT_TOOL_SEARCHES` query.
5. Response wiring — `src/tools/bootstrap.ts` imports from the registry and includes both new fields in its response object (source-read; permitted by INS-31 since this is structural registration verification, not HTTP-routing behavior).

**Full file content:**

```typescript
/**
 * tool-surface.test.ts — D-83 guard rails.
 *
 * Per INS-31, HTTP-routing tests must mock fetch. These tests verify registry
 * shape, feature-flag gating, and source-level wiring — not HTTP behavior —
 * so readFileSync-based source checks are acceptable and intentional here.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  TOOL_REGISTRY,
  getExpectedToolSurface,
  POST_BOOT_TOOL_SEARCHES,
  type ToolCategory,
} from "../src/tool-registry.js";

describe("D-83 — TOOL_REGISTRY shape", () => {
  it("contains exactly 18 tools", () => {
    expect(TOOL_REGISTRY).toHaveLength(18);
  });

  it("categorizes 12 prism_core, 4 railway, 2 claude_code", () => {
    const counts: Record<ToolCategory, number> = {
      prism_core: 0,
      railway: 0,
      claude_code: 0,
    };
    for (const t of TOOL_REGISTRY) counts[t.category]++;
    expect(counts).toEqual({ prism_core: 12, railway: 4, claude_code: 2 });
  });

  it("has unique tool names", () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("D-83 — getExpectedToolSurface() feature-flag gating", () => {
  it("returns all 18 tools when both flags enabled", () => {
    const surface = getExpectedToolSurface(true, true);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toHaveLength(4);
    expect(surface.claude_code).toHaveLength(2);
    const flat = [...surface.prism_core, ...surface.railway, ...surface.claude_code];
    expect(flat).toEqual(TOOL_REGISTRY.map((t) => t.name));
  });

  it("excludes railway when RAILWAY_ENABLED=false", () => {
    const surface = getExpectedToolSurface(false, true);
    expect(surface.railway).toEqual([]);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.claude_code).toHaveLength(2);
  });

  it("excludes claude_code when CC_DISPATCH_ENABLED=false", () => {
    const surface = getExpectedToolSurface(true, false);
    expect(surface.claude_code).toEqual([]);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toHaveLength(4);
  });

  it("returns only prism_core when both optional flags disabled", () => {
    const surface = getExpectedToolSurface(false, false);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toEqual([]);
    expect(surface.claude_code).toEqual([]);
  });
});

describe("D-83 — drift guard: src/index.ts registers every TOOL_REGISTRY entry", () => {
  // Tool name -> register function name mapping.
  // If TOOL_REGISTRY names deviate from the register* naming convention, update here.
  const REGISTER_FN_BY_TOOL: Record<string, string> = {
    prism_bootstrap: "registerBootstrap",
    prism_fetch: "registerFetch",
    prism_push: "registerPush",
    prism_status: "registerStatus",
    prism_finalize: "registerFinalize",
    prism_analytics: "registerAnalytics",
    prism_scale_handoff: "registerScaleHandoff",
    prism_search: "registerSearch",
    prism_synthesize: "registerSynthesize",
    prism_log_decision: "registerLogDecision",
    prism_log_insight: "registerLogInsight",
    prism_patch: "registerPatch",
    railway_logs: "registerRailwayLogs",
    railway_deploy: "registerRailwayDeploy",
    railway_env: "registerRailwayEnv",
    railway_status: "registerRailwayStatus",
    cc_dispatch: "registerCCDispatch",
    cc_status: "registerCCStatus",
  };

  const indexSource = readFileSync("src/index.ts", "utf-8");

  it.each(TOOL_REGISTRY.map((t) => [t.name]))(
    "%s has a matching register*() call in src/index.ts",
    (toolName) => {
      const registerFn = REGISTER_FN_BY_TOOL[toolName];
      expect(registerFn, `No REGISTER_FN_BY_TOOL mapping for ${toolName} — update this test`).toBeDefined();
      expect(indexSource).toContain(`${registerFn}(server)`);
    },
  );

  it("REGISTER_FN_BY_TOOL covers every tool (no missing mappings)", () => {
    const missing = TOOL_REGISTRY.filter((t) => !REGISTER_FN_BY_TOOL[t.name]);
    expect(missing).toEqual([]);
  });
});

describe("D-83 — coverage guard: every tool has keyword overlap with POST_BOOT_TOOL_SEARCHES", () => {
  it("every tool shares at least one token with at least one query", () => {
    const queryTokens = new Set(
      POST_BOOT_TOOL_SEARCHES.flatMap((q) =>
        q.query.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
      ),
    );

    const gaps: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      const toolTokens = tool.name.toLowerCase().split("_");
      const hasOverlap = toolTokens.some((tt) =>
        Array.from(queryTokens).some((qt) => qt === tt || qt.includes(tt) || tt.includes(qt)),
      );
      if (!hasOverlap) gaps.push(tool.name);
    }

    expect(
      gaps,
      `Tools with no keyword overlap in POST_BOOT_TOOL_SEARCHES: ${gaps.join(", ")}. ` +
        `Either add a keyword to one of the queries or rename the tool.`,
    ).toEqual([]);
  });

  it("POST_BOOT_TOOL_SEARCHES has exactly 2 queries (S43 empirical)", () => {
    expect(POST_BOOT_TOOL_SEARCHES).toHaveLength(2);
  });

  it("every query has limit >= 15 (defeats relevance-ranking cap)", () => {
    for (const q of POST_BOOT_TOOL_SEARCHES) {
      expect(q.limit).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("D-83 — bootstrap response wiring (source-read)", () => {
  const bootstrapSource = readFileSync("src/tools/bootstrap.ts", "utf-8");

  it("imports getExpectedToolSurface and POST_BOOT_TOOL_SEARCHES from ../tool-registry.js", () => {
    expect(bootstrapSource).toMatch(
      /import\s*\{[^}]*getExpectedToolSurface[^}]*\}\s*from\s*["']\.\.\/tool-registry\.js["']/,
    );
    expect(bootstrapSource).toMatch(
      /import\s*\{[^}]*POST_BOOT_TOOL_SEARCHES[^}]*\}\s*from\s*["']\.\.\/tool-registry\.js["']/,
    );
  });

  it("imports RAILWAY_ENABLED and CC_DISPATCH_ENABLED from ../config.js", () => {
    expect(bootstrapSource).toMatch(/import\s*\{[^}]*RAILWAY_ENABLED[^}]*\}\s*from\s*["']\.\.\/config\.js["']/);
    expect(bootstrapSource).toMatch(/import\s*\{[^}]*CC_DISPATCH_ENABLED[^}]*\}\s*from\s*["']\.\.\/config\.js["']/);
  });

  it("response object includes expected_tool_surface field wired to getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED)", () => {
    expect(bootstrapSource).toContain(
      "expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED)",
    );
  });

  it("response object includes post_boot_tool_searches field wired to POST_BOOT_TOOL_SEARCHES", () => {
    expect(bootstrapSource).toContain("post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES");
  });
});
```

---

## Verification (run ALL of these locally before pushing — fail any, stop)

Per INS-27, every claim below must be computed explicitly via a command, not eyeballed.

1. **Typecheck and build pass.** Run `npm run build`. Expected: zero TypeScript errors. If the build fails with any error mentioning `tool-registry`, `expected_tool_surface`, `RAILWAY_ENABLED`, `CC_DISPATCH_ENABLED`, or `POST_BOOT_TOOL_SEARCHES`, stop and fix before proceeding.

2. **Full test suite passes.** Run `npm test`. Expected: baseline 545 + new tests from `tool-surface.test.ts`. Compute the expected new test count:
   - `describe("D-83 — TOOL_REGISTRY shape")`: 3 tests
   - `describe("D-83 — getExpectedToolSurface() feature-flag gating")`: 4 tests
   - `describe("D-83 — drift guard")`: 18 `it.each` tests + 1 coverage-of-mapping = 19 tests
   - `describe("D-83 — coverage guard")`: 3 tests
   - `describe("D-83 — bootstrap response wiring")`: 4 tests
   - **Total new tests: 33.** Expected final count: `545 + 33 = 578 passing`.
   - If the pre-edit baseline was NOT 545 (per Pre-Flight step 2), adjust: `<actual_baseline> + 33`. Report the computation in your run log.

3. **No pre-existing tests broke.** Compute `before` and `after` passing counts. `after - before` MUST equal exactly 33 (the new tests). If the delta is less, some existing test regressed — stop and identify which.

4. **Drift-guard test proves the wiring.** The test file at `tests/tool-surface.test.ts` has an `it.each` over TOOL_REGISTRY that runs 18 assertions (one per tool). Each one MUST pass. If any fails, it means `src/index.ts` is missing a `registerX(server)` call — fix index.ts, not the test.

5. **Registry size grep sanity check.** Run:
   ```bash
   grep -cE "^\s*\{ name:" src/tool-registry.ts
   ```
   Expected output: `18`.

6. **Source-level integration confirmation.** Run:
   ```bash
   grep -c "expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED)" src/tools/bootstrap.ts
   grep -c "post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES" src/tools/bootstrap.ts
   ```
   Both must output `1`. Zero means the edit didn't land. More than 1 means a duplicate was introduced.

---

## Pre-existing test failure policy (INS-26)

If `npm test` on the pre-edit baseline reveals any FAILING tests already (before your edits), report them in your run log by filename and test name — do NOT fix them, and do NOT count them against your success criteria. Your delta is measured on the passing count. Only failures introduced by your changes count as regressions.

---

## Completion Criteria (all MUST be satisfied — aligns with Verification above)

- [ ] `src/tool-registry.ts` exists with TOOL_REGISTRY (18 entries), getExpectedToolSurface, POST_BOOT_TOOL_SEARCHES (2 entries).
- [ ] `src/tools/bootstrap.ts` imports from `../tool-registry.js` and `../config.js` (extended), and includes `expected_tool_surface` and `post_boot_tool_searches` in the response object.
- [ ] `tests/tool-surface.test.ts` exists and contributes exactly 33 new passing tests.
- [ ] `npm run build` succeeds with zero TypeScript errors.
- [ ] `npm test` passing count equals pre-edit baseline + 33.
- [ ] Single commit pushed to `main`. No extra commits, no leftover local changes.

---

## Finishing Up (single chained command — INS-20)

```bash
npm test && npm run build && git add -A && git commit -m "feat: D-83 bootstrap tool-surface preloading (S44)

- Add src/tool-registry.ts as single source of truth for tool surface
- Extend prism_bootstrap response with expected_tool_surface and post_boot_tool_searches fields
- Add tests/tool-surface.test.ts (33 tests: shape, gating, drift, coverage, wiring)
- Fixes default tool_search('prism') loading only 5 of 18 tools (S43 diagnosis)
- See briefs/s44-d83-tool-surface.md" && git push origin main && git log --oneline -3 origin/main
```

If any step in this chain fails, the commit does NOT push. Do not break the chain into separate steps. Do not run `git commit` and `git push` as separate commands — the chain is intentional per INS-20 to make "failed verification → silent exit" impossible.

---

## Post-Flight

After push succeeds:
1. Railway auto-deploys on push to main. Deploy takes ~60–90s.
2. **No live-verification in this CC run.** The operator (Claude.ai) will handle live-verify post-deploy by calling `prism_bootstrap` on a different project and inspecting the response for the new fields. Do not attempt live verification from the CC environment.
3. Exit cleanly. Do not leave dangling shells.

---

## Out of scope (do NOT do any of these)

- Do not edit `src/index.ts`. The drift-guard test reads it; modifying it silently will cause the test to pass for the wrong reason.
- Do not update `_templates/core-template-mcp.md`. That's a different repo (`prism-framework`) and will be handled ad-hoc by the operator after this deploys.
- Do not update `_templates/banner-spec.md`. That file is stale from the HTML-to-text banner migration and needs a separate cleanup pass.
- Do not refactor `src/index.ts` to iterate the registry. That's a larger change deferred by explicit design.
- Do not modify `src/utils/banner.ts` or the banner text renderer. The Tool Surface checklist is a client-side augmentation, not a server-rendered field.
- Do not touch `src/config.ts` unless `RAILWAY_ENABLED` or `CC_DISPATCH_ENABLED` is not already exported — in which case STOP and report rather than fixing.
- Do not bundle the FINDING-2 logger `level`/`severity` fix into this brief — that's a separate one-line change being handled in a follow-up.

<!-- EOF: s44-d83-tool-surface.md -->
