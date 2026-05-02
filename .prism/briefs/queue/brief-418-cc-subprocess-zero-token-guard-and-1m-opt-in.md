# Brief 418 — cc_subprocess wrapper zero-token guard + Sonnet 1M [1m] opt-in for CS-3 OAuth path

**Repo:** prism-mcp-server

## Context

S111 (May 1, 2026) executed the D-198 env-var flip authorizing Phase 3c-A (CS-3 PDU synthesis routed via cc_subprocess on Sonnet 4.6 OAuth). The very first finalization to exercise this path produced corrupted output: `pending-doc-updates.md` contained only the literal string "Prompt is too long" (57 bytes including EOF sentinel). S112 boot detected the corruption; revert executed via `railway_env set SYNTHESIS_PDU_TRANSPORT=messages_api`.

Investigation established two compounding defects (D-199 settled S112; INS-244 standing rule logged S112):

**Defect A — Sonnet 4.6 1M context requires explicit `[1m]` opt-in on Claude Code OAuth.** PRISM's PDU synthesis input bundle is ~902,177 bytes (~225K tokens) assembled from 16 living docs. The wrapper passes `model: "claude-sonnet-4-6"` (bare ID, from `SYNTHESIS_PDU_MODEL` env). On the OAuth/Claude Code path, only Opus auto-upgrades to 1M on Max plans (default since Claude Code v2.1.75, March 13, 2026). Sonnet 1M requires the `[1m]` suffix on the model identifier (per code.claude.com/docs/en/model-config). Without the suffix, Claude Code routes to the 200K Sonnet variant; 225K input is rejected with "Prompt is too long". Important: this is a Claude Code routing surface error, NOT the API-side beta header (`context-1m-2025-08-07`) story — those are separate surfaces with separate rules and should not be conflated.

**Defect B — Agent SDK silent-success on API rejection.** When the underlying API rejects with "Prompt is too long", the Agent SDK's `query()` does NOT throw and does NOT emit an error subtype. It emits a terminal `result` message with `subtype: "success"`, the literal API error string as the `result` text, and `usage.input_tokens === 0 && usage.output_tokens === 0`. The wrapper at `src/ai/cc-subprocess.ts` validates only on `subtype === "success"` and `resultText.length > 0`. Both checks pass for the error string. Wrapper returns `{success: true, content: "Prompt is too long", input_tokens: 0, output_tokens: 0}`. `synthesize()` in `client.ts` never enters the `SYNTHESIS_TRANSPORT_FALLBACK` branch — wrapper said success. Error string flows downstream into `pending-doc-updates.md`.

This brief implements both fixes together: (a) the wrapper guard that catches zero-token "success" as failure and triggers the existing fallback path, and (c) the model-identifier mechanism for Sonnet 1M opt-in via OAuth. (b) is the investigation step that determines (c)'s exact form.

## Scope (in)

1. **Wrapper zero-token-success guard in `src/ai/cc-subprocess.ts`.** When the SDK returns `subtype === "success"` AND `usage.input_tokens === 0 && usage.output_tokens === 0`, treat as failure. Return `SynthesisError` with `error_code: "API_ERROR"` and a message identifying the zero-token signal. The existing `success: true` path remains for genuine successful calls (any result with non-zero token counts). This guard ensures the existing `SYNTHESIS_TRANSPORT_FALLBACK` machinery in `client.ts` engages on this failure shape.

2. **Investigation: how does the [1m] suffix flow through the Agent SDK?** Read the installed `@anthropic-ai/claude-agent-sdk` version under `node_modules/@anthropic-ai/claude-agent-sdk/`. Determine whether passing `model: "claude-sonnet-4-6[1m]"` to the SDK's `options.model` field results in:
   - **(i)** The suffix being preserved end-to-end as the model string the spawned `claude` binary sees (in which case the binary parses [1m] itself per code.claude.com/docs/en/model-config) — preferred path, simplest fix.
   - **(ii)** The SDK rejecting / stripping / sanitizing the suffix before the binary sees it — in which case the [1m] must be applied via env-var pinning: set `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6[1m]` (and analogously for Opus) in `buildDispatchEnv()`, and pass `sonnet` as the `model` argument.
   - **(iii)** Some third path — document and choose.

   Document findings inline in the PR body with explicit SDK file paths + line numbers. Do NOT live-test the OAuth path (would burn quota); rely on code trace.

