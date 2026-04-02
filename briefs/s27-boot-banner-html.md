# Brief: Re-enable Server-Side Boot Banner HTML Rendering

**Session:** S27
**Target Repo:** prism-mcp-server
**Target System:** MCP Server (Node.js/TypeScript on Railway)
**Risk Level:** Low — using existing, tested rendering function

---

## Pre-Flight

**Context:** D-47 (bootstrap payload optimization) set `banner_html: null` in bootstrap.ts, replacing it with a lightweight `banner_data` object. The intent was to save tokens. The unintended consequence: every session must fetch the 15KB `banner-spec.md` to construct the HTML from `banner_data`, costing ~2% context window per session across all projects. Additionally, when Claude constructs the banner manually, it drifts — wrong colors, wrong design tokens, wrong theme (this happened twice in S27 and once in PlatformForge S98-S99).

The rendering function `renderBannerHtml()` already exists in `src/utils/banner.ts` and is fully implemented against banner-spec.md v2.0. It was the original D-35 implementation. It just needs to be called from bootstrap.ts.

**Goal:** Restore `banner_html` in the bootstrap response by calling the existing `renderBannerHtml()` function. Keep `banner_data` present for backward compatibility.

---

## Changes

### File: `src/tools/bootstrap.ts`

**Change 1: Add import**

At the top of the file, add `renderBannerHtml` and `BannerData` to the existing import from `../utils/banner.js`:

```typescript
// BEFORE:
import { generateCstTimestamp, parseResumptionForBanner } from "../utils/banner.js";

// AFTER:
import { generateCstTimestamp, parseResumptionForBanner, renderBannerHtml, type BannerData } from "../utils/banner.js";
```

**Change 2: Render banner HTML from existing data**

After the `bannerData` object is constructed (around line 250, after `const bannerData = { ... };`), add the banner rendering block. This maps the bootstrap-shaped `bannerData` to the `BannerData` interface and calls `renderBannerHtml()`:

```typescript
// --- Render boot banner HTML (D-35, restored from D-47 data-only mode) ---
let bannerHtml: string | null = null;
try {
  const bannerInput: BannerData = {
    templateVersion: bannerData.template_version,
    projectDisplayName: bannerData.project,
    sessionNumber: bannerData.session,
    timestamp: bannerData.timestamp,
    handoffVersion: bannerData.handoff_version,
    handoffSizeKb: bannerData.handoff_kb,
    decisionCount: bannerData.decisions,
    decisionNote: `${bannerData.guardrails} guardrails`,
    docCount: docCount,
    docTotal: docTotal,
    docStatus: bannerData.doc_status,
    docLabel: bannerData.doc_label,
    tools: bannerData.tools,
    resumption: resumption,
    nextSteps: bannerData.next_steps.map((s, i) => ({
      text: s.text,
      status: (i === 0 ? "priority" : "normal") as "priority" | "warn" | "normal",
    })),
    warnings: bannerData.warnings,
    errors: [],
  };
  bannerHtml = renderBannerHtml(bannerInput);
  logger.info("boot banner HTML rendered", { htmlLength: bannerHtml.length });
} catch (bannerError) {
  const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
  logger.warn("boot banner render failed, falling back to banner_data", { error: msg });
}
```

**Change 3: Set `banner_html` in the result object**

In the result object (around line 280), change `banner_html: null` to use the rendered HTML:

```typescript
// BEFORE:
banner_html: null,                           // D-47: null for backward compat detection

// AFTER:
banner_html: bannerHtml,                     // D-35 restored: server-rendered HTML, D-47 banner_data kept as fallback
```

**Change 4: Update component_sizes tracking**

In the `componentSizes` object, add the banner HTML size for monitoring:

```typescript
// Add after banner_data line:
banner_html: bannerHtml?.length ?? 0,
```

**Change 5: Update log output**

In the final `logger.info("prism_bootstrap complete", {...})` call, update the banner field:

```typescript
// BEFORE:
bannerDataDelivered: true,                   // D-47

// AFTER:
bannerHtmlRendered: !!bannerHtml,            // D-35 restored
bannerDataDelivered: true,                   // D-47 kept as fallback
```

### No other files need changes.

- `src/utils/banner.ts` — no changes. `renderBannerHtml()` and `BannerData` are already exported.
- `src/tools/finalize.ts` — no changes. Already has its own `renderFinalizationBanner()` with the red gradient.
- Template (`core-template-mcp.md`) — no changes needed. Rule 2 already has the correct fallback chain: `banner_html` present → pass through; null → fetch spec. Once this deploys, the `banner_html` path will be the one that fires.

---

## Verification

1. **Build passes:** `tsc` compiles with zero errors.
2. **Server starts:** Railway deploy succeeds, no crash on startup.
3. **Bootstrap response check:** Call `prism_bootstrap` in a new session. Verify:
   - `banner_html` is a non-null string containing `--bn-accent-start: #6366f1` (purple gradient — boot banner)
   - `banner_data` is still present (backward compat)
   - `component_sizes.banner_html` reports a non-zero value
4. **Visual check:** The boot banner renders in the correct dark theme with purple gradient header, not the host page's theme.
5. **Finalization banner unaffected:** Finalize a session and verify the finalization banner still uses the red gradient (`#dc2626`).

---

## Post-Flight

1. After Railway auto-deploys, reconnect PRISMv2 MCP Server connector in Claude.ai Settings (INS-11).
2. Start a new conversation and bootstrap any project to verify `banner_html` is populated.
3. Verify `banner_data` is still present in the response (backward compat for older template versions).
4. No template changes needed — Rule 2's fallback chain already prefers `banner_html` when present.

<!-- EOF: s27-boot-banner-html.md -->
