# D-275 Cost Audit & GLM-5.2 Offload Design (brief-s196a, S196)

**Analyzed main HEAD:** `0b5d31b6fed989a6e8de6ea7bdd04da2d56051b1` (feat: Railway creation/lifecycle verbs (#103))
**Observed test baseline (this audit, at that SHA):** 1662 passed / 5 skipped (1667 total tests), 139 test files passed / 1 skipped; `npx tsc --noEmit` clean; `npm run lint` clean (96 files). *(Brief pinned PR #104's reported "1667 passed / 5 skipped"; PR #104 adds one test file and was still open at audit time — the counts above are what this audit observed on main, reported unmodified per INS-283.)*
**Machine-readable companion:** `d275-callsite-inventory.json` (9 rows: 5 LLM call sites, 4 NON-LLM surfaces — row count matches §2). s196b consumes the JSON as its work list.
**Scope discipline:** docs-only; no env VALUE was read or reproduced (env names only); no LLM provider network call was made.

---

## §1 Executive summary

PRISM's server has exactly **five LLM call sites**. Three of them — the finalization draft (CS-1), the intelligence brief (CS-2), and the pending-doc-updates proposal (CS-3) — are **mechanical document synthesis** against fixed output contracts with server-side validators, and are migratable to GLM-5.2 via a new `openrouter` adapter in the existing routing layer. The other two are non-migratable by nature: `prism_x_sentiment` (CS-4) is bound to xAI's exclusive `x_search` tool, and `cc_dispatch` (CS-5) is the Claude judgment tier, hard-walled in code (`src/llm/routing-policy.ts:55-57`).

**Headline numbers (estimates — see §3 assumptions; authoritative dollars live in the Anthropic Console per INS-241):**

| Bucket | Current est. monthly | Post-migration est. monthly | Delta |
|---|---|---|---|
| API-billed synthesis (CS-1/2/3, 30 finalize-equivalents/mo) | **~$10–16** (openai + gemini live routes; Opus 4.8 fallback exposure ~$0.38/call) | **~$5–7** (GLM-5.2 all three sites, thinking off) | −45–65% |
| Same, if all three sites fell to the Opus 4.8 `messages_api` leg | ~$29 | ~$5–7 | −80% |
| CloudShift Max capacity consumed by cc_subprocess PDU leg | ~30 calls/mo × ~60K-token inputs | 0 (freed for cc_dispatch) | capacity, not dollars |
| Chat-session tokens (operator Max) & Trigger/cc_dispatch (CloudShift) | **untouched by this migration** | untouched | see §6 for the framework-level lever |

The honest finding: at today's volume the API-billed synthesis tier is **tens of dollars per month, not hundreds** — the per-call savings are large (60–80%) but the absolute base is small. The dominant spend lives in the subscription surfaces (operator Max chat + CloudShift Claude Code) that D-275 explicitly keeps out of scope for s196b. What the GLM tier actually buys is: (a) near-elimination of per-token frontier pricing on the mechanical tier, (b) **headroom to scale synthesis frequency and coverage ~10× without cost anxiety** (per-session micro-synthesis, doc-hygiene passes, ingest processing), and (c) the §6 framework offloads, which move today's *chat-side* clerical token burn (the Max-plan pressure) onto the cheap server tier — that is where the invoice actually moves.

**Forensics headline (§3.5):** nothing about the existing router is broken — it is working exactly as coded. The openai/gemini flips **do serve** (live provider routes execute before the cc_subprocess transport, `src/ai/client.ts:206-233`). DeepSeek was never reachable: it is double-gated (no surface selects it; not in `LLM_ROUTING_ALLOWED_PROVIDERS`). `LLM_ROUTING_PROFILE` is cosmetic (status display only). The reason earlier offloads "didn't move the invoice" is that they moved spend **between frontier-priced providers** (Opus → GPT-5.5/Gemini-3.1-Pro, all $1.25–5 in / $10–25 out class) on a tier whose absolute spend was already small — no offload to a genuinely cheap tier ever existed, and several configured knobs (deepseek, perplexity) were structurally inert.

---

## §2 LLM call-site inventory (prose; JSON companion has the same 9 rows)

Exhaustiveness: every provider host and SDK entry point in `src/` was enumerated —
`api.anthropic.com` via `anthropic.messages.create` (`src/ai/client.ts:351`, sole Messages-API call site), Agent SDK `query()` (`src/ai/cc-subprocess.ts:170`, `src/claude-code/client.ts:306`), `api.openai.com` (`src/llm/provider-adapters.ts:341,347`), `api.x.ai` (`provider-adapters.ts:340`, `src/tools/x-sentiment.ts:12`), `generativelanguage.googleapis.com` (`provider-adapters.ts:240`), `api.deepseek.com` (`provider-adapters.ts:345`), `api.perplexity.ai` (`provider-adapters.ts:346`). `openrouter` appears **nowhere** in `src/` at the analyzed SHA. No other module makes LLM calls (Railway client is GraphQL observability; GitHub client is repo I/O).

### CS-1 `synthesis_draft` — finalization drafts

- **Invocation:** `synthesize(FINALIZATION_DRAFT_PROMPT, …, 4096, …, 0, true, "draft", slug)` at `src/tools/finalize.ts:505-514`, inside `draftPhase` (`finalize.ts:429-544`). Reached from `prism_finalize action=draft` (`finalize.ts:2396-2409`) and `action=full` (`finalize.ts:2051`, deadline race `:2042,2058-2063`).
- **Frequency:** once per finalize using draft/full. Observed: ~21 prism-project finalizes in the last 30 days (git log of the prism repo, `prism: finalize session` commits); fleet model 25–30/mo.
- **Transport + fallback chain (live env, per S196 verified facts):** ① **gemini live** (`LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER=gemini`; model `LLM_ROUTING_GEMINI_MODEL`; adapter `provider-adapters.ts:236-284`; billed to `GEMINI_API_KEY`) → on failure `SYNTHESIS_PROVIDER_FALLBACK` (`client.ts:225-233`) → ② **cc_subprocess** (`SYNTHESIS_DRAFT_TRANSPORT=cc_subprocess`, model `SYNTHESIS_DRAFT_MODEL`; `client.ts:235-270`, wrapper `cc-subprocess.ts:111-296`; billed to CloudShift OAuth) → on failure `SYNTHESIS_TRANSPORT_FALLBACK` → ③ **messages_api** with `SYNTHESIS_MODEL` default `claude-opus-4-8` (`client.ts:256-269`, `models.ts:82`; billed to `ANTHROPIC_API_KEY`).
- **Input:** 7 living docs (`DRAFT_RELEVANT_DOCS`, `finalize.ts:141-148` — excludes architecture/glossary/intelligence-brief/archives) + ≤50 commit messages; bounded by `boundSynthesisInput` (`finalize.ts:463-465`). Measured on the prism repo at origin/main `7f445b5e`: 161,317 bytes ≈ **~46K est tokens** (chars/3.5).
- **Output contract + validator:** strict 6-key JSON (`prompts.ts:171-178`); parsed by `extractJSON` (`finalize.ts:526`). **Gap:** parse failure currently returns `success: true` with `raw_content` + `parse_warning` (`finalize.ts:535-543`) — acceptable when chat reviews, but must become a hard validation failure on the GLM route (§4.5). `max_tokens` 4096 (`finalize.ts:508`); thinking hardcoded `true` (`finalize.ts:511` — no `SYNTHESIS_DRAFT_THINKING` switch exists; `computeSynthesisThinkingEnabled` accepts only brief|pdu, `config.ts:154-163`).
- **Classification:** **MECHANICAL** — fixed-contract drafting with chat-side review before anything persists.
- **Verdict:** **migrate-to-GLM-5.2** (stage 1; already staged in `LLM_ROUTING_OPENROUTER_SITES`).

### CS-2 `synthesis_brief` — intelligence brief (continuity carrier)

- **Invocation:** `synthesize(FINALIZATION_SYNTHESIS_PROMPT, …, "brief", slug)` at `src/ai/synthesize.ts:254-263` inside `generateIntelligenceBrief` (`synthesize.ts:212-408`). Fired fire-and-forget after finalize commit/full (`finalize.ts:1437-1457`) and by `prism_synthesize mode=generate` (`tools/synthesize.ts:138-141`).
- **Frequency:** once per finalize + occasional manual refresh (34 `auto-synthesized` pushes in the prism repo over 30 days ≈ 17 brief+PDU pairs).
- **Chain (live env):** ① **openai live** (`LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER=openai`; model `LLM_ROUTING_OPENAI_MODEL`, registry default `gpt-5.5` `provider-registry.ts:28`; Responses API adapter `provider-adapters.ts:143-185`, url `:341`; billed to `OPENAI_API_KEY`) → ② cc_subprocess (`SYNTHESIS_BRIEF_TRANSPORT`, `SYNTHESIS_BRIEF_MODEL`; CloudShift) → ③ messages_api Opus 4.8 (`ANTHROPIC_API_KEY`).
- **Input:** shared bundle assembled once per finalize (`assembleSynthesisBundle`, `synthesize.ts:164-201`): 9 living docs + 7 decision-domain files (`synthesize.ts:140-148`). Measured on prism: **~739KB pre-trim ≈ ~211K est tokens — exceeds the 120K ceiling** (`SYNTHESIS_INPUT_MAX_TOKENS`, `config.ts:204-205`), so `input-budget.ts` deterministically trims to the **60K target** (`config.ts:220-221`) on every prism finalize. Dominant inputs: `decisions/operations.md` 278KB, `decisions/architecture.md` 155KB, `glossary.md` 72KB.
- **Output contract + validators:** exactly 3 H2 sections, 1500–3000 token target, EOF sentinel (`prompts.ts:9-42`); required-section check against `INTELLIGENCE_BRIEF_SPEC_SECTIONS` (`synthesize.ts:281`); truncated-AND-incomplete output refuses to overwrite the previous brief (`synthesize.ts:286-305`); EOF enforcement (`:312-314`); server-stamped staleness + provenance headers (`:319-320`). Transport-level guards: refusal/empty (`client.ts:362-387`), truncation warn (`client.ts:388-398`), provider `finish_reason`/empty guards (`provider-adapters.ts:169-173,216-222`). Max output 8192 (`config.ts:169`); thinking default-on via `SYNTHESIS_BRIEF_THINKING` (`config.ts:154-163`).
- **Classification:** **MECHANICAL** — non-interactive synthesis against a fixed contract with deterministic validators; quality is diff-testable. (It is simultaneously the **highest-criticality** artifact — see §4.4.)
- **Verdict:** **migrate-to-GLM-5.2** (stage 2, morning-diff-gated flip).

### CS-3 `synthesis_pdu` — pending doc updates

- **Invocation:** `synthesize(PENDING_DOC_UPDATES_PROMPT, …, "pdu", slug)` at `synthesize.ts:466-475` inside `generatePendingDocUpdates` (`synthesize.ts:421-645`); same two callers/cadence as CS-2 (fired together, `finalize.ts:1453-1456`).
- **Chain (live env):** per-surface provider is `anthropic` → `currentAnthropicFallback` (`routing-policy.ts:48-53,167-174`) → not a live provider decision → ① **cc_subprocess serves** (`SYNTHESIS_PDU_TRANSPORT=cc_subprocess`, model `SYNTHESIS_PDU_MODEL`; billed to **CloudShift Max OAuth**) → ② messages_api Opus 4.8 fallback (INS-332; `ANTHROPIC_API_KEY`).
- **Input:** byte-identical shared bundle to CS-2 (`synthesize.ts:435-441`) — **~60K est tokens post-trim** on prism.
- **Output contract + validators:** exactly 4 H2 sections in the machine-applied grammar consumed by `parseProposals` in apply-pdu (contract note `prompts.ts:78-84`, pinned by `tests/pdu-prompt-parser-contract.test.ts`); 1500–3500 token target (`prompts.ts:139`); warn-level section check (`synthesize.ts:492-501`); byte-count baseline ±50% vs last 5 successes (`:511-531`); preamble shape check (`:536-544`); EOF (`:547-549`). Non-conforming proposals are archived as rejected — never applied.
- **Classification:** **MECHANICAL** — grammar-gated machine output with rejection-safe downstream.
- **Verdict:** **migrate-to-GLM-5.2** (stage 1; staged). Side benefit: frees the CloudShift Max capacity the PDU leg consumes today.

### CS-4 `x_sentiment` — aggregate X sentiment

- **Invocation:** `fetch` to `https://api.x.ai/v1/responses` with the `x_search` tool at `x-sentiment.ts:131-160`; model `LLM_ROUTING_XAI_MODEL` default `grok-4.3` (`:13,90`); `max_output_tokens` 1200 (`:157`); billed to `XAI_API_KEY`. Five-gate authorization chain (`:377-393`): `LLM_ROUTING_X_SENTIMENT_ENABLED` ∧ `LLM_ROUTING_ENABLED` ∧ ¬`LLM_ROUTING_DRY_RUN` ∧ xai ∈ allowed ∧ key present. No fallback chain — failures return `unavailable`/`error`.
- **Frequency:** on-demand only. **Classification:** MECHANICAL (fixed-enum labeling). **Verdict:** **keep-other-provider (xai)** — `x_search` is an xAI-exclusive server-side tool; GLM-5.2 via OpenRouter cannot search X, so migration would delete the capability that defines the call site.

### CS-5 `cc_dispatch` — Claude Code judgment tier

- **Invocation:** Agent SDK `query()` at `claude-code/client.ts:306-323` inside `dispatchTask` (`:234-417`), from the `cc_dispatch` tool (`tools/cc-dispatch.ts:123,351`). Model `CC_DISPATCH_MODEL` default `claude-opus-4-8` (`models.ts:92`, `config.ts:536`); effort `CC_DISPATCH_EFFORT` default `max` (`config.ts:550`); billed to **CloudShift Max OAuth** (`ANTHROPIC_API_KEY` deliberately scrubbed from the subprocess env, `claude-code/client.ts:176-178`). The Trigger daemon spawns the same `claude` CLI with the same credential class; the trigger repo makes **no direct LLM API calls** (verified read-only against `origin/main`).
- **Route protection:** `resolveRoute` returns the anthropic path for `surface=cc_dispatch` unconditionally (`routing-policy.ts:55-57`); `observeRoute` in `dispatchTask` (`claude-code/client.ts:261-268`) is log-only.
- **Classification:** **JUDGMENT.** **Verdict:** **keep-anthropic** — protected boundary by code and by D-275's own terms; also subscription-billed, so per-token migration wouldn't reduce the invoice anyway.

### NON-LLM surfaces (inventoried to close the "is anything else calling a model?" question)

- **N-1 recommendation:** `classifySession` is a deterministic keyword score (`session-classifier.ts:2-4` states it; keyword lists `:77-119`; env overrides `RECOMMENDATION_MODEL_{REASONING,EXECUTIONAL,MIXED}` `:308-310`; callers `bootstrap.ts:1293`, `finalize.ts:968,1623`). **NON-LLM, not-migratable.** `LLM_ROUTING_RECOMMENDATION_PROVIDER` is inert: no production caller resolves `surface=recommendation`, and live synthesis excludes the surface (`provider-adapters.ts:45`).
- **N-2 route observation/status:** `observeRoute` logs decisions (`route-observer.ts:5-24`); `buildRouteReadinessStatus` renders sanitized status (`route-status.ts:38-65`; consumed `status.ts:282,300,370`). NON-LLM.
- **N-3 deterministic doc pipeline:** `summarizeMarkdown` is slice+headers (`summarizer.ts:17-44`); apply-pdu is a grammar parser (invoked `finalize.ts:1384`); input-budget is a deterministic trim (`input-budget.ts:71-73,98-110`). NON-LLM.
- **N-4 synthesis observability:** in-memory tracker (`synthesis-tracker.ts:1-6`) + Railway warn-log query (`synthesis-fallback-check.ts`; window `config.ts:644-646`). NON-LLM.

---

## §3 Cost attribution model

**Every number below is an estimate.** Authoritative dollars live in the Anthropic Console and each provider's billing page (operator-side, INS-241). The §4.8 telemetry exists precisely so post-migration numbers become *measured* per call.

**Stated assumptions:**

1. **Token estimator:** chars/3.5 (`input-budget.ts:71-73`, `config.ts:232-235`). Provider tokenizers differ; billed input may run 1.0–1.35× these estimates.
2. **Frequency:** 25–30 finalize-equivalents/month fleet-wide (observed: ~21 prism finalizes + 34 auto-synth pushes in 30 days; recent cadence is bursty — 6 finalizes in the 07-12/13 48-hour window — so the model uses 30 as the planning number).
3. **List prices per MTok (input/output):** Anthropic (authoritative, cached 2026-06-24): Opus 4.8 **$5/$25**, Sonnet 5 $3/$15, Haiku 4.5 $1/$5. OpenAI `gpt-5.5`: **assumption $1.25–2.50 / $10–20** (unverified — operator to confirm against OpenAI pricing). Gemini `gemini-3.1-pro-preview`: **assumption $2–4 / $12–18** (unverified). GLM-5.2 via OpenRouter: **$0.93–1.40 / $3.00–4.40** (pinned, S196 verified fact #1; midpoints $1.15/$3.70 used below).
4. **Subscription surfaces (operator Max chat; CloudShift OAuth for cc_subprocess + cc_dispatch + Trigger)** are flat-rate (plus possible overage) and are **not modeled per-token**. This migration does not touch them (D-275 scope statement); §6 addresses the chat-side burn structurally.

**Per-call and monthly (30 finalize-equivalents/mo):**

| Site | Est. in/out tokens | Current serving route → est. $/call | Current $/mo | GLM-5.2 $/call (thinking OFF) | GLM $/mo |
|---|---|---|---|---|---|
| CS-1 draft | 46K / ~3K | gemini-3.1-pro (assumed $3/$15 mid): **$0.183** | $5.49 | $0.064 | $1.92 |
| CS-2 brief | 60K / ~2.5K | gpt-5.5 (assumed $1.75/$15 mid): **$0.143** | $4.28 | $0.078 | $2.35 |
| CS-3 pdu | 60K / ~3K | cc_subprocess: **$0 marginal** (CloudShift subscription capacity); fallback leg Opus 4.8 $0.375/call | $0 marginal (+fallback exposure) | $0.080 | $2.40 |
| CS-4 x_sentiment | 0.2K / 0.8K | grok-4.3, on-demand | ≈$0 (rare) | n/a (keep) | — |
| CS-5 cc_dispatch | agentic | CloudShift subscription | flat | n/a (keep) | — |
| **API-billed total** | | | **~$10–16** (range over price assumptions; **~$29** if all three sites fell to the Opus 4.8 leg every call) | | **~$6.7 (±40%)** |

**Reading the table honestly:** the migration cuts the mechanical tier 45–80% in relative terms but only ~$5–25/month in absolute terms at today's volume. Its real value: (a) CS-3 stops consuming CloudShift Max capacity (~30 × 60K-token subprocess calls/mo) that cc_dispatch needs; (b) the Opus-fallback exposure ($0.375/call) is replaced by a $0.08/call primary; (c) synthesis volume can grow ~10× (more projects, per-session synthesis, §6 offloads) inside a ~$70/mo envelope that would be ~$300–900/mo at frontier prices.

**Thinking-token overhead (the GLM trap):** the S196 micro-call showed GLM-5.2 **defaults to thinking** — all 16 completion tokens went to `reasoning`, `finish_reason: length`, zero answer text. Reasoning bills at output rate and consumes `max_tokens`. Uncontrolled, a 2.5K-token brief could carry 5–20K reasoning tokens (2–8× output cost — $0.02→$0.09/call, still cheap, but the *hard failure* is `finish_reason=length` starving answer text inside our 4096/8192 caps). Thinking control is therefore a **correctness** requirement, not just a cost knob — §4.2.

**Buckets this migration does NOT touch:** operator chat-session tokens (Max subscription — the brief/boot payloads consumed *in chat* are unchanged by where synthesis runs) and Trigger/cc_dispatch Claude Code execution (CloudShift). Those are the large buckets; §6 is the design surface aimed at the first of them.

---

## §3.5 Prior-attempt forensics — why earlier offloads didn't move the invoice

**(a) DeepSeek: keyed + model-configured, structurally unable to serve.** Selection requires an env var to *name* deepseek: `requestedProvider` reads only `LLM_ROUTING_{SURFACE}_PROVIDER` / `LLM_ROUTING_DEFAULT_PROVIDER` (`routing-policy.ts:112-121`), and no live-env surface names it (S196 verified fact #3). Even if one did, the allowed-providers gate rejects it: `providerAllowed` (`routing-policy.ts:123-130`) returns false for any provider absent from `LLM_ROUTING_ALLOWED_PROVIDERS`, forcing `liveInvocationAllowed=false` with reason `provider-not-allowed` (`:69-72`), which fails `isLiveProviderSynthesisDecision` (`provider-adapters.ts:38-49`), so `synthesizeViaProvider` is never invoked (`client.ts:206`). **Two independent gates; both closed.** Git history: deepseek entered with the routing layer itself in `8cdc489` ("Add dormant model route resolver (#94)", 2026-06-25) as a registry entry (`provider-registry.ts:44-54`) and adapter URL (`provider-adapters.ts:345`); live activation came the same day in `167da5b` ("Activate live multi-provider synthesis routing"). **No commit ever wired a deepseek selector; no code path ever selected it.** The key + model env are scaffolding that was never flipped — the archetype of the "configured but never serving" class.

**(b) The openai/gemini flips: they ACTUALLY serve (code-level determination).** The resolution order inside `synthesize()` (`src/ai/client.ts:176-289`) is unambiguous:

1. `resolveCallSiteRouting` reads `SYNTHESIS_{SITE}_TRANSPORT`/`_MODEL` (`client.ts:89-134`);
2. `observeRoute`→`resolveRoute` produces the route decision (`client.ts:193-204`);
3. **if the decision is live** (routing enabled `routing-policy.ts:43-44,93-95`; dry-run explicitly false `:97-99` — note dry-run is ON unless exactly false/0/no; provider named for the surface `:112-121`; provider in allowed list `:123-130`; auth env var non-empty `:132-134`; surface supported `:59-62`), **the provider adapter executes FIRST** (`client.ts:206-233`);
4. only on provider failure (`SYNTHESIS_PROVIDER_FALLBACK` warn, `client.ts:225-233`) does the configured `cc_subprocess` transport run (`client.ts:235-270`);
5. only on *its* failure does `messages_api` run (`client.ts:256-269`, or directly at `:275-288` when no cc_subprocess transport is set).

Under the live env (ENABLED=true, DRY_RUN=false, allowed=anthropic,openai,gemini,xai, OPENAI/GEMINI keys present), `synthesis_brief`→**openai serves**, `synthesis_draft`→**gemini serves**, and `SYNTHESIS_{BRIEF,DRAFT}_TRANSPORT=cc_subprocess` are **demoted to failure-fallbacks**. `synthesis_pdu`→anthropic is *not* a live provider decision (`routing-policy.ts:48-53`), so its cc_subprocess transport genuinely serves. Corroboration: no Railway-log markers (`Synthesis provider call complete`, `SYNTHESIS_PROVIDER_FALLBACK`) are quoted in repo docs/tests (checked `docs/` and `tests/` — the strings exist only in `src/`), so per the brief this stands as a **code-level determination**; the operator can confirm live with one Railway log query for `LLM_ROUTE_OBSERVATION` / `Synthesis provider call complete`.

**Why the invoice didn't move:** the flips replaced Opus 4.8 API calls ($5/$25) with GPT-5.5 (~$1.25–2.50/$10–20) and Gemini 3.1 Pro (~$2–4/$12–18) — a lateral move within the frontier price band, on a tier spending tens of dollars a month, activated only ~18 days ago (2026-06-25). Spend moved *between invoices*, it did not *shrink materially* — and the genuinely cheap tier (GLM class, ~5–15× cheaper) had no adapter at all.

**(c) Authoritative precedence chain** (s196b defers to this table):

| # | Question | Winner | Resolving code |
|---|---|---|---|
| 1 | Routing master switch | `LLM_ROUTING_ENABLED` ≠ true → anthropic-legacy everything | `routing-policy.ts:43-44,93-95` |
| 2 | Protected task class | `protected-boundary-negative-control` → blocked | `routing-policy.ts:27-41` |
| 3 | Which provider is asked for | `LLM_ROUTING_{SURFACE}_PROVIDER`, else `LLM_ROUTING_DEFAULT_PROVIDER` | `routing-policy.ts:15-21,112-121` |
| 4 | Provider unset / `anthropic` | anthropic path (transport decides — row 10) | `routing-policy.ts:48-53` |
| 5 | `cc_dispatch` surface | always anthropic, regardless of row 3 | `routing-policy.ts:55-57` |
| 6 | Surface unsupported by provider | anthropic path | `routing-policy.ts:59-62` |
| 7 | `LLM_ROUTING_DRY_RUN` ≠ false | decision observed, never live | `routing-policy.ts:64-68,97-99` |
| 8 | Provider ∉ `LLM_ROUTING_ALLOWED_PROVIDERS` | `provider-not-allowed`, never live | `routing-policy.ts:69-72,123-130` |
| 9 | Provider auth env var empty | `provider-auth-missing`, never live | `routing-policy.ts:73-76,132-134` |
| 10 | Live decision on brief/draft/pdu | **provider adapter first**, then `SYNTHESIS_*_TRANSPORT=cc_subprocess`, then messages_api (`SYNTHESIS_*_MODEL` override → `SYNTHESIS_MODEL`) | `client.ts:206-233` → `:235-270` → `:275-288`; guard `provider-adapters.ts:38-49`; SRV-50 model-id guard `client.ts:120-131` |
| 11 | `LLM_ROUTING_PROFILE` | **nothing** — display-only | only `route-status.ts:15,56`; absent from `routing-policy.ts` |
| 12 | `prism_x_sentiment` | separate 5-gate chain, no fallback | `x-sentiment.ts:377-393` |

**Configured-but-inert classification (live env; this failure class must die — §4.8's startup table is the cure):** `DEEPSEEK_API_KEY`+`LLM_ROUTING_DEEPSEEK_MODEL` (never serving, double-gated); `PERPLEXITY_API_KEY` (same); `LLM_ROUTING_PROFILE` (cosmetic); `LLM_ROUTING_RECOMMENDATION_PROVIDER` (surface never resolved in production; `provider-adapters.ts:45`); `LLM_ROUTING_CC_DISPATCH_PROVIDER` (hard-walled, `routing-policy.ts:55-57`); `SYNTHESIS_{BRIEF,DRAFT}_TRANSPORT` (demoted to fallback #2 while provider routes serve); `SYNTHESIS_{BRIEF,DRAFT}_MODEL` (fallback-leg-only, `client.ts:239`); staged `OPENROUTER_*` triplet (inert by design until s196b — zero `src/` references at `0b5d31b`).

---

## §4 Target design (s196b's implementation spec)

Design rule: **map and extend the existing routing layer** — no new abstraction. The openai (`provider-adapters.ts:143-185`) and deepseek (`openai_compatible_chat`, `:187-234`) adapters are the pattern.

### 4.1 `openrouter` provider

- **Registry entry** (`src/llm/provider-registry.ts`): `{ id: "openrouter", displayName: "OpenRouter", authEnvVar: "OPENROUTER_API_KEY", modelEnvVar: "LLM_ROUTING_OPENROUTER_MODEL", defaultModel: "z-ai/glm-5.2", transport: "openai_compatible_chat", supportedSurfaces: [synthesis_brief, synthesis_draft, synthesis_pdu], activationStatus: "active_when_configured", qualityPolicy: "quality-before-cost" }`. Add `"openrouter"` to `LlmProviderId` (`route-types.ts:8-14`). **Not** on `recommendation` (NON-LLM) or `cc_dispatch` (protected).
- **URL routing:** extend `openAiCompatibleChatUrl` (`provider-adapters.ts:344-348`): `if (provider === "openrouter") return "https://openrouter.ai/api/v1/chat/completions"`. Bearer `OPENROUTER_API_KEY` (existing header path `:194-196`).
- **Optional headers:** `HTTP-Referer` / `X-Title` from `OPENROUTER_SITE_URL` / `OPENROUTER_APP_TITLE` env (names only; skip when unset).
- **Request extensions (openrouter-only branch in the chat adapter):** `usage: { include: true }` (returns provider-computed cost → measured `est_cost_usd` in telemetry) and `provider: { data_collection: "deny" }` (§7 governance; documented assumption — s196b verifies the field passes route validation; the operator's account-level train-toggles are the backstop).
- **max_tokens floors vs the 32K-route gotcha:** our caps are 4096 (draft) / 8192 (brief, pdu) — far under any 32,768 output-capped route, so no floor conflict *provided reasoning is off*. Guard: when reasoning is enabled for a site, require `max_tokens ≥ 16384` or refuse activation for that site with a startup warn (reasoning shares the completion budget — the S196 micro-call failure mode).
- **Timeout/retry parity:** reuse `fetchJson` + AbortController (`provider-adapters.ts:286-299`) and the caller-supplied per-site timeout (`client.ts:212`, resolved by `resolveCallSiteTimeout` `client.ts:144-148`) — no new knobs.

### 4.2 Thinking control (correctness-critical)

GLM-5.2 defaults to thinking; reasoning tokens bill as output and consume `max_tokens` (S196 live evidence: 16/16 tokens to `reasoning`, `finish_reason: length`, zero text). Design:

- Send OpenRouter's unified reasoning parameter **`reasoning: { enabled: false }`** on every openrouter call by default. **Documented assumption** (per brief Phase 3.2): this is OpenRouter's cross-provider off-switch; some GLM providers alternatively honor `chat_template_kwargs: { enable_thinking: false }`. s196b MUST pin the working mechanism in adapter tests (fixture asserts the field is sent) and verify live in the canary (§5) that `finish_reason=stop` with non-empty text and near-zero `reasoning` usage.
- Per-site opt-in: `LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}` ∈ `off|low|medium|high` (default `off`), mapped to `reasoning: { effort }` when not off. Per-site rationale: **draft OFF** (strict-JSON emission — reasoning adds length-failure risk, chat reviews anyway); **pdu OFF** (grammar emission, parser-gated); **brief OFF at flip, revisit with diff evidence** (if morning diffs show quality loss vs frontier, `low` is the first lever — at ~$0.01–0.03/call it is affordable; GLM-5.2's High/Max thinking tiers exist for §6-class future work, not these contracts).
- The existing `thinking` boolean from callers (`synthesize.ts:260,472`; hardcoded `true` at `finalize.ts:511`) maps to Anthropic adaptive thinking on Anthropic transports ONLY — the openrouter branch must **ignore it** in favor of the explicit reasoning config above (otherwise CS-1's hardcoded `true` would silently re-enable GLM thinking).

### 4.3 GLM-5.2 capability profile → where the MECHANICAL/JUDGMENT line sits

1,048,576-token context (entire *untrimmed* prism bundle ≈ 211K est tokens fits — do **not** raise the trim ceiling in s196b; keep inputs identical for a clean quality A/B), up to ~131K output route-dependent (some routes cap 32,768), High/Max thinking tiers, top-decile agentic/coding benchmarks (S196 verified facts #1–2 + operator directive). Implication: all three synthesis contracts (3-section brief, 4-section grammar, 6-key JSON) sit **comfortably inside** GLM-5.2's demonstrated envelope — the maximum-offload line is "all three synthesis sites migrate; x_sentiment is tool-bound to xAI; cc_dispatch is the protected judgment tier." Anything less leaves cheap capability unused; anything more (offloading cc_dispatch) crosses D-275's own boundary.

### 4.4 Continuity-criticality ranking → staged flip order

| Rank | Site | Why | Stage |
|---|---|---|---|
| 1 (highest) | `synthesis_brief` | The continuity carrier — every boot consumes it; a bad brief degrades all subsequent sessions | **Stage 2** — flip after morning diff of a stage-1-era brief vs GLM candidate |
| 2 | `synthesis_pdu` | Auto-applied at next finalize, but grammar-parser-gated with rejection archival | **Stage 1** (staged tonight) |
| 3 (lowest) | `synthesis_draft` | Chat reviews/edits drafts before commit — human-equivalent in the loop | **Stage 1** (staged tonight) |

### 4.5 Quality gates (INS-184) — per-site validation = fallback trigger

Existing validators stay (cited in §2). Additions, applied to openrouter results **before** they count as success (a gate failure is treated exactly like a provider failure → `SYNTHESIS_PROVIDER_FALLBACK` → the site's existing anthropic chain):

- All sites: `finish_reason` ≠ `stop` → **failure** (exists, `provider-adapters.ts:216-219`); empty content → **failure** (exists, `:221-222`).
- **brief:** all 3 `INTELLIGENCE_BRIEF_SPEC_SECTIONS` present AND ≥2,000 bytes (new min-length; today's section check at `synthesize.ts:281` only warns when un-truncated).
- **pdu:** all 4 required H2 sections present AND ≥500 bytes (today warn-only, `synthesize.ts:492-501` → becomes gate on the openrouter leg).
- **draft:** `extractJSON` must parse AND contain ≥4 of the 6 contract keys — closing the `raw_content` success gap (`finalize.ts:535-543`) on the GLM route (Anthropic legs keep today's lenient behavior).

### 4.6 Fallback + kill-switch

Failure/validation-fail → structured warn (`SYNTHESIS_PROVIDER_FALLBACK`, extended with `fallback_reason: validation_failed|provider_error|timeout`) → the site's existing chain (cc_subprocess where configured, then messages_api) — i.e., openrouter becomes hop 0 in front of the §2 chains, changing nothing behind it. **Rollback is env-only:** remove the site from `LLM_ROUTING_OPENROUTER_SITES` (per-site) or unset it (global); no deploy required.

### 4.7 Activation surface — `LLM_ROUTING_OPENROUTER_SITES`

Comma list of call-site ids (`synthesis_draft,synthesis_pdu[,synthesis_brief]`). Semantics: openrouter serves **exactly (SITES ∩ {mechanical synthesis sites})**. Resolution: in `resolveRoute`, after the enabled/protected checks and *before* `requestedProvider` — if the surface is in SITES and `OPENROUTER_API_KEY` is present, select openrouter with reason `live-provider-route`; `providerAllowed` treats openrouter as allowed **internally when the surface is in SITES** (no mutation of `LLM_ROUTING_ALLOWED_PROVIDERS` or any pre-existing shared env var required — brief constraint). SITES unset/empty ⇒ the new branch is dead code ⇒ **bit-identical behavior to today** (s196b must add a routing-policy test asserting exactly this). Dry-run and ENABLED master switches retain their row-1/row-7 precedence.

### 4.8 Telemetry — the permanent activation proof

- **Per-call:** one structured `LLM_CALL` info line for every LLM invocation across ALL providers/transports: `{ call_site, provider, model, transport, input_tokens, output_tokens, est_cost_usd, latency_ms, fallback_used, fallback_reason }`. Emission point: end of `synthesize()` (`src/ai/client.ts`) so every transport passes through it; plus `dispatchTask` (`claude-code/client.ts`) and `analyzeXSentiment` (`x-sentiment.ts`) for CS-4/5. `est_cost_usd`: measured from OpenRouter `usage.cost` when present; computed from a static price table otherwise (marked `estimated: true`).
- **Startup:** one `LLM_ROUTING_TABLE` line at server start (beside `index.ts:204`, today's only startup log) printing resolved `call_site→provider→model→transport` for all five surfaces via `resolveRoute` + `resolveCallSiteRouting` — env names and model ids only, no secrets. This permanently kills the "configured but never serving" class: any inert knob is visible in one log line at every deploy.

### 4.9 Env end-state after s196b (names only)

Already staged (inert): `OPENROUTER_API_KEY`, `LLM_ROUTING_OPENROUTER_MODEL=z-ai/glm-5.2`, `LLM_ROUTING_OPENROUTER_SITES=synthesis_draft,synthesis_pdu`. New optional: `LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}` (default off), `OPENROUTER_SITE_URL`, `OPENROUTER_APP_TITLE`. Unchanged: every pre-existing var — activation requires **no mutation of any shared env var**. Stage 2 is a one-token append to SITES. Recommended cleanup (separate, operator-decided): retire `DEEPSEEK_API_KEY`/`PERPLEXITY_API_KEY` or wire them deliberately — the startup table will keep them honest either way.

---

## §5 Rollout / canary / rollback

**Stage 1 (deploy night, sites already staged):**
1. Merge s196b; Railway auto-deploys. Verify startup: `LLM_ROUTING_TABLE` shows `synthesis_draft→openrouter→z-ai/glm-5.2→openai_compatible_chat`, `synthesis_pdu→openrouter→…`, `synthesis_brief→openai→…` (unchanged).
2. Canary tool call: `prism_finalize action=full` on the prism project (or `prism_synthesize mode=generate` for a commit-free PDU/brief pass — note it exercises pdu+brief, not draft).
3. Proof logs (Railway): `LLM_CALL { call_site: synthesis_draft, provider: openrouter, model: z-ai/glm-5.2, … }` and same for `synthesis_pdu`; `finish_reason` absent from warns; **no** `SYNTHESIS_PROVIDER_FALLBACK`; `Synthesis provider call complete`-class success lines carry openrouter.
4. Quality diff: `pending-doc-updates.md` (4 sections present, proposals parse — next finalize's apply-pdu report shows applied>0 or clean skips) and the draft JSON surfaced in the finalize response (all 6 keys, prose density comparable to the prior session's).
**Stage 2 (morning-diff gate):** operator compares the latest frontier-produced `intelligence-brief.md` against a GLM candidate (one-off `prism_synthesize mode=generate` after appending `synthesis_brief` to SITES, or a side-by-side in a scratch project). On pass: append `synthesis_brief` to `LLM_ROUTING_OPENROUTER_SITES`. On fail: try `LLM_ROUTING_OPENROUTER_REASONING_BRIEF=low`; re-diff; otherwise leave brief on openai.
**Rollback (any point, env-only):** remove the regressing site from SITES → next call resolves exactly as today (§3.5 table rows 3–10). Railway env change, no deploy.

---

## §6 Framework-level offload opportunities (design-only — NOT for s196b)

Surveyed read-only (`git show origin/main:<file>`; working trees untouched — S195 lesson): prism-framework `6a46ae7` (`_templates/core-template-mcp.md` v2.29.0, 42.6KB), trigger `69e27f95e1`, prism `7f445b5e`. These target the **chat-side Max-plan token burn** — the bucket §3 can't touch. All are recommendations with fleet-wide protocol impact (INS-340); each needs its own brief.

| # | Opportunity | Today (citation) | Proposal | Est. chat-token saving / risk |
|---|---|---|---|---|
| F-1 | **Finalize composition offload** | Chat reviews CS-1 drafts, composes `files[]`, must satisfy the handoff schema (template SESSION END; `core-template-mcp.md:287-297`; HANDOFF_SCHEMA hard requirement) | Server-side GLM composes complete finalization files; chat approves a compact server-rendered diff instead of authoring | ~3–6K tokens/finalize × ~25/mo ≈ **75–150K/mo**; risk medium (server validation already enforces schema); protocol: finalize contract + Rules 10-15 |
| F-2 | **Ingest stubs + INDEX lines (D-270)** | Chat extracts binaries, composes metadata stubs and appends `ingest/INDEX.md` lines itself (`core-template-mcp.md` Document Ingest §1-6) | `prism_ingest` server tool: GLM writes the one-line description + stub server-side; chat passes content once | ~0.6–4K tokens/item; low risk (secret scan stays server-side deterministic); smallest, cleanest first move |
| F-3 | **Boot-payload compaction** | Boot payload steady state ~115KB ≈ ~33K tokens/session (`config.ts:72-73` measured S166/S167) × ~25 sessions/mo ≈ **~825K chat tokens/mo standing cost** | GLM-side compression experiments: session-tailored intelligence-brief digest (brief already targets 1.5–3K tokens — compress *other* sections), Tier-A standing-rules dedup against template content | Target 20–30% ≈ 200–250K/mo; **risk HIGH** — behavioral-rules fidelity; experiments only, gated on D-253 lessons |
| F-4 | **Session-log/task-queue rolling composition** | Chat composes checkpoint entries and parking-lot items inline (Rules 5/7/8, `core-template-mcp.md` DURING WORK/PERSISTENCE) | GLM "compose-from-bullet" endpoint behind prism_push/patch | ~0.5–1K/item; marginal — defer until F-1/F-2 prove the pattern |
| F-5 | **Trigger** | Daemon spawns Claude Code on CloudShift OAuth; no direct LLM API calls in the trigger repo (verified) | **No change.** Brief execution is judgment-tier + subscription-billed; a GLM code-runner is a separate subsystem D-275 excludes. D-274 (CC Leverage Mandate, `core-template-mcp.md:82-92`) already routes chat clerical work off the Max plan | — |

**Sequencing:** F-2 → F-1 → F-3 experiments; F-4 opportunistic; F-5 none. Combined, F-1+F-2 realistically relieve **100–200K chat tokens/month** of Max-plan pressure — an order of magnitude more invoice-relevant than the §3 API delta, and only viable because the GLM tier makes per-call cost negligible.

---

## §7 Risks

1. **Data governance (flagged for operator sign-off):** living-document content — project state, decisions, operational detail — transits OpenRouter and its upstream providers (S196 micro-call served by **Wafer**) once SITES activates. Operator has account-level training-toggles OFF (S196 verified fact #2); design adds request-level `provider: { data_collection: "deny" }` (§4.1, s196b-verified). Residual risk: provider-side transient retention per OpenRouter's provider policies. Mitigation: pin acceptable providers via OpenRouter provider preferences if Wafer-class routing proves inconsistent.
2. **GLM thinking default** — the S196 micro-call's `finish_reason: length` with zero text is the exact production failure mode if §4.2 ships wrong; gates in §4.5 convert it to a clean fallback, but a silent thinking regression would burn output tokens invisibly → the `LLM_CALL` line's output_tokens vs content-bytes ratio is the watch signal.
3. **Quality drift on the continuity carrier** — mitigated by stage-2 gating + validators + env-only rollback; the brief is the one artifact where "cheap but subtly worse" compounds across sessions.
4. **Tokenizer variance** — §3 estimates use chars/3.5; GLM's tokenizer may bill 1.0–1.35× estimates. Telemetry (`usage.include`) replaces estimates with measured values from call one.
5. **Marketplace pricing variance** — $0.93–1.40/$3.00–4.40 is a range across routes; OpenRouter may route to pricier providers under load. `usage.cost` telemetry surfaces the real number per call.
6. **Fallback masking** — a persistently failing openrouter route would silently serve frontier prices again (by design). The `fallback_used` telemetry field + the existing boot-time synthesis observation surfacing (`synthesis-fallback-check.ts`) make sustained fallback operator-visible.
7. **Validation-gate false positives** — new min-length/parse gates (§4.5) could reject legitimate short outputs (e.g., a genuinely quiet session's PDU). Thresholds are deliberately low (500B/2000B); gates trigger fallback (artifact still produced, by Claude) rather than artifact loss.

<!-- EOF: d275-audit-design.md -->
