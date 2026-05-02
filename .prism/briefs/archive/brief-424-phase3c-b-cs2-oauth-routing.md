# Brief 424 — Phase 3c-B: Wire callSite="brief" at CS-2 (generateIntelligenceBrief)

**Repo:** prism-mcp-server
**Authorized:** D-208 (S119) — Phase 3c-B CS-2 OAuth routing
**Branch:** main
**PR title:** feat: Phase 3c-B — wire callSite="brief" at CS-2 for per-call-site routing

---

## Context

The synthesis layer in `src/ai/client.ts` supports per-call-site routing via env vars: `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` and `SYNTHESIS_${CALLSITE_UPPER}_MODEL`. The `SynthesisCallSite` type already includes `"brief"` in its union, but the `generateIntelligenceBrief` function in `src/ai/synthesize.ts` currently calls `synthesize()` with `callSite: undefined`, which means it bypasses routing entirely and always uses the default `claude-opus-4-7` + Messages API path — currently billing ~$2.10/finalize against `ANTHROPIC_API_KEY` (385,874 input + 6,855 output tokens measured at S118 finalize).

Phase 3c-B wires `callSite="brief"` at that call site so `SYNTHESIS_BRIEF_TRANSPORT` and `SYNTHESIS_BRIEF_MODEL` env vars can route CS-2 through the existing `cc_subprocess` OAuth path on the operator's CloudShift Max 20x plan, eliminating the per-token API cost while preserving Opus 4.7-class quality.

Mirror in shape of brief-420 (Phase 5a CS-1 wiring) and brief-417 (Phase 3c-A CS-3 routing). Adds the timeout-branching pattern already used by `generatePendingDocUpdates` because `cc_subprocess` requires a larger wall-clock ceiling than `messages_api`.

## Pre-flight verification (operator-side, completed S119)

Operator-side `/status` output from local Claude Code (S119, Ex 13) confirmed Opus 4.7 with 1M context is reachable on the operator's CloudShift Max 20x OAuth surface:

- `Auth token: CLAUDE_CODE_OAUTH_TOKEN` (OAuth, not API key)
- `Model: opus[1m] (claude-opus-4-7[1m][1m])` (Opus 4.7 + 1M context active)

This eliminates the model-resolution uncertainty noted in S119 chat-side investigation. No synthetic probe required — the operator's own CC client demonstrates the surface works for Opus 4.7. The "Billed as extra usage · $5/$25" UI text in the model picker is a known display artifact (anthropics/claude-code#34790, #40223) on Max plans, not an indication of actual billing — Opus 1M is included in Max subscriptions.

## Scope

Exactly **two files change**:

1. `src/ai/synthesize.ts` — modify `generateIntelligenceBrief` to pass `callSite: "brief"` and apply the timeout-branching pattern already used by `generatePendingDocUpdates`.
2. `src/ai/__tests__/client-routing.test.ts` — add unit-test coverage for the `"brief"` callSite routing path.

No other files change. No new functions. No prompt changes. No new env vars defined in code (the `SYNTHESIS_BRIEF_*` env vars are read by the existing `resolveCallSiteRouting()` machinery the moment a callSite of `"brief"` is passed).

## Change 1 — `src/ai/synthesize.ts`

Locate the `synthesize(` call inside `generateIntelligenceBrief` (currently approximately line 75–86). The current call is:

```ts
const result = await synthesize(
  FINALIZATION_SYNTHESIS_PROMPT,
  userMessage,
  undefined,
  SYNTHESIS_TIMEOUT_MS,
  undefined,
  true, // thinking: true — Phase 3a CS-2 adaptive-thinking flag
  undefined, // callSite — CS-2 stays on messages_api per Phase 3c-A scope
  projectSlug, // brief-419: project tagging for boot-time observation surfacing
);
```

Replace the call AND add the timeout-branching block immediately above it (mirroring the pattern in `generatePendingDocUpdates`):

```ts
// Determine which timeout to use: cc_subprocess needs its own (larger) ceiling
// because subprocess startup overhead is on top of inference time. Messages API
// path continues to use SYNTHESIS_TIMEOUT_MS (fire-and-forget baseline).
// Mirror of the same logic in generatePendingDocUpdates (brief-417 / Phase 3c-A).
const briefTransport = process.env.SYNTHESIS_BRIEF_TRANSPORT;
const briefTimeoutMs = briefTransport === "cc_subprocess"
  ? CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS
  : SYNTHESIS_TIMEOUT_MS;

const result = await synthesize(
  FINALIZATION_SYNTHESIS_PROMPT,
  userMessage,
  undefined,
  briefTimeoutMs,
  undefined,
  true, // thinking: true — Phase 3a CS-2 adaptive-thinking flag
  "brief", // brief-424 Phase 3c-B: per-call-site routing (SYNTHESIS_BRIEF_* env vars)
  projectSlug, // brief-419: project tagging for boot-time observation surfacing
);
```

