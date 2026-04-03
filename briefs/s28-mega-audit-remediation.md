# Brief: PRISM Full-Stack Audit Remediation (Mega Brief)

**Session:** S28
**Target Repos:** prism-mcp-server, prism-framework, prism (all under brdonath1/)
**Audit Source:** `reports/s27-full-audit-report.md` in prism-mcp-server repo
**Risk Level:** High — production code changes, data integrity fixes, documentation overhaul
**Estimated Duration:** 45-60 minutes

---

## Pre-Flight

**Context:** This brief addresses ALL findings from the S27 Full-Stack Audit Report. The audit identified 55 findings across 9 dimensions spanning 3 repos. This brief implements every actionable recommendation in a single pass.

**IMPORTANT:** Read `reports/s27-full-audit-report.md` in the prism-mcp-server repo first for full context on each finding. This brief references findings by their audit ID (e.g., B.1, A.4).

**One correction from the audit:** Finding A.5 (guardrail count mismatch) is invalid. The handoff's "10 guardrails" refers to D-1 through D-10 — foundational guardrailed *decisions* — not G-N entries in eliminated.md. The 3 entries in eliminated.md are correct. However, the unnumbered "Architecture D" entry should be designated G-3.

## Step 1: Clone All Three Repos

```bash
cd /tmp
git clone https://github.com/brdonath1/prism-mcp-server.git
git clone https://github.com/brdonath1/prism-framework.git
git clone https://github.com/brdonath1/prism.git
```

## Step 2: Read Key Source Files

Before making changes, read these files to understand current state:

### prism-mcp-server
```bash
cat src/index.ts
cat src/config.ts
cat src/github/client.ts
cat src/ai/client.ts
cat src/tools/bootstrap.ts
cat src/tools/finalize.ts
cat src/tools/search.ts
cat src/tools/log-decision.ts
cat src/tools/push.ts
cat src/tools/status.ts
cat src/utils/banner.ts
cat src/utils/cache.ts
cat src/validation/index.ts
cat src/validation/decisions.ts
cat src/validation/common.ts
cat src/validation/handoff.ts
cat .github/workflows/ci.yml
cat package.json
cat tests/intelligence-layer.test.ts
cat CLAUDE.md
```

### prism-framework
```bash
cat _templates/core-template-mcp.md
cat _templates/core-template.md
cat _templates/banner-spec.md
cat _templates/finalization-banner-spec.md
cat _templates/CHANGELOG.md
cat _templates/project-instructions.md
cat _templates/modules/onboarding.md
cat _templates/modules/finalization.md
cat docs/METHODOLOGY_DEEP_DIVE.md | head -20
cat docs/THREE_TIER_ARCHITECTURE.md | head -20
cat docs/SETUP_GUIDE.md | head -20
```

### prism
```bash
cat decisions/_INDEX.md
cat decisions/architecture.md
cat decisions/operations.md
cat decisions/optimization.md
cat decisions/efficiency.md
cat decisions/onboarding.md
cat decisions/integrity.md
cat decisions/resilience.md
cat eliminated.md
cat known-issues.md
cat glossary.md
cat artifacts/current/claude-md-prism-mcp-server.md | head -5
cat artifacts/current/living-documents-design.md | head -5
```

---

# PHASE 1: prism-mcp-server Code Fixes

All changes in `/tmp/prism-mcp-server/`.

## 1A: Security Fixes (Critical — B.2, B.3, B.11, G.4)

### B.2 — Add Bearer Token Authentication to MCP Endpoint

Add auth middleware in `src/index.ts`. Use environment variable `MCP_AUTH_TOKEN`.

1. Add `MCP_AUTH_TOKEN` to `src/config.ts`:
```typescript
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
```

2. Create `src/middleware/auth.ts`:
```typescript
import { type Request, type Response, type NextFunction } from "express";
import { MCP_AUTH_TOKEN } from "../config.js";
import { logger } from "../utils/logger.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no token configured (development mode)
  if (!MCP_AUTH_TOKEN) {
    next();
    return;
  }

  // Skip auth for health check
  if (req.path === "/health") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Unauthorized request — missing or malformed Authorization header", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: "Unauthorized — Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== MCP_AUTH_TOKEN) {
    logger.warn("Unauthorized request — invalid token", {
      ip: req.ip,
      path: req.path,
    });
    res.status(403).json({ error: "Forbidden — invalid token" });
    return;
  }

  next();
}
```

