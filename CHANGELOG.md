# Changelog — PRISM MCP Server

All notable changes to the PRISM MCP server, plus the banner-contract and
framework-template history the server implements. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). The banner contract is owned
by `src/utils/banner.ts` (`BANNER_SPEC_VERSION`) plus the prism-framework
templates; [docs/banner-spec.md](docs/banner-spec.md) is historical reference.
Banner changes add an entry here.

## [4.14.11] - 2026-09-03 (brief-802: railway_create_project sends workspaceId, not legacy teamId)

### Fixed
- **`railway_create_project` failed with Railway GraphQL `Workspace not found`, even when `RAILWAY_WORKSPACE_ID` was verified correct** (dashboard "Copy Active Workspace ID" returned the same value the server held). Root cause: `src/railway/client.ts`'s `createProject` set `input.teamId = RAILWAY_WORKSPACE_ID` on the `projectCreate` mutation's `ProjectCreateInput`. Railway migrated teams to workspaces and `ProjectCreateInput` now takes `workspaceId` (the Railway CLI itself moved from `teamId` in 4.5.x to `workspaceId` in 4.57.x — `src/gql/mutations/strings/ProjectCreate.graphql` in the `railwayapp` crate). The list query in the same file already scoped reads with `projects(workspaceId:)`, which is why `railway_list_projects`/reads worked while creates failed. `createProject` now sets `input.workspaceId` instead; its doc comment updated to match.
- Tests: `tests/railway-lifecycle-tools.test.ts`'s `railway_create_project` happy-path test now sets a `RAILWAY_WORKSPACE_ID` fixture and asserts the captured `projectCreate` mutation input carries `workspaceId` equal to that fixture and no longer contains `teamId`.
- Scope: this one field (plus its comment and test) only — no other Railway mutation, the list query, env handling, or masking behavior changed.

## [4.14.10] - 2026-09-03 (brief-801: claude-fable-5-1 registered in MODEL_CAPABILITIES)

### Added
- **`claude-fable-5-1` in the model capability registry** (`src/models.ts`). Operator directive 2026-09-03 (porch-pop-collective S1 INS-1, corroborated by independent-appraisers-coalition-platform INS-1 via support.claude.com): Fable 5.1 in Claude Cowork/chat has a 1,000,000-token context window. `prism_bootstrap` called with `client_model: "claude-fable-5-1", client_surface: "chat"` previously fell back to the 200K `undocumented_floor` with a `CONTEXT_WINDOW_STALE` diagnostic; it now resolves to the operator-confirmed 1M figure. `chat` and `claude_code` are both `1_000_000` tokens under a new `operator_confirmed` provenance tag; `api` is copied verbatim from the existing `claude-fable-5` cell (1M, `documented`, unchanged `as_of`) rather than re-dated, since the API surface was not re-verified by this directive.
- **New `Provenance` value: `operator_confirmed`.** The registry's provenance enum (`documented | inferred | observed | undocumented_floor`) had no member for an operator-asserted, independently-corroborated window that lacks a citable per-model published statement — exactly this case. Staleness treats it like `documented` (180-day threshold), since it is a confirmed determination rather than a standing request for evidence.
- **Alias resolution confirmed, no normalizer changes needed.** `claude-fable-5-1`, `fable-5-1`, `Fable 5.1`, and `claude-fable-5.1` all already resolve to the `fable-5-1` registry key through the existing generic `normalizeModelKey` transform (prefix-strip, space/dot-to-dash, dedup) — no hardcoded alias table exists to extend.
- Tests: +9 (`tests/model-capabilities.test.ts`, `tests/bootstrap-context-window.test.ts`) covering the new cell's chat/claude_code/api resolution, all four aliases, and the absence of `CONTEXT_WINDOW_STALE` at the `prism_bootstrap` tool layer. Full suite: 2201 passed / 6 skipped / 0 failed (baseline 2192/6 at `f4cd043`).
- This is a registry addition only — the undocumented-floor fallback, the 30-day staleness rule, and every other model's numbers are unchanged. Companion framework-side change: brief-800 on `prism-framework` (separate repo, out of scope here).

## [4.14.9] - 2026-08-18 (banner color self-containment: chained fallbacks, no more undocumented namespace)

**Plan v3 (3-round gate, FOLDS addendum).** `src/utils/banner.ts` rendered
every banner color/radius through an undocumented `--color-*` /
`--border-radius-*` namespace that does not exist on the `visualize` host
today (probed directly via the host's own `read_me` contract capture, which
returns zero `--color-*`/`--border-radius-*` definitions). This release
widens every one of those expressions to a documented-token-first chained
fallback and fixes two live defects the probe surfaced along the way.

### Fixed
- **Radii rendered 0px, not 12px/6px, on the live host.** `--border-radius-lg`
  / `-md` had no fallback, so on any host lacking the legacy namespace the
  `border-radius` property fell back to its CSS initial value (0). The
  finalize card corner is now a bare `12px` literal (contract-cited, D7 --
  chaining it onto the documented `--radius` token, which is 8px, would have
  visibly shrunk the corner); chip/pill radii chain to `var(--radius,6px)`.
- **The boot masthead's alias block shadowed the host's real tokens.** It
  declared local custom properties named `--surface-1`, `--surface-2`,
  `--text-primary`, `--text-secondary`, `--border` and `--font-mono` --
  exactly the host's documented names. The five color aliases were declared
  as `var(--color-*, keyword)`, so inside `#prism-boot-masthead` they
  SHADOWED the host's working tokens with `transparent`/`currentColor`
  instead of reading them; `--font-mono` was declared as a hardcoded font
  stack, shadowing the host's documented `--font-mono` token outright. The
  un-shadowed `--font-mono` is a **visible live-host improvement**: the
  session-name box now uses the host's own monospace stack whenever the
  host supplies one, with the hardcoded stack demoted to the fallback
  position (D-Q7).

### Changed
- **Documented-token-first chained fallback everywhere** (89 edit sites: 60
  `var()` occurrences across the boot SVG/HTML/finalize surfaces, 2 sites
  whose token name was interpolated from a module constant, 27
  alias-consumption sites). Shape: `var(<documented>, var(<legacy>,
  <literal>))` -- on the real host the documented token resolves and the rest
  of the chain is inert; on a host supplying only the legacy namespace,
  behavior is unchanged; on a host supplying neither, a contract-sourced
  literal renders a legible, self-paired neutral/ramp-stop palette. See
  `docs/banner-spec.md` section 5.1 for the full 13-row token map.
- **The boot masthead alias block is renamed to a private `--pbm-*`
  namespace** (`--pbm-surface-1`, `--pbm-tint-ok`, `--pbm-font-mono`, etc.),
  ending the shadowing defect and making a self-reference cycle structurally
  impossible (the defined set and the host-namespace set are disjoint by
  construction).
- **`HTML_STATUS_TINT_VAR` -> `HTML_STATUS_TINT_EXPR`** and
  **`PHASE_COLOR_VAR` -> `PHASE_COLOR_EXPR`**: both module constants now hold
  full CSS color expressions (documented token -> legacy token -> literal)
  instead of a bare property name for the template's own `var(...)` wrapper
  to consume; the templates now interpolate the constant directly. Neither
  constant is exported, so the rename is internal.
- **`SVG_AT_BRIEF_720` re-captured and renamed `SVG_AT_4_14_9`**
  (`tests/brief-720-boot-masthead-html.test.ts`). Its "locks that guarantee
  for good" framing was retired -- a byte-exact pin cannot be both permanent
  and re-specifiable. It now locks the SVG against COLLATERAL drift and moves
  only on a deliberate, reviewed edit to `renderBootMastheadSvg`; exactly the
  four lines carrying a `--color-border-tertiary` / `--color-background-primary`
  var() chain differ from the prior capture.

### Not changed
- **`BANNER_SPEC_VERSION` stays "4.3" -- deliberately not bumped.** This is a
  styling-only change to the server's rendering implementation, not a
  contract change (`docs/banner-spec.md:286`, "Deliberately not versioned").
  A bump would fire `BANNER_DRIFT` on every boot and finalize until the
  framework templates catch up; because there is no bump, no diagnostic
  fires and the companion prism-framework update (below) can land
  independently, in either order. All 16 pre-existing `"4.3"` assertions
  across 9 test files are untouched.
- No markup restructuring, no class fights, no `@media` block added anywhere
  (dark mode in the normal case comes from the documented host token, which
  auto-adapts; the degraded no-token case uses mode-neutral literals by
  construction -- each pill pairs its own surface and text from the same ramp
  stop, so it is legible in either OS mode without a media query).

