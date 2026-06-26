# Model Bump SOP — the canonical fleet migration procedure (D-254)

> **Current source fallback** (2026-06-25): Claude Fable 5 is unavailable for
> the foreseeable future per operator direction, so repo-visible defaults fall
> back to Claude Opus 4.8 (`claude-opus-4-8`). This document is the checklist
> for the NEXT bump. The guiding invariant: **inside this repo, a model
> migration is one edit block in `src/models.ts`** — everything else either
> derives from the registry or lives on a surface outside this repo, enumerated
> below.

## 1. The single switch — `src/models.ts`

Every server-side model default is a named export of `src/models.ts`:

| Constant | What it pins | Consumed by |
|---|---|---|
| `RECOMMENDATION_MODELS` | Operator-facing picker recommendation per session category (`code` + `display` + canonical API `id`) — the **default**, overridable per category via env (§2) | `src/utils/session-classifier.ts` — derives the `RecommendedModel` union (default codes) and feeds `resolveRecommendationModel()`, which applies any `RECOMMENDATION_MODEL_*` env override before falling back to these defaults; nothing re-pins a model literal |
| `SYNTHESIS_MODEL_ID` | Default model the server calls for synthesis (intelligence-brief + pending-doc-updates) | `src/config.ts:95` → `SYNTHESIS_MODEL` |
| `CC_DISPATCH_MODEL_ID` | Default model for Claude Code dispatches (`cc_dispatch`) | `src/config.ts:449` → `CC_DISPATCH_MODEL` |

To bump inside this repo: edit those constants, run `npm run build && npm test`,
and confirm the pin audit is clean:

```sh
grep -rnE '"claude-[a-z]+-[0-9]' src --include='*.ts' | grep -v __tests__ | grep -v models.ts
# → must print nothing
```

**Detection automation** (Phase 2 / D-235): `scripts/check-model-freshness.mjs`
runs on a schedule (`.github/workflows/model-freshness.yml`), diffs the
Anthropic Models API against the registry, and opens a bump PR — detection is
automatic, adoption is always human-merged. Two coupling contracts when
editing the registry:

1. Keep the literal shapes regex-parseable by `extractPins()` (entry shape
   `{ code: "...", display: "...", id: "..." }`; `NAME = "..."` for the id
   pins).
2. A new model **family** (as `fable` was in S162) must be added to
   `KNOWN_FAMILIES` in the script, or every scheduled run files an
   "unrecognized family" issue.
3. Parser-compatible historical families are not automatically adoptable. If
   operator evidence says a family is unavailable, the freshness automation
   must not be merged to that family until a later reviewed plan re-enables it.

## 2. Precedence — env beats registry, registry is the fallback

The rule, precisely: **for every model surface — server-call and the
operator-facing recommendation alike — a Railway env var that is set,
non-blank, and well-formed wins; the registry constant applies only when the
env var is unset (or blank/whitespace, or — for the recommendation vars —
malformed).**

| Surface | Env override (Railway, chat-side owned) | Fallback chain |
|---|---|---|
| Synthesis global default | `SYNTHESIS_MODEL` | → `SYNTHESIS_MODEL_ID` (`src/config.ts:95`) |
| Synthesis per call-site (`brief` / `draft` / `pdu`) — model | `SYNTHESIS_{BRIEF\|DRAFT\|PDU}_MODEL` | → `SYNTHESIS_MODEL` → `SYNTHESIS_MODEL_ID` (`src/ai/client.ts:82`) |
| Synthesis per call-site — transport | `SYNTHESIS_{BRIEF\|DRAFT\|PDU}_TRANSPORT` | → `messages_api` (`src/ai/client.ts:72`) |
| Background synthesis per call-site (`brief` / `pdu`) — adaptive thinking | `SYNTHESIS_{BRIEF\|PDU}_THINKING` | → `true` (`src/config.ts`) |
| Claude Code dispatch | `CC_DISPATCH_MODEL` | → `CC_DISPATCH_MODEL_ID` (`src/config.ts:449`) |
| Recommendation — reasoning_heavy | `RECOMMENDATION_MODEL_REASONING` | → `RECOMMENDATION_MODELS.reasoning_heavy` (`src/utils/session-classifier.ts`) |
| Recommendation — executional | `RECOMMENDATION_MODEL_EXECUTIONAL` | → `RECOMMENDATION_MODELS.executional` |
| Recommendation — mixed | `RECOMMENDATION_MODEL_MIXED` | → `RECOMMENDATION_MODEL_REASONING` → `RECOMMENDATION_MODELS.mixed` |

