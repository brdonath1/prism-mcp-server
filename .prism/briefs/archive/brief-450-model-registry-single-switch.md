---
model: claude-fable-5
affects:
  - src/models.ts
  - src/config.ts
  - src/claude-code/client.ts
  - docs/
---

# Brief 450 — Model registry single-switch: bump to Claude Fable 5 + consolidate every model pin (D-254)

**Repo:** prism-mcp-server

> Operator directive S162: migrate the fleet to Claude Fable 5 (`claude-fable-5`) AND re-architect so future model bumps are "a couple of switches." INS-244/245 gates PASSED S162 (operator probe: both `claude-fable-5` and the `fable` alias returned completions on the Max OAuth CC surface). Railway env already flipped chat-side: SYNTHESIS_BRIEF_MODEL, SYNTHESIS_DRAFT_MODEL, CC_DISPATCH_MODEL → `claude-fable-5`. SYNTHESIS_PDU_MODEL deliberately HELD at `claude-sonnet-4-6[1m]` pending a `claude-fable-5[1m]` window probe — do not touch it or reference removing it.

## Objective

Make `src/models.ts` the single switch for every server-side model default, bump it to Fable 5, and document the canonical bump SOP. After this PR, a future model migration inside this repo = one edit block in `src/models.ts`.

## Constraints

1. No Railway env reads/writes — env is owned chat-side. No `[1m]` suffixes anywhere.
2. Do NOT change routing BEHAVIOR (`resolveCallSiteRouting` semantics, transport selection, fallbacks). Documentation of that behavior is in scope; modification is not.
3. Branch from `main`: `brief/450-model-registry-single-switch`.

## Tasks

### 1 — Registry bump (`src/models.ts`)
- `SYNTHESIS_MODEL_ID` → `"claude-fable-5"`. Update its comment to note the INS-244/245 gate was passed S162.
- Add Fable 5 to `RECOMMENDATION_MODELS` as the top capability tier (display `Fable 5`), preserving the file's derivation pattern so `RecommendedModel`, the session-classifier `MODEL_BY_CATEGORY` map, and banner display pick it up without drift. Update `MODEL_BY_CATEGORY` so categories currently mapping to the top model map to Fable 5.

### 2 — Pin consolidation (single-switch audit)
- Enumerate every model literal in `src` (non-test): `grep -rnE '"claude-[a-z]+-[0-9]' src --include='*.ts' | grep -v __tests__`. Migrate each to a named export in `src/models.ts` (e.g. add `CC_DISPATCH_MODEL_ID`) and import from there. Known target: `src/config.ts` `CC_DISPATCH_MODEL` fallback `"opus"` → registry constant `CC_DISPATCH_MODEL_ID = "claude-fable-5"`.
- Tests asserting dated strings: update minimally; prefer importing registry constants over re-pinning literals where the test intent is "uses the default."

### 3 — Bump SOP doc (`docs/model-bump.md`, new)
Document the canonical fleet bump, with the env-vs-registry precedence rule stated precisely. REQUIRED: read `resolveCallSiteRouting` (src/ai client routing) and document exactly what happens to BOTH model and TRANSPORT when each `SYNTHESIS_*_MODEL` env is unset (the test suite suggests unset env may fall back to `messages_api` + SYNTHESIS_MODEL — confirm against source and state it; this determines whether clearing env overrides is ever safe). Cover all surfaces: (a) this registry + merge, (b) Railway env overrides, (c) Trigger daemon runtime config (chezmoi `~/.config/trigger/trigger.config.yaml`, INS-277) + rebuild-if-code/kickstart, (d) operator local CC setting, (e) living-doc references = INS-307 per-line manifest only.

## Verification (paste all outputs in PR body — INS-148)

1. `npm run build` clean; `npm test` all pass (report counts; baseline 1264+).
2. `grep -rnE '"claude-[a-z]+-[0-9]' src --include='*.ts' | grep -v __tests__ | grep -v models.ts` → 0 lines.
3. `grep -n 'claude-fable-5' src/models.ts` → present in SYNTHESIS_MODEL_ID + CC_DISPATCH_MODEL_ID + RECOMMENDATION_MODELS.
4. Paste the documented unset-env routing behavior with the source lines that prove it.

## Finishing up

- Commit prefix `fix:`. PR title: `fix: model registry single-switch — bump to claude-fable-5 (D-254)`. PR body: evidence block.
- DO NOT deploy. Merge + Railway deploy are handled chat-side.

<!-- EOF: brief-450-model-registry-single-switch.md -->