### Measured payload growth (four named fixtures, `Buffer.byteLength` utf8, vs the `0224a03c` HEAD baseline; bound was <= +25% per surface)
| fixture | HEAD bytes | 4.14.9 bytes | growth |
|---|---|---|---|
| boot masthead HTML | 7,464 | 7,782 | +4.26% |
| boot masthead SVG | 2,353 | 2,539 | +7.90% |
| finalize widget, minimum legal input | 3,100 | 3,734 | +20.45% |
| finalize widget, maximum legal input | 12,820 | 15,190 | +18.49% |

### Required follow-up (tracked, non-blocking)
- The prism-framework design of record (`_templates/finalization-banner-spec.md:88-103`)
  pins the legacy color namespace in its Design Tokens table and cites
  byte-exact markup. That table needs the same chained-fallback update and a
  re-capture of its markup pins; because `BANNER_SPEC_VERSION` did not bump,
  this can ship as a separate, independently-timed PR in that repo.

## [4.14.8] - 2026-08-17 (synthesis effort knob: SYNTHESIS_EFFORT global override)

**Plan v6 (5-round gate).** Adds a global, opt-in reasoning-effort override
for synthesis. Behavior-neutral when unset: every existing path (cc_subprocess
per-model default, messages_api thinking-branch default) stays byte-identical
to 4.14.7.

### Added
- **`SYNTHESIS_EFFORT` env knob** (`src/config.ts`, `resolveSynthesisEffort`):
  accepts `low|medium|high|xhigh|max` (case-insensitive, trimmed). Unset or
  empty resolves to `{ value: null, invalid: false }` (no override); an
  unrecognized value resolves to `{ value: null, invalid: true }` so callers
  fall back to their own per-path default. Resolved at call time (same
  pattern as `computeSynthesisThinkingEnabled`), no logger import (avoids the
  logger.ts TDZ cycle).
- **cc_subprocess consumer** (`src/ai/cc-subprocess.ts`): `synthesizeViaCcSubprocess`
  now resolves `SYNTHESIS_EFFORT` at call time and applies it in place of
  `ccSubprocessEffortForModel(model)` when set to a recognized value. The
  per-model function is now exported for reuse by the routing table. The
  applied effort is added to the `cc_subprocess synthesis complete` info log
  as `effort`.
- **messages_api thinking-branch consumer** (`src/ai/client.ts`): when
  `thinking` is true, `output_config.effort` now carries the
  `SYNTHESIS_EFFORT` override when set, else the existing `"max"` default.
  The applied effort is added to the `Synthesis API call complete` info log
  as `effort` (`null` when thinking was off, since no `output_config` was
  sent).
- **Routing table effort column** (`src/llm/route-table.ts`): `RoutingTableRow`
  gains an optional `effort` field, populated only for the three
  anthropic-serving synthesis rows (never for live non-anthropic rows,
  `cc_dispatch`, or `recommendation` -- `cc_dispatch` is governed by
  `CC_DISPATCH_EFFORT`, not this knob). The column shows only what the next
  call will actually send: a messages_api synthesis row whose call-site
  thinking resolves off omits `effort` entirely (that leg sends no
  `output_config`; draft thinking is hardcoded on at the finalize call
  site). An invalid `SYNTHESIS_EFFORT` emits exactly one `logger.warn` per
  table build before the rows are returned.

### Changed
- **`docs/model-bump.md`**: the section 4 row b `SYNTHESIS_PDU_MODEL` hold is
  recorded as RELEASED by the 2026-08-17 operator synthesis Sonnet 5 OAuth
  speed-flip directive (plan v6); the section 3 tail is annotated to match.
  Prior hold language is kept for history, not deleted.
- **`.env.example`**: the "INTENDED PRODUCTION CONFIG" block is realigned to
  the new intended config -- all three synthesis lanes on `claude-sonnet-5`
  via `cc_subprocess` at effort `high`, zero metered API spend (OAuth
  billing), thinking on for brief/PDU. A new commented `SYNTHESIS_EFFORT`
  example line is added. The file still contains the SRV-95-pinned literal
  substrings `SYNTHESIS_BRIEF_TRANSPORT`, `SYNTHESIS_BRIEF_THINKING=true`,
  and `SYNTHESIS_PDU_THINKING=true`.
- **`CLAUDE.md`**: server version bumped 4.14.7 -> 4.14.8 (both the metadata
  line and the architecture-banner line); new `SYNTHESIS_EFFORT` row added to
  the environment-variables table.

## [4.14.7] - 2026-08-17 (S210 seat: T9c docstring reconciliation -- comment-only)

### Changed
- **Comment-only**: the appendTruncationProvenanceFooter docstring (src/ai/synthesize.ts) claimed "No truncated inputs -> the content is returned unchanged (no footer)"; inexact post-#128 because the untruncated branch strips a stale/model-echoed footer line (test-pinned). Docstring now states the strip. Recorded as residual 3 in the served-by-footer implementation review packet and in the prism baselines followup. Zero behavior change; no source logic touched.

## [4.14.6] - 2026-08-17 (S209: synthesize guidance refresh + T9c docstring reconciliation -- v3.4 ruling)