**Verification:** `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` is already imported at the top of the file from `../config.js` — confirm by `grep -n CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS src/ai/synthesize.ts` before save (existing import line was added by brief-423).

**Default behavior unchanged:** when `SYNTHESIS_BRIEF_TRANSPORT` is unset, `briefTimeoutMs === SYNTHESIS_TIMEOUT_MS` and `resolveCallSiteRouting("brief")` defaults transport to `messages_api` with no model override — exactly the behavior before this change. No production behavior changes until the operator explicitly sets the env var.

## Change 2 — `src/ai/__tests__/client-routing.test.ts`

Add a test block for the `"brief"` callSite following the same pattern as the existing `"pdu"` and `"draft"` tests in this file. The tests must cover:

1. **Default routing (no env var set):** `resolveCallSiteRouting("brief")` returns `{ transport: "messages_api", modelOverridden: false }`. Verifies no behavior regression when env vars are absent.
2. **Transport override:** when `SYNTHESIS_BRIEF_TRANSPORT=cc_subprocess` is set, `resolveCallSiteRouting("brief")` returns `{ transport: "cc_subprocess" }`.
3. **Model override:** when `SYNTHESIS_BRIEF_MODEL=claude-opus-4-7` is set, `resolveCallSiteRouting("brief")` returns `{ model: "claude-opus-4-7", modelOverridden: true }`.

Follow the exact mock setup, env-var injection, and teardown pattern already used in this test file for other callSites. Do not add integration tests or mock the full `synthesize()` call — the routing unit tests are sufficient for this scope.

## Verification Steps (post-edit, pre-PR)

1. `npx tsc --noEmit` — must pass with zero errors.
2. `npx vitest run src/ai/__tests__/client-routing.test.ts` — all tests pass including the new `"brief"` block.
3. `npm test` — full suite passes, no regressions.
4. `npm run lint` — clean (biome).
5. Grep confirm: `grep -n 'callSite' src/ai/synthesize.ts` shows TWO usages — the existing `"pdu"` at the PDU call site and the new `"brief"` at the brief call site.
6. Grep confirm: `grep -n 'briefTimeoutMs\|pduTimeoutMs' src/ai/synthesize.ts` shows BOTH timeout-branching variables exist with parallel patterns.

## Files Changed

- `src/ai/synthesize.ts` (1 edit: timeout-branching block added + 2 lines changed in synthesize() call)
- `src/ai/__tests__/client-routing.test.ts` (3 new test cases added)

## PR Body Requirements

The PR body MUST include:

1. **Test results.** Confirm `npx tsc --noEmit`, `npx vitest run src/ai/__tests__/client-routing.test.ts`, `npm test`, and `npm run lint` all pass.
2. **Diff size.** Confirm both files changed are minimal — synthesize.ts gains ~5 lines net; test file gains a single new describe block with 3 cases.
3. **Operator-side activation note.** State explicitly: "This PR adds the routing wiring but does NOT activate it. Setting `SYNTHESIS_BRIEF_TRANSPORT=cc_subprocess` + `SYNTHESIS_BRIEF_MODEL=claude-opus-4-7` on Railway production is a separate operator-side step performed chat-side post-merge."

## Operator-side Activation (NOT part of this brief — chat-side follow-up)

After the PR merges and Railway auto-deploys, activation happens chat-side via:

1. `railway_env set SYNTHESIS_BRIEF_TRANSPORT=cc_subprocess`
2. `railway_env set SYNTHESIS_BRIEF_MODEL=claude-opus-4-7`

No redeploy needed. Effective on next finalize. Observation gate: watch the next 3-5 finalizations for `SYNTHESIS_TRANSPORT_FALLBACK` log entries with `callSite: "brief"`. Pass criterion: <10% fallback rate. Brief intelligence-brief.md outputs reviewed at boot for quality regression. Revert via `railway_env delete SYNTHESIS_BRIEF_TRANSPORT` (no code revert required).

## Tier-A Insights Referenced

- **INS-32** deep-dive before proposing framework fixes
- **INS-230** CC channel discipline — this brief is appropriately routed via Trigger
- **INS-234** brief target repo declaration — declared at top of this brief (Repo: prism-mcp-server matches queue path)
- **INS-244** cc_subprocess wrapper guard + [1m] opt-in — wrapper guard already in place from brief-418; [1m] suffix not required for Opus 4.7 on Max (auto-upgrades to 1M per operator's verified `/status` output)

<!-- EOF: brief-424-phase3c-b-cs2-oauth-routing.md -->