Each `RECOMMENDATION_MODEL_*` value is an Anthropic model id (e.g.
`claude-opus-4-8`); the classifier derives the banner's short `code` and
`display` from it (`modelDisplayFromId`, stripping a `claude-` prefix and any
`[1m]` suffix).

Env is **owned chat-side** (operator + claude.ai session via the Railway
tools). This repo's code and dispatched Claude Code instances never read
Railway state to mutate it and never write it.

**The recommendation surface is advisory, not a server-call.**
`RECOMMENDATION_MODEL_*` only changes which model the boot/finalize banner
tells the operator to **select** — the server never calls that model — so the
INS-244 / INS-245 OAuth-availability + cost gates (§5) do **not** apply.
Because it is unvalidated free-form env, a value that does not look like a
model id is ignored with a logged warning and the category falls back to its
registry default, so a typo can never emit a broken banner. `mixed` resolves
`RECOMMENDATION_MODEL_MIXED` → `RECOMMENDATION_MODEL_REASONING` → registry, so
overriding only the reasoning recommendation moves mixed sessions with it
(the common case: a deployment whose top tier is unavailable redirects both
reasoning and mixed with a single var).

## 3. Unset-env routing behavior — what `resolveCallSiteRouting` actually does

`resolveCallSiteRouting(callSite)` (`src/ai/client.ts:63-84`) resolves both
knobs per call-site. The unset-env behavior, confirmed against source:

- **Transport when `SYNTHESIS_*_TRANSPORT` is unset → `messages_api`.**
  The transport initializes to `"messages_api"` (`src/ai/client.ts:72`) and
  flips to `cc_subprocess` only on the exact value `"cc_subprocess"`
  (`:73-74`). Any other non-empty value logs a warning and stays
  `messages_api` (`:75-80`).
- **Model when `SYNTHESIS_*_MODEL` is unset or blank → `SYNTHESIS_MODEL`.**
  `const model = modelEnv && modelEnv.trim().length > 0 ? modelEnv.trim() :
  SYNTHESIS_MODEL` (`:82`), where `SYNTHESIS_MODEL` is itself
  `process.env.SYNTHESIS_MODEL ?? SYNTHESIS_MODEL_ID` (`src/config.ts:95`).
  `modelOverridden` is false (`:83`), so the `messages_api` path passes
  `modelOverride: undefined` (`:173`) and `callMessagesApi` lands on
  `modelOverride ?? SYNTHESIS_MODEL` (`:212`).
- **cc_subprocess failure fallback ignores the env model.** When a call-site
  routes to `cc_subprocess` and the subprocess fails, the retry goes through
  `messages_api` with `modelOverride: undefined` (`:154`) — i.e. the registry
  default — and tags the result `messages_api_fallback` (`:158`). The env
  override is deliberately dropped on the retry because the override is what
  failed.

So the test suite's suggestion is confirmed: **fully unset env for a
call-site = `messages_api` transport + `SYNTHESIS_MODEL` (registry default
unless the global `SYNTHESIS_MODEL` env is set).**

### Is clearing env overrides ever safe?

Clearing a call-site's env vars is **not a "reset to default" no-op** — it
changes both knobs at once:

- **Transport** flips from the OAuth `cc_subprocess` surface
  (`CLAUDE_CODE_OAUTH_TOKEN`, Max-plan billing, Agent SDK subprocess) to the
  direct Messages API (`ANTHROPIC_API_KEY`, per-token billing).
- **Capability**: `[1m]`-suffixed long-context model ids are valid **only**
  on the `cc_subprocess` surface — the Agent SDK forwards `--model`
  uninterpreted (`src/ai/cc-subprocess.ts`), whereas the Messages API rejects
  the suffix. A call-site holding a long-context pin loses the 1M window the
  moment its env is cleared.

Therefore: clearing a call-site's env overrides is safe **only when the
intended end-state for that call-site is `messages_api` + the registry
default**. In particular, `SYNTHESIS_PDU_MODEL` is deliberately **held** on
its Sonnet 4.6 long-context pin (with its `cc_subprocess` transport) until the
replacement model's long-context window probe passes — do not clear or "tidy"
it during a bump.

