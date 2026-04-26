# Brief — S71 Phase 3a: Synthesis on Opus 4.7 with Adaptive Thinking

> **Brief type:** Fix brief (source modifications, single PR).
> **Authored:** PRISM S71 (04-26-26).
> **Target repo:** brdonath1/prism-mcp-server.
> **Estimated runtime:** 30–60 minutes wall-clock (read + small surgical edits + tests).
> **Predecessor:** PR #19 audit (commit `6972ebd8` on `audits/s71-phase3-llm-routing` branch). This brief implements a corrected, narrower Phase 3a scope discovered during S71 review.

## 1. Context

During S71, the operator caught an underexploited quality lever the audit missed: synthesis is running on `claude-opus-4-6` with **no extended thinking** while the rest of the PRISM stack (Claude.ai, `cc_dispatch` subprocess) sits at Opus 4.7 with max effort. The audit focused on auth-path migration (OAuth) and did not probe the model/effort/thinking dimensions per call site.

**Operator goal:** improve PRISM efficiency, quality, and performance — without sacrificing precision or quality. Phase 3 was widened in S71 to three sub-phases:

- **Phase 3a (this brief):** synthesis (fire-and-forget) gets Opus 4.7 + adaptive thinking. Lowest risk, highest immediate quality lift.
- **Phase 3b (deferred):** draft phase (`blocks-operator`) gets Opus 4.7. Adaptive thinking gated on benchmark.
- **Phase 3c (deferred):** OAuth migration on synthesis. Gated on the OAuth-on-Messages-API verification (the curl one-liner outstanding to operator).

This brief is **only Phase 3a**. Do not modify auth path; do not modify draft phase.

## 2. Grounding (verified S71, do not re-research these)

Three facts established this session that the brief depends on:

1. **Model identifier:** `claude-opus-4-7`. Source: Anthropic announcement, https://www.anthropic.com/news/claude-opus-4-7 (2026-04-15 GA). Drop-in replacement for `claude-opus-4-6` in the `@anthropic-ai/sdk` `Anthropic({ apiKey })` constructor + `messages.create({ model: ... })` call.
2. **Thinking parameter:** Opus 4.7 supports **only** `thinking.type: "adaptive"`. The legacy `thinking.type: "enabled"` + `budget_tokens` form returns HTTP 400 on 4.7. Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html ("If you are migrating from Opus 4.6, update your requests to use thinking.type: 'adaptive'"). Adaptive thinking lets the model dynamically allocate thinking-token budget per request based on complexity.
3. **Removed parameters:** Opus 4.7 rejects `temperature`, `top_p`, `top_k`. Source: same Bedrock model card. `src/ai/client.ts` was verified S71 to NOT pass any of these — no removal work needed.

**Tokenizer change:** Opus 4.7 counts ~1.0–1.35× more tokens than 4.6 on the same input. Modest input-cost increase. Source: nxcode developer guide (citing Anthropic). Not a blocker; mention in PR body for cost-tracking.

## 3. Pre-flight (mandatory — INS-33)

Before writing any code, verify each of these. Capture verbatim outputs in PR body.

```bash
# 3.1 — confirm current SYNTHESIS_MODEL is the stale 4.6 default
grep -n "SYNTHESIS_MODEL" src/config.ts
# Expected: line ~72 with default "claude-opus-4-6"

# 3.2 — confirm synthesize() does NOT currently pass forbidden 4.7 params
grep -nE "temperature|top_p|top_k" src/ai/client.ts
# Expected: 0 hits

# 3.3 — confirm synthesize() does NOT already pass thinking
grep -n "thinking" src/ai/client.ts src/ai/synthesize.ts src/tools/finalize.ts
# Expected: 0 hits

# 3.4 — confirm SDK version supports the parameter shape
grep -E "@anthropic-ai/sdk" package.json
# Note version. If <0.40.0, adaptive thinking types may not exist in TS — see Step 5.

# 3.5 — confirm SYNTHESIS_TIMEOUT_MS
grep -n "SYNTHESIS_TIMEOUT_MS" src/config.ts
# Expected: line ~82 = 120_000ms. Will need bump in Step 4.
```

