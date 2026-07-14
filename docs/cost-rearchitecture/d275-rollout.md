# D-275 Rollout — OpenRouter GLM-5.2 Mechanical-Tier Routing (brief-s196c)

Operator SOP for activating, canarying, and rolling back the openrouter
(GLM-5.2) mechanical-tier synthesis routes shipped in server 4.12.0.
Design source: [`d275-audit-design.md`](d275-audit-design.md) (§4–§5);
work list: [`d275-callsite-inventory.json`](d275-callsite-inventory.json).
Env **names only** in this doc — values live in Railway (INS-241 / repo
secrets discipline).

## 1. Go-live env end-state (stage 1 — deploy night)

Already pre-staged on Railway before the merge (inert until this code
deploys):

| Env var | End-state (stage 1) |
|---|---|
| `OPENROUTER_API_KEY` | set (OpenRouter account key) |
| `LLM_ROUTING_OPENROUTER_MODEL` | `z-ai/glm-5.2` |
| `LLM_ROUTING_OPENROUTER_SITES` | `synthesis_draft,synthesis_pdu` |

Everything else is **unchanged** — activation requires no mutation of any
pre-existing shared var (`LLM_ROUTING_ENABLED`, `LLM_ROUTING_DRY_RUN`,
`LLM_ROUTING_ALLOWED_PROVIDERS`, `LLM_ROUTING_SYNTHESIS_*_PROVIDER`,
`SYNTHESIS_*_TRANSPORT/_MODEL` all stay as they are). The existing master
switches retain precedence: openrouter only serves live when
`LLM_ROUTING_ENABLED=true` and `LLM_ROUTING_DRY_RUN=false` (both already
true in the live env).

New optional knobs (all default-off / default-sane, set only if needed):

| Env var | Default | Purpose |
|---|---|---|
| `LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}` | `off` | Per-site GLM thinking opt-in (`off\|low\|medium\|high`). Guarded: reasoning is forced off when the site's `max_tokens` < 16384 (reasoning shares the completion budget — the S196 `finish_reason=length` hazard). |
| `OPENROUTER_SITE_URL` | repo URL | `HTTP-Referer` attribution header |
| `OPENROUTER_APP_TITLE` | `PRISM MCP Server` | `X-Title` attribution header |

## 2. Stage-1 verification (deploy night)

1. **Merge → Railway auto-deploys.** In deploy logs find the single startup
   line `LLM_ROUTING_TABLE` and verify rows:
   - `synthesis_draft → openrouter → z-ai/glm-5.2 → openai_compatible_chat` (live: true)
   - `synthesis_pdu → openrouter → z-ai/glm-5.2 → openai_compatible_chat` (live: true)
   - `synthesis_brief → openai → gpt-5.5 → openai_responses` (unchanged — stage 2 not flipped)
   - `cc_dispatch → anthropic → … → claude_code_oauth` and `recommendation` unchanged.
2. **Canary call:** `prism_finalize action=full` on the prism project — or
   `prism_synthesize mode=generate` for a commit-free pass (exercises
   pdu+brief, NOT draft).
3. **Proof logs (Railway):**
   - `LLM_CALL { call_site: synthesis_pdu, provider: openrouter, model: z-ai/glm-5.2, cost_source: provider_usage, fallback_used: false, … }` (and `synthesis_draft` when the canary was a finalize).
   - `Synthesis provider call complete` lines carry `provider: openrouter`.
   - **No** `SYNTHESIS_PROVIDER_FALLBACK` warns for the canary window.
   - `est_cost_usd` in the GLM `LLM_CALL` lines is measured (`usage.cost`) and
     in the ~$0.05–0.10/call band, not frontier-priced.
4. **Quality diff:** `pending-doc-updates.md` has all 4 grammar sections and
   parses (next finalize's apply-pdu report shows applied>0 or clean skips);
   the draft JSON in the finalize response carries all 6 contract keys with
   prose density comparable to the prior session.
5. **Watch signal for silent thinking regression:** in `LLM_CALL`, GLM
   `output_tokens` far above content size (bytes/3.5) means reasoning crept
   back in — check the reasoning envs and OpenRouter route.

## 3. Stage 2 — intelligence-brief flip (morning-diff gated)

The brief (CS-2) is the continuity carrier — highest criticality, so it flips
only after operator review:

1. Compare the latest frontier-produced `intelligence-brief.md` against a GLM
   candidate: append `synthesis_brief` to `LLM_ROUTING_OPENROUTER_SITES`,
   run a one-off `prism_synthesize mode=generate` (or side-by-side in a
   scratch project), and diff.
2. **Pass →** keep `LLM_ROUTING_OPENROUTER_SITES=synthesis_draft,synthesis_pdu,synthesis_brief`.
3. **Fail →** first lever is `LLM_ROUTING_OPENROUTER_REASONING_BRIEF=low`
   (~$0.01–0.03/call); re-diff. Still failing → remove `synthesis_brief`
   from SITES and leave the brief on its openai route.

## 4. Rollback (any point — env-only, no deploy)

- **Per-site:** remove the regressing site id from
  `LLM_ROUTING_OPENROUTER_SITES`. The next call resolves exactly as before
  D-275 (the SITES branch is inert for that surface).
- **Global kill-switch:** clear/unset `LLM_ROUTING_OPENROUTER_SITES`
  entirely — routing is then bit-identical to the 4.11.0 router
  (regression-pinned by `src/llm/__tests__/openrouter-routing.test.ts`).
- No other var needs touching. `OPENROUTER_API_KEY` may stay set — it is
  inert without SITES.
- **In-flight safety:** even while active, every openrouter failure or
  quality-gate rejection already falls back automatically to the site's
  existing Anthropic chain (`SYNTHESIS_PROVIDER_FALLBACK` warn with
  `fallback_reason`), so rollback urgency is cost/quality, never availability.
- **Sustained-fallback visibility:** `fallback_used: true` in `LLM_CALL`
  lines plus the existing boot-time synthesis observation surfacing
  (`synthesis-fallback-check`) make a persistently failing openrouter route
  operator-visible — a silently-failing route would otherwise serve frontier
  prices again by design.

## 5. Out of scope (do not do from this SOP)

Chat-protocol/template changes (design §6 — future fleet brief per INS-340);
cc_dispatch/Trigger execution routing (protected Claude judgment tier);
`prism_x_sentiment` (xAI `x_search` exclusive); provider changes for
judgment-tier sites.

<!-- EOF: d275-rollout.md -->
