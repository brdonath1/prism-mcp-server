# fullPhase: also emit finalization_banner_html (D-249 follow-up to brief-447)

**Repo:** `prism-mcp-server`
**Files touched:** `src/tools/finalize.ts` + its test in `tests/banner-handshake.test.ts`
**Directed:** PRISM S156 (06-07-26), D-249 / D-250 follow-up to brief-447 (PR #66, merged)
**Type:** Small gap fix — wires an existing render path into one more code path. No new markup, no spec change.

---

## Context

brief-447 restored the finalization HTML widget but populated `finalization_banner_html` ONLY on the `commit` surface. `fullPhase` (the single-call `action:"full"` = audit+draft+commit) still returns `finalization_banner_html: null`, so a session that finalizes via `action:"full"` gets the text fallback only — not the graphical widget. Close the gap: fullPhase emits the widget too, from the data it already assembles.

## Verified starting state (read before coding)

In `src/tools/finalize.ts` (post-brief-447 / PR #66):
- `assembleFinalizeBanner(...)` already returns `{ text: string; htmlInput: FinalizationBannerHtmlInput | null }`.
- The `commit`-surface handler already does `const { text: bannerText, htmlInput } = await assembleFinalizeBanner(...)`, then renders `finalization_banner_html` from `htmlInput` inside a try/catch (null on failure), and sets the field on the response. MIRROR that block.
- `fullPhase(...)` currently does `const { text: bannerText } = await assembleFinalizeBanner(...)` (DISCARDS htmlInput) and hardcodes `finalization_banner_html: null` in its return object (comment: "fullPhase emits banner_text only").
- `renderFinalizationBannerHtml` is already exported from `src/utils/banner.ts` and already imported into `finalize.ts` (confirm the import is present).

### Reading list (in order)
1. `src/tools/finalize.ts` — read `fullPhase` (its `assembleFinalizeBanner` destructure + the `finalization_banner_html: null` return line) and the `commit`-surface handler's widget-render block (the source to mirror).

## Spec

### Change 1 — `finalize.ts` `fullPhase`: render and emit the widget
1. Change fullPhase's destructure to keep htmlInput: `const { text: bannerText, htmlInput } = await assembleFinalizeBanner(...)`.
2. Immediately before fullPhase's return object, add the same render block the commit handler uses (adapted to fullPhase's variable names):
```ts
let finalization_banner_html: string | null = null;
if (htmlInput) {
  try {
    finalization_banner_html = renderFinalizationBannerHtml(htmlInput);
  } catch (htmlErr) {
    logger.warn("finalization HTML widget render failed — leaving null (banner_text fallback)", {
      project_slug: projectSlug,
      error: htmlErr instanceof Error ? htmlErr.message : String(htmlErr),
    });
  }
}
```
(Use fullPhase's actual project-slug parameter — it is `projectSlug` in that function, vs `project_slug` in the commit handler.)
3. In fullPhase's return object, replace `finalization_banner_html: null,` with `finalization_banner_html,` and update the trailing comment to note the widget is now emitted on the full surface too (matching the commit surface).

### Notes
- Do NOT touch `assembleFinalizeBanner`, the commit handler, the SVG/HTML markup, or `banner.ts`. This only wires fullPhase to the already-existing render path.
- `banner_text` stays the genuine fallback; `htmlInput` is null on the text-fallback path, so the field correctly stays null in that case.

### Explicitly out of scope
- No markup/spec/version changes; no framework changes; no Railway deploy (operator-gated).

## Verification

Runner MUST:
1. Apply the change.
2. Build + typecheck (`npm run build`, `npx tsc --noEmit`) — 0 errors. Paste tail into PR body under `## Build`.
3. `npm test` (vitest) — all pass. Paste counts into PR body under `## Tests`.
4. Grep predicates (PR body under `## Verification greps`):
   - `grep -cF 'finalization_banner_html: null' src/tools/finalize.ts` → `0` (the hardcoded null in fullPhase's return is gone; the `let … : string | null = null` initializers use `= null`, not `: null`, so they don't match)
   - `grep -cF 'finalization_banner_html = renderFinalizationBannerHtml' src/tools/finalize.ts` → `2` (commit surface + full surface)
5. Add a test in `tests/banner-handshake.test.ts`: `prism_finalize` with `action:"full"` populates `finalization_banner_html` (truthy, contains `"PRISM"` and `"finalized"`), and `banner_text` is also truthy. Paste the test name + pass output into PR body under `## New test`.
6. `git status` shows ONLY `src/tools/finalize.ts` and `tests/banner-handshake.test.ts` modified.

## Finishing up
- Open a PR against `main`.
  - **Title:** `fix: emit finalization_banner_html on the full finalize surface too [D-249 / brief-447 follow-up]`
  - **Body:** one-line summary, the grep counts, build + test tails, the new test name. Reference this brief: `.prism/briefs/queue/brief-448-fullphase-finalization-widget.md`.
- DO NOT deploy. Operator reviews, merges, and triggers the Railway deploy manually.
- Exit without further commands after the PR is opened.
