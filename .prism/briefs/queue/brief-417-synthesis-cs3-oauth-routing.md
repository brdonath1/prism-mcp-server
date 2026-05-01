# Brief 417 — Phase 3c-A: per-call-site synthesis routing infrastructure + CS-3 OAuth + Sonnet 4.6

**Repo:** prism-mcp-server

## Context

D-161 (S73) WONTFIX'd Phase 3c (synthesis OAuth migration) on a quality-first tiebreaker when projected savings were ~$700-800/yr. D-161 explicitly defined re-evaluation condition (b): "synthesis monthly cost exceeds ~$200 sustained over a quiet month (>2.5x current steady-state)".

S110 (May 1, 2026) cost-dashboard reading: $37.84 month-to-date for `prism-mcp-server-v2` API key on a day the operator described as exceptionally slow. Extrapolated monthly: ~$1,135/month. That's 5.6x the D-161 re-eval threshold. Annualized projection ranges $14K-$42K depending on steady-state finalization volume. D-161's quality-first calculus inverts at this magnitude — the engineering work to verify quality holds is now justified.

This brief implements **Phase 3c-A**: per-call-site routing infrastructure + flip CS-3 (`generatePendingDocUpdates`) only. CS-1 (draft) and CS-2 (intelligence brief) stay on direct Messages API + Opus 4.7 pending observation gates in Phase 3c-B and Phase 3c-C.