**Plan v3.4 Change B.** `prism_synthesize`'s background-dispatch
`status_hint` still asserted Haiku-era durations as current ("brief ~1-2
min, pending-doc-updates up to ~8 min") -- stale by roughly two orders of
magnitude on the speed-tier lane, and wrong in the other direction if a lane
reverts to anthropic. Also reconciles the T9c docstring's placement
sentences and normalizes the CHANGELOG dates. An earlier draft of this PR
also attempted header duplicate-strip parity; two independent implementation
reviews of PR #129 found the fix unsafe and it was descoped (see below).

### Changed
- **`status_hint` (`src/tools/synthesize.ts`):** no longer asserts any
  duration as universal or current. Neutral, self-contained wording:
  duration varies with the routed synthesis provider/model, so no fixed
  estimate is given. Retains the `mode=status` completion-check instruction
  unchanged. Carries no concrete numbers and no cross-repo pointer -- an
  earlier draft pointed at the prism repo's performance-baselines doc, but
  both PR #129 implementation reviews found that pointer unactionable for a
  generic MCP consumer and a leak of operator-local repo layout, so it is
  dropped.
- **Historical header comment (`src/tools/synthesize.ts`, S172
  fire-and-forget rationale):** gains a "(Haiku-era measurement)"
  clarifier; no longer claims the baselines doc carries "current per-model
  bands" (its speed-tier rows are still `pending_measurement`) -- points at
  it as the measurement ledger for the figure instead.

### Fixed
- **T9c docstring (`appendTruncationProvenanceFooter`, comment-only).**
  4.14.5 appended a served-by placement note without amending the original
  "immediately above the EOF sentinel" sentence, leaving two claims that
  read as contradictory when both a T9c footer and a served-by line stamp.
  Tightened into one consistent claim: the T9c footer sits immediately above
  the EOF sentinel only when no served-by line also stamps that run. The
  format example's trim arrow, briefly ASCII-ified to "->" in an earlier
  draft of this PR, is restored to the real arrow character matching the
  emitted, test-pinned format.
- **CHANGELOG.md date normalization.** The 4.14.5 entry above was dated
  2026-08-16 (local) while 4.14.4 below it was dated 2026-08-17 (UTC spill),
  so the file read non-monotonically. Normalized 4.14.5 to 2026-08-17.

### Descoped
- **Header duplicate-strip parity** (`enforceLastSynthesizedHeader`,
  `enforceProvenanceHeader` in `src/ai/synthesize.ts`) was attempted in an
  earlier draft of this PR and reverted. Both PR #129 implementation reviews
  verified the strip-all-then-reinsert shape relocates the canonical line in
  the normal every-run case (splitting the PDU's prescribed contiguous
  blockquote and desynchronizing from apply-pdu's
  `buildResidualPduDocument`) and accumulates one blank line per run
  (idempotence loss, probe-verified both ways); the review-prescribed
  replace-first + strip-rest alternative was then shown to delete
  header-formatted lines legitimately inside fenced PDU proposal bodies (an
  `^`-anchored global strip has no fence awareness). The header
  duplicate-echo defect has never been observed live, and the prompts
  prescribe exactly one header line; a speculative fix whose blast radius
  exceeds its observed benefit does not ship. Both helpers are reverted to
  their pre-PR-128 main behavior (replace-first-in-place), byte-identical;
  the two duplicate-stale header tests this PR had added are removed. The
  residual defect class is recorded as a watch item -- a fix, if ever
  needed, requires its own design (e.g. fence-aware or region-bounded
  stripping).

### Tests
- Regression pin (`tests/synthesize.test.ts`): `status_hint` must NOT match
  `/~?\d+(-\d+)?\s*min/` and MUST still contain `mode=status`.

## [4.14.5] - 2026-08-17 (S209: served-by provider/model/transport stamp on synthesis artifacts)

**Baselines followup `served-by-footer`, registered in
`docs/prisma-performance-baselines.json`.** Synthesis artifacts
(intelligence-brief.md, pending-doc-updates.md) stamped their INPUTS (T9
manifest, T9c truncation footer) and a human-friendly model display line
(SRV-89), but never the serving provider/model/transport -- so the
per-(model,transport) rows in the baselines file could not be verified from
the committed artifacts themselves.

### Added
- **`appendServedByFooter()`** (`src/ai/synthesize.ts`): server-stamped
  `> Served by: {provider}/{model} via {transport}` line, same
  deterministic-stamp family as `enforceLastSynthesizedHeader` /
  `enforceProvenanceHeader` / `appendTruncationProvenanceFooter`. Degrades to
  `> Served by: {provider}/{model}` (no transport clause) on the rare
  success that somehow lacks a transport; strips any stale line and stamps
  nothing when provider or model is unknown (never a half claim). Called
  immediately after the T9c truncation footer at both stamp sites --
  intelligence-brief.md and pending-doc-updates.md -- landing between the
  T9c footer and the EOF sentinel when both stamp. NOT called on the draft
  lane (it composes canonical .prism docs the server must not decorate).
- **`SynthesisResult.provider`** (`src/ai/client.ts`): the serving provider
  label, set by `synthesize()`'s success re-wrap from the SAME
  `providerForTransport()` call the LLM_CALL telemetry line already uses --
  so the served-by stamp and the telemetry line can never disagree. The
  re-wrap sets ONLY `provider`; `transport` is untouched, and the legacy
  no-callSite contract (`result.transport` undefined) is unchanged.

### Behavior change
- **pending-doc-updates.md gains its first model-attribution line.** The PDU
  artifact has never carried `enforceProvenanceHeader`, so the served-by
  line is the first place a pushed PDU states which model produced it.
  Intended and desirable.

### Tests
- Unit pins for `appendServedByFooter` (`tests/synthesis-output-guards.test.ts`):
  fresh stamp, replace-stale, strip-when-provider-unknown,
  strip-when-model-unknown, transport-less degraded shape, placement above
  the EOF sentinel (with the no-sentinel edge), and coexistence/line-order
  with the T9c truncation footer.
- Pipeline pins (`tests/synthesis-input-budget.test.ts`): the pushed content
  of both `generateIntelligenceBrief` and `generatePendingDocUpdates` is
  asserted to carry the exact served-by line, including the T9c-coexistence
  case on oversized-input fixtures.
- Mutation-criterion pins on the `synthesize()` success re-wrap
  (`src/ai/__tests__/client-routing.test.ts`,
  `src/ai/__tests__/client-openrouter.test.ts`): fail if the re-wrap
  assignment is deleted.

## [4.14.4] - 2026-08-17 (S208: cerebras mechanical-cost tier + SRV-90 package-lock pin -- PR #126 activation-gate follow-ups)

**The two prescribed follow-ups from the PR #126 review, closed before
cerebras is eligible for the allow-list.** Neither changes routing
selection or authorization -- both are truth-in-labeling and drift-guard
fixes.

### Changed
- **`qualityTierFor()` now labels `cerebras` explicitly** (`src/llm/routing-policy.ts`):
  a new `provider === "cerebras"` row returns `"mechanical-cost"`, the same
  D-275 precedent already applied to `openrouter`/GLM-5.2. Before this fix
  a cerebras decision fell through to the surface-based default (`"frontier"`
  for most surfaces), mislabeling a ~$0.6/$2.2-per-M-token `zai-glm-4.7`
  route as a frontier-tier one in cost-tier analytics and the
  `LLM_ROUTE_OBSERVATION` telemetry record. Pinned by a direct unit test
  (`src/llm/__tests__/routing-policy.test.ts`) and a route-observer
  telemetry-record test (`src/llm/__tests__/route-observer.test.ts`,
  new -- no prior dedicated route-observer test existed for the openrouter
  case either, so this adds the direct pin rather than parallel
  dispatch-level telemetry-capture machinery).

### Added
- **SRV-90 package-lock drift guard** (`tests/brief-466-docs-version.test.ts`):
  a new assertion that `package-lock.json`'s `version` (both the root field
  and `packages[""].version`) equals `SERVER_VERSION`. Closes the drift
  class that recurred twice already (stale at 4.12.0, then again at 4.14.1,
  #125) by making the next recurrence a test failure instead of an
  operator-packet cleanup item.

### Fixed
- **`package-lock.json` version fields** re-synced to `4.14.4` via
  `npm install --package-lock-only` (dependency tree untouched, verified by
  diff -- only the two version fields moved).

## [4.14.3] - 2026-08-16 (S208: register Cerebras as an LLM routing provider)

**A registration, not an activation.** Cerebras joins the provider registry
as a seventh routable synthesis provider on its OpenAI-compatible chat
endpoint. Nothing about routing behavior changes with this release: no
surface selects `cerebras`, and `cerebras` is absent from
`LLM_ROUTING_ALLOWED_PROVIDERS`, so the same double gate that keeps
`deepseek` and `perplexity` dormant keeps `cerebras` dormant. Activation is
a separate operator env action -- see the gates below.

Model catalog is ground truth, not a guess: the operator's Cerebras account
was queried live against `https://api.cerebras.ai/v1/models` on 2026-08-16
and serves exactly three models -- `zai-glm-4.7`, `gpt-oss-120b`, and
`gemma-4-31b`. The registry default is `zai-glm-4.7`: the estate's synthesis
lanes already run GLM-class models via OpenRouter per D-275, and Cerebras
serves that family natively at high throughput. The other two are reachable
via `LLM_ROUTING_CEREBRAS_MODEL` with no code change.

### Added
- **`cerebras` provider row** (`src/llm/provider-registry.ts`,
  `src/llm/route-types.ts`). `CEREBRAS_API_KEY` /
  `LLM_ROUTING_CEREBRAS_MODEL`, default `zai-glm-4.7`, transport
  `openai_compatible_chat`, `active_when_configured`, the four routable
  synthesis surfaces (never `cc_dispatch`), `quality-before-cost`.
- **Cerebras base URL** in the OpenAI-compatible chat adapter
  (`src/llm/provider-adapters.ts`): `https://api.cerebras.ai/v1/chat/completions`.
  The OpenRouter-only request extensions (`usage.include`,
  `provider.data_collection`, `reasoning`) stay OpenRouter-only.
- **`LLM_ROUTING_CEREBRAS_MODEL`** in the sanitized readiness inventory
  (`src/llm/route-status.ts`), so `prism_*` route status names the knob
  without ever printing a value.
- **Price rows** for all three Cerebras models (`src/llm/pricing.ts`) so a
  served cerebras call can never log `est_cost_usd: null`. These are
  UNVERIFIED conservative midpoints in the same list-price class as the
  S203 F-G-A11 rows -- round on purpose, not vendor-console-confirmed.
  Re-derive before any budget decision.
- **Gating proof tests** (`src/llm/__tests__/routing-policy.test.ts`): with
  `CEREBRAS_API_KEY` present, routing enabled, and dry-run off, no surface
  selects cerebras; naming cerebras without allow-listing it yields
  `provider-not-allowed` with `liveInvocationAllowed: false`; `cc_dispatch`
  stays on Claude Code even when cerebras is both allowed and requested.
  Plus registry-shape, adapter-URL, readiness, and pricing tests.

### Operator activation (all five required, none of them shipped here)
`LLM_ROUTING_ENABLED=true`, `LLM_ROUTING_DRY_RUN=false`, a
`LLM_ROUTING_*_PROVIDER` naming `cerebras`, `cerebras` added to
`LLM_ROUTING_ALLOWED_PROVIDERS`, and `CEREBRAS_API_KEY` set. Kill-switch:
remove `cerebras` from `LLM_ROUTING_ALLOWED_PROVIDERS` (env-only, no deploy).

## [4.14.2] - 2026-08-16 (S208 PR-S2c: BOOT_INDEX_MODE default → compact, soak-gated merge)

**The D-278 two-phase completion.** Phase one (4.13.0, S202) shipped
`session_state_manifest` ADDITIVELY, alongside the legacy
`standing_rules_index`, with `BOOT_INDEX_MODE=full` as the safe default and
`compact` as an opt-in. Phase two — this release — flips that default:
`compact` now ships on every boot that doesn't set the env var, dropping the
legacy `standing_rules_index` field entirely. `session_state_manifest.rules`
was always a complete replacement (same rules, same topics, same
reachability — brief-s202b round-trip fidelity, re-pinned by the T1 test
matrix); the flip stops shipping the duplicate.

Measured with `scripts/measure-boot-payload.mjs` against the live prism
corpus, same harness, same frozen clock, default env on both sides:

```
97,361 B → 76,429 B   (−20,932 B, −21.5%)
  standing_rules_index   20,908 B → (absent)
```

No other field moved — `session_state_manifest` (11,830 B),
`boot_masthead_html` (7,692 B), and every other section are byte-identical to
4.14.1. At roughly 3.5 bytes/token this is ≈ −5,974 tokens off every default
boot fleet-wide, with zero information loss: everything the legacy index
carried is still reachable, just from `session_state_manifest.rules.index`
instead of a second copy of it.

### Changed
- **`resolveBootIndexMode` default flips `full` → `compact`** (`src/config.ts`).
  An unset or unrecognized `BOOT_INDEX_MODE` now resolves to `compact`;
  `BOOT_INDEX_MODE=full` is the env-only rollback, unchanged in behavior and
  still fully tested (`tests/brief-s202b-boot-lean.test.ts`,
  `tests/bootstrap-rich-payload.test.ts`). No deploy is required to roll
  back — flip the env var and the next boot reverts.
- Boot-payload-shape test pins across `tests/brief-s202b-boot-lean.test.ts`,
  `tests/bootstrap-budget.test.ts`, `tests/bootstrap-payload-diet.test.ts`,
  `tests/bootstrap-context-window.test.ts`, and
  `tests/bootstrap-rich-payload.test.ts` updated to match: under default env
  the legacy `standing_rules_index` is now asserted ABSENT (not merely
  empty), with `session_state_manifest.rules.index` as the reachable
  surface; tests that pin the legacy field's exact shape now set
  `BOOT_INDEX_MODE=full` explicitly, since that shape is the rollback path,
  not the default.

### Merge gate (soak-gated, D-278/CLAUDE.md:96)
This PR is opened, reviewed, and CI-gated in the normal way, but **merge is
held on one post-4.14.1 (S2b) boot observation** — the payload-contract
release immediately prior in this chain — before this default flip lands on
top of it. The R35 kernel consumption path (`prism-framework`
`core-template-mcp.md`) is already fleet-live and shape-agnostic for the
compact manifest, so the gate here is operational confidence in 4.14.1's
delivered shape, not a framework dependency. The orchestrator holds the
merge decision; this PR does not self-merge.

### Rollback
Set `BOOT_INDEX_MODE=full` (env-only, no deploy) to restore the legacy
`standing_rules_index` field on every boot. No code change is required in
either direction.

## [4.14.1] - 2026-08-16 (S208 PR-S2b: payload contract — single masthead + compact manifest)

**This release deliberately changes delivered bootstrap bytes.** Every other
release in the S208 server chain (4.13.1, 4.13.2, 4.14.0) was byte-identical by
design and proved so with `scripts/measure-boot-payload.mjs`. This one is the
payload change the chain was clearing the way for: **103,690 B → 97,362 B on
the measured prism corpus (−6,328 B, −6.1%)**, attributed exactly as
`boot_masthead_svg` −2,721 B and `session_state_manifest` −3,605 B. Same
harness, same frozen clock, same corpus; the two reports differ only where
this release intends them to. `BANNER_SPEC_VERSION` is unchanged (4.3) — no
banner grammar moved.

### Added
- **`BOOT_MASTHEAD` (`html` | `svg` | `off`, default `html`)** (S208 MCP-6).
  Exactly ONE graphical masthead is populated per boot; the other field ships
  `null`, and `off` ships both null with `banner_text` as the render surface.
  brief-720 added `boot_masthead_html` ALONGSIDE `boot_masthead_svg` so older
  consumers saw no change, and both have rendered on every boot since — while
  the session renders one, because the kernel has always said "render
  whichever" (Rule 1). The loser was 2,721 measured bytes no client read.
  Resolved from `process.env` per call, so the flip and its rollback are
  env-only with no deploy.
  **Precedence** (two variables now overlap, so it is stated in the config
  docblock, `CLAUDE.md`, and `docs/banner-spec.md` §2.1): a recognized
  `BOOT_MASTHEAD` wins outright in both directions; unset, empty, OR an
  unrecognized value falls through to the legacy `BOOT_MASTHEAD_SVG`
  (`off`/`false`/`0`/`no` → `off`, anything else → `html`). A deployment that
  set `BOOT_MASTHEAD_SVG=off` therefore stays off across this upgrade with no
  operator action, and a typo in the new variable can never silently
  re-enable a masthead an operator turned off.
- **`session_state_manifest.rules.topic_names`** (S208 GAP-5) — a deduplicated
  dictionary of every indexed topic string, built in first-seen order so the
  payload stays deterministic. Rows now carry `topics` as INDICES into it. As
  of prism 7bb470e7, the live prism registry repeats 117 distinct topic
  strings across 260 row-slots.
- **`tests/s208-pr-s2b-payload-contract.test.ts`** (22 tests) — the resolver
  matrix plus the two PINNED gates the plan names: SIZE (the serialized rule
  index at a live-shaped 103-rule registry fixture) and PARITY (id-set
  equality pre/post compaction with `id`/tier/topics resolvable for every
  single rule, including the defaulted-tier rows). Parity is the gate that
  matters: compaction that loses a rule, a tier, or a topic is a regression no
  byte count would catch.

### Changed
- **Manifest rule rows are compacted** (S208 GAP-5): `title60` → `title40`
  (`truncateTitle60` → `truncateTitle40`), inline topic strings → indices into
  `topic_names`, and the tier tag `t` is emitted ONLY for Tier-C rows — the
  index is B ∪ C, so B is the default and naming it on ~85% of rows was pure
  repetition. Measured on the live registry (as of prism 7bb470e7: 115 rules,
  106 indexed — 90 B + 16 C): **14,685 B → 9,740 B**. The 60-char cap barely
  bit (mean live title: 119 chars); 40 is enough to recognize a rule you know
  and decide whether to fetch one you do not, which is the whole job of an
  index row.
  **No template coupling.** The framework kernel's R35 consumption text is
  shape-agnostic by construction (`prism-framework` `core-template-mcp.md`,
  merged 2ad598d: topics are "inline strings or indices into
  `rules.topic_names`"), which is the hard gate this PR was held behind.
- **Stale measurements corrected in place.** The S202-era config comment
  claimed a "compact manifest index ≈ 4.5KB" and `CLAUDE.md` claimed
  `BOOT_INDEX_MODE=compact` saves "≈ −15.4KB"; both were taken against a much
  smaller registry. Re-measured at S208 against the live corpus: legacy
  `standing_rules_index` is 20,908 B, so the `compact` flip is ≈ −20.9KB.

### Deviation from plan v6 (recorded)
The plan pinned the size gate at **≤ 6,000 B at 103 rules**; this ships it at
**≤ 11,000 B** (measured 10,376 B), paired with a relative gate of **≤ 80% of
the pre-compaction shape** (measured 73.7%). 6,000 B is unreachable under the
row shape the same plan mandates: 6,000 / 103 = 58 B per row, and a capped
title (53 B) plus an `id` (15 B) already exceed that before `topics`, braces,
or separators. The 6,000 figure descends from the stale "≈ 4.5KB" note
corrected above. The shipped ceiling is derived from the arithmetic floor of
the mandated shape (~87 B/row × 103 + a ~1.2KB dictionary), not tuned to pass.

## [4.14.0] - 2026-08-16 (S208 PR-S3: gated auth hardening + ops truth-up)

Nothing about request handling changes on deploy. The one code change ships
behind a knob that defaults OFF, so 4.14.0 answers every request exactly as
4.13.2 did until an operator flips it. `BANNER_SPEC_VERSION` is unchanged (4.3).

### Added
- **`AUTH_REQUIRE_BEARER` (default `false`)** (S203 audit R20). `authMiddleware`
  rejected a WRONG Bearer token but never noticed a request carrying NO
  `Authorization` header at all - that case skipped the token check and fell
  through to the IP allowlist. So a configured `MCP_AUTH_TOKEN` was not
  actually required of any caller inside the allowlisted CIDR, and the token's
  real strength was the allowlist's. With the knob ON and a token configured, a
  missing or non-Bearer `Authorization` header is `401` before the IP check
  runs. `/health` stays exempt in both modes (Railway's probe sends no
  credential) and a wrong token keeps its existing `403`. Resolved from
  `process.env` per call (the `resolveBootIndexMode` pattern), so both the flip
  and its rollback are env-only with no deploy; any value other than
  `true`/`1`/`yes`/`on` is the default, because a typo must never silently
  harden auth.
  **Shipped OFF deliberately:** the live connector's auth posture is UNKNOWN,
  and hardening blind would lock out a client that authenticates by source IP
  today. The flip is an operator action taken after confirming the live client
  sends Bearer.
- **`tests/auth-middleware.test.ts`** - the auth middleware had no test file at
  all. 22 tests pin BOTH gate states: the gate-OFF cases pass against the
  unmodified 4.13.2 middleware (that is what makes "default is byte-identical"
  a checked claim rather than an assertion), and the gate-ON cases cover the
  new 401 path, the untouched 403 path, the `/health` exemption, and the
  no-token-configured case where there is nothing to require.

### Changed
- **Backfilled the missing `4.13.0` CHANGELOG entry** (OPS-4). The file jumped
  4.12.0 -> 4.13.1, so every PR merged under version 4.13.0 - #109 through
  #119, including the entire S202 boot-lean bundle, `boot_masthead_html`, the
  model-capability registry and the brief-s205a S203 audit-rec bundle - had no
  release note. `/health` reports a version; a changelog that skips it cannot
  answer what that version contains. Backfilled from the merge commits, dated
  by the merge range rather than guessed.
- **`docs/banner-spec.md` aligned with the shipped renderer** (S208 PR-S1 fold).
  The doc still described `decisionCount`/`docCount` as plain numbers and the
  boot L2 docs label as always `docs healthy`, which 4.13.1 stopped being true:
  an unverified count now renders `? decisions (unverified[; {note}])` and
  `?/{T} docs (unverified)`. Reference docs that describe a renderer they no
  longer match are how the next reader gets misled.

### Not done here (stated residual)
- **`X-Forwarded-For` trust is unchanged.** `getClientIp` still takes the
  leftmost XFF value verbatim, so while `AUTH_REQUIRE_BEARER` is off a forged
  header naming an allowlisted address is served - pinned as a test rather than
  fixed. The repair (Express `trust proxy`, or counting hops from the right)
  needs a decision about the live Railway topology that this release does not
  make. Turning the knob on closes the bypass without touching XFF at all,
  because the 401 lands before the IP check.

## [4.13.2] - 2026-08-16 (S208 PR-S2a: boot + load latency, payload-byte-identical)

Latency and robustness only. The DELIVERED `prism_bootstrap` payload is
byte-identical to 4.13.1 - proven per-release by `scripts/measure-boot-payload.mjs`,
which replays a full simulated boot against the live prism `.prism/` corpus and
reports the total payload bytes plus per-field attribution. `BANNER_SPEC_VERSION`
is unchanged (4.3).

### Added
- **Sha/ETag-conditional rule-source cache** (MCP-1). `standing-rules.md`,
  `insights.md` and `standing-rules-archive.md` are the heaviest documents PRISM
  reads - prism's registry alone is ~320KB - and both `prism_bootstrap` and
  `prism_load_rules` re-downloaded them in full on every single call. They now
  resolve through `resolveRuleSourceDoc()`, which sends `If-None-Match` with the
  cached ETag: an unchanged document answers 304 with no body and without
  consuming rate-limit budget. A cache hit still round-trips, so the content
  served is exactly what an unconditional fetch would have returned - the cache
  can never serve an unvalidated body. Bounded by TTL and size like every other
  house cache (`src/utils/cache.ts`).
- **Sha-keyed standing-rule parse cache** (MCP-1, `unionStandingRulesCached`).
  Keyed on `(repo, registry sha, insights sha)`, shared by both consumers.
  Keying on content shas is what makes it safe: a changed document is a changed
  sha is a different key, so a stale parse is unreachable rather than unlikely.
- **`LOAD_RULES_WALL_CLOCK_DEADLINE_MS`** (MCP-2, default `MCP_SAFE_TIMEOUT`).
  `prism_load_rules` was fanning out to the two largest documents in the system
  with no tool-level backstop; a stalled fetch held the client to the ~60s
  transport timeout with nothing structured to show. Same sentinel/race shape as
  `prism_push`, timer cleared in `finally`.
- **Archive body resolution for pointer stubs** (net-new, inert today). A
  registry entry whose entire body is `Body: standing-rules-archive.md` is a
  STUB: its id/title/tier/topics stay in the registry while the body lives in
  the archive. Both consumers splice the real body back in - bootstrap for the
  Tier A rules it actually delivers, `prism_load_rules` for matched rules - and
  the archive is read ONLY when a stub is present, which is never until the
  body moves land. Unresolvable stubs surface a diagnostic instead of silently
  shipping the pointer.
- **`SYNTHESIS_OBSERVATION_TIMEOUT` diagnostic** when the boot-time Railway
  observation read is abandoned (see below).

### Changed
- **Wave-3 boot reads launch at slug-resolution time** (MCP-8). The
  intelligence-brief / insights / pending-doc-updates / standing-rules fan-out
  depends on nothing but the project slug, yet it waited for the core fetch,
  the boot-test push and the prefetch wave to finish first. It now starts
  immediately and is awaited exactly where it always was. Pure reordering: same
  reads, same results, same payload.
- **Boot-test path is cached per repo** (MCP-16). The boot-test write cost four
  serial GitHub round trips - two existence probes, a sha read and a PUT - to
  write ~140 bytes on the critical boot path. Where the doc lives is a property
  of the repo, not the session, so the resolved path is cached (60 min / 100
  repos) and the chain collapses to sha-read + PUT for repos already on the
  canonical `.prism/` layout. Only a canonical resolution is ever cached - a
  legacy-root resolution always re-probes on the next boot, since a push to
  the legacy root keeps succeeding right up until the repo migrates and a
  failed-push invalidation alone would never fire to unstick it. A repo that
  migrates picks up the canonical path (and starts caching) on its first
  post-migration boot instead of latching onto the stale root path forever.
- **The boot-time Railway observation read is bounded at 2.5s** (MCP-17) by a
  CALL-SITE `Promise.race` in `checkSynthesisObservation`. The timer is
  `unref()`d and cleared in `finally`, and the loser's rejection is swallowed.
  Deliberately at the call site, not in `src/railway/client.ts`: every other
  Railway caller is an explicit operator tool where a long read is correct;
  only this one is a best-effort boot extra that was charging the operator
  latency for an optional diagnostic.
- **`GITHUB_RETRY_BUDGET_MS` now bounds TOTAL elapsed attempt time** (MCP-14),
  not just the backoff sleeps. Previously only the SLEEP was budget-checked, so
  a chain of slow-but-not-timed-out attempts could overrun the budget by
  multiples. Now no retry starts once the budget is spent and each retry's
  per-request timeout is clamped to what remains. The FIRST attempt keeps the
  full per-request timeout, so single-attempt calls are unchanged.
- **`KNOWN_PRISM_PATHS` covers the post-D-18 living docs** (MCP-15 / KI-28):
  `audit-trail.md`, `pending-doc-updates.md`, `audit-harness.md`,
  `standing-rules-archive.md`, `pending-doc-updates-archive.md`. A bare-name
  `prism_push` of any of these wrote a ROOT-LEVEL DUPLICATE while the canonical
  `.prism/` copy went stale - observed live at S179 with a 6,259 B root
  `audit-trail.md`. `prism_patch`/`prism_fetch` already resolved them, so the
  divergence was `prism_push`'s alone; this also widens `prism_fetch`'s SRV-17
  allowlist to match.
- `MemoryCache` takes a `maxEntries` bound (default 200) alongside its TTL.

## [4.13.1] - 2026-08-16 (S208 PR-S1: finalize + banner reliability)

Banner-contract behavior changes; `BANNER_SPEC_VERSION` stays 4.3 (the grammar
is unchanged - only which values the server is willing to assert).

### Added
- **Banner fields on every `prism_bootstrap` exit** (MCP-3). The ambiguous-slug
  rejection, the hard-error catch, and the wall-clock deadline shipped NO
  banner field at all, so the session's first response could not satisfy the
  template's render contract. New `assembleBootErrorBannerFields()` (the boot
  mirror of `assembleFinalizeErrorBannerFields`) supplies `banner_text`,
  `banner_spec_version`, and null mastheads. Pre-resolution exits emit no
  session-name fence - the template omits the chat title rather than naming
  the session wrongly.
- **`FINALIZE_AUDIT_DEADLINE_EXCEEDED` + a bounded `action=audit`** (MCP-1c).
  The standalone audit was the last finalize action with no deadline: a hung
  ten-doc fan-out held the client to the ~60s transport timeout with no
  structured error. Bounded at `FINALIZE_AUDIT_ACTION_DEADLINE_MS`
  (`MCP_SAFE_TIMEOUT` by default, `FINALIZE_AUDIT_DEADLINE_MS` to override);
  expiry returns collected diagnostics plus error-banner fields with a null
  handoff version.
- **A 120s anti-hang bound on `action=full`'s internal audit** (MCP-1d),
  `FINALIZE_FULL_AUDIT_DEADLINE_MS`. Expiry degrades FAIL-CLOSED: every living
  document counts unverified, so the INS-360 recreate guard drops file-shaped
  draft keys (`FINALIZE_RECREATE_BLOCKED`). The brief-456 bridged keys
  (`session_log_entry`, `task_queue_*`) do not consult that set and still
  commit - that loss is the entire degradation, and it is regression-pinned.
  No draft cap was added to `action=full`.
- **`FINALIZE_MISSING_SESSION_LOG` warn diagnostic** (GAP-9) when the committed
  set carries `handoff.md` but no `session-log.md`, surfaced in the banner's
  own warning block as well as in `diagnostics`.
- **`BANNER_RENDER_FAILED` / `MASTHEAD_RENDER_FAILED` diagnostics** (MCP-19)
  replacing log-only catches on the finalization widget, the finalization text
  banner, and both boot mastheads. A null widget field is no longer
  indistinguishable from the knob being off.
- **`FINALIZE_BANNER=html|off` knob** (OPS-2), the finalize mirror of
  `BOOT_MASTHEAD_SVG`. `off` ships `finalization_banner_html: null`;
  `banner_text` is deliberately unaffected - it is the genuine fallback.
- **`decision_count` on the `action=audit` response** - the count the drift
  detector already computed, never the index content. A response byte-size
  assertion guards the standalone audit against payload growth.
- **`BANNER_DECISIONS_UNVERIFIED` warn diagnostic** when the finalization
  banner's decision-index read loses its race.

### Changed
- **The finalization banner is now network-safe** (MCP-2). Decision-count
  precedence is `files[]` entry -> the audit's already-computed count (on
  `action=full`) -> a 3s `Promise.race` against the repo read
  (`BANNER_DECISIONS_RACE_MS`) -> `(unverified)`. The banner is assembled
  AFTER the atomic commit, so the previous un-raced `resolveDocPath` held a
  completed finalization hostage to a slow read; the losing promise is
  `.catch()`-swallowed and the timer is `unref`'d and cleared in a `finally`.
