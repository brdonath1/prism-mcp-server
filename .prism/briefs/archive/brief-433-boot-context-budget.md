# Brief 433 — Boot context budget: DEFAULT_CONTEXT_WINDOW_TOKENS 200K→500K + honest boot-cost estimate numerator

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-mcp-server (this repo)
**Origin:** PRISM session S146, D-240 Phase B, roadmap item **R7-a** (per the brief-431 framework audit at `reports/brief-431-prism-framework-audit.md`)

## Context

The server-side boot-cost estimate that `prism_bootstrap` reports (the “~N% of context” figure in the boot banner) is computed against `DEFAULT_CONTEXT_WINDOW_TOKENS` in `src/config.ts`, currently `200_000`. Per that constant’s own doc comment, the TRUE window for every chat-surface model PRISM actually runs on — Opus 4.8 / 4.7 / 4.6 and Sonnet 4.6 — is **500K** (resolved client-side per core-template Rule 9). The 200K default therefore overstates boot cost by ~2.5×, which misrepresents how much of the real budget boot consumes and discourages the richer boot payload the 500K headroom is meant to carry (R7-b, a separate later brief).

Separately, the brief-431 audit found the **numerator** of that same estimate is built from an INCOMPLETE serialization of the bootstrap response — it omits ~13 fields of the object actually returned to the client — so the token estimate undercounts the real boot payload. Denominator too small AND numerator too small means the reported percentage is doubly inaccurate.

This brief makes BOTH honest. The goal is ACCURACY, not a smaller number — the reported % may move up or down; what matters is that the numerator (real serialized payload) and the denominator (real model window) both reflect reality.

## Required Changes

### 1. `src/config.ts` — `DEFAULT_CONTEXT_WINDOW_TOKENS` 200_000 → 500_000

- Change the value to `500_000`.
- Update the doc comment so it reflects the new default: 500K matches the documented window of the current chat-surface models (Opus 4.8/4.7/4.6, Sonnet 4.6). Keep the existing notes that the true window is resolved client-side per core-template Rule 9 and that the server still cannot know the exact active model.
- Matching this file’s strong convention for tunables (`Number(process.env.X ?? default)`), OPTIONALLY make it env-overridable: `export const DEFAULT_CONTEXT_WINDOW_TOKENS = Number(process.env.DEFAULT_CONTEXT_WINDOW_TOKENS ?? 500_000) || 500_000;` — but ONLY if it does not complicate existing import/usage sites. Verify the usage sites first; if env-override adds churn, just change the literal.

### 2. `src/tools/bootstrap.ts` — honest boot-cost estimate numerator

Investigate first: find where `DEFAULT_CONTEXT_WINDOW_TOKENS` is consumed to compute the boot-cost percentage, and the code that builds the token-estimate numerator (audit pointer: the boot-cost/estimate block, formerly ~lines 951–960 — locate by symbol/behavior, not by line number).

The numerator currently serializes only a SUBSET of the bootstrap response payload, omitting ~13 fields of the object that is actually returned to the client. Change it to estimate from the COMPLETE response object — the exact payload returned to the caller — so the token count reflects everything boot actually emits. If the response is assembled incrementally, serialize the FINAL assembled object (e.g. `JSON.stringify(response)`), not a hand-picked field subset.

Do NOT change the estimation METHOD (whatever chars/token proxy is already in use) — only the COMPLETENESS of what is fed into it.

### 3. Tests

- Update/extend the bootstrap estimate tests to assert the numerator covers the full response payload (e.g. adding a field to the response should change the estimate).
- If any test hard-codes the old 200K denominator or an expected percentage, update it to the new 500K basis.
- Mirror the existing bootstrap test layout.

## Verification (land ALL of this in the PR body — the dispatching session has ZERO pane visibility; INS-148)

1. `npm test` — all pass. Record the BEFORE and AFTER test counts.
2. `npm run lint` — clean.
3. `npm run build` (`tsc`) — clean.
4. Paste the BEFORE and AFTER of: the `DEFAULT_CONTEXT_WINDOW_TOKENS` value, and a representative boot-cost line showing the estimated tokens + percentage for the same project, so the reviewer can see both numerator and denominator changed.
5. `grep -n "500_000\|500000" src/config.ts` shows the new default.

## Out of Scope

- Do NOT implement R7-b (enriching the boot PAYLOAD itself — more decisions, full intelligence brief, all Tier A+B standing rules). This brief corrects only the COST ESTIMATE; payload enrichment is a separate brief.
- Do NOT touch client-side model/context resolution (core-template Rule 9) — that is the chat-side resolver, out of this repo’s scope.
- Do NOT change synthesis/finalize/patch timeouts or any other constant in `config.ts`.

## PR Title / Body Hint

Title: `fix(bootstrap): honest boot-cost estimate — 500K context default + full-payload numerator (S146 brief-433 / R7-a)`
Body: reference brief-433, D-240 Phase B item R7-a, and the brief-431 audit finding. Include the verification block above.

## Brief Author Notes

Authored from PRISM session S146 (Claude.ai chat) as the FIRST Phase-B implementation brief after the CI merge-gate (brief-432) went live. Dispatch path is the Trigger daemon (`cc_dispatch` suspended per INS-282). AUTO-tier (safe for hands-off gated auto-merge): a config constant + an estimate-completeness fix + tests — no daemon/coordination/destructive surface. Takes effect on Railway redeploy after merge; no local daemon restart needed.

<!-- EOF: brief-433-boot-context-budget.md -->
