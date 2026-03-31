# Claude Code Brief — S21 Server Fixes

**Repo:** `brdonath1/prism-mcp-server`
**Branch:** `main`
**Server version:** 2.6.0 → 2.7.0

---

## Pre-Flight

```bash
cd ~/prism-mcp-server && git pull origin main
```

---

## Changes (4 files, all in `src/`)

### 1. `src/config.ts`
- Change `SERVER_VERSION` from `"2.6.0"` to `"2.7.0"`

### 2. `src/tools/bootstrap.ts`
- Add `LIVING_DOCUMENTS` to the existing import from `"../config.js"` (the import already pulls other items from config — just add `LIVING_DOCUMENTS` to the destructure)
- Find these two hardcoded lines (they are near each other, around the banner data assembly):
  ```ts
  const docCount = 8;
  const docTotal = 8;
  ```
  Replace with:
  ```ts
  const docCount = LIVING_DOCUMENTS.length;
  const docTotal = LIVING_DOCUMENTS.length;
  ```
- No other changes to this file.

### 3. `src/tools/finalize.ts`
- In the `commitPhase` function, find the success confirmation string:
  ```ts
  `Session ${sessionNumber} finalized. Handoff v${handoffVersion} pushed and verified. ${livingDocsUpdated}/8 living documents updated.`
  ```
  Replace `/8` with `/${LIVING_DOCUMENTS.length}`.
- `LIVING_DOCUMENTS` is already imported at the top of this file (used in `auditPhase`), so no new import needed.
- No other changes to this file.

### 4. `src/tools/search.ts`
- In the `inputSchema` object, change:
  ```ts
  max_results: z.number().optional().default(10).describe("Maximum snippets to return (default: 10)"),
  ```
  to:
  ```ts
  max_results: z.number().optional().describe("Maximum snippets to return (default: 10)"),
  ```
- In the handler function (the `async ({ project_slug, query, max_results })` callback), add this line near the top of the `try` block, before any use of `max_results`:
  ```ts
  const limit = max_results ?? 10;
  ```
- Find the `.slice(0, max_results)` call and replace with `.slice(0, limit)`.
- Also find the logger call that logs `max_results` and change it to `limit`.
- No other changes to this file.

---

## Verification

```bash
npm run build
```

Build must complete with zero errors. If it fails, fix the TypeScript error before proceeding.

---

## Post-Flight

```bash
git add -A && git commit -m "fix: 9/9 living docs in banner + search tool registration (S21)" && git push origin main
```

Railway auto-deploys on push to main. After deploy (~60s), verify:

```bash
curl -s https://prism-mcp-server-production.up.railway.app/health
```

Expected: `{"status":"ok","version":"2.7.0"}`

---

## Context

- **Why 9/9:** D-41 (S20) added `insights.md` as the 9th mandatory living document. `LIVING_DOCUMENTS` in config.ts was updated correctly, but bootstrap.ts and finalize.ts had hardcoded `8`. Banner has been showing "8/8 healthy" instead of "9/9 healthy".
- **Why search breaks:** The MCP SDK's JSON Schema serializer doesn't handle `ZodDefault` wrapper types from `.default()`. The tool silently fails to register. All 7 working tools use `.optional()` without `.default()`. Removing `.default(10)` and handling the fallback in the function body matches the pattern of every other tool.