- **`decisionCount` widened to `number | null`** in `UnifiedBannerInput` and
  `FinalizationBannerHtmlInput`; all four interpolation sites render
  `? decisions (unverified)` instead of a confident `0 decisions`.
- **The boot docs count is measured, not asserted** (MCP-13). `docCount` was
  hardcoded to `LIVING_DOCUMENTS.length`, so every boot claimed
  `10/10 docs healthy` while the fan-out reads only a handful of the ten. It
  is now derived from the boot's own probes and renders `?/10 docs
  (unverified)` unless all ten were probed. `docCount` widened to
  `number | null` in `UnifiedBannerInput` accordingly.
- **`renderBannerFallback` accepts a null session number / handoff version**,
  rendering `Session ?` / `Handoff v?`. The seven
  `assembleFinalizeErrorBannerFields` call sites that defaulted
  `handoff_version ?? 1` now pass `?? null` - no more fabricated "Handoff v1"
  on an error exit.
- **`widget_channel:` Critical Context items are exempt** from the 5-item
  compose gate and from handoff condensation. The flag is a machine signal the
  boot kernel keys on, not one of the five substantive facts the cap rations,
  and it is set exactly when condensing it away costs the next boot a
  multi-minute hang. Effective cap: 5 + flag.
- **`action=full`'s tool description and the `FINALIZE_DRAFT_ACTION_DEADLINE_MS`
  comment corrected** (MCP-1a/b). Both claimed the background race "is not
  bounded by a client turn"; the real distinction is the CALLER - `action=full`
  is intended for the Trigger / Claude Code path, and the action enum cannot
  structurally prevent a chat client from calling it (stated residual).

## [4.13.0] - 2026-07-14 .. 2026-08-14 (S202 boot-lean, S9 masthead, S5 model registry, S205 audit recs)

> **Backfilled 2026-08-16 by S208 PR-S3 (OPS-4).** This entry did not exist:
> the file ran 4.12.0 straight to 4.13.1 while eleven PRs shipped under
> version 4.13.0. It is reconstructed from the merge commits in the 4.13.0
> window (`b956f7c` set the version, `f1adb3e` moved off it), so the scope is
> the version's real contents rather than one session's memory of them. It is a
> release-level summary, not a re-derivation of each PR's rationale - the
> commit messages remain the detailed record.

### Added
- **S202 boot-lean server bundle** (#109, brief-s202b). `session_state_manifest`
  plus `BOOT_INDEX_MODE=full|compact` (default `full`, additive two-phase);
  `rules_hint` stateless module nudges on the push/patch/`cc_dispatch` ingest
  paths; `BRIEF_COMPACT_MODE=dedup|legacy` (default `dedup` - drops the Project
  State digest line, a measured duplicate of `current_state`);
  `PREFETCH_MODE=opening_only|legacy` plus `PREFETCH_DELIVERED`; the warn-only
  `HANDOFF_ITEM_OVERSIZE` item budget; the `BOOT_MASTHEAD_SVG=on|off` knob; and
  the Kernel-Manifest handshake behind `KERNEL_SPLIT_DRIFT`.
- **Finalize compose-offload** (#109). `FINALIZE_COMPOSE_MODE=files|legacy`
  (default `files`): finalize emits complete validated finalization files to
  `.prism/finalize-draft.json`, `action=commit` accepts `use_draft_files` with
  per-path override, and any gate failure falls back to the legacy six-key
  draft under `FINALIZE_COMPOSE_FALLBACK`.
- **D-278 synthesis truncation fidelity** (#110, brief-s202b v2). Trim
  annotations that cite the TRUE size and forbid citing the truncated one; a
  per-doc INPUT MANIFEST (`{path, true_bytes, included_bytes, truncated}`)
  prepended at every synthesis site; a server-stamped `Synthesized from:`
  provenance footer on the generated brief and PDU, with stale/model-echoed
  footers stripped on untruncated runs; and a `SYNTHESIS_INPUT_TRUNCATED`
  diagnostic per truncated document. This is the metadata that lets a size
  claim be classified as a pipeline artifact instead of drift.
- **`boot_masthead_html`** (#112, brief-720). An additive bootstrap field
  carrying the same information as `boot_masthead_svg` plus the thing SVG
  cannot do: an interactive copy control for the chat session name.
  `boot_masthead_svg` stays byte-identical (locked by a frozen render in
  tests), the HTML renderer has its own try/catch, and `banner_spec_version`
  deliberately stayed 4.3 so the two repos could not desync.
- **`MODEL_CAPABILITIES` model-capability registry** (#114, brief-s5 PR A).
  `src/models.ts`, keyed model x surface, every cell carrying tokens, a
  provenance tag and an `as_of` date; `resolveContextWindow` degrades to a
  disclosed 200K floor rather than throwing on the boot path; CI drift check on
  the `api` column only. Data-only at merge - nothing read it yet.
- **`prism_bootstrap` context-window contract** (#118, brief-s5 PR B). Optional
  `client_model` / `client_surface`: the client declares the one fact only it
  knows, the server owns the table. Absent, behavior is unchanged and tagged
  `source: "server_fallback"` so a client can tell "the server does not know"
  from "the server checked". `context_window` attaches POST-measurement, so
  every size budget and boot-cost figure is bit-identical to before the
  contract existed. `CONTEXT_WINDOW_OVERRIDE` warns when a
  `DEFAULT_CONTEXT_WINDOW_TOKENS` disagrees with the resolved cell - the
  distinction a bare const collapses, and the mechanism by which a stale
  Railway `200000` beat an already-corrected code default for three model
  generations.
- **brief-s205a S203 audit-rec bundle** (#118). Config keel (handoff item
  budget 300 -> 800, deadline and retry-budget constants, empty `files[]`
  reject); infra hardening (total retry budget, blob-SHA landed-commit
  identity, pagination/body hygiene, shutdown reaper + inflight registry);
  bootstrap guards (wall-clock deadline with partial payload, slug-ambiguity
  error, rule-aware `KERNEL_SPLIT_DRIFT`); read-path truth (`DOC_READ_DEGRADED`
  nulls, archived-rule anchors); the finalize contract split into
  `finalize/audit.ts` + `finalize/banner.ts` (loud draft failures, banner on
  bare shapes, render contract on commit and full, deliverables cap, unverified
  `docCount`); and the `LOG_RECREATE_BLOCKED` guard so only a confirmed 404
  creates a starter document.
- **Anthropic prompt caching on the `messages_api` synthesis transport** (#119),
  applied to the large stable living-doc bundle only, size-gated, and a strict
  no-op for the `cc_subprocess` and non-Anthropic transports. Haiku 4.5 gained
  its `claude_code` cell so it resolves to a documented 200K window instead of
  the undocumented floor. Speed only - the per-site quality-gate fallback still
  protects output.
- **`prism_log_decision` status validation** (#117, brief-s204c). The tool
  accepted arbitrary status strings while the `_INDEX.md` push validator
  enforced the canonical enum - the divergence behind the legacy DECIDED drift.
  `VALID_DECISION_STATUSES` / `normalizeDecisionStatus` became the single
  source of truth for both, and a non-enum status is now rejected fail-fast
  before any GitHub I/O.

### Fixed
- **Kernel-Manifest parse tolerated pipes and markdown decoration** (#111). The
  v3.0.0 kernel writes `> **Kernel-Manifest:** A | B | C`; the comma-only,
  decoration-blind parse read the whole line as one section and warn-fired
  `KERNEL_SPLIT_DRIFT` on every single boot (live canary evidence).

### Documentation
- S202 boot-context burn audit and refactor design (#108); brief-s203b
  framework-wide audit (#116); model-bump / d275-rollout / CLAUDE.md truth-up
  riding #118.

## [4.12.0] — 2026-07-14 (D-275: OpenRouter GLM-5.2 mechanical-tier routing)

### Added
- **`openrouter` provider (GLM-5.2) in the existing LLM routing layer**
  (D-275 / brief-s196c, design: `docs/cost-rearchitecture/d275-audit-design.md`).
  Registry entry + `openai_compatible_chat` adapter branch targeting
  `https://openrouter.ai/api/v1/chat/completions`, Bearer auth from
  `OPENROUTER_API_KEY`, model from `LLM_ROUTING_OPENROUTER_MODEL` (default
  `z-ai/glm-5.2`), attribution headers (`HTTP-Referer`/`X-Title`), and the
  openrouter-only request extensions `usage: {include: true}` (measured
  per-call cost) and `provider: {data_collection: "deny"}` (governance).