If any pre-flight returns unexpected results, STOP and report. Do not proceed with edits.

## 4. Steps

### Step 1 — Bump `SYNTHESIS_MODEL` default to `claude-opus-4-7`

**File:** `src/config.ts`
**Line:** ~72

```ts
// Before
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-opus-4-6";

// After
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-opus-4-7";
```

Also update the comment on line ~70 from "Anthropic API key for Opus 4.6 synthesis (Track 2)" to "Anthropic API key for Opus 4.7 synthesis (Track 2)".

**Affects:** all three PRIM-1 callers (`generateIntelligenceBrief`, `generatePendingDocUpdates`, `draftPhase`). Draft phase gets the model bump as part of this brief; what 3a does NOT do is enable thinking on draft (see Step 3).

### Step 2 — Extend `synthesize()` signature with optional `thinking` flag

**File:** `src/ai/client.ts`

Add a new optional parameter `thinking?: boolean` (default `false`) to `synthesize()`. When `true`, pass `thinking: { type: "adaptive" }` to `anthropic.messages.create()`.

```ts
// Approximate shape (CC: adapt to existing code style and ordering of params)
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
  thinking?: boolean, // NEW — default false
): Promise<SynthesisOutcome> {
  // ...
  const requestBody: Anthropic.MessageCreateParams = {
    model: SYNTHESIS_MODEL,
    max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  };
  if (thinking) {
    // Opus 4.7 supports ONLY adaptive; "enabled" + budget_tokens returns 400.
    (requestBody as any).thinking = { type: "adaptive" };
  }
  const response = await anthropic.messages.create(requestBody, requestOptions);
  // ...
}
```

