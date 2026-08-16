# Changelog — PRISM MCP Server

All notable changes to the PRISM MCP server, plus the banner-contract and
framework-template history the server implements. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). The banner contract is owned
by `src/utils/banner.ts` (`BANNER_SPEC_VERSION`) plus the prism-framework
templates; [docs/banner-spec.md](docs/banner-spec.md) is historical reference.
Banner changes add an entry here.

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
