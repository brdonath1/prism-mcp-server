---
brief: s196a
title: "S196 — D-275 cost audit: full LLM call-site inventory, prior-attempt forensics, GLM-5.2 offload design (docs-only)"
parallel: false
depends_on: []
affects:
  - docs/cost-rearchitecture
complexity: high
workflow: direct
model: claude-fable-5
effort: max
---

# Brief s196a — D-275 full-codebase cost audit, LLM call-site inventory, prior-attempt forensics, and GLM-5.2 offload design

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** Operator directive D-275 (S196): PRISM's monthly LLM spend is unmanageable; re-architect so the mechanical/clerical LLM tier runs on GLM-5.2 via OpenRouter while Claude remains the judgment tier. This is the AUDIT + DESIGN half (INS-177 audit-then-fix). READ-ONLY outside docs/cost-rearchitecture/ — no src/, test, config, or CHANGELOG changes. brief-s196b implements your design tonight.

## Verified facts (pinned by the S196 chat, 07-13-26 — treat as inputs; re-verify in code where cited)

1. GLM-5.2 live on OpenRouter: model ID `z-ai/glm-5.2`, ~$0.93–1.40/M input, $3.00–4.40/M output (marketplace range), 1,048,576-token context, OpenAI-compatible chat-completions API (`https://openrouter.ai/api/v1`). Some marketplace routes cap output at 32,768 tokens.
2. Live micro-call evidence (22:34 CST tonight): `z-ai/glm-5.2` served by provider **Wafer** under the operator's tightened data policies; usage 20 in / 16 out, cost $0.0000896. **CRITICAL: GLM-5.2 defaults to THINKING mode** — all 16 completion tokens went to `reasoning`, `finish_reason: length`, zero answer text emitted. Reasoning tokens bill at output rate and consume max_tokens. The design MUST control thinking per call site.
3. The repo ALREADY HAS a live multi-provider LLM routing layer. Live Railway env (verified tonight): `LLM_ROUTING_ENABLED=true`, `LLM_ROUTING_DRY_RUN=false`, `LLM_ROUTING_ALLOWED_PROVIDERS=anthropic,openai,gemini,xai`, `LLM_ROUTING_PROFILE=frontier-quality`, `LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER=openai`, `LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER=gemini`, `LLM_ROUTING_SYNTHESIS_PDU_PROVIDER=anthropic`, `LLM_ROUTING_RECOMMENDATION_PROVIDER=anthropic`, `LLM_ROUTING_CC_DISPATCH_PROVIDER=anthropic`, per-provider model vars, and keys for openai/gemini/deepseek/perplexity/xai. `DEEPSEEK_API_KEY` + `LLM_ROUTING_DEEPSEEK_MODEL` exist but **deepseek is ABSENT from ALLOWED_PROVIDERS**. There is no openrouter provider in code. Do not design a new abstraction — map and extend the existing one.
4. Synthesis transports: `SYNTHESIS_BRIEF_TRANSPORT` / `SYNTHESIS_DRAFT_TRANSPORT` / `SYNTHESIS_PDU_TRANSPORT` = `cc_subprocess`, models `claude-*`, with a cc_subprocess→messages_api fallback using global `SYNTHESIS_MODEL` (INS-332). cc_subprocess bills the CloudShift OAuth subscription; messages_api bills `ANTHROPIC_API_KEY`.
5. Tonight's staged Railway env (already set, inert until s196b deploys): `OPENROUTER_API_KEY` (present, sk-or-*), `LLM_ROUTING_OPENROUTER_MODEL=z-ai/glm-5.2`, `LLM_ROUTING_OPENROUTER_SITES=synthesis_draft,synthesis_pdu`. Your design MUST adopt `LLM_ROUTING_OPENROUTER_SITES` as the opt-in activation surface (see Phase 3.7).
6. Baseline: PR #104 (open at authoring; watcher merges) reported 1667 passed / 5 skipped, tsc + lint clean. Record the actual main HEAD SHA you clone and the baseline you observe (INS-283).

## Phase 1 — Exhaustive LLM call-site inventory (core deliverable)