- **`LLM_ROUTING_OPENROUTER_SITES` activation surface** — openrouter serves
  exactly (SITES ∩ mechanical synthesis sites: `synthesis_draft`,
  `synthesis_pdu`, `synthesis_brief`), resolved ahead of the per-surface
  provider vars with no mutation of any pre-existing shared env var.
  SITES unset/empty ⇒ routing bit-identical to 4.11.0 (regression-tested).
  Kill-switch: clear the var — env-only, no deploy.
- **GLM thinking control (correctness-critical)** — every openrouter call
  pins `reasoning: {enabled: false}` (the S196 live micro-call spent all 16
  completion tokens on reasoning: `finish_reason=length`, zero answer text).
  Per-site opt-in via `LLM_ROUTING_OPENROUTER_REASONING_{BRIEF,DRAFT,PDU}`
  (`off|low|medium|high`), guarded to `max_tokens ≥ 16384`. The callers'
  Anthropic `thinking` flag is deliberately ignored on this leg.
- **Per-site quality gates on the openrouter leg** (design §4.5): brief =
  3 required H2 sections + ≥2000 bytes; PDU = 4 grammar sections + ≥500
  bytes; draft = parseable JSON with ≥4 of 6 contract keys (closing the
  `raw_content` success gap on the GLM route only). A gate failure is
  treated exactly like a provider failure: structured
  `SYNTHESIS_PROVIDER_FALLBACK` warn now carrying
  `fallback_reason: validation_failed|provider_error|timeout`, then the
  site's existing Anthropic chain serves.
