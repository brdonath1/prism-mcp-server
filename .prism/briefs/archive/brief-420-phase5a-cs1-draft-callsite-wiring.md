# Brief 420 — Phase 5a: Wire callSite="draft" at CS-1 (finalize.ts draftPhase)

**Repo:** prism-mcp-server  
**Authorized:** D-204 (S115) — Phase 5a CS-1 leg  
**Branch:** main  
**PR title:** feat: Phase 5a — wire callSite="draft" at CS-1 for per-call-site routing

---

## Context

The synthesis layer in `src/ai/client.ts` supports per-call-site routing via env vars: `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` and `SYNTHESIS_${CALLSITE_UPPER}_MODEL`. The `SynthesisCallSite` type already includes `"draft"` in its union, but the `draftPhase` handler in `src/tools/finalize.ts` currently calls `synthesize()` without passing `callSite` (arg 7 is omitted), which means it bypasses routing entirely and always uses the default Opus 4.7 + Messages API path.

Phase 5a wires `callSite="draft"` at that call site so `SYNTHESIS_DRAFT_TRANSPORT` and `SYNTHESIS_DRAFT_MODEL` env vars can route CS-1 independently.

---

## Scope

Exactly **two files change**:

1. `src/tools/finalize.ts` — add `callSite` and `projectSlug` args to the `synthesize()` call
2. `src/ai/__tests__/client-routing.test.ts` — add test coverage for the `"draft"` callSite routing path

No other files change. No new functions. No prompt changes. No env-var changes (env vars already readable; adding the call site is what activates them).

---

## Change 1 — `src/tools/finalize.ts`

Locate the `synthesize(` call inside `draftPhase` at approximately line 395. The current call is:

```ts
synthesize(
  FINALIZATION_DRAFT_PROMPT,
  userMessage,
  4096,
  draftTimeoutMs,
  0, // maxRetries — retry storms on draft are worse than fast failure (S41)
  true, // thinking: true — Phase 3b CS-1 adaptive-thinking flag (D-159 successor)
)
```

Replace it with:

```ts
synthesize(
  FINALIZATION_DRAFT_PROMPT,
  userMessage,
  4096,
  draftTimeoutMs,
  0, // maxRetries — retry storms on draft are worse than fast failure (S41)
  true, // thinking: true — Phase 3b CS-1 adaptive-thinking flag (D-159 successor)
  "draft", // brief-420 Phase 5a: per-call-site routing (SYNTHESIS_DRAFT_* env vars)
  projectSlug, // brief-420 Phase 5a: project tag for observation surfacing (brief-419)
)
```

**Verification:** `projectSlug` is confirmed in scope at the `draftPhase` call site (type `string`).

**Default behavior unchanged:** when `SYNTHESIS_DRAFT_TRANSPORT` is unset, `resolveCallSiteRouting` defaults to `messages_api` — exactly the behavior before this change. No production behavior changes until the operator sets the env var.

---

## Change 2 — `src/ai/__tests__/client-routing.test.ts`

Add a test block for the `"draft"` callSite following the same pattern as the existing `"pdu"` tests in this file. The tests must cover:

1. **Default routing (no env var set):** `resolveCallSiteRouting("draft")` returns `{ transport: "messages_api", modelOverridden: false }`. This verifies no behavior regression when env vars are absent.

2. **Transport override:** when `SYNTHESIS_DRAFT_TRANSPORT=cc_subprocess` is set, `resolveCallSiteRouting("draft")` returns `{ transport: "cc_subprocess" }`.

3. **Model override:** when `SYNTHESIS_DRAFT_MODEL=claude-sonnet-4-6` is set, `resolveCallSiteRouting("draft")` returns `{ model: "claude-sonnet-4-6", modelOverridden: true }`.

Follow the exact mock setup, env-var injection, and teardown pattern already used in this test file for other callSites. Do not add integration tests or mock the full `synthesize()` call — the routing unit tests are sufficient for this scope.

---

## Verification Steps (post-edit, pre-PR)

1. `npx tsc --noEmit` — must pass with zero errors.
2. `npx jest src/ai/__tests__/client-routing.test.ts --no-coverage` — all tests pass including the new `"draft"` block.
3. Grep confirm: `grep -n 'callSite' src/tools/finalize.ts` must show the new `"draft"` arg at the draftPhase call site.
4. Grep confirm: `grep -n 'SYNTHESIS_DRAFT' src/tools/finalize.ts` must show zero results (the env var is read by `resolveCallSiteRouting` in `client.ts`, not referenced directly in `finalize.ts` — if it appears there, something went wrong).

---

## Operator Experiment (post-merge, no code)

After the PR merges and Railway auto-deploys:

```
SYNTHESIS_DRAFT_MODEL=claude-sonnet-4-6
```

Set on Railway → prism-mcp-server → production. Run 3–5 finalization sessions with `action="draft"`. Evaluate draft quality. If acceptable, `SYNTHESIS_DRAFT_TRANSPORT=cc_subprocess` can optionally be set to route the draft phase fully off the API key (Phase 5c scope).

---

## Files Changed

- `src/tools/finalize.ts` (1 edit: 2 lines added to synthesize() call)
- `src/ai/__tests__/client-routing.test.ts` (3 new test cases added)

<!-- EOF: brief-420-phase5a-cs1-draft-callsite-wiring.md -->
