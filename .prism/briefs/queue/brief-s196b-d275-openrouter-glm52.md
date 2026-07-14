---
brief: s196b
title: "S196 — D-275 implementation: OpenRouter + GLM-5.2 provider in the existing LLM routing layer (mechanical-tier offload)"
parallel: false
depends_on:
  - s196a
affects:
  - src
  - tests
  - docs
  - CHANGELOG.md
complexity: high
workflow: direct
model: claude-fable-5
effort: max
---

# Brief s196b — D-275 implementation: OpenRouter + GLM-5.2 mechanical-tier routing

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-275 (S196). Implement the design merged by brief-s196a: `openrouter` provider (GLM-5.2) in the EXISTING routing layer, mechanical sites routed to it, automatic anthropic fallback, cost telemetry, env-only kill-switch. Watcher merges; Railway auto-deploys; tonight's pre-staged env activates it on deploy.

## Dependency gate (bounded wait — FIRST)

Pinned inputs: `docs/cost-rearchitecture/d275-audit-design.md` + `docs/cost-rearchitecture/d275-callsite-inventory.json` on origin/main (from s196a). Loop: `git fetch origin main --quiet`; check `git cat-file -e origin/main:docs/cost-rearchitecture/d275-callsite-inventory.json`; if absent sleep 60s, retry up to 60 attempts (s196a's PR may be in watcher-merge flight). Still absent after the window → EXIT without pushing anything (state journal records it; morning re-issues per INS-361). On success, base your branch on that origin/main and record its SHA in the PR body.

## Scope rails (authoritative — where the design doc and these rails conflict, the rails win)

1. **Adapter.** Add provider `openrouter` mirroring the existing openai/deepseek adapter structure, error taxonomy, timeout, retry. Endpoint `https://openrouter.ai/api/v1/chat/completions`; Bearer from `OPENROUTER_API_KEY` (name only, never a value); model from `LLM_ROUTING_OPENROUTER_MODEL` default `z-ai/glm-5.2`; optional `HTTP-Referer: https://github.com/brdonath1/prism-mcp-server` + `X-Title: PRISM MCP Server`; per-site max_tokens floors per design doc §4 (32K-route truncation gotcha); map non-2xx/timeout/malformed-JSON/empty-choices into the existing error taxonomy.
2. **Thinking control (live-verified hazard).** Tonight's live test: GLM-5.2 defaults to thinking mode; a 16-token call spent ALL tokens on reasoning, `finish_reason=length`, zero answer text (provider Wafer, cost $0.0000896). Implement per-site thinking control per design doc §4's mechanism; default thinking OFF for mechanical sites; treat `finish_reason=length` or empty/short-below-floor content as validation failure → fallback. Cover with a test.
3. **Control surface.** Follow the design doc §3.5 precedence table (transport vs per-site provider vs profile) — wire openrouter through the AUTHORITATIVE surface it identifies, not an assumed one. Activation: NEW env `LLM_ROUTING_OPENROUTER_SITES` (comma list of call-site ids; Railway already carries `synthesis_draft,synthesis_pdu`). openrouter serves exactly (SITES ∩ inventory-mechanical). SITES unset/empty → behavior bit-identical to today (regression-test this). No pre-existing shared env var may REQUIRE mutation for activation — code may internally accept openrouter in allowed-providers when SITES is present. Kill-switch documented: clear SITES.
4. **Do NOT migrate** sites marked keep-anthropic / keep-other-provider / NON-LLM; do NOT touch cc_dispatch/Trigger CC execution or x_sentiment xAI routing.
5. **Fallback.** On openrouter HTTP error / timeout / validation failure / empty output: structured warn log {reason} and transparently invoke the site's existing anthropic path.
6. **Telemetry + activation proof.** One structured log line per LLM invocation across ALL providers {call_site, provider, model, input_tokens, output_tokens, est_cost_usd, latency_ms, fallback_used, fallback_reason} (usage fields when returned, else labeled chars/3.5 estimate; pricing table in one config module with source-date comment). STARTUP log line printing the resolved routing table (call_site→provider→model→transport, no secrets).
7. **Tests (INS-31).** Mocked global fetch asserting URL + method + Authorization-header PRESENCE (never a value) + model + payload shape; thinking-control shape; fallback per failure class; SITES parsing incl. unset/empty regression; suite green vs the baseline recorded at the gate (expect ≥ PR #104's 1667/5-skipped; record actuals); `npx tsc --noEmit`, `npm run lint`, `npm run build` clean. No live network calls in tests; no real keys anywhere.
8. **Docs + version ripple** per repo convention (mirror PR #103 lockstep): package.json/package-lock.json/src/config.ts/CLAUDE.md version bump, CHANGELOG entry, CLAUDE.md env-contract update, and `docs/cost-rearchitecture/d275-rollout.md` (go-live env end-state incl. stage-2 intelligence-brief flip, canary steps, rollback).
9. **Secrets discipline.** Never read/print/echo/commit any credential or env VALUE anywhere (code, tests, docs, PR body, printed logs).

## Push directive (exactly one — INS-20)

Branch `feat/brief-s196b-d275-openrouter-glm52`; PR to main titled `prism(S196): brief-s196b D-275 OpenRouter GLM-5.2 mechanical-tier routing`; PR body = migrated-site table from the inventory, test counts baseline→branch, fallback/quality-gate description, the resolved routing table your code produces under tonight's staged env, base main SHA. Immediately after PR-open, self-dequeue: fetch briefs branch, delete `.prism/briefs/queue/brief-s196b-d275-openrouter-glm52.md` ONLY, push, retry 3x on 409/422, record dequeue SHA in the PR body (INS-324). Watcher merges; Railway auto-deploys. No other pushes, no merges, no env mutation from the worker.

## Verification (hard block — land evidence in the PR body)

1. Regression: SITES unset reproduces current behavior (test cited). 2. Routing table under staged env shows synthesis_draft + synthesis_pdu → openrouter/z-ai/glm-5.2 and everything else unchanged. 3. Thinking-control + length-truncation fallback tests green. 4. Full-suite counts, tsc, lint, build. 5. `git diff --check` clean.

## Out of Scope

Chat-protocol/template changes (design §6 → future fleet brief per INS-340); the INS-360 finalize-audit FIX; Trigger/daemon changes; Railway config/env mutation; provider changes for judgment-tier sites; the intelligence-brief flip itself (stage 2, morning-gated).

## Brief Author Notes

Authored chat-side S196 under D-275. Pinned `claude-fable-5` / `effort: max` (operator Max Effort directive). depends_on s196a is declared for daemon awareness; the bounded wait-gate above is the enforced dependency (INS-40: daemon depends_on semantics unverified).

<!-- EOF -->