3. **Update `src/ai/cc-subprocess.ts` (and `src/claude-code/client.ts` if needed) to pass the verified-correct form for 1M context.** Implementation depends on (2)'s outcome:
   - If **(i)**: no code change to model handling. The existing wrapper handles `claude-sonnet-4-6[1m]` as well as `claude-sonnet-4-6` because `model` is forwarded uninterpreted. No-op for this scope item beyond the JSDoc update in (4).
   - If **(ii)**: update `buildDispatchEnv()` in `src/claude-code/client.ts` to set `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6[1m]` and `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-7[1m]` in the spawned subprocess env. The Opus suffix is set defensively — on plans where 1M auto-upgrades the suffix is redundant; on plans where it doesn't, it's necessary. Per code.claude.com docs, no harm either way.

   Document which path was chosen in the PR description with code-trace evidence.

4. **Update inline JSDoc in `src/ai/cc-subprocess.ts`** to explicitly document the [1m] mechanism, including:
   - That [1m] is a Claude Code routing concept, NOT a beta header passed to the Anthropic API.
   - That the API-side beta header `context-1m-2025-08-07` is a different mechanism on a different surface (messages_api), retired April 30, 2026 for legacy Sonnet 4 / 4.5, and irrelevant to the OAuth path.
   - That Opus 4.7 / 4.6 auto-upgrade to 1M on Max OAuth plans without the suffix, but Sonnet 4.6 requires explicit opt-in.
   - That Sonnet 1M on Max plans requires "extra usage" enabled per the operator's plan configuration and may not be available on all Max accounts.

5. **Tests for the wrapper guard.** Add new test cases to the existing `cc-subprocess` test file (locate via `find . -name "cc-subprocess.test.ts"`):
   - SDK emits `result` message with `subtype: "success"`, `result: "Prompt is too long"`, `usage: { input_tokens: 0, output_tokens: 0 }` → wrapper returns `success: false`, `error_code: "API_ERROR"`, error message includes "zero" or "tokens".
   - SDK emits `result` message with `subtype: "success"`, valid `result` text, `usage: { input_tokens: 1234, output_tokens: 567 }` → wrapper returns `success: true` (existing happy path, regression).
   - SDK emits `result` message with `subtype: "success"`, valid `result` text, `usage: { input_tokens: 0, output_tokens: 567 }` → defense-in-depth case. Wrapper SHOULD treat as failure (input_tokens=0 alone is suspicious — no real prompt was tokenized). If implementation determines this produces false positives in legitimate scenarios (cached prompts, etc.), document the choice and adjust the guard to require both fields zero. Either choice is acceptable; the rationale must be in the PR body.

   If outcome (ii) was chosen in scope item 3, add one assertion to the existing `buildDispatchEnv` test file confirming `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` are set to the [1m]-suffixed values when `oauthToken` is non-empty.

6. **`SERVER_VERSION` bump:** `4.5.0` → `4.5.1` (patch release for bug fix). Sync `package.json` version.

## Scope (out)

- Re-flipping `SYNTHESIS_PDU_TRANSPORT=cc_subprocess`. That's an operator-driven post-merge action gated on (a) merge + deploy, (b) operator-side verification that Sonnet 1M is exposed on the CloudShift Max account.
- Changes to CS-1 (draft) or CS-2 (intelligence_brief) routing. Phase 3c-A scope is CS-3 only; this brief does not expand that.
- Changes to observability codes (`SYNTHESIS_TRANSPORT_FALLBACK`, `CS3_QUALITY_*`). The implementations from brief-417 are correct; the missing piece is the wrapper-side trigger that this brief adds.
- Cost-dashboard analysis. Operator pulls Console after re-flip per INS-241 procedure.
- Pivot to Opus 4.7 in cc_subprocess if Sonnet 1M turns out unavailable on the operator's plan. That's a chat-side decision after the operator's pre-flight check, not a code change. The wrapper code works for either model identifier.
- Live testing of the OAuth path during CC dispatch. Investigation is read-only code trace; live verification happens post-merge via the operator's re-flip.