**Notes for CC:**
- The `as any` cast is acceptable if the installed `@anthropic-ai/sdk` types do not yet include `thinking.type: "adaptive"`. Runtime works regardless. If types DO include it, drop the cast.
- The response from a thinking-enabled call may include `thinking` content blocks alongside `text` blocks. The existing extraction at `src/ai/client.ts` filters to `block.type === "text"` — that filter handles thinking blocks correctly (they're ignored, only text is concatenated). **Do not change the extraction.**
- The existing logging at `logger.info("Synthesis API call complete", ...)` should additionally log `thinking_enabled: !!thinking` for post-deploy verification.

### Step 3 — Enable thinking on synthesis callers (CS-2, CS-3) ONLY

**Files:** `src/ai/synthesize.ts`

At the two `synthesize(...)` call sites:
- `generateIntelligenceBrief` (around line 84): pass `thinking: true`.
- `generatePendingDocUpdates` (around line 245): pass `thinking: true`.

**DO NOT modify** `src/tools/finalize.ts:396` (the `draftPhase` call). Draft remains thinking-disabled in this brief. Phase 3b decision.

Rationale: synthesis is fire-and-forget per D-78 (`void Promise.allSettled` at `src/tools/finalize.ts:722`) — latency overhead is invisible to operator. Draft phase blocks finalize commit and has a strict JSON contract via `extractJSON`; thinking-induced output drift is a regression risk that needs a separate benchmark.

### Step 4 — Bump `SYNTHESIS_TIMEOUT_MS` to accommodate adaptive thinking

**File:** `src/config.ts`
**Line:** ~82

Observed S71 baseline (PRISM project, 19 finalize-time synthesis calls, S51–S70): p95 = 118.9s, near the current 120s ceiling. Adaptive thinking will add additional output tokens; conservatively expect p95 to increase 1.5–2×.

```ts
// Before
export const SYNTHESIS_TIMEOUT_MS = 120_000;

// After
export const SYNTHESIS_TIMEOUT_MS =
  parseInt(process.env.SYNTHESIS_TIMEOUT_MS ?? "240000", 10) || 240_000;
```

Make it env-overridable (currently it's a hardcoded constant) so we can tune per-deployment without redeploys. 240s default = 2× current; conservatively absorbs adaptive overhead. Synthesis is fire-and-forget so longer timeout has no operator-visible cost.

**Also:** review whether `SYNTHESIS_MAX_OUTPUT_TOKENS = 4096` (line ~78) is sufficient when thinking is on. Adaptive thinking output may include thinking content blocks separate from text blocks; the API counts thinking against `max_tokens`. Current observed text output is 1–3.5K tokens; thinking budget can add several thousand more. Bump to 8192 to be safe:

```ts
// Before
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 4096;

// After
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 8192;
```

### Step 5 — SDK type compatibility check

If pre-flight 3.4 reports `@anthropic-ai/sdk` at `^0.81.0` or similar:

- The SDK passes `MessageCreateParams` through to the API verbatim. Runtime supports any `thinking` object the API accepts.
- TypeScript types may not yet include `thinking.type: "adaptive"` (added by Anthropic April 2026). The `as any` cast in Step 2 handles this.
- **Do NOT bump the SDK version in this brief.** SDK upgrade has its own surface area (breaking changes between major versions, type-shape shifts) and belongs in a separate brief if needed. The cast is the safer path for Phase 3a.

### Step 6 — Tests

**File:** `tests/ai/client.test.ts` (or wherever existing synthesize() tests live — grep to find)

Add at least these test cases:

1. `synthesize()` called WITHOUT `thinking` argument → request body does NOT include `thinking` field. Existing CS-1 (draft) path is preserved.
2. `synthesize()` called WITH `thinking: true` → request body includes `thinking: { type: "adaptive" }`.
3. Mock API response with both `text` and `thinking` content blocks → verify `result.content` contains only the text block content (thinking blocks ignored, no leakage).
4. Existing tests still pass with the new default model `claude-opus-4-7` (update any hardcoded `"claude-opus-4-6"` assertions to use `SYNTHESIS_MODEL` constant).

**File:** `tests/ai/synthesize.test.ts` (or equivalent)

Verify:
5. `generateIntelligenceBrief` mock-call argument inspection shows `thinking: true` is forwarded.
6. `generatePendingDocUpdates` mock-call argument inspection shows `thinking: true` is forwarded.

**File:** `tests/tools/finalize.test.ts` (or equivalent)

Verify:
7. `draftPhase` mock-call argument inspection shows `thinking` is NOT passed (or is `false`/undefined).

### Step 7 — Build + lint + typecheck

```bash
npm run typecheck   # must pass with 0 errors (allowing the as any cast)
npm run lint        # must pass
npm test            # all tests green; new tests added in Step 6 pass
npm run build       # must pass
```

If typecheck flags the `thinking` field as an unknown property, that confirms Step 5's `as any` cast was needed. Acceptable.

## 5. Verification (mandatory — INS-166)

Run each grep AT THE END (not mid-way) and quote outputs verbatim in PR body.

```bash
# V1 — model bumped, no stale refs
grep -rn "claude-opus-4-6" src/
# Expected: 0 hits (or zero hits in src/; comments referencing historical 4.6 are fine ONLY if explicitly historical, e.g., decision log refs)

grep -rn "claude-opus-4-7" src/
# Expected: ≥ 1 (at least the SYNTHESIS_MODEL default in src/config.ts)

# V2 — adaptive thinking present in client + callers
grep -rn "thinking" src/ai/client.ts
# Expected: ≥ 2 (parameter declaration + request body assignment)

grep -rn "thinking: true" src/ai/synthesize.ts
# Expected: exactly 2 (one per CS-2 and CS-3 call site)

grep -rn "thinking" src/tools/finalize.ts
# Expected: 0 hits (CS-1 untouched)

# V3 — no legacy budget_tokens form crept in
grep -rn 'type:.*"enabled"' src/
grep -rn "budget_tokens" src/
# Expected: 0 hits each

# V4 — forbidden-on-4.7 params absent
grep -rn "temperature\|top_p\|top_k" src/ai/
# Expected: 0 hits in src/ai/

# V5 — timeout + max_tokens bumps applied
grep -n "SYNTHESIS_TIMEOUT_MS" src/config.ts
# Expected: env-overridable form with 240_000 default

grep -n "SYNTHESIS_MAX_OUTPUT_TOKENS" src/config.ts
# Expected: 8192

# V6 — builds + tests clean
npm test 2>&1 | tail -20
# Expected: all tests pass; specifically the new thinking-flag tests
```

If ANY V1–V6 predicate fails, fix the code before committing.

## 6. Finishing Up

- Single PR on a new branch (suggested name: `feat/phase-3a-synthesis-opus-4-7`).
- PR title: `feat: Phase 3a — synthesis on Opus 4.7 with adaptive thinking`
- PR body must include:
  - Summary of changes (one bullet per file modified).
  - Verification grep outputs verbatim (V1–V6).
  - Pre-flight grep outputs verbatim (3.1–3.5).
  - **Cost note:** "Tokenizer change — Opus 4.7 counts ~1.0–1.35× more tokens than 4.6 on equivalent input. Adaptive thinking adds output tokens variable per request. Net cost increase modest; will be partially offset when Phase 3c (OAuth migration) lands and synthesis spend moves from API per-token billing to Max OAuth quota."
  - **Quality note:** "CS-1 (draft phase) gets the 4.7 model bump but NOT adaptive thinking; thinking on draft is deferred to Phase 3b pending a benchmark of the 150s draft budget under thinking-enabled load."
- Files touched (expected scope, no others):
  - `src/config.ts` (model + timeout + max_tokens)
  - `src/ai/client.ts` (signature + thinking branch)
  - `src/ai/synthesize.ts` (CS-2 + CS-3 thinking: true)
  - `tests/...` (new + updated tests per Step 6)
- Files explicitly NOT modified:
  - `src/tools/finalize.ts` — draft phase (CS-1) untouched.
  - `src/claude-code/*` — cc_dispatch already on OAuth + max effort, out of scope.
  - `package.json` / `package-lock.json` — no SDK upgrade in this brief.
- DO NOT modify auth path. DO NOT add OAuth migration. DO NOT touch CS-1 (draft) thinking.
- DO NOT run `claude setup-token` or any operator-interactive command.

## 7. Post-merge smoke test (operator-runs after Railway deploy)

After Railway redeploys with the merged change:

1. Trigger any project's finalize OR call `prism_synthesize project_slug=<slug> mode=generate session_number=<N>`.
2. Pull last 5 minutes of Railway logs filtered to `synthesis`.
3. **Verify:** every `Synthesis API call complete` entry shows `model: "claude-opus-4-7"`. Pre-deploy values were `claude-opus-4-6`.
4. **Verify:** durations are within reasonable bounds (target: p50 ≤ 240s; if any single call hits 240s timeout, check thinking is not over-allocating).
5. **Verify:** zero 400 errors in logs (would indicate thinking parameter mis-shape).

If smoke test fails, revert the PR; do not partial-fix in production. The brief is small enough that revert + re-issue is cleaner than amend-in-flight.

## 8. References

- D-78 (prism, S39) — synthesis decoupled from finalize commit response (fire-and-forget).
- D-146 (prism, S56) — OAuth boundary on Messages API; reason CS-2/CS-3 stay on API key in 3a (3c addresses this).
- D-156 (prism, S66) — Phase 2 design, parallel synthesis of intelligence-brief + pending-doc-updates.
- INS-33 — zero-result inference; verify input contains target class (this brief's pre-flight section).
- INS-166 — verification claims must be computed against prescribed code.
- INS-180 — production-data grounding (Step 4 timeout bump grounded in S71 Railway-log p95).
- Anthropic Opus 4.7 announcement: https://www.anthropic.com/news/claude-opus-4-7
- Adaptive thinking spec (Bedrock model card, applies to direct API): https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html
- Audit PR #19 (predecessor): https://github.com/brdonath1/prism-mcp-server/pull/19

<!-- EOF: s71-phase3a-synthesis-opus-4-7-adaptive-thinking.md -->