- **`LLM_CALL` per-invocation cost telemetry** across ALL providers/
  transports (synthesis in `src/ai/client.ts`, `cc_dispatch`,
  `prism_x_sentiment`): `{call_site, provider, model, transport,
  input_tokens, output_tokens, est_cost_usd, latency_ms, fallback_used,
  fallback_reason}` — provider usage preferred, labeled chars/3.5 estimates
  otherwise; prices in the new `src/llm/pricing.ts` (source-dated table;
  measured OpenRouter `usage.cost` wins when present).
- **`LLM_ROUTING_TABLE` startup log** — one line at boot printing the
  resolved `call_site→provider→model→transport` for every surface (no
  secrets), permanently killing the "configured but never serving" class.
- **Rollout SOP** at `docs/cost-rearchitecture/d275-rollout.md` (go-live env
  end-state, canary steps, stage-2 intelligence-brief flip, rollback).

### Changed
- `extractJSON` moved to `src/utils/extract-json.ts` (re-exported from
  `src/tools/finalize.ts` unchanged) so the draft quality gate can consume it
  without a module cycle.
- Provider adapter errors now carry a `failure_class`
  (`validation|timeout|http`) so fallback telemetry can distinguish the GLM
  length-starvation signature from transport failures.

## [4.11.0] — 2026-07-08 (Railway provisioning & lifecycle)