3. In `src/index.ts`, import and apply the middleware:
```typescript
import { authMiddleware } from "./middleware/auth.js";
// After express.json() and requestLogger:
app.use(authMiddleware);
```

4. Add to `.env.example`:
```
MCP_AUTH_TOKEN=your-secret-token-here
```

### B.3 — Add Request Body Size Limit

In `src/index.ts`, change:
```typescript
app.use(express.json());
```
to:
```typescript
app.use(express.json({ limit: "5mb" }));
```

### B.11 — Input Sanitization on Project Slug

Create `src/validation/slug.ts`:
```typescript
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_SLUG_LENGTH = 100;

export function validateProjectSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Project slug cannot be empty" };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Project slug exceeds ${MAX_SLUG_LENGTH} characters` };
  }
  if (!VALID_SLUG_PATTERN.test(slug)) {
    return { valid: false, error: "Project slug must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$" };
  }
  return { valid: true };
}

export function validateFilePath(path: string): { valid: boolean; error?: string } {
  if (!path || path.length === 0) {
    return { valid: false, error: "File path cannot be empty" };
  }
  if (path.includes("..")) {
    return { valid: false, error: "File path cannot contain '..'" };
  }
  if (path.startsWith("/")) {
    return { valid: false, error: "File path must be relative (no leading /)" };
  }
  return { valid: true };
}
```

Apply `validateProjectSlug` at the top of every tool handler that accepts `project_slug`. Apply `validateFilePath` in push and fetch tools for each file path. Return early with a clear error if validation fails.

### G.4 — XSS Fix in Banner HTML Escaping

In `src/utils/banner.ts`, find the `escapeHtml` function and add single quote escaping:
```typescript
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

## 1B: Performance Fixes (High — B.1, F.2, D.1)

### B.1 — Single API Call Per File Fetch (Eliminate Double Call)

In `src/github/client.ts`, refactor `fetchFile` to use a single API call that returns both content and SHA. Currently it makes TWO calls: one for raw content, one for SHA.

**Replace the current approach with:**
```typescript
async fetchFile(repo: string, path: string): Promise<FileResult> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/contents/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",  // JSON mode returns content + sha
    },
  });

  if (!res.ok) {
    // ... existing error handling ...
  }

  const data = await res.json() as GitHubContentsResponse;
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha, size: data.size };
}
```

**Remove the separate `fetchSha` method** if it exists solely for this purpose. Update any callers of `fetchSha` to use the combined response from `fetchFile`.

**Important:** The push flow still needs SHA for conflict detection. It should get SHA from the `fetchFile` call (or a HEAD request), NOT from a separate full-content fetch. Review `pushFile` to ensure it uses the SHA returned from the initial fetch and doesn't re-fetch content.

### F.2 — Eliminate Double Fetch in Search

In `src/tools/search.ts`, the `discoverDecisionDomainFiles` function fetches each domain file completely, then the search logic fetches them AGAIN. Fix by:

1. In `discoverDecisionDomainFiles`, use `fileExists` (or a lightweight HEAD/list call) instead of `fetchFile` to discover which files exist
2. Cache the file contents from the first full fetch and pass them to the search logic
3. Alternatively, merge discovery and search into a single pass

### D.1 — Parallelize Bootstrap Fetches

In `src/tools/bootstrap.ts`, find sequential `await` calls for intelligence brief and insights fetches (around lines 307-345). Wrap them in `Promise.allSettled`:

```typescript
const [briefResult, insightsResult] = await Promise.allSettled([
  client.fetchFile(repo, "intelligence-brief.md"),
  client.fetchFile(repo, "insights.md"),
]);
// Process results individually, handling rejections gracefully
```

## 1C: Reliability Fixes (High/Medium — B.4, B.7, B.8, B.12, B.13)

### B.4 — Add Anthropic API Timeout

In `src/ai/client.ts`, add a timeout to the Anthropic SDK client:

```typescript
const response = await anthropic.messages.create({
  // ... existing params ...
}, {
  timeout: 30000, // 30 second timeout
});
```

Also check `src/tools/finalize.ts` for the fire-and-forget synthesis call (~line 422). Add timeout there as well via `AbortSignal.timeout(30000)` or the SDK's timeout option.

### B.7 — Improve Rate Limit Retry

