---
brief: 436
title: "R5-b — fix prism-mcp-server doc drift (CLAUDE.md tools/version/model, models.ts docstring)"
parallel: true
depends_on: []
affects:
  - CLAUDE.md
  - README.md
  - src/models.ts
complexity: low
workflow: direct
model: claude-sonnet-4-6
effort: medium
---

# Brief 436 — R5-b: fix prism-mcp-server doc drift

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 finding #147 + table row R5-b. AUTO-tier quick win; runs parallel to brief-435 (disjoint files).

## Context

The server's own identity docs have drifted from the code (audit brief-431 #147):
- `CLAUDE.md` claims **v4.0.0 / 18 tools / Opus 4.6**; the code is **v4.7.0 / 23 tools / Opus 4.8**.
- `src/models.ts:57-58` docstring stale-claims the synthesis model is `claude-opus-4-7`, but the constant `SYNTHESIS_MODEL_ID` (`models.ts:60`) is `claude-opus-4-8`.

Authoritative sources to reconcile against: version in `src/config.ts` (~line 55), tool count/list in `src/tool-registry.ts` `getExpectedToolSurface` (~line 70), synthesis model in `src/models.ts` (~line 60).

## Required Changes

**Investigate first.** Read `CLAUDE.md` (the drifted claims), `src/config.ts` (version), `src/tool-registry.ts` `getExpectedToolSurface` (the authoritative registered tool count — audit says 23; confirm the exact number), `src/models.ts` (`SYNTHESIS_MODEL_ID` + the stale docstring ~57-58).

**Change (docs + one code comment only — no logic):**
- Update `CLAUDE.md` so every version / tool-count / model claim matches the code: version → the `config.ts` value, tool count → the actual registered count from `tool-registry.ts`, model → Opus 4.8. Grep `CLAUDE.md` for stale tokens (`18`, `4.0`, `4.6`, `Opus 4.6`) and reconcile each.
- Fix the `src/models.ts:57-58` docstring to read `claude-opus-4-8` (match the `SYNTHESIS_MODEL_ID` constant). **Comment-only — do not touch any constant or logic.**
- Grep the rest of the repo's docs (`README.md`, any `docs/`) for the same stale claims and fix them too.

## Verification (hard block — land evidence in the PR body)

1. The `models.ts` change is **comment-only** — confirm zero logic diff (show the diff).
2. `tsc` + lint + build clean; full test suite still green (no test changes expected — docs/comment only). Report counts.
3. Report before/after values (version, tool count, model) and confirm they now match `config.ts` / `tool-registry.ts` / `models.ts`.
4. Grep confirms no remaining stale tokens (`18 tools`, `v4.0`, `Opus 4.6`, docstring `claude-opus-4-7`) across `CLAUDE.md` / `README.md` / docs.

## Out of Scope

- The `trigger` repo `DESIGN.md` drift (synchronous→fire-and-forget) — different repo, separate brief.
- `DEFAULT_CONTEXT_WINDOW_TOKENS` (already fixed in brief-433 / R7-a).
- Any code/logic change beyond the `models.ts` docstring.

## PR Title / Body Hint

Title: `prism(R5-b): doc drift — CLAUDE.md + models.ts docstring match code (D-240 Phase B)`
Body: the drift (v4.0→4.7, 18→23 tools, Opus 4.6→4.8, docstring 4-7→4-8), authoritative sources, before/after values, confirmation models.ts is comment-only and tests are green.

## Brief Author Notes

- Grounded against audit brief-431 #147 + table R5-b and the cited sources (`config.ts:55`, `models.ts:57-60`, `tool-registry.ts:70`).
- Tier: **AUTO** (pure docs + one code comment).
- Pinned `claude-sonnet-4-6` (right-sized for a mechanical reconciliation; also validates R4 selects a non-default model). Confirm in the PR body which model CC actually launched on.

<!-- EOF -->