### Added
- **Six Railway creation/lifecycle tools** so PRISM sessions can manage Railway
  fully autonomously (previously the surface was read/mutate-only:
  `railway_status`, `railway_env`, `railway_logs`, `railway_deploy`):
  - `railway_create_project(name)` — create a project; returns the ID and the
    auto-created production environment.
  - `railway_create_service(project, name, source, variables?, region?)` —
    create a service from a GitHub **repo** (with optional `rootDirectory` /
    `branch`) **or** a Docker **image**. Variables are forwarded verbatim, so
    Railway reference syntax like `${{Postgres.DATABASE_URL}}` is never
    interpolated server-side.
  - `railway_update_service_settings(project, service, …)` — update
    `rootDirectory` / `startCommand` / `healthcheckPath` / `restartPolicy`.
  - `railway_create_volume(project, service, mountPath)` — attach a persistent
    volume.
  - `railway_create_domain(project, service, targetPort?)` — generate a Railway
    domain and return it in the result.
  - `railway_delete_service(project, service, confirm)` — hard-requires
    `confirm === true`; refuses with a clear error otherwise.
- New GraphQL client helpers in `src/railway/client.ts` (`createProject`,
  `createService`, `updateServiceInstanceSettings`, `createVolume`,
  `createServiceDomain`, `deleteService`) plus supporting types. All reuse the
  existing `railwayQuery` transport, Bearer auth, name→ID resolver, and
  production-environment defaulting. Existing tools are unchanged.
- Registered behind the existing `RAILWAY_ENABLED` flag; tool surface count
  updated 26 → 32 (14 PRISM / 10 Railway / 2 Claude Code / 6 GitHub) across
  `TOOL_REGISTRY`, the bootstrap tool-search keywords, CLAUDE.md, and the
  drift-guard tests. Unit tests (mocked GraphQL) cover a happy path and a
  failure path for each new tool.

## [4.8.0] — 2026-06-14 (D-257 wave 3, brief-466 / W3-S7)

### Changed
- **`SERVER_VERSION` un-frozen** (SRV-90): was stuck at 4.7.0 across ~28 merged
  PRs of materially different deployments, which made version reporting
  meaningless and falsified the framework template's `>=4.7.1` floor check.
  Bumped to 4.8.0 and kept in lockstep with `package.json`.

### Fixed (documentation currency, M-017)
- CLAUDE.md tool inventory (25 = 13 prism / 4 railway / 2 claude_code / 6
  github), brief paths (`.prism/briefs/queue/` per `.prism/trigger.yaml`), model
  references (defer to `src/models.ts` registry), and env-var coverage corrected.
