# Brief 423 — cc_subprocess PDU Timeout: Separate Timeout Constant + Strip Thinking Flag

**Repo:** prism-mcp-server
**Session:** S118
**Priority:** High — Phase 3c-A is 100% fallback rate; this is the root cause
**Authorized by:** D-206 (S118, pending log)

---

## Problem

The PDU call-site (`callSite="pdu"`) cc_subprocess path consistently times out at exactly 240,000ms and falls back to messages_api. Railway logs from S116 and S117 finalizations confirm 2/2 (100%) fallback rate:

```
cc_subprocess synthesis timeout — aborting  { deadline: 240000, model: "claude-sonnet-4-6[1m]" }
cc_subprocess synthesis crashed            { error: "Claude Code process aborted by user", timed_out: true }
SYNTHESIS_TRANSPORT_FALLBACK              { callSite: "pdu", original_error_code: "TIMEOUT" }
```

Two compounding root causes identified via source read (S118):

**Cause A — Wrong timeout value passed to subprocess:**
`generatePendingDocUpdates` in `src/ai/synthesize.ts` passes `SYNTHESIS_TIMEOUT_MS` (240s, env-default) as the `timeoutMs` argument to `synthesize()`, which passes it through to `synthesizeViaCcSubprocess()`. `SYNTHESIS_TIMEOUT_MS` was designed for the messages_api fire-and-forget path. The subprocess has additional overhead on top of inference: CLI spawn, OAuth handshake, model load, token streaming. 240s is the messages_api inference ceiling — it is not enough for the subprocess end-to-end.

Observed messages_api inference time for this input: ~82-132s (Railway logs). Subprocess needs that plus ~30-60s of overhead. A ceiling of 600s absorbs realistic variance without letting a genuinely stuck process block indefinitely.

**Cause B — `thinking: true` passed to cc_subprocess:**
`generatePendingDocUpdates` passes `thinking: true` to `synthesize()`, which passes it through to `synthesizeViaCcSubprocess()`, which adds `thinking: { type: "adaptive" }` to the Agent SDK `query()` options. The Agent SDK's behavior when `thinking: adaptive` is passed on Sonnet 4.6[1m] via OAuth is unverified. It may cause the subprocess to consume dramatically more time, or to hang. The PDU prompt was authored for Opus 4.7 with adaptive thinking via the messages_api — it was not tested with cc_subprocess + Sonnet 4.6 + thinking. The cc_subprocess path should not pass thinking through; it should override to `false` for all Sonnet routing.

---

## Scope

Three changes only. No functional changes beyond what is specified.

### Change 1 — `src/config.ts`: Add `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS`

Add a new exported constant immediately after `SYNTHESIS_TIMEOUT_MS`:

```typescript
/** Wall-clock deadline (ms) for the PDU synthesis call when routed through
 *  the Claude Code subprocess (cc_subprocess transport). Distinct from
 *  SYNTHESIS_TIMEOUT_MS (which governs the messages_api fire-and-forget path)
 *  because cc_subprocess has additional overhead beyond inference: CLI spawn,
 *  OAuth handshake, model load, and token streaming. Default 600s absorbs
 *  realistic end-to-end variance (observed messages_api inference: 82-132s;
 *  subprocess overhead estimated 30-60s additional) while still catching
 *  genuinely stuck processes. Configurable via env var so operators can
 *  tune per-deployment without code change. */
export const CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS =
  parseInt(process.env.CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS ?? "600000", 10) || 600_000;
```

### Change 2 — `src/ai/synthesize.ts`: Use `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` for PDU cc_subprocess path

In `generatePendingDocUpdates`, the `synthesize()` call currently passes `SYNTHESIS_TIMEOUT_MS` as `timeoutMs`.

Add the import for `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` to the existing config import line.

Before the `synthesize()` call, add:

```typescript
    // Determine which timeout to use: cc_subprocess needs its own (larger) ceiling
    // because subprocess startup overhead is on top of inference time. Messages API
    // path continues to use SYNTHESIS_TIMEOUT_MS (fire-and-forget baseline).
    const pduTransport = process.env.SYNTHESIS_PDU_TRANSPORT;
    const pduTimeoutMs = pduTransport === "cc_subprocess"
      ? CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS
      : SYNTHESIS_TIMEOUT_MS;
```

Replace `SYNTHESIS_TIMEOUT_MS` with `pduTimeoutMs` in the `synthesize()` call's `timeoutMs` argument position.

### Change 3 — `src/ai/cc-subprocess.ts`: Override `thinking` to `false` for all cc_subprocess calls

In `synthesizeViaCcSubprocess`, immediately after the `CLAUDE_CODE_OAUTH_TOKEN` guard and before the `abortController` setup, add:

```typescript
  // cc_subprocess always disables thinking, regardless of caller intent.
  // Adaptive thinking on Sonnet 4.6[1m] via the Agent SDK OAuth path is
  // unverified — it may cause dramatically increased processing time or
  // silent hangs. The PDU prompt was designed for Opus 4.7 + messages_api
  // with thinking; the cc_subprocess + Sonnet path should use text-only mode
  // until thinking behavior is explicitly validated on this surface.
  // (S118 diagnosis — root cause B of Phase 3c-A PDU timeout failures, D-206)
  if (thinking) {
    logger.warn("cc_subprocess: ignoring thinking=true — adaptive thinking is disabled on cc_subprocess path", { model });
  }
  const effectiveThinking = false;
```

Replace the `...(thinking ? { thinking: { type: "adaptive" as const } } : {})` spread in `queryOptions` with:

```typescript
      ...(effectiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
```

Add a paragraph to the JSDoc on `synthesizeViaCcSubprocess` documenting the thinking override (place after the "Context-window opt-in" section):

```
 * Thinking override:
 *
 * The `thinking` parameter is accepted for signature parity with `synthesize()`
 * but is always overridden to `false` for cc_subprocess calls. Adaptive
 * thinking on Sonnet 4.6[1m] via the Agent SDK OAuth path is unverified —
 * the combination may cause dramatically increased processing time or silent
 * hangs compared to the messages_api path. Thinking is disabled until
 * explicitly validated on this surface (S118 root cause B, D-206).
```

---

## Test Plan

- [ ] `npx tsc --noEmit` — clean compile
- [ ] `npm run lint` — clean
- [ ] `npm test` — all existing tests pass; no new tests required (behavioral verification is via Railway logs post-deploy)
- [ ] Grep `src/ai/cc-subprocess.ts` for `effectiveThinking` to confirm the spread uses the override, not the original `thinking` parameter
- [ ] Grep `src/ai/synthesize.ts` for `pduTimeoutMs` to confirm the transport-aware timeout is in the call
- [ ] Grep `src/config.ts` for `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` to confirm the export exists

---

## PR Title

`fix: cc_subprocess PDU timeout — separate timeout constant + strip thinking flag (brief-423)`

---

## Post-Merge Operator Actions

After Railway auto-deploys:

1. Set `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS=600000` on Railway (makes the value visible and operator-controllable even though it matches the code default).
2. Run S118 finalization to produce Phase 3c-A datapoint #5.
3. Check Railway logs for:
   - `cc_subprocess: ignoring thinking=true` warn log (confirms Change 3 active)
   - `cc_subprocess synthesis complete` info log (confirms subprocess completed)
   - Absence of `SYNTHESIS_TRANSPORT_FALLBACK` on `callSite: "pdu"` (confirms fix)
4. If clean: gate at 5/5–10. If still timing out: re-examine actual subprocess wall-clock in logs and raise `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` further.

<!-- EOF: brief-423-cc-subprocess-timeout-and-thinking-fix.md -->