Enumerate EVERY code path that can cause an LLM invocation. Start at src/ai/ and src/config.ts; grep for messages-API calls, cc_subprocess spawns, provider registry entries, fetches to api.anthropic.com / api.openai.com / generativelanguage / api.deepseek.com / api.perplexity.ai / api.x.ai, `SYNTHESIS_*`, `LLM_ROUTING_*`, `RECOMMENDATION_MODEL*`, `CC_DISPATCH_MODEL`, x_sentiment. For EACH call site record, with file:line citations (INS-29/INS-40 — cite, never infer): call_site id + name; invoking tool/flow + frequency (per bootstrap / finalize / synthesize / session); implemented transport + fallback chain and the exact env vars selecting provider/model; billing surface (CloudShift OAuth vs ANTHROPIC_API_KEY vs other provider key); typical input assembly + estimated tokens (known doc sizes: handoff ~5.5KB, session-log ~19KB, standing-rules ~304KB if ever included) and typical/max output; output contract + validator (cite it); classification MECHANICAL / JUDGMENT / NON-LLM (if the recommendation classifier is deterministic keyword scoring, cite it and mark not-migratable); migration verdict migrate-to-GLM-5.2 / keep-anthropic / keep-other-provider with one-line reason. No INCONCLUSIVE or DEFERRED verdicts (INS-182). Emit prose (design doc §2) AND machine-readable `docs/cost-rearchitecture/d275-callsite-inventory.json` — s196b consumes the JSON as its work list.

## Phase 1.5 — Prior-attempt forensics (why did earlier offloads not move the invoice?)

Settle with code citations + git history, no speculation:
(a) **DeepSeek**: keyed + model-configured yet absent from ALLOWED_PROVIDERS — confirm in code that the allowed-providers gate (or per-site flips never happening) made it structurally unable to serve; find when/how it was introduced (git log) and whether any code path ever selected it.
(b) **The openai/gemini flips**: SYNTHESIS_BRIEF→openai and SYNTHESIS_DRAFT→gemini are set — determine whether they ACTUALLY serve (precedence vs `SYNTHESIS_*_TRANSPORT=cc_subprocess` and vs `LLM_ROUTING_PROFILE=frontier-quality`), i.e. does transport, per-site provider, or profile win? Cite the resolution code. If reachable, corroborate with recent Railway-log markers quoted in repo docs/tests; otherwise state code-level determination only.
(c) Conclude the precedence chain in one authoritative table — s196b defers to it. Classify every configured-but-inert setting found; "configured but never serving" is a first-class failure class this program must eliminate.

## Phase 2 — Cost attribution model

Per-call-site monthly cost at (a) current routing/pricing (state list-price assumptions explicitly) and (b) GLM-5.2 pricing ($0.93–1.40 / $3.00–4.40 per M, plus thinking-token overhead if enabled). Mark every estimate as an estimate; authoritative dollars live in the Anthropic Console (operator-side, INS-241) — design the Phase-3 telemetry so post-migration numbers become measured. State plainly which buckets this migration does NOT touch: chat-session tokens (operator Max) and Trigger/cc_dispatch Claude Code execution (CloudShift).

## Phase 3 — Target design (what s196b implements)