CS-3 chosen as first migration target for three reasons: (a) pending-doc-updates has a mandatory operator-review safety net — quality regressions are caught before they affect downstream sessions; (b) CS-3 outputs ~3-5KB, well below any plausible CC subprocess truncation threshold (D-161 concern #4); (c) per D-161's own breakdown, CS-2 + CS-3 are 85-95% of steady-state spend, so even just CS-3 captures meaningful cash burn elimination.

## Scope (in)

1. Add per-call-site routing infrastructure to `src/ai/client.ts`'s `synthesize()` function via optional `callSite?: "draft" | "brief" | "pdu"` parameter. When provided, function reads two env vars:
   - `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT`: one of `messages_api` (default) or `cc_subprocess`
   - `SYNTHESIS_${CALLSITE_UPPER}_MODEL`: model identifier (default: `claude-opus-4-7`)

2. Create new lightweight CC subprocess wrapper at `src/ai/cc-subprocess.ts`. Uses Claude Code SDK in non-workspace, non-tool, non-PR mode — purely prompt-in / text-out. Honors:
   - Configurable model via parameter
   - Adaptive thinking activation when SDK supports it on the chosen model
   - Output token logging parity with `synthesize()` for monitoring
   - Timeout matching `MCP_SAFE_TIMEOUT`
   - Authentication via `CLAUDE_CODE_OAUTH_TOKEN` (already present in Railway env per S87 D-173)

3. Wire `generatePendingDocUpdates` in `src/ai/synthesize.ts` to pass `callSite: "pdu"` to `synthesize()`. No other change to that function.

4. Implement automatic fallback resilience: if `cc_subprocess` transport call returns failure (rate limit, subprocess crash, parse error), `synthesize()` automatically retries via `messages_api` transport with default model. Logs `SYNTHESIS_TRANSPORT_FALLBACK` warning with the original error. Finalization completes successfully; operator sees degradation in Railway logs and in next session's intelligence brief if relevant.

5. Add programmatic quality checks specific to CS-3 in `generatePendingDocUpdates` post-synthesis:
   - All four required sections present (existing check, keep)
   - EOF sentinel preserved (existing check, keep)
   - Output byte count within 50%-150% of recent baseline computed from last 5 successful CS-3 outputs in `synthesis-tracker.ts` log (NEW — implement baseline rolling window)
   - No preamble prompt-leak: first non-empty line must start with `## ` or `**` (NEW)
   
   Quality-check failures emit warnings but do NOT fail the synthesis (warn-and-push pattern already established for missing sections per current code).

6. Update Railway env vars (operator-side post-merge action documented in Acceptance):
   - `SYNTHESIS_PDU_TRANSPORT=cc_subprocess`
   - `SYNTHESIS_PDU_MODEL=claude-sonnet-4-6`
   - `SYNTHESIS_DRAFT_*` and `SYNTHESIS_BRIEF_*` left unset → defaults route to `messages_api` + `claude-opus-4-7`

## Scope (out)

- CS-1 migration. Defer to Phase 3c-C brief (highest stakes per D-161 concern #4 — long outputs and max-output-tokens fidelity).
- CS-2 migration. Defer to Phase 3c-B brief (medium stakes — no operator-review safety net).
- Removal of `ANTHROPIC_API_KEY` from Railway. Stays in place — CS-1 and CS-2 still use it. Future Phase 3c-C completion enables removal.
- CC subprocess implementation reusing existing `cc_dispatch` infrastructure. New lightweight wrapper preferred for cleanliness (no clone, no workspace, no PR machinery).
- Cost-tracking dashboard. Existing `synthesis-tracker.ts` already records per-call costs; sufficient for Phase 3c-A monitoring.
- Decision logging on the `prism` framework project. The chat-side D-N re-opening D-161 is logged separately by Claude before this brief executes.

## File-by-file changes

### `src/ai/client.ts`

Modify `synthesize()` signature to add optional final parameter:
```
callSite?: "draft" | "brief" | "pdu"
```

When `callSite` is provided:
1. Read `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` from `process.env`. Default: `messages_api`.
2. Read `SYNTHESIS_${CALLSITE_UPPER}_MODEL` from `process.env`. Default: `SYNTHESIS_MODEL` (current config-level default).
3. If transport === `cc_subprocess`:
   - Call new `synthesizeViaCcSubprocess()` from `./cc-subprocess.js` with the resolved model.
   - On failure (any non-success outcome), log `SYNTHESIS_TRANSPORT_FALLBACK` warning with original error code, then fall through to messages_api branch with default model (NOT the env-overridden model — the override is what may have failed).
4. Otherwise (transport === `messages_api` or undefined): existing Messages API path, but use the env-overridden model if `SYNTHESIS_${CALLSITE_UPPER}_MODEL` is set.

When `callSite` is NOT provided: existing behavior unchanged (uses `SYNTHESIS_MODEL` config default + Messages API). Back-compat for any callers not yet updated.

### `src/ai/cc-subprocess.ts` (new file)

New lightweight wrapper. Exports:
```typescript
export async function synthesizeViaCcSubprocess(
  systemPrompt: string,
  userContent: string,
  model: string,
  maxTokens?: number,
  timeoutMs?: number,
  thinking?: boolean,
): Promise<SynthesisOutcome>
```

Implementation:
- Uses Claude Code SDK in headless query mode (no workspace, no tools).
- Spawns subprocess with explicit `--model` flag set to the `model` parameter.
- Passes `systemPrompt` as `--system-prompt` (overrides CC's default coding-agent prompt — addresses D-161 concern #3 prompt-cache geometry).
- Passes `userContent` via stdin or `-p` (whichever the SDK exposes for headless prompt input).
- If `thinking === true` AND the SDK exposes adaptive-thinking activation for the specified model: enable it. If not exposable, proceed without (log informational note).
- Parses subprocess stdout as the synthesis output text.
- Returns `SynthesisOutcome` shape matching `synthesize()` for drop-in substitution.
- On any subprocess failure (non-zero exit, timeout, parse error): return `SynthesisError` with `error_code: "API_ERROR"` (or `"TIMEOUT"` when timeout-specific).

Reuse pattern: any subprocess management utilities already in `src/claude-code/` may be imported, but the new wrapper does NOT reuse `cc_dispatch` directly — `cc_dispatch` is for code-execution agent runs with workspace + PR semantics. Synthesis is prompt-in / text-out only.

### `src/ai/synthesize.ts`

In `generatePendingDocUpdates`, modify the existing `synthesize()` call:
```typescript
const result = await synthesize(
  PENDING_DOC_UPDATES_PROMPT,
  userMessage,
  undefined,
  SYNTHESIS_TIMEOUT_MS,
  undefined,
  true, // thinking
  "pdu", // NEW: callSite
);
```

Add new programmatic quality checks after the existing sections check:
1. **Byte count baseline:** Read last 5 successful `synthesis-tracker.ts` events with `synthesis_kind: "pending_updates"`. Compute average output byte count. If current output is < 50% or > 150% of baseline (and baseline N >= 3), log `CS3_QUALITY_BYTE_COUNT_WARNING` with current and baseline numbers.
2. **Preamble check:** Strip leading whitespace from result content. If first line does NOT start with `## ` or `**`, log `CS3_QUALITY_PREAMBLE_WARNING` with the first 200 chars.

Both warnings are non-fatal — synthesis still pushes. Operator triages via Railway logs.

### `src/ai/synthesis-tracker.ts`

Extend `recordSynthesisEvent` to accept (and persist) two new optional fields:
- `transport?: "messages_api" | "cc_subprocess" | "messages_api_fallback"`
- `model?: string`

Both surface in the tracker's stored events for future cost/quality analysis. No behavior change for callers that don't pass them.

### `src/config.ts`

Add SERVER_VERSION bump: `4.4.0` → `4.5.0`. Sync `package.json` version.

No new exports needed (env vars are read directly at call site in `synthesize()`).

## Tests

### Unit tests (new file `src/ai/__tests__/client-routing.test.ts`)

1. `synthesize(callSite="pdu")` with no env vars → routes to messages_api with SYNTHESIS_MODEL default.
2. `synthesize(callSite="pdu")` with `SYNTHESIS_PDU_TRANSPORT=cc_subprocess` → routes to `synthesizeViaCcSubprocess` (mocked).
3. `synthesize(callSite="pdu")` with `SYNTHESIS_PDU_MODEL=claude-sonnet-4-6` and `SYNTHESIS_PDU_TRANSPORT=cc_subprocess` → subprocess called with model="claude-sonnet-4-6".
4. `synthesize(callSite="pdu")` with `SYNTHESIS_PDU_MODEL=claude-sonnet-4-6` and transport=messages_api → Messages API called with model override.
5. `synthesize(callSite="pdu")` with cc_subprocess transport that returns failure → falls back to messages_api with SYNTHESIS_MODEL default (not the override) → returns success.
6. `synthesize()` with NO callSite (legacy callers like CS-1, CS-2) → existing behavior unchanged, no env-var reads.
7. Invalid callSite values rejected at type level (compile-time test).

### Unit tests (new file `src/ai/__tests__/cc-subprocess.test.ts`)

Mock the SDK; verify wrapper:
1. Subprocess invoked with correct `--model` and `--system-prompt` args.
2. Adaptive thinking flag respected when supported.
3. Successful output returns SynthesisResult with parsed text.
4. Subprocess timeout returns SynthesisError with `error_code: "TIMEOUT"`.
5. Subprocess non-zero exit returns SynthesisError with `error_code: "API_ERROR"`.
6. Output token count logged for monitoring parity.

### Integration test (new file `src/ai/__tests__/synthesize-pdu-routing.integration.test.ts`)

LIVE test (gated behind `RUN_LIVE_INTEGRATION_TESTS=true` env var to avoid burning OAuth quota on CI):
1. Set env: `SYNTHESIS_PDU_TRANSPORT=cc_subprocess`, `SYNTHESIS_PDU_MODEL=claude-sonnet-4-6`.
2. Call `generatePendingDocUpdates(projectSlug, sessionNumber)` with a known small project (use a test fixture with minimal living docs to keep quota cost low).
3. Assert: result.success === true, result.bytes_written ≥ 1KB, output contains all 4 required sections, output ends with EOF sentinel.

### Existing tests must pass unchanged

All tests in `src/ai/__tests__/` and elsewhere must pass without modification. The optional `callSite` param is additive; legacy code paths are unchanged. Verify in CI.

## Acceptance gates

### Code-level (Claude Code self-verifies before PR)

1. `npm test` passes (all existing + new tests).
2. `npm run lint` passes.
3. `npm run build` passes.
4. SERVER_VERSION bumped to 4.5.0 in both `src/config.ts` AND `package.json`.
5. Test count delta documented in PR body (was 903, expect ~915 with the new tests above).

### Deploy-level (operator post-merge action)

After PR merge and Railway deploy SUCCESS:
1. Set `SYNTHESIS_PDU_TRANSPORT=cc_subprocess` via `railway_env set`.
2. Set `SYNTHESIS_PDU_MODEL=claude-sonnet-4-6` via `railway_env set`.
3. No redeploy needed — env vars take effect on next synthesis call.
4. Verify next finalize on any active project: Railway logs show `synthesis_kind: pending_updates` with `transport: cc_subprocess` and `model: claude-sonnet-4-6`.
5. Verify pending-doc-updates.md output is well-formed (sections present, EOF sentinel, no preamble).

### Observation gate (operator-driven)

Over the next 5-10 finalizations on prism-mcp-server (or whichever projects finalize):
- Compare pending-doc-updates.md outputs to recent baselines (pre-flip outputs from S107-S110 captured in living docs).
- Watch for quality-check warnings in Railway logs (`CS3_QUALITY_BYTE_COUNT_WARNING`, `CS3_QUALITY_PREAMBLE_WARNING`, `SYNTHESIS_TRANSPORT_FALLBACK`).
- Cost-dashboard verification: confirm `prism-mcp-server-v2` API key spend drops by approximately the CS-3 share of synthesis cost (D-161 estimated CS-2 + CS-3 = 85-95% of steady-state, with CS-3 share split roughly 50/50 with CS-2 by output size).

If observation gate passes (quality holds + savings materialize): scope Phase 3c-B brief for CS-2.
If quality regression detected: revert via `railway_env set SYNTHESIS_PDU_TRANSPORT=messages_api` (no redeploy).

## Cross-references

- D-161 (S73, SETTLED): Phase 3c WONTFIX on quality-first tiebreaker. Re-eval condition (b) triggered S110.
- D-191 (S106): Phase 5 model routing on cash API key — superseded for CS-3 by this OAuth path.
- INS-165: Messages API rejects OAuth — motivates CC subprocess wrapping.
- INS-201, S94 D-180: CLAUDE_CODE_OAUTH_TOKEN routes to CloudShift Max OAuth.
- INS-238 (S110): visibility-hint vs guard contract — quality-check warnings here are visibility hints (warn-and-push, no failure).
- INS-239 (S110): brief tightening loop — applied to this brief (8 implementation flags resolved before push).
- INS-234 (S109): brief-author Repo declaration verified — Repo: prism-mcp-server matches queue path.

## Estimated implementation cost

- Code changes: ~250 lines across 5 files.
- Test changes: ~200 lines across 3 new test files.
- Build + lint + test runtime: ~5 minutes.
- Total CC dispatch: estimated 15-25 minutes wall clock.
<!-- EOF: brief-417-synthesis-cs3-oauth-routing.md -->
