# brief-s182-prism-mcp-hygiene — prism-mcp-server doc + marker hygiene

STEP 0: Run `claude auth status`; print the active account + auth mode (presence only, never token values) as the first line of your work.

## Context
Three long-deferred, low-risk hygiene items, bundled per the task-queue "bundle with next prism-mcp-server brief" notes (S147 / S164 / D-240). All additive/corrective — no living-doc deletions, no architectural changes. Verify each item's CURRENT state first; SKIP any already done and say so in the PR body.

## Tasks
1. **banner-spec doc currency.** `docs/banner-spec.md` is stale at v3.0; the shipped renderer is 4.1 (pin 4c242ed). Rewrite the doc to match the shipped 4.1 renderer, and replace the documented schema name `BannerTextInput` with the shipped `UnifiedBannerInput`. Read the actual renderer + schema in src to ground every field — invent nothing.

2. **sanitizeContentField on prism_log_insight.** `prism_log_insight` does not apply `sanitizeContentField` to its content/description input the way sibling write tools do. Apply it, matching the existing sibling pattern, and add/extend a unit test for the sanitization.

3. **Trigger-marker dead-knob honesty (S147 / D-241).** In the bootstrap marker-generator that emits `.prism/trigger.yaml`, the fields `intra_project_parallel` and `max_parallel_briefs` are dead config (never read at runtime) and the auto-generated comment wrongly implies they gate parallelism. Default them to `intra_project_parallel: false` / `max_parallel_briefs: 1` and rewrite the comment to state plainly they are inert (serial-within-repo is enforced elsewhere per D-241). Honest defaults + honest comment — no runtime wiring. NOTE: the live prism-mcp-server marker itself currently carries the misleading S146/D-240 comment with these set true/5 — that confirms this item is applicable; fix the GENERATOR, do not hand-edit the marker.

## Constraints
- Do NOT delete or modify any `.prism/` living-doc files — out of scope, handled separately.
- Do NOT touch `validation/slug.ts` — out of scope, handled separately.
- Limit source changes to the three items above. No unrelated refactors.

## Verification & evidence (INS-148)
- Run the FULL test suite; it must be green (0 failed) before opening the PR.
- PR body must include: STEP 0 auth attestation; per-item done/skipped + what changed; the full-suite result line (passed/failed/skipped counts); any targeted test counts added. One PR for the bundle, targeting `main`.

<!-- EOF: brief-s182-prism-mcp-hygiene.md -->
