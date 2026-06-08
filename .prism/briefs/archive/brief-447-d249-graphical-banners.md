# Restore graphical banners — boot SVG masthead + finalization HTML widget (D-249, banner spec 3.0 → 4.0)

**Repo:** `prism-mcp-server`
**Files touched:** `src/utils/banner.ts`, `src/tools/bootstrap.ts`, `src/tools/finalize.ts`, the banner/finalize test file under `tests/`
**Directed:** PRISM S156 (06-07-26), operator-directed (D-249)
**Type:** Feature restoration. Design is PRE-APPROVED and embedded below — do NOT recover old designs from git. Retains R8's `banner_spec_version` drift handshake.

---

## Context

D-249 directs restoring "robust, visually pleasing graphical" banners while RETAINING R8's unified text generator + `banner_spec_version` drift handshake. After design review the shapes are locked:

- **Boot = masthead-hybrid (Option M).** The server emits a compact **SVG masthead** built ONLY from server-owned fields (wordmark, version, session #, timestamp, count chips, the four boot-status glyphs, the Suggested line). The variable/narrative tail — Resumption, the `Next:` block, warnings, and the client-side Tool Surface line — stays in the existing `banner_text` and renders as inline text below the masthead. The masthead has NO client-side data, so Claude passes it to `visualize:show_widget` verbatim (zero interpretation) — strictly more drift-proof than today's text assembly.
- **Finalization = full HTML widget.** The server re-populates `finalization_banner_html` with rich HTML/CSS (variable-length Deliverables list → HTML wraps natively). Rendered via `visualize:show_widget` at session end.

Both keep `banner_text` as a genuine fallback.

---

## Verified starting state (read before coding)

Confirmed against current `src/utils/banner.ts` (SHA f487913):

- `banner.ts` is **text-only** (the R8/brief-439 unified generator): `renderUnifiedBanner`, `renderBannerFallback`, `stripMarkdown`, `generateCstTimestamp`, `parseResumptionForBanner`, `parseTemplateBannerSpecVersion`. There is **no** HTML/SVG renderer and **no** CSS present. You are ADDING the render functions, not re-wiring an extant one.
- `export const BANNER_SPEC_VERSION = "3.0";` — drift handshake is live (`parseTemplateBannerSpecVersion` + the server's BANNER_DRIFT warn).
- History: boot HTML was removed at ME-1 (template v2.10.0); the finalization HTML widget (D-46) was deprecated at spec 3.0 (R8). `finalization_banner_html` is currently always null.
- The `banner.ts` header comments reference `docs/banner-spec.md`. The real path is **`_templates/banner-spec.md`** (boot) and **`_templates/finalization-banner-spec.md`** (finalize). Fix those comment references while you are in the file.

### Reading list (in order)

1. `src/utils/banner.ts` — full file. You'll ADD two exported render fns here and bump the version constant. Keep `renderUnifiedBanner` for the text tail + fallback.
2. `src/tools/bootstrap.ts` — find where the response object is assembled and `banner_text` is set (surface `"boot"`). You'll add a sibling `boot_masthead_svg` field built from the same input data.
3. `src/tools/finalize.ts` — find the commit-phase banner-prep `try` block that currently sets `finalization_banner_html` (today: null). You'll populate it via the new render fn. Note the existing outer `try/catch` that nulls the field on hard error — preserve it as the genuine fallback.
4. `tests/` — locate the banner/finalize test file; you'll add cases (see Verification).
5. (OPTIONAL reference only) `git log -p -- src/utils/banner.ts` to see how the pre-R8 HTML render was wired into responses. NOT needed for the design — the approved markup is embedded below.

---

## Spec

### Change 1 — `banner.ts`: bump spec version
`export const BANNER_SPEC_VERSION = "3.0";` → `"4.0";`

### Change 2 — `banner.ts`: add `renderBootMastheadSvg(input)`
Add an exported function returning the SVG below **as a string**, with ONLY the annotated fields interpolated from a typed input (reuse `UnifiedBannerInput`'s boot fields — `templateVersion`, `sessionNumber`, `timestamp`, `handoffVersion`, `handoffNote`, `decisionCount`, `decisionNote`/guardrails, `docCount`, `docTotal`, `statusRow`, `suggested`). Static layout/classes/colors must be **byte-identical** to this target:

```svg
<svg width="100%" viewBox="0 0 680 256" role="img" xmlns="http://www.w3.org/2000/svg">
<title>PRISM boot banner masthead</title>
<desc>Boot status masthead showing session 156, timestamp, handoff and decision counts, four completed status checks, and the suggested session setting.</desc>
<rect x="40" y="40" width="600" height="200" rx="12" class="box"/>
<g class="c-purple"><rect x="65" y="64" width="14" height="14" rx="2" transform="rotate(45 72 71)"/></g>
<g class="c-purple"><text x="92" y="80" class="th" font-size="24">PRISM</text></g>
<text x="182" y="80" class="ts" font-size="13">v2.19.1</text>
<g class="c-teal"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>
<line x1="64" y1="98" x2="616" y2="98" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="64" y="124" class="th" font-size="16">Session 156</text>
<text x="176" y="124" class="ts" font-size="13">06-07-26 14:21:51 CST</text>
<rect x="64" y="144" width="150" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="139" y="160" class="ts" text-anchor="middle">Handoff v163 · 7.3KB</text>
<rect x="226" y="144" width="190" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="321" y="160" class="ts" text-anchor="middle">201 decisions · 20 guardrails</text>
<g class="c-green"><rect x="428" y="144" width="140" height="24" rx="6"/><text x="498" y="160" class="ts" text-anchor="middle">10/10 docs healthy</text></g>
<g class="c-green"><text x="64" y="192" class="th" font-size="13">✓</text></g>
<text x="78" y="192" class="ts">bootstrap</text>
<g class="c-green"><text x="152" y="192" class="th" font-size="13">✓</text></g>
<text x="166" y="192" class="ts">push verified</text>
<g class="c-green"><text x="262" y="192" class="th" font-size="13">✓</text></g>
<text x="276" y="192" class="ts">template loaded</text>
<g class="c-green"><text x="384" y="192" class="th" font-size="13">✓</text></g>
<text x="398" y="192" class="ts">no scaling needed</text>
<line x1="64" y1="208" x2="616" y2="208" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="64" y="228" class="ts">Suggested: Opus 4.8 · Adaptive off — mixed queue</text>
</svg>
```

Interpolation rules:
- Wordmark `PRISM`, the purple mark, the `boot` pill, layout, classes, colors → **static**.
- `v2.19.1` ← `templateVersion`; `Session 156` ← `sessionNumber`; timestamp ← `timestamp`.
- Chip 1 `Handoff v163 · 7.3KB` ← `Handoff v{handoffVersion} · {handoffNote}`.
- Chip 2 `201 decisions · 20 guardrails` ← `{decisionCount} decisions` + `· {decisionNote}` when present (else drop the `· …` segment).
- Chip 3 (docs) ← `{docCount}/{docTotal} docs healthy`. Keep the `c-green` wrap when `docCount === docTotal`; otherwise render it as a neutral chip (white fill + tertiary border, like chips 1–2).
- Status glyphs ← `statusRow`: one `✓/⚠/✗` glyph + label per entry, glyph colored by status using `c-green` (ok), `c-amber` (warn), `c-red` (critical). Reuse the existing `STATUS_ICONS` glyph set. Lay them out left-to-right on the row at y=192 with the same x-spacing pattern.
- Suggested line ← `Suggested: {suggested.display} — {suggested.rationale}`. **Omit the entire `<text>` line (and tighten the viewBox/panel height accordingly) when `suggested` is null/undefined** — mirrors `renderUnifiedBanner`'s null handling.

### Change 3 — `banner.ts`: add `renderFinalizationBannerHtml(input)`
Add an exported function returning the HTML below **as a string**, data-interpolated. Static layout/classes/styles byte-identical to:

```html
<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Finalization banner: session 156 finalized, handoff pushed, all four phases complete, three deliverables shipped.</h2>
<style>.brand{color:#534AB7}.mark{background:#534AB7}@media(prefers-color-scheme:dark){.brand{color:#b3aef0}.mark{background:#b3aef0}}</style>
<div style="background:var(--color-background-secondary);border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);padding:1.1rem 1.25rem;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <span class="mark" style="display:inline-block;width:13px;height:13px;border-radius:2px;transform:rotate(45deg);"></span>
      <span class="brand" style="font-size:22px;font-weight:500;letter-spacing:0.5px;">PRISM</span>
      <span style="font-size:13px;color:var(--color-text-secondary);">v2.19.1</span>
    </div>
    <span style="font-size:12px;font-weight:500;color:var(--color-text-success);background:var(--color-background-success);padding:4px 12px;border-radius:var(--border-radius-md);">finalized</span>
  </div>
  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px;">
    <span style="font-size:16px;font-weight:500;color:var(--color-text-primary);">Session 156 finalized</span>
    <span style="font-size:13px;color:var(--color-text-secondary);">06-07-26 15:40:02 CST</span>
  </div>
  <div style="border-top:0.5px solid var(--color-border-tertiary);padding-top:12px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;">
    <span style="font-size:12px;color:var(--color-text-secondary);background:var(--color-background-primary);border:0.5px solid var(--color-border-tertiary);padding:5px 10px;border-radius:var(--border-radius-md);">Handoff v163 → v164 · pushed</span>
    <span style="font-size:12px;color:var(--color-text-secondary);background:var(--color-background-primary);border:0.5px solid var(--color-border-tertiary);padding:5px 10px;border-radius:var(--border-radius-md);">203 decisions (+2)</span>
    <span style="font-size:12px;color:var(--color-text-success);background:var(--color-background-success);padding:5px 10px;border-radius:var(--border-radius-md);">10/10 docs updated</span>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:12px;">
    <span style="font-size:12px;color:var(--color-text-secondary);"><span style="color:var(--color-text-success);font-weight:500;">✓</span> docs updated</span>
    <span style="font-size:12px;color:var(--color-text-secondary);"><span style="color:var(--color-text-success);font-weight:500;">✓</span> index synced</span>
    <span style="font-size:12px;color:var(--color-text-secondary);"><span style="color:var(--color-text-success);font-weight:500;">✓</span> pushed</span>
    <span style="font-size:12px;color:var(--color-text-secondary);"><span style="color:var(--color-text-success);font-weight:500;">✓</span> verified</span>
  </div>
  <div style="border-top:0.5px solid var(--color-border-tertiary);padding-top:12px;">
    <div style="font-size:12px;font-weight:500;color:var(--color-text-secondary);margin-bottom:8px;">Deliverables</div>
    <div style="font-size:13px;color:var(--color-text-primary);line-height:1.5;margin-bottom:7px;"><span class="brand" style="margin-right:8px;">▸</span>Graphical banners restored — boot masthead (SVG) + finalization widget (HTML), v3.0 drift handshake retained</div>
    <div style="font-size:13px;color:var(--color-text-primary);line-height:1.5;margin-bottom:7px;"><span class="brand" style="margin-right:8px;">▸</span>banner-spec.md raised to v4.0; finalization-banner-spec.md restored to widget-primary</div>
    <div style="font-size:13px;color:var(--color-text-primary);line-height:1.5;"><span class="brand" style="margin-right:8px;">▸</span>prism-mcp-server: HTML/SVG renders re-added, BANNER_SPEC_VERSION 3.0 → 4.0, Railway redeployed</div>
  </div>
  <div style="margin-top:12px;font-size:12px;color:var(--color-text-tertiary);">Next: D-249 follow-through → PAT rotation Phase 2</div>
</div>
```

Interpolation rules:
- Wordmark/mark/`finalized` pill/layout/styles → **static**.
- Header: `v{templateVersion}`, `Session {sessionNumber} finalized`, timestamp.
- Stat chips: `Handoff v{from} → v{to} · {pushed|push failed|unverified}` (handoff chip); `{decisionCount} (+{delta})`; docs `{docCount}/{docTotal} docs updated` (keep the success-colored chip when all healthy, else neutral).
- Phase steps: render one `✓/⚠/✗ {label}` span per `statusRow` entry using the **actual `prism_finalize` phase labels and statuses** — the four shown here (`docs updated / index synced / pushed / verified`) are PLACEHOLDERS; use whatever `surface:"finalize"` already feeds `statusRow`.
- Deliverables: one `▸` row per deliverable from the finalize input (the list wraps). Render the real list, not these samples.
- `Next:` line ← next-session pointer; omit the line when empty.

### Change 4 — `bootstrap.ts`: emit `boot_masthead_svg`
Add `boot_masthead_svg` to the bootstrap response object, built by calling `renderBootMastheadSvg(...)` with the same data that already feeds `renderUnifiedBanner` for `banner_text`. Leave `banner_text` unchanged (it carries the text tail + fallback).

### Change 5 — `finalize.ts`: populate `finalization_banner_html`
In the commit-phase banner-prep `try` block, set `finalization_banner_html = renderFinalizationBannerHtml(...)` from the finalize data instead of null. Keep `banner_text`. Leave the existing outer `try/catch` (which nulls the field on hard error) intact — that is the genuine fallback.

### Notes
- **RENDER COUPLING (important).** The masthead SVG and finalization HTML reference the `visualize` widget design-system classes (`box`, `c-purple`, `c-green`, `c-teal`, `c-amber`, `c-red`, `t`, `ts`, `th`) and CSS variables (`--color-*`, `--border-radius-*`). These resolve at render time inside `visualize:show_widget`, which Claude invokes per the Stage-2 framework template. The server emits the markup as an inert STRING. **Do NOT substitute hardcoded colors for the classes/vars** — dark-mode + theming depend on them. The `.brand`/`.mark` `<style>` block in the finalization HTML is intentionally self-contained (hardcoded purple + dark `@media`) because no host CSS var exists for purple; leave it as-is.
- Emit markup byte-identical to the approved targets except for the interpolated data. No layout/spacing/color edits.
- The new functions are ADDITIVE; the unified text generator and `banner_text` on both surfaces are unchanged.

### Explicitly out of scope
- All prism-framework changes — `_templates/banner-spec.md` (→ v4.0), `_templates/finalization-banner-spec.md` (widget-primary), `_templates/core-template-mcp.md` (Rule 1 + Rule 2 boot-response rewrite), `_templates/rules-session-end.md`, and declaring `Banner-Spec-Version: 4.0`. That is the **Stage 2** brief, dispatched after this merges.
- **Expected transient drift:** shipping spec 4.0 here before the templates declare 4.0 will fire a **warn-level** `BANNER_DRIFT` (non-blocking) until Stage 2 lands. This is expected; do not "fix" it server-side.
- No Railway deploy (operator-gated).

---

## Verification

Runner MUST:

1. Apply all five changes exactly as specified.
2. **Build & typecheck.** Run the package's build command (confirm via `package.json` `scripts` — likely `pnpm build`). 0 errors. Paste the tail into the PR body under `## Build`.
3. **Test suite.** Run it (vitest; `pnpm test`). All pass. Paste the summary counts into the PR body under `## Tests`.
4. **Grep predicates** (paste into PR body under `## Verification greps`):
   - `grep -cF 'export const BANNER_SPEC_VERSION = "4.0"' src/utils/banner.ts` → `1`
   - `grep -cF '"3.0"' src/utils/banner.ts` → `0` (no stale spec version anywhere in the file)
   - `grep -cF 'export function renderBootMastheadSvg' src/utils/banner.ts` → `1`
   - `grep -cF 'export function renderFinalizationBannerHtml' src/utils/banner.ts` → `1`
   - `grep -cF 'boot_masthead_svg' src/tools/bootstrap.ts` → `1` (or more)
   - `grep -cF 'finalization_banner_html = renderFinalizationBannerHtml' src/tools/finalize.ts` → `1`
   - `grep -cF 'docs/banner-spec.md' src/utils/banner.ts` → `0` (stale path comments fixed)
5. **Add tests** (in the banner/finalize test file). Paste new test names + pass output into PR body under `## New tests`:
   - `renderBootMastheadSvg` returns a non-empty string starting with `<svg` that contains the interpolated session number and all four status glyph labels.
   - `renderBootMastheadSvg` with `suggested: null` omits the `Suggested:` line.
   - `renderFinalizationBannerHtml` returns non-empty HTML containing each supplied deliverable string.
   - `BANNER_SPEC_VERSION === "4.0"`.
   - Existing `parseTemplateBannerSpecVersion` drift test updated to 4.0 and still fires on a 3.x mismatch.
6. Paste the FULL source of both new render functions into the PR body under `## New render functions`.
7. `git status` shows ONLY the four files modified (`banner.ts`, `bootstrap.ts`, `finalize.ts`, the test file).

---

## Finishing up

- Open a PR against `main`.
  - **Title:** `feat: restore graphical banners (boot SVG masthead + finalization HTML), bump banner spec 3.0 → 4.0 [D-249]`
  - **Body:** one-paragraph summary; the two new render functions; verification greps; build + test tails; new test names; and a one-line note that a transient warn-level `BANNER_DRIFT` is expected until the Stage-2 framework brief lands. Reference this brief: `.prism/briefs/queue/brief-447-d249-graphical-banners.md`.
- DO NOT deploy. Operator reviews, merges, and triggers the Railway deploy manually.
- Exit without further commands after the PR is opened.
