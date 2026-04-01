# CC Brief: Finalization Banner (D-46)

> **Session:** S24
> **Decision:** D-46
> **Spec:** `brdonath1/prism-framework/_templates/finalization-banner-spec.md`
> **Goal:** Add a server-rendered finalization banner to `prism_finalize` commit, mirroring boot banner architecture.

---

## Pre-Flight

1. Read `src/tools/bootstrap.ts` — find the `renderBootBanner` function and understand the pattern (how data maps to HTML template, how CSS vars work, how the HTML string is returned in the bootstrap response as `banner_html`)
2. Read `src/tools/finalize.ts` — find the commit action handler and understand what data is available at commit time (session_number, handoff_version, files array, etc.)
3. Read the finalization banner spec: `cat` the spec from this repo at the URL `https://raw.githubusercontent.com/brdonath1/prism-framework/main/_templates/finalization-banner-spec.md`

---

## Changes

### 1. Add `renderFinalizationBanner` function to `src/tools/finalize.ts`

Model it after `renderBootBanner` in bootstrap.ts. Key differences:

**Design tokens** — only the accent colors change:
```css
--bn-accent-start: #dc2626;  /* red instead of purple */
--bn-accent-end: #ef4444;    /* red instead of purple */
```
All other CSS variables (`--bn-bg`, `--bn-surface`, `--bn-border`, etc.) stay identical to the boot banner.

**Header:**
- Version line: `PRISM v{version}` (same as boot)
- Title: `Session {session} — Finalized` (not project name)
- Badge: `COMMITTED ✓` (not `MCP ✓`)

**Metrics grid (4 cards):**
| Card | Label | Value | Subtitle |
|------|-------|-------|----------|
| 1 | SESSION | `{session}` | none |
| 2 | HANDOFF | `v{handoff_version}` | status-colored label ("pushed", "retry succeeded") |
| 3 | DOCS UPDATED | `{count}/{total}` | none |
| 4 | DECISIONS | `{count}` | `({note})` |

**Toolbar (4 cells):** `audit`, `draft`, `commit`, `verified` — each with ok/warn/critical status.

**Sections:** "Resumption point" then "Deliverables" (replaces "Next steps").

**Warning/error bars:** Same pattern as boot banner.

The function signature:
```typescript
function renderFinalizationBanner(data: {
  version: string;
  session: number;
  timestamp: string;
  handoff_version: number;
  handoff_status: 'ok' | 'warn';
  handoff_label: string;
  docs_updated: number;
  docs_total: number;
  decisions_count: number;
  decisions_note: string;
  steps: Array<{label: string; status: 'ok' | 'warn' | 'critical'}>;
  resumption: string;
  deliverables: Array<{text: string; status: 'ok' | 'warn'}>;
  warnings: string[];
  errors: string[];
}): string
```

### 2. Add optional `banner_data` parameter to commit action schema

In the Zod schema for the finalize tool, add an optional `banner_data` parameter (only used when `action === "commit"`):

```typescript
banner_data: z.object({
  deliverables: z.array(z.object({
    text: z.string(),
    status: z.enum(['ok', 'warn'])
  })).optional(),
  decisions_note: z.string().optional(),
  step_statuses: z.object({
    audit: z.enum(['ok', 'warn', 'critical']).optional(),
    draft: z.enum(['ok', 'warn', 'critical']).optional(),
    commit: z.enum(['ok', 'warn', 'critical']).optional(),
    verified: z.enum(['ok', 'warn', 'critical']).optional()
  }).optional()
}).optional()
```

**IMPORTANT per INS-6:** Do NOT use `.default()` on any Zod schema field. Use `.optional()` and handle defaults in the function body with `?? fallback`.

### 3. Wire up banner rendering in the commit handler

At the end of the commit handler (after all files are pushed and verified), compute the banner data:

1. **docs_updated:** Count the number of unique living document files in the `files` array. Living docs are: `handoff.md`, `session-log.md`, `task-queue.md`, `decisions/_INDEX.md`, `decisions/*.md`, `eliminated.md`, `architecture.md`, `glossary.md`, `known-issues.md`, `insights.md`, `intelligence-brief.md`.
2. **docs_total:** Always 10.
3. **handoff_version:** From the `handoff_version` parameter.
4. **handoff_status/label:** `'ok'` / `'pushed'` if handoff push succeeded on first try. `'ok'` / `'retry succeeded'` if it needed a retry. `'warn'` / `'push failed'` if it ultimately failed.
5. **resumption:** Extract from the handoff.md content in the files array. Look for the `## Where We Are` or `## Current State` section and grab the first paragraph. If not found, use `"See handoff.md for resumption point."`
6. **decisions_count / decisions_note:** Use `banner_data.decisions_note` if provided, otherwise `"see index"`.
7. **deliverables:** Use `banner_data.deliverables` if provided, otherwise generate from the files pushed (e.g., `"✓ {N} files pushed"`).
8. **steps:** Use `banner_data.step_statuses` if provided, otherwise default all to `'ok'` since we're in the commit phase.
9. **timestamp:** Generate CST timestamp at commit time.
10. **version:** Use the template version from cache/config.
11. **warnings/errors:** Collect from any validation warnings or push failures during the commit.

Call `renderFinalizationBanner(data)` and include the result as `finalization_banner_html` in the commit response object.

### 4. Update the commit response type

Add `finalization_banner_html: string | null` to the commit response. Always attempt to render; set to `null` if rendering fails (don't let banner rendering break the commit).

---

## Verification

1. `npm run build` — must compile without errors
2. Verify the Zod schema doesn't use `.default()` anywhere (INS-6)
3. Check that `renderFinalizationBanner` produces valid self-contained HTML with:
   - Red gradient header (`#dc2626` → `#ef4444`)
   - Same dark body as boot banner (`#1e1e2e`)
   - All 8 sections in correct order
   - Status-colored elements working correctly
4. Verify the commit handler still works identically when `banner_data` is not provided (backward compatible)
5. Check that banner rendering failure doesn't break the commit flow (wrapped in try/catch)

---

## Post-Flight

1. Push to `main` branch
2. Wait for Railway deploy to complete
3. Report: files changed, lines added/removed, any issues encountered

<!-- EOF: s24-finalization-banner.md -->