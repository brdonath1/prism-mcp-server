# Bootstrap payload diet: Tier A-only rule bodies, B+C index, in-response oversize tripwire, spec-coupled brief compaction (D-253)

**Repo:** `prism-mcp-server`
**Files touched:** `src/utils/standing-rules.ts`, `src/tools/bootstrap.ts`, `src/tools/load-rules.ts`, `tests/standing-rule-tiers.test.ts`, `tests/bootstrap-rich-payload.test.ts`, `tests/bootstrap-budget.test.ts`
**Directed:** PRISM S161 (06-09-26), D-253. Partial, evidence-driven reversal of R7-b (brief-443 / D-240 Phase B).
**Type:** Hot-path payload fix. The R7-b "500K-context" rationale broke in production: prism boots are 234–246KB, exceeding the Claude.ai client's inline tool-result cap, so the ENTIRE bootstrap response is offloaded to a sandbox file and zero bytes (banner, behavioral rules, everything) reach the session. Railway has logged `bootstrap response exceeds 100KB` at error level on every prism boot since at least 06-07. Measured S161 payload: standing_rules 182,992B of 248,016B total (Tier A 59 rules/91,288B, Tier B 62 rules/91,705B); intelligence_brief 13,928B full.

---

## Verified starting state (read before coding; HEAD 11737fc at authoring)

- `src/utils/standing-rules.ts:133-135` — `selectStandingRulesForBoot` returns `rules.filter(rule => rule.tier === "A" || rule.tier === "B")`.
- `src/tools/bootstrap.ts:~995-1012` — R7-b block calls `selectStandingRulesForBoot`, builds `standingRulesTierCIndex = tierC.map(r => ({ id, title }))`, emits `STANDING_RULES_TIERED` diagnostic with `tier_b_loaded`.
- `src/tools/bootstrap.ts:~938-955` — intelligence brief full passthrough; comment block documents the D-47 reversal AND its reason: the old compactor matched section headers by string literal, so a renamed header silently dropped a section. That defect must be fixed by the restore, not reintroduced — see Change 3.
- `src/tools/bootstrap.ts:1196` — `diagnostics: diagnostics.list()` is materialized into `result` BEFORE the oversize check at lines ~1257-1265, so the `BOOTSTRAP_OVERSIZE` diagnostic can never appear in any response (Railway-only today). `bytes_delivered` counts fetched-file bytes, not response bytes.
- `src/tools/load-rules.ts:5` — header comment says "bootstrap delivers Tier A + Tier B bodies plus a Tier-C index". Tool already serves Tier B (+C with `include_tier_c`) by topic; Tier A excluded by design — unchanged.
- `src/utils/intelligence-brief-spec.ts` — exports the 6 spec section names (verify exact export shape before use in Change 3).
- Tests pinning current behavior: `tests/standing-rule-tiers.test.ts` (describe at line 42 pins A+B selection), `tests/bootstrap-rich-payload.test.ts` (lines ~260-300 pin FULL brief incl. `not.toContain("(compact)")` and `.length === FULL_BRIEF.length`; lines ~400-430 pin standing_rules contents), `tests/bootstrap-budget.test.ts:137` pins `context_window_tokens` to literal `500000`.

### Reading list (in order)
1. `src/utils/standing-rules.ts` — selection + tier types.
2. `src/tools/bootstrap.ts` — the R7-b standing-rules block, the brief-delivery block, result assembly through the oversize check.
3. `src/utils/intelligence-brief-spec.ts` — section-name exports.
4. The three test files above.

## Spec

### Change 1 — Tier A-only bodies at boot; Tier B joins the index
1. `selectStandingRulesForBoot` returns Tier A only: `rules.filter(rule => rule.tier === "A")`. Update its JSDoc: Tier B bodies are lazy-loaded via `prism_load_rules` (D-156 §3.5 restored, D-253).
2. In `bootstrap.ts`, build `standingRulesIndex` = Tier B ∪ Tier C entries, each `{ id, title, tier, topics }` (Tier B entries first, then Tier C, both in source order). Add to the result as `standing_rules_index`. KEEP `standing_rules_tier_c_index` exactly as today (C-only, `{id,title}`) for template back-compat — one-release alias, comment it as deprecated in favor of `standing_rules_index`.
3. Update the `STANDING_RULES_TIERED` diagnostic + `standing rules extracted` log: message "Standing rules delivered by tier (Tier A bodies; Tier B+C indexed — D-253)"; rename context key `tier_b_loaded` → `tier_b_indexed`.
4. `load-rules.ts` line-5 header comment: "bootstrap delivers Tier A bodies plus a Tier B+C index". Do NOT change the tool's runtime behavior or its registered description string (tool-surface text changes require a connector reconnect per INS-227 — out of scope).