In `src/github/client.ts`, implement 2-3 retries with exponential backoff for 429 responses. Currently only 1 retry exists. Add rate-limit handling to the `listRepos` pagination loop as well.

```typescript
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "1", 10);
      const delay = Math.min(retryAfter * 1000, 10000) * Math.pow(2, attempt);
      logger.warn("Rate limited, retrying", { attempt, delay, url });
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    return res;
  }
  throw new Error(`Rate limited after ${maxRetries} retries: ${url}`);
}
```

Use `fetchWithRetry` in `fetchFile`, `pushFile`, `listRepos`, and other GitHub API methods.

### B.8 — Robust JSON Parsing of AI Output

In `src/tools/finalize.ts` (~line 272), replace the regex-based JSON extraction:

```typescript
// OLD:
const clean = result.content.replace(/```json\n?|```\n?/g, "").trim();
const parsed = JSON.parse(clean);

// NEW:
function extractJSON(text: string): unknown {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch {}
  // Strip markdown fences
  const fenceStripped = text.replace(/```(?:json)?\s*\n?/g, "").trim();
  try { return JSON.parse(fenceStripped); } catch {}
  // Find first { and last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  throw new Error("Failed to extract JSON from AI response");
}
```

### B.12 — Fix fileExists Silent Error Catch

In `src/github/client.ts`, find the `fileExists` method. Change the catch block to only return `false` for 404s:

```typescript
async fileExists(repo: string, path: string): Promise<boolean> {
  try {
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/contents/${path}`;
    const res = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${GITHUB_PAT}` },
    });
    await res.body?.cancel(); // B.13: Consume response body
    return res.ok;
  } catch (error) {
    // Only return false for network errors that look like 404s
    // Re-throw unexpected errors
    if (error instanceof TypeError && error.message.includes("fetch")) {
      logger.error("Network error checking file existence", { repo, path, error: String(error) });
      throw error;
    }
    return false;
  }
}
```

### B.13 — Consume Response Body in fileExists

Addressed above in B.12 — add `await res.body?.cancel()` after checking `res.ok`.

## 1D: Configuration & Cleanup (Medium — B.5, B.6, B.10)

### B.5 — Unify Version Strings

1. In `package.json`, change `"version": "2.5.0"` to `"version": "2.9.0"`
2. In `src/config.ts`, ensure `SERVER_VERSION` reads from a single source. Either:
   - Import from package.json: `import pkg from "../package.json" assert { type: "json" }; export const SERVER_VERSION = pkg.version;`
   - Or keep the constant but ensure it says "2.9.0"
3. In `src/ai/client.ts`, find the User-Agent string that says "2.0.0" and update it to reference `SERVER_VERSION` from config: `"User-Agent": \`prism-mcp-server/${SERVER_VERSION}\``

### B.6 — Add Missing Decision Statuses

In `src/validation/decisions.ts`, update VALID_STATUSES:
```typescript
const VALID_STATUSES = ["SETTLED", "PENDING", "SUPERSEDED", "REVISITED", "ACCEPTED", "OPEN"];
```

### B.10 — Remove Dead Code

