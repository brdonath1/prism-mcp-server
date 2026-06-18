---
brief: 1870
title: "S187 — reconcile docs/banner-spec.md to shipped UnifiedBannerInput (v4.1)"
parallel: true
depends_on: []
affects:
  - docs/banner-spec.md
complexity: low
workflow: direct
model: claude-sonnet-4-6
effort: low
---

# Brief 1870 — reconcile docs/banner-spec.md to shipped banner (v4.1 / UnifiedBannerInput)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 residual tail / S164 "banner-spec doc debt." The boot-banner spec doc lags the shipped unified-banner implementation. AUTO-tier, docs-only quick win.

## Context

`docs/banner-spec.md` documents an obsolete banner contract: it still describes **v3.0 / `BannerTextInput`**, but the shipped banner is **v4.1 / `UnifiedBannerInput`** (the unified boot+finalize banner from brief-439 and the D-249/D-250/D-263 banner arc). PR #86 touched this doc only superficially and left the core interface description stale.

Authoritative sources to reconcile against — these are the shipped truth; **read them, do NOT change them**:
- `src/utils/banner.ts` — the shipped banner builder (the real `UnifiedBannerInput` shape, fields, and version).
- `tests/banner-unified.test.ts` — the contract the implementation is verified against.

## Required Changes

**Investigate first.** Read `docs/banner-spec.md` (the drifted spec), then `src/utils/banner.ts` and `tests/banner-unified.test.ts` to capture the actual shipped interface name, version, field set, and behavior.

**Change (docs only — no code, no logic):**
- Rewrite `docs/banner-spec.md` so the documented interface, version, field set, and semantics match `src/utils/banner.ts` exactly: `BannerTextInput` → `UnifiedBannerInput`; version 3.0 → the actual shipped version (confirm it is 4.1 from the code — do not assume); reconcile every field / shape / example to the current builder.
- Grep `docs/banner-spec.md` for stale tokens (`BannerTextInput`, `3.0`, and any removed/renamed fields) and reconcile each.
- If other docs (`README.md`, anything under `docs/`) reference the old `BannerTextInput` / v3.0 banner contract, fix those references too.

## Verification (hard block — land evidence in the PR body)

1. **Docs-only diff** — confirm zero changes to any `src/` or `tests/` file (show `git diff --stat`).
2. `tsc` + lint + build clean; full test suite still green (no test changes expected — docs only). Report counts.
3. Report before/after for the key facts (interface name, version, field list) and confirm they now match `src/utils/banner.ts` / `tests/banner-unified.test.ts`.
4. Grep confirms no remaining stale tokens (`BannerTextInput`, banner-spec `3.0`) across `docs/` + `README.md`.

## Out of Scope

- Any change to `src/utils/banner.ts`, the tests, or banner behavior — this is a documentation reconciliation only.
- The framework core-template version stamp / glossary currency (PRISM-side, tracked separately).
- Any other D-240 residual not directly part of the banner-spec doc.

## PR Title / Body Hint

Title: `docs: reconcile banner-spec.md to shipped UnifiedBannerInput v4.1 (D-240 residual)`
Body: the drift (`BannerTextInput`/3.0 → `UnifiedBannerInput`/4.1), the authoritative sources, before/after key facts, and confirmation the diff is docs-only with tests green.

## Brief Author Notes

- Grounded against the S164 "banner-spec doc debt" task-queue item + D-240 residual tail, and the shipped sources `src/utils/banner.ts` + `tests/banner-unified.test.ts`.
- Tier: **AUTO** (pure docs).
- Pinned `claude-sonnet-4-6` — right-sized for a mechanical doc reconciliation.
- Brief id `1870` is session-anchored (S187) and intentionally out-of-band: the framework's `reference/trigger-channel.md` (which documents the brief-numbering scheme) is currently missing/moved, so a sequential number could not be confirmed collision-free against the fleet counter (~700s). Renumber on archive if desired.

<!-- EOF -->