- Synthesis-pipeline comments and the `prism_push` schema description no longer
  hardcode stale model names / commit prefixes (derive from the registry /
  `VALID_COMMIT_PREFIXES`). `docs/banner-spec.md`, `docs/intelligence-layer-design.md`,
  and `docs/audit-s33c.md` marked current/superseded/historical.

### Removed (dead code, M-018)
- Dead boot topic-selection path, batch resolvers, `pushFiles`/`BatchPushResult`,
  zero-consumer exports, permanently-null banner back-compat fields, the phantom
  repo-root gitlink, and 15 legacy `.dispatch/` files.

## [Banner 4.1] — 2026-06 (brief-448 + 4c242ed, D-249 follow-up)

### Added
- `finalization_banner_html` extended to the `prism_finalize action=full`
  surface (matching the commit surface). `BANNER_SPEC_VERSION` → **4.1**.

## [Banner 4.0] — 2026-06-08 (brief-447, D-249)

### Added
- **Graphical widgets restored** as NEW response fields after the brief-439
  deletion: `boot_masthead_svg` (bootstrap) and `finalization_banner_html`
  (finalize commit), rendered via `renderBootMastheadSvg` /
  `renderFinalizationBannerHtml` for `visualize:show_widget`. `banner_text`
  remains the guaranteed fallback when a widget render fails. `BANNER_SPEC_VERSION`
  → **4.0**. (These changes were previously unlogged — backfilled per SRV-91.)

## [Banner 3.0] — 2026-06-04 — brief-439 (D-240 Phase B, R8): unified drift-proof banner

### Added
- **Unified banner generator** (`renderUnifiedBanner`, `src/utils/banner.ts`):
  ONE server-side text generator produces `banner_text` for both
  `prism_bootstrap` and `prism_finalize` (commit + full). Boot and finalize
  banners are byte-consistent by construction. Contract: banner spec **3.0**
  ([docs/banner-spec.md](docs/banner-spec.md)).
- **`banner_spec_version` handshake**: every bootstrap/finalize response
  emits `banner_spec_version`; where template content is in hand
  (bootstrap → `core-template-mcp.md`, finalize audit →
  `rules-session-end.md`) the server parses the template's
  `Banner-Spec-Version` declaration, returns it as
  `template_banner_spec_version`, and logs a **`BANNER_DRIFT`** warn
  diagnostic on mismatch. Visibility only — never blocking. Templates that
  declare nothing predate the handshake and produce no diagnostic.
- `prism_finalize action=full` now returns `banner_text` (it previously
  returned no banner at all); its step row carries the real audit/draft
  outcomes.
- `project_display_name` is a top-level bootstrap response field (it
  previously existed only inside the removed `banner_data` object).

### Changed
- **Null-fallback contradiction resolved**: on banner render failure the
  server now emits the Rule 2 single-line fallback
  (`PRISM | Session {N} | Handoff v{V} | {C}/{T} docs`) in `banner_text`
  itself, instead of returning `banner_text: null` plus a structured
  `banner_data` object that contradicted the template's documented fallback.
  Boot adds a `BANNER_RENDER_FALLBACK` warn diagnostic when this happens.
- Bootstrap's template-version parse prefers the explicit
  `Template Version:` declaration so a `Banner-Spec-Version:` line can never
  pollute `template_version`.
- Living-document counting is normalized and unified
  (`countLivingDocumentsUpdated`): the finalize banner's `{C}/{T} docs
  updated` and the commit `confirmation` sentence /
  `living_documents_updated` field now share one counter that handles both
  repo layouts (`.prism/` and legacy root-level — the old HTML banner and
  confirmation both reported `0/10` for unmigrated repos), excludes domain
  decision files (`decisions/{domain}.md` are not living documents), and is
  bounded by the 10-doc total by construction.

### Deprecated
- **HTML finalization widget** (D-46, consumed by Rule 11 Step 6 / D-84):
  `finalization_banner_html` is now **always `null`** — no HTML is generated
  server-side. The field is retained for backward compatibility; Rule 11
  Step 6's documented null path (minimal text confirmation) applies until
  the framework template consumes the finalize `banner_text`
  (chat-side cross-repo follow-up). `banner_html` (bootstrap, null since
  ME-1) and `synthesis_banner_html` (null since D-78) are likewise retained
  as null-only fields.

### Removed
- HTML renderers and helpers deleted from the codebase:
  `renderBannerHtml`, `renderFinalizationBanner`, `escapeHtml`,
  `formatResumptionHtml`, `toolIcon` (~330 lines of HTML/CSS generation).
- `banner_data` bootstrap response field (the QW-1 fallback object) — the
  single-line `banner_text` fallback replaces it. The `banner_data` *input*
  parameter of `prism_finalize` (deliverables / decisions_note /
  step_statuses) is unchanged and honored by the unified generator.

---

## Banner & Rule-9 history backfill (D-84, D-85)

Logged here per the brief-431 audit (D-240 Phase B): these framework
decisions shaped the banner/response contract this server implements but
were never recorded in any changelog.

- **D-84 — Hard-structured boot and finalization response templates**
  (S45, architecture, SETTLED). Introduced the HARD-RULE response
  structures: Rule 2's exact boot response (session-name fence → rename
  directive → banner fence built from `banner_text` → opening statement →
  context status line) and Rule 11 Step 6's exact finalization response
  (widget → confirmation sentence → context status line). Eliminated
  Claude-side presentation drift; shipped as template v2.12.0 +
  `rules-session-end.md`. Rule 11 Step 6's widget consumption of
  `finalization_banner_html` is the surface deprecated by brief-439.
- **D-85 — Rule 9 context-status-line prominence boost** (S45,
  architecture, SETTLED). Added the ⛔ marker on Rule 9 and the standalone
  "Mandatory Response Closer" restatement section after observed compliance
  drift in instruction-dense projects (prose-style tier mentions substituted
  for the literal `[S{n} · Ex {n} · {emoji} ~{percent}%]` line, suppressing
  tier advisories and causing auto-compaction). Shipped as template v2.13.0.

## MCP template version history backfill (2.10.0 → 2.18.0)

`core-template-mcp.md` versions that were never logged (reconstructed from
`prism-framework` commit history). The framework's earlier changelog
backfill covered v2.2.0–v2.9.0 (S28 audit remediation); this closes the gap
to current.

| Version | Session | Change |
|---------|---------|--------|
| 2.10.0 | S29 (+S35) | S29 audit remediation: **text banner (`banner_text`) replaces HTML in Rule 2** (ME-1), Rule 9 context-estimation update, session-end rules deferred to `prism_finalize` delivery. S35 added the candor-over-agreement Operating Posture bullet (D-74) without a version bump. |
| 2.11.0 | S44 | D-83: Rule 1 post-boot tool surface instruction — `tool_search` sweep after bootstrap + the banner's Tool Surface line. |
| 2.12.0 | S45 | **D-84**: hard-structured boot + finalization response templates (Rule 2 exact structure; Rule 11 Step 6 in `rules-session-end.md`). |
| 2.13.0 | S45 | **D-85**: Rule 9 prominence boost — ⛔ marker + Mandatory Response Closer restatement section. |
| 2.14.0 | S103 | D-190: CC Channel Discipline section — Trigger promoted to canonical channel for substantial Claude Code work; `cc_dispatch` retained for simple/small scope. |
| 2.15.0 | S106 | D-191 / brief-405: session-recommendation banner line — Rule 2 Block 3 renders the `Suggested:` line from `banner_text` position 4. |
| 2.16.0 | S107 | D-193 Pieces 4+1 / brief-411: concise-default Operating Posture bullet + persisted-recommendation note (finalize persists `recommended_session_settings` into handoff.md; bootstrap reads it back — closed the S107→S108 banner discrepancy). |
| 2.17.0 | S108 | D-193 Piece 2 / brief-412: Active model awareness Tier A rule — model/thinking/window self-report on the boot response + triage against the persisted recommendation. |
| 2.18.0 | S110 | D-196 Piece 3 / brief-416: stale-active surfacing paragraph — Trigger stuck-slot warning flows into the banner's `⚠` line. |

For context beyond the backfill range: v2.19.0 (D-227, window-aware Rule 9
context estimation) and v2.19.1 (Opus 4.8 added to the model-strength
ordering) are the currently deployed template versions and were logged in
their own commits.

<!-- EOF: CHANGELOG.md -->