1. In `src/index.ts`, remove the unused import: `import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";`
2. In `src/utils/banner.ts` (~line 192), find and remove the dead `border` variable: `const border = i < data.tools.length - 1 ? "" : "";` and any reference to it.
3. In `src/tools/finalize.ts` (~lines 599-619), find and remove the unused `auditSchema` and `commitSchema` definitions (the inline schema at ~line 622 is what's actually used).

## 1E: Test Coverage (Critical — B.15)

### Fix Standing Rule Test

In `tests/intelligence-layer.test.ts`, the `extractStandingRules` function is re-implemented locally with a different interface (`content` field) than production code (`procedure` field). Fix by importing the production function:

```typescript
// Remove the local re-implementation
// Import the actual function from production code
import { extractStandingRules } from "../src/tools/bootstrap.js";
// (or wherever the production function lives)
```

If the function is not exported, export it. Update the test to use the actual function with its actual interface.

### Add New Test Files

Create the following test files with at minimum the described test cases:

**`tests/push-validation.test.ts`:**
- Test the validate-all-or-push-none invariant: if one file fails validation, NO files should be pushed
- Test EOF sentinel validation (matching filename, present/absent)
- Test commit message prefix validation (prism:, fix:, docs:, chore:)
- Test empty content rejection
- Test that valid files pass validation

**`tests/finalize.test.ts`:**
- Test audit phase: returns living document inventory
- Test that the extractJSON function handles markdown fences, raw JSON, and embedded JSON
- Test finalization draft structure validation

**`tests/bootstrap-parsing.test.ts`:**
- Test handoff parsing: extracts Meta, Critical Context, Where We Are sections
- Test size threshold detection (>15KB → scaling_required: true)
- Test decision index parsing: correct row extraction from markdown table
- Test keyword-to-document mapping for intelligent prefetch

**`tests/validation-extended.test.ts`:**
- Test validateDecisionIndex with all valid statuses including ACCEPTED and OPEN
- Test validateEofSentinel with matching and mismatching filenames
- Test validateCommitMessage with all valid and invalid prefixes
- Test slug validation (valid slugs, empty, too long, special chars, path traversal)
- Test file path validation (relative paths, .., leading /)

## 1F: CI Pipeline Enhancement (High — B.16)

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npx tsc --noEmit

      - name: Security audit
        run: npm audit --audit-level=high
        continue-on-error: true

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
        env:
          GITHUB_PAT: test-pat-not-real
          GITHUB_OWNER: test-owner
          FRAMEWORK_REPO: prism-framework
```

## 1G: Documentation Overhaul (High — H.5, E.4, E.7, A.6)

### H.5 — Rewrite CLAUDE.md

Replace the entire CLAUDE.md with an updated version. Remove the Session 1 build specification (everything below the `# SESSION 1 BUILD SPECIFICATION` header). Update to reflect current state:

- 12 tools (not 7): prism_bootstrap, prism_fetch, prism_push, prism_status, prism_finalize, prism_analytics, prism_scale_handoff, prism_search, prism_synthesize, prism_log_decision, prism_log_insight, prism_patch
- 10 living documents (not 8): add insights.md and intelligence-brief.md
- 17 projects (not 12)
- Server version 2.9.0 (not 2.0.0)
- Remove "3 sessions planned" — build is complete
- Remove the embedded architecture diagram that shows 7 tools and 8 docs
- Keep the Project Overview, Technology Stack, GitHub Configuration, Validation Rules, Commit Prefixes, and Working Preferences sections — but update them for accuracy
- Add the 5 newer tools to the project structure tree (search.ts, synthesize.ts, log-decision.ts, log-insight.ts, patch.ts)
- Add `src/ai/` directory to the project structure tree
- Add the `src/utils/cache.ts`, `src/utils/banner.ts` to the project structure
- Add EOF sentinel: `<!-- EOF: CLAUDE.md -->`
- Document the intentional cache singleton (A.6) as a note in the Architecture section: "The MemoryCache singleton and Anthropic client singleton are intentional performance optimizations — safe in stateless mode since they are read-only/config-only."

### E.4 — prism-mcp-server Living Documents: Add Archive Notice

For each of the 10 living documents in the prism-mcp-server repo root (handoff.md, session-log.md, task-queue.md, decisions/_INDEX.md, eliminated.md, architecture.md, glossary.md, known-issues.md, insights.md, intelligence-brief.md), add a notice at the top:

```markdown
> **⚠️ ARCHIVAL NOTICE:** This document is frozen at Session 10 (CC-S4). Active development of the PRISM MCP Server is tracked in the [prism meta-project](https://github.com/brdonath1/prism) living documents. This file is retained for historical context only.
```

Do NOT update the actual content — just add the archival notice. This is a lightweight fix; full reconciliation is a separate effort.

### E.7 — Fix EOF Sentinel Issues

1. `briefs/d35-html-banner.md` — Change EOF from `<!-- EOF: html-banner-brief.md -->` to `<!-- EOF: d35-html-banner.md -->`
2. `briefs/ki15-slug-resolution.md` — Change EOF from `<!-- EOF: slug-resolution-brief.md -->` to `<!-- EOF: ki15-slug-resolution.md -->`
3. `briefs/s22-intelligence-layer.md` — Add `<!-- EOF: s22-intelligence-layer.md -->` at the end
4. `CLAUDE.md` — EOF sentinel is added as part of the H.5 rewrite above

### F.6 — Cache Log Level

In `src/utils/cache.ts`, change cache hit/miss log statements from `logger.info` to `logger.debug`:
- Cache hit: `logger.debug("Cache hit", ...)`
- Cache miss: `logger.debug("Cache miss", ...)`
- Cache set: `logger.debug("Cache set", ...)`

---

# PHASE 2: prism-framework Template & Doc Fixes

All changes in `/tmp/prism-framework/`.

## 2A: Template Fixes (High — A.1, A.3, C.2, C.3, C.4, C.5, C.6, C.8)

### A.3 / C.5 — Update All "8 Mandatory" References to "10"

Search all files for "8 mandatory", "8 living", "8 docs", and related patterns. Update to 10. Specific known locations:

1. `_templates/core-template.md` (~lines 210, 221) — "8 mandatory" → "10 mandatory"
2. `_templates/banner-spec.md` (~line 43) — `docs.total` "always 8" → "always 10"
3. `_templates/modules/finalization.md` (~lines 16, 169) — "8" → "10"
4. `_templates/modules/onboarding.md` — any "8" references → "10"

**Do not change** files in prism-mcp-server here — those were handled in Phase 1 (CLAUDE.md rewrite) and will be handled in Phase 1 (the archival notice preserves frozen content).

### C.6 — Fix Wrong Filename Reference in MCP Template

In `_templates/core-template-mcp.md`, line ~6, change:
```
Full template: `_templates/core-template-full.md`
```
to:
```
Full template: `_templates/core-template.md`
```

### A.1 / C.1 — Refactor Rules 1 and 11 for Tier Compliance

The audit found that Rules 1 and 11 in `core-template-mcp.md` contain excessive procedural detail that belongs in Tier 3 (situational modules/specs), violating the three-tier architecture's own design guidance of "1-3 sentences per rule."

**Rule 1 (Bootstrap):** Keep the high-level flow. Remove the banner rendering cascade (banner_html → banner_data → banner_svg → null fallback chain — ~10 lines of procedural logic). Replace with a single reference:

```
**Boot banner (MCP mode).** After bootstrap, render the boot banner. If `banner_html` is present, pass it to `visualize:show_widget`. For fallback rendering when `banner_html` is null, follow `brdonath1/prism-framework/_templates/banner-spec.md`.
```

**Rule 11 (Finalize):** Keep the 6-step STOP/AUDIT/DRAFT/COMPOSE/COMMIT/CONFIRM structure. Remove the inline compose requirements list and the finalization banner rendering cascade. Replace the compose section with a reference:

```
**Step 4 — COMPOSE.** Build updated files addressing any audit issues. Use finalization drafts as starting points. For required sections and format, reference the finalization module.
```

Replace the finalization banner cascade with:
```
**Finalization banner (D-46).** If `finalization_banner_html` is present in the commit response, pass it to `visualize:show_widget`. For fallback rendering when null, follow `brdonath1/prism-framework/_templates/banner-spec.md` using a red header gradient.
```

### C.2 — Reconcile Rule 5 Between Templates

In `_templates/core-template.md`, find Rule 5 which says "Track silently." Update to match the MCP template's intent:

```
**Rule 5 — Track and capture knowledge.**
Log every decision (D-N format) and rejection (G-N format) as you work. Capture institutional knowledge proactively — patterns, preferences, explorations, project-specific gotchas. Don't wait for the user to say "save this"; detect insight-worthy moments and capture them. Push decisions and insights to GitHub immediately; don't accumulate for finalization.
```

### C.4 — Add Missing Modules to MCP Template Trigger Table

In `_templates/core-template-mcp.md`, in the Module Triggers table, the note about finalization and handoff-scaling being replaced exists but they're not listed. Add them as explicit fallback entries:

```markdown
| `finalization.md` | Fallback only — replaced by `prism_finalize()` in MCP mode |
| `handoff-scaling.md` | Fallback only — replaced by `prism_scale_handoff()` in MCP mode |
```

### C.8 — Add Scope Qualifier to Sequential Instructions Rule

In `_templates/core-template-mcp.md`, in the Interaction Rules section, find "Sequential instructions only" and add a qualifier:

```
- **Sequential instructions only.** Always provide instructions in order, never out of sequence. Provide instructions step-by-step and wait for the user's response before moving on to the next step. *(Applies to user-facing instructions, not automated PRISM protocol execution like bootstrap or finalization.)*
```

Apply the same change to `_templates/core-template.md` if the same rule exists there.

## 2B: Documentation Fixes (High/Critical — H.1, H.2, H.3, C.3)

### H.1, H.2, H.3 — Add Deprecation Notices to docs/ Files

For each of the three docs/ files, add a prominent deprecation banner at the very top (before the title):

**`docs/METHODOLOGY_DEEP_DIVE.md`:**
```markdown
> ⚠️ **DEPRECATED — v1.0.0 (February 2026)**
> This document describes the original PRISM v1.0.0 methodology. The framework has since evolved to v2.9.0 with an MCP server architecture, 10 living documents, 12 MCP tools, and server-rendered banners. For current behavioral rules, see `_templates/core-template-mcp.md`. For current architecture, see the prism repo's `architecture.md`. This document is retained for historical context only.

```

**`docs/THREE_TIER_ARCHITECTURE.md`:**
```markdown
> ⚠️ **DEPRECATED — v1.0.0 (February 2026)**
> This document describes the original three-tier architecture design rationale. While the three-tier model (structural/behavioral/situational) remains foundational, specific details (e.g., context zone placement, tier boundaries) have evolved significantly through v2.9.0. Some design rationale documented here has been intentionally overridden — for example, context tracking is now in Tier 2 as Rule 9, contrary to this document's recommendation. For current tier implementation, see `_templates/core-template-mcp.md`.

```

**`docs/SETUP_GUIDE.md`:**
```markdown
> ⚠️ **DEPRECATED — v1.0.0 (February 2026)**
> **DO NOT follow this guide for new PRISM projects.** It describes a pre-MCP workflow that is incompatible with the current v2.9.0 framework. The embedded templates, modules, and onboarding flow are all outdated. For new project setup, use the Project Instructions from `_templates/project-instructions.md` and the current onboarding module at `_templates/modules/onboarding.md`.

```

### C.3 — Backfill CHANGELOG

In `_templates/CHANGELOG.md`, the last entry is v2.1.1 (Session 13). Add entries for v2.2.0 through v2.9.0 by reading the session log in the prism repo. The session log has entries for S14 through S27.

Read `prism/session-log.md` to extract what changed in each session, then construct changelog entries. Map sessions to versions:

- Sessions typically correspond to minor version bumps when they involve template changes
- Use the session log's "Key outcomes" and "Focus" fields to determine what changed
- Format each entry consistently with existing entries

**If exact version-to-session mapping is unclear from the session log, create a consolidated entry:**

```markdown
## v2.9.0 (2026-04-02)
### Changes since v2.1.1 (Sessions 14-27)
- Added 5 MCP tools: prism_search (D-43), prism_synthesize, prism_log_decision (D-45), prism_log_insight (D-45), prism_patch (D-45)
- Intelligence layer: AI-synthesized session intelligence briefs (D-44)
- Server-rendered boot banner in HTML (D-35)
- Server-rendered finalization banner (D-46)
- Bootstrap payload optimization — banner data mode, compact intelligence brief (D-47)
- Standing rule lifecycle — ACTIVE, ARCHIVED, DORMANT states (D-48)
- MCP-first template — separate MCP and fallback templates (D-30)
- Behavioral rules delivery — server-cached template in bootstrap response (D-31)
- Generic Project Instructions — identical PI across all projects (D-32, D-37)
- Server-side slug resolution (D-33)
- Decision index split — domain files with lightweight index (D-40)
- Insights living document — 9th mandatory file (D-41)
- Intelligence-brief.md — 10th mandatory file (D-44)
- Interaction Rules codified (D-38) with clickable links rule (D-39)
- Richer session log format with discussion notes (D-42)
- Session efficiency tools — server-side decision/insight logging, section patching (D-45)
```

## 2C: Security (Critical — G.2)

### G.2 — Replace PAT in Project Instructions Template

In `_templates/project-instructions.md`, find the line containing the GitHub PAT and replace with a placeholder:

```markdown
**GitHub PAT:** YOUR_GITHUB_PAT_HERE
```

Add a comment above it:
```markdown
<!-- Replace YOUR_GITHUB_PAT_HERE with your actual GitHub Personal Access Token. Never commit a real PAT to a shared repo. -->
```

---

# PHASE 3: prism Data Integrity Fixes

All changes in `/tmp/prism/`.

## 3A: Decision Index Reconciliation (Critical — A.4, E.1, E.2)

**This is the most complex fix in the entire brief. Proceed carefully.**

The `_INDEX.md` is the authoritative source of truth for decision ID → title mapping. The domain files (`decisions/architecture.md`, `decisions/operations.md`, etc.) contain full decision entries but some have ID collisions where the same D-N refers to a different decision than what _INDEX says.

### Step 1: Inventory

Read `decisions/_INDEX.md` and build a mapping of every D-N ID to its title, domain, and status.

Read every domain file and build a mapping of every D-N entry in each file to its title and content.

### Step 2: Identify Collisions

For each entry in each domain file, check if the D-N ID matches the title in _INDEX.md. Flag any mismatches.

The audit report identified these specific collisions:
- D-11: _INDEX="Validation-first push pattern", operations.md="Automated SBF-to-PRISM mass migration"
- D-12: _INDEX="Boot-test write verification", operations.md="4-tier context awareness protocol"
- D-13: _INDEX="Structured logging", operations.md="Finalization hard-stop protocol"
- D-14: _INDEX="MCP Architecture A", operations.md="Mandatory bootstrap size check"
- D-15: _INDEX="Context-aware summarization in fetch", architecture.md="Research-first Operating Posture"
- D-25: _INDEX="Multi-tool finalization", architecture.md="Architecture E — PRISM MCP Server"
- D-26: _INDEX="Architecture.md as living document", architecture.md="PRISM v2 build plan"
- D-27: _INDEX="Glossary.md as living document", architecture.md="Framework v2.0.0 — MCP integration"
- Plus mismatches for D-6, D-30, D-32, D-33, D-35, D-36

### Step 3: Reconcile

For each collision:
1. The _INDEX title is authoritative for that D-N ID
2. Find the domain file entry that has the wrong ID
3. Determine the correct ID for that domain file entry by searching _INDEX for a title that matches
4. If the domain file entry title exists in _INDEX under a different ID, update the domain file entry to use that correct ID
5. If the domain file entry title does NOT exist in _INDEX at all, it may be:
   - A historical artifact from pre-D-40 days → remove or archive
   - A decision that was never added to _INDEX → add it with a new ID

**Approach:** Generate corrected domain files where every entry's D-N ID matches the _INDEX title for that ID. Preserve all content — only change the ID headers.

### Step 4: Fix Domain Count

In `_INDEX.md`, update the header domain counts to match the actual count of entries per domain. Current header says 43 total but table has 48 entries. Recount after reconciliation.

Remove "production-stack" from the domain list if no decisions claim that domain.

## 3B: Data Cleanup (Medium — E.3, E.8, H.4)

### Eliminated.md — Assign G-3 to Architecture D

In `eliminated.md`, find the unnumbered "Architecture D evaluated and rejected" entry. Change its header to:

```markdown
### G-3: No Claude.ai-triggered headless Claude Code sessions
```

Keep the rest of the content unchanged.

### E.3 — Resolve Stale Known Issues

In `known-issues.md`:

1. **KI-2** ("PlatformForge decision index 44.7KB"): If this was resolved by v2.0.0's decision domain split, update status to RESOLVED with a note: "Resolved by D-40 (decision domain split) in S20. PlatformForge index size reduced by splitting full entries into domain files."

2. **KI-3** ("11 projects have only 4/8 living documents"): Update the "8" to "10" in the description. Add a note: "Last audited S4. Current project count is 17. Status requires re-audit."

3. Search for any known-issues entry referencing "8" documents and update to "10".

### E.8 — Rename Historical Artifacts Directory

```bash
cd /tmp/prism
git mv artifacts/current artifacts/archive
```

If any other files reference `artifacts/current/`, update those references to `artifacts/archive/`.

### H.4 — Glossary Standardization

In `glossary.md`, standardize all entries to use table format. Currently the file uses table format for some entries and bullet format for others. Convert all bullet-format entries to table rows matching the existing table structure.

Add these missing terms:
- **Banner data mode** — Bootstrap response includes structured `banner_data` object for client-side banner rendering when server-rendered HTML is unavailable (D-47)
- **Compact intelligence brief** — Shortened version of the intelligence brief included in bootstrap payload to reduce context consumption (D-47)
- **Standing rule lifecycle** — Three states for standing rules: ACTIVE (loaded at boot), ARCHIVED (retained but not loaded), DORMANT (temporarily disabled) (D-48)
- **Decision domain file** — Per-domain markdown file containing full decision entries (e.g., `decisions/architecture.md`), created by D-40 domain split
- **Intelligence brief** — AI-synthesized project state summary generated during finalization, loaded at next bootstrap (D-44)

---

# PHASE 4: Git Operations

## Push prism-mcp-server Changes

```bash
cd /tmp/prism-mcp-server
git add -A
git status  # Review all changes
git diff --cached --stat  # Verify file list
git commit -m "fix: S28 mega audit remediation — security, performance, reliability, tests, docs"
git push
```

## Push prism-framework Changes

```bash
cd /tmp/prism-framework
git add -A
git status
git diff --cached --stat
git commit -m "docs: S28 audit remediation — template fixes, deprecation notices, changelog backfill"
git push
```

## Push prism Changes

```bash
cd /tmp/prism
git add -A
git status
git diff --cached --stat
git commit -m "fix: S28 audit remediation — decision index reconciliation, data cleanup, glossary"
git push
```

---

## Verification

After all changes are committed and pushed, verify:

### prism-mcp-server
- [ ] `npm run build` compiles with zero errors
- [ ] `npm test` passes all tests (existing + new)
- [ ] No TypeScript errors from `npx tsc --noEmit`
- [ ] `src/index.ts` has no unused imports
- [ ] `package.json` version is "2.9.0"
- [ ] CLAUDE.md has no Session 1 build spec, lists 12 tools, references 10 docs
- [ ] Auth middleware exists in `src/middleware/auth.ts`
- [ ] `express.json({ limit: "5mb" })` is set
- [ ] `validateProjectSlug` is called in at least 3 tool handlers
- [ ] VALID_STATUSES includes "ACCEPTED" and "OPEN"
- [ ] All dead code removed (isInitializeRequest import, border variable, unused schemas)
- [ ] All 10 living documents in repo root have archival notices
- [ ] All 4 EOF sentinel issues fixed
- [ ] Cache log level is debug, not info
- [ ] GitHub client `fetchFile` makes exactly 1 API call (not 2)
- [ ] New test files exist: push-validation.test.ts, finalize.test.ts, bootstrap-parsing.test.ts, validation-extended.test.ts
- [ ] CI pipeline tests Node 18 and 20, includes type check and npm audit

### prism-framework
- [ ] No references to "8 mandatory" or "8 living documents" remain (search all files)
- [ ] `core-template-mcp.md` line ~6 references `core-template.md` (not `core-template-full.md`)
- [ ] Rule 1 in MCP template is concise — no banner cascade logic inline
- [ ] Rule 11 in MCP template is concise — no inline compose requirements
- [ ] Rule 5 in full template matches MCP template intent ("proactive capture")
- [ ] Module trigger table has 6 entries (4 active + 2 fallback)
- [ ] All 3 docs/ files have deprecation banners
- [ ] CHANGELOG has entries covering v2.2.0 through v2.9.0
- [ ] `project-instructions.md` has PAT placeholder, not real PAT
- [ ] `banner-spec.md` docs.total says 10, not 8
- [ ] `finalization-banner-spec.md` docs.total says 10

### prism
- [ ] `decisions/_INDEX.md` domain counts sum to 48 (or adjusted total)
- [ ] No "production-stack" domain if no decisions claim it
- [ ] Every D-N entry in every domain file matches the _INDEX title for that ID
- [ ] Zero ID collisions between _INDEX and domain files
- [ ] `eliminated.md` has G-3 designation for Architecture D entry
- [ ] KI-2 is marked RESOLVED in known-issues.md
- [ ] KI-3 references "10" documents, not "8"
- [ ] `artifacts/archive/` exists (renamed from `artifacts/current/`)
- [ ] `glossary.md` uses consistent table format throughout
- [ ] Glossary has entries for: banner data mode, compact intelligence brief, standing rule lifecycle, decision domain file, intelligence brief

## Post-Flight

After all verification passes:

1. **Report Results:** Create a summary at `/tmp/s28-remediation-results.md` listing:
   - Total files modified per repo
   - Total new files created
   - Any items that could not be completed and why
   - Any new issues discovered during remediation

2. **Do NOT:**
   - Modify any living document content beyond the specified changes
   - Change the prism handoff.md (session finalization will handle that)
   - Modify any file outside the three specified repos
   - Skip the verification checklist

<!-- EOF: s28-mega-audit-remediation.md -->