### Change 2 — Oversize tripwire must ship in-response; expose response_bytes
Restructure the tail of the bootstrap handler so measurement precedes diagnostics materialization:
1. Assemble `result` WITHOUT `diagnostics` and WITHOUT `context_estimate`.
2. `const measured = JSON.stringify(result);` compute `bootstrapTokens` from `measured.length` and `responseBytes = new TextEncoder().encode(measured).length` (the two later attachments add <2KB; acceptable undercount, note it in a comment).
3. Run the existing >100_000 / >80_000 checks against `responseBytes` (unchanged thresholds, unchanged log lines, unchanged diagnostic code `BOOTSTRAP_OVERSIZE`).
4. THEN attach `result.context_estimate = {...}` (unchanged shape), `result.response_bytes = responseBytes` (new field), and `result.diagnostics = diagnostics.list()` LAST.
5. Final `JSON.stringify(result)` for the return. Remove the now-duplicate earlier serialization.

### Change 3 — Restore D-47 brief compaction, with the header-coupling defect fixed
1. Reintroduce a `compactIntelligenceBrief(full: string): string` (in `bootstrap.ts` or a util) implementing the INS-249 contract: output = `**Project State (compact):** ` + first 3 sentences of the Project State section, then the FULL "Risk Flags" section, then the FULL "Quality Audit" section.
2. Section names MUST come from the exports in `src/utils/intelligence-brief-spec.ts` — no string literals. If a referenced section is missing from the input, fall back to FULL passthrough and emit a `diagnostics.warn("BRIEF_COMPACT_FALLBACK", ...)` naming the missing section — this is the fix for the silent-drop defect the R7-b comment documents.
3. Replace the full-passthrough assignment with `intelligenceBrief = compactIntelligenceBrief(briefFile.content)`. Rewrite the surrounding comment block: full delivery reversed by D-253 (payload-cap incident); compaction is spec-coupled + fallback-guarded, superseding the brief-443 "Do NOT re-introduce" note.

### Change 4 — Tests
1. `tests/standing-rule-tiers.test.ts` — rewrite the line-42 describe: A-only selection (A kept in order; B excluded regardless of topics; C excluded; empty input → empty).
2. `tests/bootstrap-rich-payload.test.ts` — lines ~260-300: brief assertions now expect the compact shape (`toContain("(compact)")`, contains Risk Flags + Quality Audit section headers, does NOT equal/contain the full-brief-only sections' bodies, length < FULL_BRIEF.length); add a fallback test (brief missing "Risk Flags" header → full passthrough + BRIEF_COMPACT_FALLBACK diagnostic). Lines ~400-430: standing_rules contains ONLY Tier A ids; add assertions that `standing_rules_index` contains the B and C entries with correct `tier` tags and that `standing_rules_tier_c_index` is unchanged (C-only).
3. NEW test (rich-payload or budget file): with a fixture large enough to exceed 100KB (e.g., oversized standing-rules content), the parsed response's `diagnostics` array CONTAINS an entry with code `BOOTSTRAP_OVERSIZE`, and `response_bytes` is a number > 100_000.
4. NEW coupling test: every section name `compactIntelligenceBrief` consumes is present in the spec exports (import both; assert subset).
5. `tests/bootstrap-budget.test.ts:137` — replace the literal `500000` with the imported `DEFAULT_CONTEXT_WINDOW_TOKENS` from `src/config.js` so the Railway env override (D-253 sets 200000 in production) cannot desync CI.

### Explicitly out of scope
- No Tier A content/re-tiering edits (separate operator-gated manifest, INS-307).
- No framework-template or marker edits; no Railway env/deploy actions; no changes to `prism_load_rules` runtime behavior or registered tool descriptions; no banner/SVG/finalize changes.

## Verification

Runner MUST:
1. Build + typecheck (`npm run build`, `npx tsc --noEmit`) — 0 errors. Tail into PR body under `## Build`.
2. `npm test` — all pass. Counts into PR body under `## Tests`.
3. Grep predicates (PR body under `## Verification greps`):
   - `grep -cF 'rule.tier === "A" || rule.tier === "B"' src/utils/standing-rules.ts` → exactly `0`
   - `grep -cF 'standing_rules_index' src/tools/bootstrap.ts` → at least `2`
   - `grep -cF 'BRIEF_COMPACT_FALLBACK' src/tools/bootstrap.ts` → at least `1`
   - `grep -cF 'response_bytes' src/tools/bootstrap.ts` → at least `1`
   - `grep -c 'tier_b_indexed' src/tools/bootstrap.ts` → at least `1`
4. Ordering proof: paste the test name + pass line for the BOOTSTRAP_OVERSIZE-in-response test under `## Oversize tripwire`.
5. `git status` shows ONLY the six files listed under **Files touched** modified (plus any new test file if Change-4 item 3/4 lands in a new file — name it in the PR body if so).

## Finishing up
- Open a PR against `main`.
  - **Title:** `fix: bootstrap payload diet — Tier A-only bodies + B/C index, in-response oversize tripwire, spec-coupled brief compaction [D-253]`
  - **Body:** one-line summary; measured before/after `response_bytes` from the test fixtures; all grep counts; build + test tails. Reference this brief: `.prism/briefs/queue/brief-449-bootstrap-payload-diet.md`.
- DO NOT deploy. Merge + Railway deploy are handled chat-side after CI review.
- Exit without further commands after the PR is opened.
