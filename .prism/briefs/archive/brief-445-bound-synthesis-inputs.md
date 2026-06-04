---
brief: 445
title: "R3-dur — bound synthesis inputs (durable cap to prevent CS-1 timeouts)"
parallel: false
depends_on: [444]
affects:
  - src/ai/synthesize.ts
  - src/config.ts
  - tests/
complexity: high
workflow: metaswarm
model: claude-opus-4-8
effort: max
---

# Brief 445 — R3-dur: bound synthesis inputs

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 row R3 (durable half). The immediate half
(R3-imm, brief-438) migrated 126 standing rules out of insights.md (407KB → ~18KB) and
merged S149, which removes the dominant input and should clear the 180s CS-1
SYNTHESIS_TIMEOUT. R3-dur is the DURABLE backstop: a hard cap on the *combined*
synthesis input so future doc growth can never re-trigger the timeout. **Depends on
brief-444** (444 edits finalize.ts, which drives synthesis; runs after 444 merges).
**CODE.**

## Context
Synthesis (`generateIntelligenceBrief` + `generatePendingDocUpdates` in
`src/ai/synthesize.ts`, invoked by `prism_synthesize` and by `prism_finalize`'s
commit-action handler) assembles living-doc content and feeds it to the model. Pre-438,
the assembled input was ~611KB / ~175K tok (insights.md dominant) and timed out at the
180s SYNTHESIS_TIMEOUT. 438 cut the data; nothing yet *bounds* the assembled input, so
a future bloat (a large architecture.md, a long task-queue, decisions accretion) could
re-cross the timeout. Failure classification (SYNTHESIS_TIMEOUT / SYNTHESIS_RETRY) lives
in the tool wrapper `src/tools/synthesize.ts` and must be preserved.

## Required Changes
**Investigate first.** Read `src/ai/synthesize.ts` end-to-end: how
`generateIntelligenceBrief` and `generatePendingDocUpdates` select and concatenate the
living docs into the prompt, what model + timeout they use, and whether any size/token
measurement already exists. Read the synthesis call site in `src/tools/finalize.ts` to
confirm the same assembly path is used.

1. **Bound the combined synthesis input** to a hard ceiling of **<=120K tokens**, with a
   **target of <60K tokens** for the assembled prompt. Add the ceiling as a named
   constant (e.g. `SYNTHESIS_INPUT_MAX_TOKENS` / `_TARGET_TOKENS`) in `src/config.ts`.
2. **Deterministic reduction when over the ceiling.** When the assembled input would
   exceed the cap, reduce it deterministically and observably — priority-trim the
   largest / lowest-signal inputs first (cap per-doc contribution, prefer recent
   sections, drop or summarize the tail of oversized docs) rather than failing. The
   selection MUST be deterministic (same inputs → same trimmed prompt) and MUST preserve
   the highest-signal content (recent decisions, active insights, handoff). Document the
   trimming order in code comments.
3. **Token measurement.** Use a real token count (the model's tokenizer if available,
   else a calibrated chars/token estimate consistent with the rest of the codebase) so
   the cap is enforced in tokens, not raw bytes.
4. **Observability.** Emit the pre-trim and post-trim input token counts (whether
   trimming fired, and which inputs were trimmed) into the synthesis `diagnostics` /
   logger so a future operator can see headroom. Log-only; no new error class.

## Verification (HARD BLOCK — land all evidence in the PR body)
1. Test: with an oversized fixture (assembled input > 120K tok), the bound fires and
   the prompt fed to the model is <=120K tok; with a normal fixture (< target), the
   prompt is unchanged (no trimming). Assert determinism (same input → identical
   trimmed output across two runs).
2. Test: highest-signal content (recent decisions / active insights / handoff) survives
   trimming; only the lowest-priority tail is dropped/summarized.
3. Test: the pre/post token counts are emitted in diagnostics; SYNTHESIS_TIMEOUT /
   SYNTHESIS_RETRY classification is unchanged.
4. Full suite green; tsc + lint clean; report counts (N -> M) and the measured
   pre/post token counts on a representative fixture.

## Out of Scope
- The data migration (R3-imm / brief-438, already merged).
- Boot-payload sizing (brief-443) and the hygiene bundle (brief-444).
- Changing the synthesis model or the 180s timeout value (only the INPUT is bounded).

## PR Title / Body Hint
Title: `prism(R3-dur): bound synthesis inputs <=120K tok (durable CS-1 timeout backstop, D-240 Phase B)`
Body: the R3-imm→R3-dur split, the <=120K ceiling / <60K target, the deterministic
priority-trim order, token measurement method, pre/post counts on a fixture, tests,
counts N->M, confirmation CC launched on claude-opus-4-8.

## Brief Author Notes
- R3-imm (438) already removed the dominant input; this is defense-in-depth, so the
  normal-case path must be a NO-OP (don't trim inputs already under target).
- Determinism matters — synthesis output should be reproducible; a nondeterministic
  trim would make the intelligence brief flap between finalizes.
- Preserve the existing SYNTHESIS_TIMEOUT / SYNTHESIS_RETRY diagnostics in
  src/tools/synthesize.ts — this brief touches src/ai/synthesize.ts, not the classifier.
- Model pinning (R4): confirm CC launched on claude-opus-4-8 in the PR body.
- Tier: AUTO. CI gates the merge.

<!-- EOF -->