## File-by-file changes

### `src/ai/cc-subprocess.ts`

**1. Add zero-token-success guard.** After the existing `if (!resultText || resultText.length === 0)` branch and BEFORE the `logger.info("cc_subprocess synthesis complete", ...)` log emission, insert a new check:

```typescript
if (inputTokens === 0 && outputTokens === 0) {
  logger.warn("cc_subprocess synthesis returned zero tokens despite subtype=success — treating as failure", {
    model,
    result_preview: resultText.slice(0, 200),
    ms: Date.now() - start,
  });
  return {
    success: false,
    error: `cc_subprocess returned success with zero input/output tokens — likely API rejection or SDK no-op (got: "${resultText.slice(0, 200)}")`,
    error_code: "API_ERROR",
  };
}
```

Place this guard so the success log only fires for genuine successes.

**2. Update file-level JSDoc.** Replace the existing block-comment to add a "Context window opt-in" section explaining:
- The OAuth path's `[1m]` suffix mechanism for Sonnet 4.6.
- That Opus auto-upgrades to 1M on Max OAuth without configuration.
- That this is unrelated to and should not be confused with the API-side beta header `context-1m-2025-08-07` (retired April 30, 2026 on legacy models).
- That Sonnet 1M on Max requires "extra usage" enabled per the operator's plan configuration.

**3. (Conditional, only if outcome (ii)):** If investigation determined the SDK strips the [1m] suffix programmatically, the model handling stays as-is. The mechanism moves into `buildDispatchEnv()` (next file).

### `src/claude-code/client.ts`

**(Conditional, only if outcome (ii) from investigation):**

In `buildDispatchEnv()`, after the existing `childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;` and `childEnv.CLAUDE_CODE_EFFORT = effort;` lines, append:

```typescript
// Pin the Sonnet alias to the 1M-context variant via Claude Code's documented
// env-var pinning mechanism. Claude Code strips the [1m] suffix before sending
// the model ID to its provider — the suffix is a Claude Code routing signal
// to select the extended-context variant. Opus suffix is set defensively;
// on Max/Team/Enterprise plans where Opus auto-upgrades to 1M, the suffix is
// redundant but harmless. See code.claude.com/docs/en/model-config.
childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6[1m]";
childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-7[1m]";
```

If outcome (i), this file is not modified.

### `src/ai/__tests__/cc-subprocess.test.ts` (or wherever wrapper tests live)

Add the three test cases per scope item 5. Use the existing SDK mocking pattern; verify the guard fires correctly across the three input shapes.

If outcome (ii) was chosen and `buildDispatchEnv()` was updated, add one test in the existing `buildDispatchEnv` test file (locate via `find . -name "*buildDispatchEnv*" -o -name "*client.test*"`) asserting that `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` are set to the `[1m]`-suffixed values when `oauthToken` is non-empty.

### `src/config.ts`

Bump `SERVER_VERSION`: `4.5.0` → `4.5.1`.

### `package.json`

Bump `version`: `4.5.0` → `4.5.1`.

## Acceptance gates

### Code-level (Claude Code self-verifies before PR)

1. `npm test` passes — all existing 928 tests plus the new wrapper guard tests (estimate +3 to +5 tests, target 931–933).
2. `npm run lint` passes.
3. `npm run build` passes.
4. SERVER_VERSION bumped to `4.5.1` in both `src/config.ts` AND `package.json`.
5. PR body documents:
   - The [1m] suffix flow investigation findings: which outcome (i / ii / iii), with SDK file paths + line numbers as evidence.
   - The chosen implementation path for scope item 3.
   - Test count delta vs baseline.
   - The defense-in-depth choice for scope item 5 case 3 (whether `input_tokens === 0` alone counts as failure, or only when both are zero).