Against the EXISTING routing layer's real interfaces (read the openai/deepseek adapters as the pattern):
1. `openrouter` adapter: OpenAI-compatible chat completions, base `https://openrouter.ai/api/v1`, Bearer `OPENROUTER_API_KEY`, model from `LLM_ROUTING_OPENROUTER_MODEL` (default `z-ai/glm-5.2`), optional HTTP-Referer/X-Title, per-site max_tokens floors vs the 32K-route gotcha, timeout/retry consistent with existing adapters.
2. **Thinking control**: explicit per-site reasoning/thinking control (OpenRouter reasoning params / `chat_template_kwargs.enable_thinking=false` — determine the mechanism that actually works via OpenRouter docs in-repo knowledge or a documented assumption s196b verifies in tests); default OFF for mechanical sites unless you argue otherwise per site.
3. GLM-5.2 capability profile: 1M context, up to 131K output (route-dependent), High/Max thinking effort levels, top-decile agentic/coding benchmarks — draw the MECHANICAL/JUDGMENT line from what the model can actually do, pushing offload as far as quality evidence allows (operator directive: maximum offload WITHOUT quality loss).
4. **Continuity-criticality ranking**: rank call sites by impact on session-to-session intelligence (the intelligence brief is the continuity carrier — highest criticality; drafts/PDU/log-composition lower). Recommend a staged flip order; tonight's staged SITES (synthesis_draft, synthesis_pdu) are stage 1, intelligence-brief flip is a morning-diff-gated stage 2.
5. Quality gates (INS-184): per-site validators (cite existing ones; add min-length + required-section checks where missing); `finish_reason=length` or empty content = validation failure.
6. Fallback + kill-switch: openrouter failure/validation-fail → the site's existing anthropic path with structured warn log; rollback = env-only.
7. **Activation surface**: adopt `LLM_ROUTING_OPENROUTER_SITES` (comma list of call-site ids) as the opt-in switch — openrouter serves exactly (SITES ∩ your mechanical set); SITES unset/empty = behavior bit-identical to today; no pre-existing shared env var may require mutation for activation (code may accept openrouter in allowed-providers internally when SITES is present).
8. Telemetry: one structured log line per LLM call across ALL providers {call_site, provider, model, input_tokens, output_tokens, est_cost_usd, latency_ms, fallback_used, fallback_reason}, plus a STARTUP log line printing the resolved routing table (call_site→provider→model→transport, no secrets) — the permanent activation proof.
9. Rollout: exact env end-state, canary steps (which tool call, which log lines prove GLM served, which docs to quality-diff), rollback steps.

## Phase 4 — Framework-level offload opportunities (design-only, NOT for s196b)

Read-only survey via `git -C <path> fetch origin --quiet` + `git -C <path> show origin/main:<file>` (NEVER mutate working trees — S195's outage was a dirty polled clone): /Users/brdonath/development/prism-framework (_templates/core-template-mcp.md), /Users/brdonath/development/trigger, /Users/brdonath/development/prism (.prism living docs). Identify where CHAT-side Claude tokens go to clerical work a server-side GLM-5.2 endpoint could absorb (session-log composition, task-queue rolling updates, finalize handoff drafting, ingest INDEX lines, boot-payload follow-ons). Per item: token savings estimate, protocol impact (fleet-wide per INS-340), risk, sequencing. Recommendations only.

## Deliverables + push directive (exactly one — INS-20)

Write `docs/cost-rearchitecture/d275-audit-design.md` (§1 exec summary + headline current-vs-projected monthly numbers; §2 inventory prose; §3 cost attribution; §3.5 prior-attempt forensics + precedence table; §4 target design; §5 rollout/canary/rollback; §6 framework recommendations; §7 risks incl. data-governance note that living-doc content transits OpenRouter providers — operator has train-toggles OFF) and `docs/cost-rearchitecture/d275-callsite-inventory.json`. Branch `docs/brief-s196a-d275-cost-audit`; PR to main titled `prism(S196): brief-s196a D-275 cost audit + GLM-5.2 offload design`; PR body = exec summary, headline numbers, observed test baseline, analyzed main HEAD SHA. Immediately after the PR opens, self-dequeue: fetch the briefs branch, delete `.prism/briefs/queue/brief-s196a-d275-cost-audit.md` ONLY, push, retry up to 3x on 409/422, record the dequeue SHA in the PR body (INS-324). The watcher merges — do not merge; no other pushes.

## Verification (hard block — land evidence in the PR body)

1. Docs-only diff (`git diff --stat` shows only docs/cost-rearchitecture/). 2. Every inventory row carries file:line citations; zero INCONCLUSIVE verdicts. 3. Precedence table (§3.5) cites the resolving code lines. 4. JSON parses and row count matches prose. 5. If you ran the suite for baseline, report counts unmodified.

## Out of Scope

Any src/test/config/CHANGELOG change; any LLM provider network call; reading/printing/copying any secret VALUE (env names only); modifying tests; the INS-360 FIX (separate brief).

## Brief Author Notes

Authored chat-side S196 under D-275. Pinned `claude-fable-5` / `effort: max` per operator directive (Max Effort audit). Session-anchored id per S195 convention.

<!-- EOF -->
