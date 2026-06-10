---
brief: 452
title: "Banner session-state color designation — green boot pill, red finalization accents (Banner Spec 4.1, D-256)"
affects:
  - src/utils/banner.ts
  - tests/banner-handshake.test.ts
complexity: small
---

# Brief 452 — Banner session-state color designation (Banner Spec 4.1)

## Context

Operator directive (prism S164, D-256): the boot and finalization banners must carry an explicit session-state color designation — GREEN marks session start, RED marks session end — consistently across every project. Today `renderBootMastheadSvg` renders the "boot" pill as `c-teal`, and `renderFinalizationBannerHtml` renders the "finalized" pill in success-green (`--color-text-success` / `--color-background-success`). Both renderers live in `src/utils/banner.ts`. This brief changes ONLY colors and the version constant — zero layout/grammar changes, zero data-contract changes. The companion prism-framework brief (brief-602) updates the spec/template documents to declare 4.1; until it merges, BANNER_DRIFT warn diagnostics at boot are expected and accepted.

## Required pre-flight (do these reads BEFORE writing code)

1. Read `src/utils/banner.ts` in full. Confirm the three target lines below exist verbatim at HEAD; if any has drifted, stop and report the actual line in the PR body instead of guessing.
2. Grep the whole repo (src + tests) for every consumer/assertion of: `c-teal`, `BANNER_SPEC_VERSION`, the literal `"4.0"` in banner-related tests, `background-success` within the finalization renderer/tests, and the card-opener string `border-radius:var(--border-radius-lg);padding:1.1rem 1.25rem`. List every hit in the PR body. `tests/banner-handshake.test.ts` is known; there may be others.
3. Confirm `renderBootMastheadSvg` is called only from `src/tools/bootstrap.ts` and `renderFinalizationBannerHtml` only from `src/tools/finalize.ts` (signatures unchanged, so call sites need no edits — verify, don't assume).

## Changes (exact targets)

**A. Boot masthead pill — green start designation.** In `renderBootMastheadSvg`, the pill line becomes exactly:

`<g class="c-green"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>`

(only `c-teal` → `c-green`; coordinates, classes, text unchanged). No other masthead changes — status glyph colors, docs chip, divider lines, Suggested line all stay as-is.

**B. Finalization pill — red end designation.** In `renderFinalizationBannerHtml`, the "finalized" pill span becomes exactly:

`<span style="font-size:12px;font-weight:500;color:var(--color-text-danger);background:var(--color-background-danger);padding:4px 12px;border-radius:var(--border-radius-md);">finalized</span>`

**C. Red top accent strip on the finalization card.** Restructure the card wrapper. The current single opener line

`<div style="background:var(--color-background-secondary);border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);padding:1.1rem 1.25rem;">`

is replaced by three lines pushed in order:

1. `<div style="background:var(--color-background-secondary);border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);overflow:hidden;">`
2. `<div style="height:3px;background:var(--color-text-danger);"></div>`
3. `<div style="padding:1.1rem 1.25rem;">`

and the final closing `</div>` push is replaced by two closes (inner padding div, then outer card). The sr-only `<h2>` and the `.brand`/`.mark` `<style>` block stay OUTSIDE/BEFORE the card div as today. Rationale for strip-inside-overflow-hidden rather than `border-top`: the widget host design system prohibits single-sided borders on rounded containers; the full-bleed inner strip keeps the rounded card and adapts to dark mode via the danger variable.

**D. Explicitly unchanged.** Phase-step glyph colors (`PHASE_COLOR_VAR` — ok stays `--color-text-success`), docs-chip success/neutral logic, `.brand`/`.mark` purple, sr-only text, `escapeMarkup` usage, `renderUnifiedBanner` (text surface carries no color), `renderBannerFallback`, `parseTemplateBannerSpecVersion` logic. Green ✓ glyphs encode phase success and MUST stay green — red there would read as failure.

**E. Version constant + docs.** `BANNER_SPEC_VERSION` `"4.0"` → `"4.1"`. Append to its JSDoc version history: `4.1 (D-256) — session-state color designation: green boot pill, red finalized pill + 3px top accent strip; structure, grammar, and data contracts unchanged.` Update the `renderFinalizationBannerHtml` JSDoc sentence about the pill to reflect the red designation.

## Tests

Update every assertion found in pre-flight step 2 that encodes the old colors/version. Add (or adjust to) explicit cases:
- masthead output contains the exact Change-A pill line (`c-green` boot pill) and contains no `c-teal`;
- finalization output contains the exact Change-B danger pill line;
- finalization output's card div carries `overflow:hidden` and its first child is the exact Change-C strip line;
- finalization output still styles ok phase glyphs with `--color-text-success`;
- `BANNER_SPEC_VERSION === "4.1"` wherever the constant is asserted.
If main has pre-existing unrelated test failures, record them verbatim in the PR body and do not fix them here (prism INS-26).

## Verification + PR evidence (REQUIRED in the PR body — this is the only observability channel)

1. `npm test` full-suite counts before and after (baseline at PR #71 merge was 1282 passing).
2. Grep excerpts proving: the three exact target lines present; zero `c-teal` occurrences in src; `BANNER_SPEC_VERSION = "4.1"`; `--color-text-success` still present in `PHASE_COLOR_VAR`.
3. The pre-flight step-2 consumer/assertion hit list, each with a one-line changed/unchanged note.

## Push directive (exactly one)

Create branch `brief/452-banner-session-state-colors` off `origin/main`, commit all changes, push, and open a PR to `main` titled `feat(banner): green boot pill + red finalization designation (Banner Spec 4.1, brief-452)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR.

## Out of scope

- prism-framework spec/template files (`banner-spec.md`, `finalization-banner-spec.md`, core templates, rules-session-end.md) — companion brief-602.
- Any layout, geometry, grammar, or data-schema change to either banner.
- `renderUnifiedBanner` / `banner_text` content.
- Railway env/config changes.