## 4. The canonical fleet bump — all surfaces, in order

A fleet migration touches five surfaces. Registry + env cover the server;
the rest live outside this repo.

| # | Surface | Owner / mechanism | Action |
|---|---|---|---|
| a | **This repo's registry** | PR to `src/models.ts` (the single switch, §1) | Edit the constants; keep `KNOWN_FAMILIES` + `extractPins()` contracts (§1); build/test/pin-audit; merge. Railway auto-deploys on merge. |
| b | **Railway env overrides** | Chat-side (operator + claude.ai session) | Flip `SYNTHESIS_BRIEF_MODEL`, `SYNTHESIS_DRAFT_MODEL`, `CC_DISPATCH_MODEL` to the new id. 2026-06-25 source fallback: all three defaults → `claude-opus-4-8`; live Railway env values are not read or changed by this repo. `SYNTHESIS_PDU_MODEL` held (§3). Gate: INS-244 / INS-245 (§5). |
| c | **Trigger daemon runtime config** | chezmoi-managed `~/.config/trigger/trigger.config.yaml` (INS-277) | Update the daemon's model setting in the chezmoi source, apply, then run the daemon's `rebuild-if-code` / kickstart path so running state picks it up. |
| d | **Operator local Claude Code setting** | Operator's machine | Update the local CC model preference (e.g. `claude config` / settings) so interactive local sessions match the fleet. |
| e | **Living-document references** | INS-307 per-line manifest — **only** | Do **not** mass-edit model mentions across PRISM living docs. The INS-307 manifest tracks model references per line; stale prose references are updated through normal doc maintenance, not a bump sweep. |

## 5. Gates for adopting a new model (server-call surfaces)

`SYNTHESIS_MODEL_ID` / `CC_DISPATCH_MODEL_ID` bumps are gated by
**INS-244 / INS-245** — OAuth-surface availability + cost — and stay
human-reviewed even when the freshness automation opens the PR:

- **Availability probe:** confirm the new model id (and its alias) return
  completions on the Max OAuth CC surface before flipping any
  `cc_subprocess`-routed call-site or the dispatch default. The 2026-06-25
  source fallback to Opus 4.8 uses official Anthropic availability and pricing
  evidence only; no Max OAuth probe, Railway env flip, merge, or production
  deploy is implied by the local source change.
- **Long-context probe (per call-site):** a call-site relying on a `[1m]`
  window (currently `pdu`) needs its own probe on the new model's
  long-context variant before its held env is touched.
- **Cost:** review the new model's pricing against synthesis + dispatch
  volume before adoption.

## 6. Current Fable rollback note

Claude Fable 5 references may remain in parser tests and historical examples
so old pins, stale provenance, and prior registry shapes continue to parse.
They must not be used as active registry defaults, Railway env targets, or
fresh model-bump destinations until a later target-specific reviewed plan
records new operator availability evidence.

## 7. Multi-provider routing activation

Multi-provider synthesis routing is separate from the Anthropic model bump SOP.
When `LLM_ROUTING_ENABLED=true` and `LLM_ROUTING_DRY_RUN=false`, synthesis
surfaces can invoke the configured non-Anthropic provider first, then fall back
to the existing Anthropic path if the provider fails or returns unusable text.
Dry-run mode still reports observations without changing execution.

Current guarantees:

- Existing `SYNTHESIS_*`, `RECOMMENDATION_MODEL_*`, and `CC_DISPATCH_*` env
  precedence remains available for Anthropic/Claude fallback behavior.
- `LLM_ROUTE_OBSERVATION` and `prism_status.llm_routing` must contain only
  provider names, model ids, transport names, auth env-var names, and routing
  status. They must not contain credential values or live provider payloads.
- Live synthesis adapters are implemented for OpenAI Responses, Gemini
  generateContent, xAI Responses, and OpenAI-compatible chat providers
  DeepSeek and Perplexity.
- `cc_dispatch` remains Claude Code OAuth execution. Non-Claude providers do
  not execute code dispatches unless a future runner subsystem is built.
- Provider keys, credential creation/rotation, billing/payment changes, active
  Claude.ai Project settings, Trigger behavior, CI behavior, and unrelated
  Railway variables remain outside this SOP unless a target-specific operator
  action says otherwise.

<!-- EOF: model-bump.md -->
