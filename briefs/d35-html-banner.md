# CC Brief: HTML Boot Banner (D-35)

> **Priority:** Medium — fixes text overflow bugs in current SVG banner
> **Scope:** Rewrite `src/utils/banner.ts`, update `src/tools/bootstrap.ts` response field
> **Branch:** `main` (direct push)
> **Estimated complexity:** Medium — 30-45 minutes

---

## Mission

Replace the SVG boot banner renderer with an HTML/CSS renderer. The current SVG banner has text overflow bugs — SVG `<text>` elements can't wrap, so long content (next steps, resumption points) clips or overflows the viewBox. HTML/CSS handles this natively.

The complete HTML template, CSS design tokens, data schema, and color logic are defined in the framework repo at `brdonath1/prism-framework/_templates/banner-spec.md` (v2.0). **Read that file first** — it is the authoritative reference. Use the PAT from environment to fetch it.

Do NOT ask questions. The spec is comprehensive.

---

## Task Checklist

### Task 1: Rewrite `src/utils/banner.ts`

**Keep these exports unchanged** (they're used elsewhere):
- `BannerData` interface
- `stripMarkdown()`
- `generateCstTimestamp()`
- `parseResumptionForBanner()`

**Modify the `BannerData` interface** to support richer status data. The banner spec v2.0 defines these status fields:

```typescript
export interface BannerData {
  templateVersion: string;
  projectDisplayName: string;
  sessionNumber: number;
  timestamp: string;
  handoffVersion: number;
  handoffSizeKb: string;
  decisionCount: number;
  decisionNote: string;          // e.g., "10 guardrails", "D-31 pending"
  docCount: number;
  docTotal: number;
  docStatus: "ok" | "warn" | "critical";  // CHANGED from docHealthy: boolean
  docLabel: string;              // NEW — e.g., "healthy", "1 stale", "2 missing"
  tools: Array<{                 // NEW — replaces scalingRequired
    label: string;
    status: "ok" | "warn" | "critical";
  }>;
  resumption: string;            // CHANGED from resumptionLines: string[] — now a single string, HTML wraps it
  nextSteps: Array<{             // CHANGED from string[] — now objects with status
    text: string;
    status: "priority" | "warn" | "normal";
  }>;
  warnings: string[];            // Unchanged
  errors: string[];              // NEW — red error messages
}
```

**Replace `renderBannerSvg()` with `renderBannerHtml()`:**
- Same signature: takes `BannerData`, returns `string`
- Output is a complete HTML string (with `<style>` block + markup) ready for `show_widget`
- **The exact CSS and HTML template is in banner-spec.md v2.0** — follow it precisely
- All text fields must be passed through `stripMarkdown()` before rendering
- All text must be HTML-escaped (replace `escapeXml` with `escapeHtml` — same logic but rename for clarity)
- Status-to-color mapping via CSS classes: `.ok`, `.warn`, `.critical`, `.priority`
- Tool icons: `✓` (ok), `⚠` (warn), `✗` (critical)
- Warning bars render only when `warnings.length > 0`
- Error bars render only when `errors.length > 0`
- First next step is always rendered with class `priority` regardless of its status field

**Remove** `wrapTextLines()` — no longer needed since HTML wraps text natively.

### Task 2: Update `src/tools/bootstrap.ts`

**Line 20 — update import:**
```typescript
// FROM:
import { renderBannerSvg, generateCstTimestamp, parseResumptionForBanner } from "../utils/banner.js";
// TO:
import { renderBannerHtml, generateCstTimestamp, parseResumptionForBanner } from "../utils/banner.js";
```

**Around line 191-221 — update banner rendering call:**
- Change variable from `bannerSvg` to `bannerHtml`
- Call `renderBannerHtml()` instead of `renderBannerSvg()`
- Update the data object passed to the renderer to match the new `BannerData` interface
- For now, default these new fields:
  - `docStatus`: `"ok"` if `docCount === docTotal`, `"critical"` if `docCount < docTotal`, otherwise `"ok"`
  - `docLabel`: `"healthy"` if ok, `"${docTotal - docCount} missing"` if critical
  - `tools`: `[{label: "bootstrap", status: "ok"}, {label: "push verified", status: "ok"}, {label: "template loaded", status: "ok"}, {label: scalingRequired ? "scaling required" : "no scaling needed", status: scalingRequired ? "warn" : "ok"}]`
  - `resumption`: join the existing resumption lines into a single string (space-separated)
  - `nextSteps`: map existing strings to `{text, status}` objects — first item gets `status: "priority"`, rest get `status: "normal"`
  - `errors`: `[]` (no error detection yet)

**Around line 242 — update response field:**
```typescript
// FROM:
banner_svg: bannerSvg,
// TO:
banner_html: bannerHtml,
```

**Update log messages** from "banner SVG" to "banner HTML".

### Task 3: Update tests

Update any tests in `tests/` that reference `banner_svg`, `renderBannerSvg`, or `BannerData.docHealthy`. The tests should:
- Import `renderBannerHtml` instead of `renderBannerSvg`
- Use the new `BannerData` interface fields
- Assert the output contains HTML elements (e.g., `<div class="bn">`) instead of SVG elements (e.g., `<svg viewBox`)
- Assert `banner_html` in bootstrap response instead of `banner_svg`

### Task 4: Version bump

In `package.json`, bump `"version"` to `"2.4.0"`.

### Task 5: Build, test, push

```bash
npm run build
npm test
git add -A && git commit -m "prism: D-35 HTML boot banner replacing SVG — banner.ts rewrite + bootstrap field change" && git push origin main
```

Railway auto-deploys on push to main.

---

## Completion Criteria

1. `renderBannerHtml()` exists and returns valid HTML matching the banner-spec.md v2.0 template
2. Bootstrap response includes `banner_html` field (not `banner_svg`)
3. `stripMarkdown()`, `generateCstTimestamp()`, `parseResumptionForBanner()` still exported and working
4. All tests pass
5. `package.json` version is `2.4.0`
6. Pushed to `main`, Railway auto-deploy triggered

---

## What NOT to Do

- Do NOT keep the SVG renderer alongside the HTML one — clean replacement
- Do NOT change `generateCstTimestamp()` or `parseResumptionForBanner()` logic
- Do NOT add any new npm dependencies
- Do NOT modify any tools other than `bootstrap.ts`
- Do NOT change the bootstrap response structure beyond renaming `banner_svg` → `banner_html`
- Do NOT add inline JavaScript to the HTML banner — it's a pure static HTML+CSS widget

---

## Reference Files

- **Banner spec (authoritative):** `brdonath1/prism-framework/_templates/banner-spec.md` — fetch this first, it has the complete CSS and HTML template
- **Current banner renderer:** `src/utils/banner.ts` — rewrite this
- **Bootstrap tool:** `src/tools/bootstrap.ts` — update import + response field
- **Tests:** `tests/` — update references

<!-- EOF: html-banner-brief.md -->