### Deploy-level (operator post-merge actions, NOT part of CC dispatch)

After PR merge and Railway deploy SUCCESS:

1. **Pre-flight: verify Sonnet 1M is enabled on the CloudShift Max account.** Run `claude` locally in interactive mode, type `/model`, look for `sonnet[1m]` or `claude-sonnet-4-6[1m]` in the picker. If present, proceed to step 2. If absent (only Opus 1M shows), pivot model variable to `claude-opus-4-7` (no [1m] needed; Opus auto-upgrades) and skip step 2.
2. **Re-flip with Sonnet [1m] (only if pre-flight passed):**
   - `railway_env set SYNTHESIS_PDU_MODEL=claude-sonnet-4-6[1m]` (was `claude-sonnet-4-6` pre-revert)
   - `railway_env set SYNTHESIS_PDU_TRANSPORT=cc_subprocess`
   - No redeploy needed.
3. **Re-flip with Opus 4.7 (if pre-flight failed):**
   - `railway_env set SYNTHESIS_PDU_MODEL=claude-opus-4-7`
   - `railway_env set SYNTHESIS_PDU_TRANSPORT=cc_subprocess`
4. Verify next finalize on any active project: Railway logs show `synthesis_kind: pending_updates` with `transport: cc_subprocess`, the chosen model, and **non-zero input/output tokens**. Verify `pending-doc-updates.md` is well-formed.

### Observation gate (operator-driven, restarts after re-flip)

Same as brief-417's observation gate. Per INS-242 thresholds:
- 5–10 finalizations watched.
- **Pass:** fallback rate <10% AND zero quality warnings.
- **Extend:** 10–30% fallback OR 1 quality warning.
- **Revert:** >30% fallback OR ≥2 quality warnings.

The wrapper guard from this brief ensures any future failure of the same shape (subtype=success with zero tokens) surfaces as a `SYNTHESIS_TRANSPORT_FALLBACK` event with messages_api fallback engaging — instead of corrupted output flowing through. This is the diagnostic safety net D-198's first observation cycle was missing.

## Cross-references

- **D-197** (S111 SETTLED): re-opened D-161, authorized Phase 3c-A migration with Sonnet 4.6 + cc_subprocess.
- **D-198** (S111 SETTLED): env-var flip executed.
- **D-199** (S112 SETTLED): Phase 3c-A reverted on first-finalization corruption; design intent preserved, re-flip gated on this brief.
- **INS-242** (S111, Tier A): Phase 3c-A observability codes — visibility gates work; the missing piece is the wrapper-side trigger this brief adds.
- **INS-244** (S112, Tier A standing rule): codifies the wrapper-success-without-token-check anti-pattern and the API-vs-OAuth surface conflation guard. This brief is the implementation that backs the rule.
- **INS-230**: CC channel discipline — substantive multi-file change with test coverage qualifies for Trigger over cc_dispatch.
- **INS-234**: brief target repo verified — Repo: prism-mcp-server matches queue path `.prism/briefs/queue/`.
- **INS-239**: brief tightening loop — applied (5 implementation flags surfaced and resolved chat-side before push).
- **code.claude.com/docs/en/model-config** — primary source for the [1m] mechanism and Claude Code routing rules.

## Estimated implementation cost

- Code changes: ~50–80 lines (wrapper guard + JSDoc + conditional buildDispatchEnv update).
- Test changes: ~60–100 lines (3–5 new test cases + minor assertion if buildDispatchEnv changed).
- Investigation: SDK code trace, ~10–15 minutes of read-only navigation through node_modules.
- Build + lint + test runtime: ~5 minutes.
- Total CC dispatch wall clock: estimated 20–35 minutes.

<!-- EOF: brief-418-cc-subprocess-zero-token-guard-and-1m-opt-in.md -->
