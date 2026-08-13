# Framework-wide audit S203 — recommendations (single-pass-implementable backlog)

> **Contract (brief s203b Task 2):** every recommendation specifies `id · target repo · files · change
> sketch · effort (S or M only) · risk · verification predicate · rollback`. Anything larger than M is in
> the **Deferred — out of scope** appendix and is excluded from the implementable set. The implementable
> set is executable by **one implementation brief per repo**, wall-clock hours, wide parallel sub-agents.
> `backlog.json` is the machine-readable mirror of this set.

Priority order within each repo: P0 first, then P1, then P2, then P3. IDs are stable across all three
deliverables. Cross-repo sequencing notes are called out where a fix depends on another landing first.

Effort legend: **S** ≈ a focused single-file-or-two change with an obvious test; **M** ≈ multi-file or a
contract change needing a soak/careful test.

---

## prism-mcp-server (one implementation brief)

### R1 · P0 · Re-land PR #115 — the model-capability window contract
- **Files:** `src/config.ts`, `src/tools/bootstrap.ts`, `tests/bootstrap-context-window.test.ts`,
  `tests/bootstrap-budget.test.ts`.
- **Change:** re-target the still-existing remote branch `prism-s5-bootstrap-context-window` (`de46d20`) to
  base `main` and re-PR, or cherry-pick `de46d20` onto a fresh branch off `main`. This restores the
  `client_model`/`client_surface` bootstrap params, the provenance-tagged `context_window` response block,
  `resolveContextWindowOverride`, and the `CONTEXT_WINDOW_OVERRIDE` / `CONTEXT_WINDOW_STALE` diagnostics —
  activating the otherwise-inert #114 registry.
- **Effort:** S · **Risk:** low (lead-verified conflict-free merge-tree; does not touch `models.ts`; additive
  post-measurement field; production auto-deploys from main so land during a quiet window).
- **Verify:** `git merge-base --is-ancestor <new-sha> origin/main` true; `grep -rn client_model
  src/tools/bootstrap.ts` non-empty; `tests/bootstrap-context-window.test.ts` present and green; a boot
  declaring `client_model` returns a top-level `context_window` with `source`/`as_of`.
- **Rollback:** revert the PR (additive field only).
- **Addresses:** F-A1-2, F-C1-4, F-B1, F-A1-3 (with R2), F-B16 unblock.

### R20 · P1 (P0 if Railway appends XFF) · Fail-closed auth on a missing/non-Bearer header
- **Files:** `src/middleware/auth.ts`, `src/config.ts`, `tests/` (new `auth-middleware.test.ts`).
- **Change:** when `MCP_AUTH_TOKEN` is set, a missing or non-Bearer Authorization header must 401 immediately
  rather than fall through to the IP check (move the reject outside the `authHeader?.startsWith("Bearer ")`
  branch). Derive the client IP from the rightmost XFF entry minus a configured trusted-hop count (or
  `app.set("trust proxy", 1)` + `req.ip`). Ship the reject-on-missing-header change **first, alone**.
- **Effort:** S · **Risk:** med (a wrong hop count could lock out the live client — hence ship the header
  reject alone first).
- **Verify:** new tests — "missing Authorization with token set → 401", "forged leftmost XFF → 403".
- **Rollback:** revert the middleware file; env unchanged.
- **Addresses:** F-C1-1, F-C1-16 (order fix rides along).

### R12 · P1 · Attach banner fields to the four bare finalize shapes
- **Files:** `src/tools/finalize.ts`, `tests/finalize-use-draft-files.test.ts`.
- **Change:** spread `...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? 1)` into the four
  early returns at `finalize.ts:3073/3083/3093/3129`; add a table-driven test asserting `banner_text` is
  non-empty on every `action ∈ {commit, full}` return site.
- **Effort:** S · **Risk:** low. **Verify:** the enumeration test passes over all commit/full sites.
- **Rollback:** revert. **Addresses:** F-A2-4.

### R11 · P1 · Deliver the finalize render contract on commit + full, not only audit
- **Files:** `src/tools/finalize.ts`.
- **Change:** hoist the `rules-session-end.md` fetch (or emit a ~15-line `finalize_render_contract` string)
  outside the `action === "audit"` branch so `commit` and `full` responses also carry the RENDER + CONFIRM
  structure and the FALLBACK. Measure the added bytes against the oversize thresholds.
- **Effort:** S · **Risk:** low. **Verify:** an `action=commit` response contains the render contract; a
  commit-only finalize with no prior audit renders correctly.
- **Rollback:** drop the field (older clients ignore it). **Addresses:** F-A2-3, F-D3.

### R22 · P1 · Make draft parse/compose failures fail loud
- **Files:** `src/tools/finalize.ts`, `tests/finalize-full-draft-bridge.test.ts`,
  `tests/finalize-compose-offload.test.ts`.
- **Change:** the parse-failure return (`:987-995`) must set `success: false` (or `parse_failed: true`) so
  `draftStatus` becomes `warn`, `DRAFT_FAILED` fires, and the raw text rides out in `draft_recovery`; narrow
  the `draftPhase` outer `catch` so a compose/persist throw emits `FINALIZE_COMPOSE_FALLBACK` with
  `fallback_reason: compose_threw` and the real message instead of "Could not parse structured JSON".
- **Effort:** S · **Risk:** low (the `action=draft` shape is preserved by keeping `raw_content`).
- **Verify:** "unparseable draft → phases.draft.status === 'warn' && draft_recovery non-null"; "pushFile throws
  → FINALIZE_COMPOSE_FALLBACK(compose_threw), no parse_warning".
- **Rollback:** revert. **Addresses:** F-C1-3, F-C1-6.

### R21 · P1 · Stop log_decision / log_insight from overwriting on a transient read error
- **Files:** `src/tools/log-decision.ts`, `src/tools/log-insight.ts`.
- **Change:** discriminate the caught error — treat only `/Not found/i` as "absent"; route anything else
  through the existing `classifyUnfetchedDoc` (export it from `finalize.ts` or lift to `src/utils/`); on an
  unverified read, return `isError` with a `LOG_RECREATE_BLOCKED` diagnostic instead of writing a starter file.
- **Effort:** M · **Risk:** low. **Verify:** "resolveDocPath rejects with a 401-shaped error → no write,
  isError"; "rejects with 'Not found' → starter file created".
- **Rollback:** revert both files. **Addresses:** F-C1-2.

### R57 · P1 · Reconcile the `DECIDED` status (validator ⇄ writer ⇄ data)
- **Files:** `src/validation/decisions.ts`, `src/tools/log-decision.ts` (+ the prism data edit is R57d).
- **Change:** decide whether `DECIDED` joins `VALID_STATUSES` (`:9`) or the 11 rows normalize to `SETTLED`;
  either way, make `prism_log_decision` validate its own output — `z.enum(VALID_STATUSES)` on the status param
  plus a `validateDecisionIndex` pass on the composed content before commit — so the write path and the
  validate path can no longer disagree.
- **Effort:** S · **Risk:** low. **Verify:** `validateDecisionIndex(<live _INDEX.md>).errors` empty AND
  `prism_log_decision` rejects `status:"BOGUS"`.
- **Rollback:** revert. **Addresses:** F-B6 (lead-verified).

### R23 · P1 · Give `prism_bootstrap` a wall-clock deadline
- **Files:** `src/config.ts` (add `BOOTSTRAP_WALL_CLOCK_DEADLINE_MS`, default `MCP_SAFE_TIMEOUT`),
  `src/tools/bootstrap.ts`, `tests/read-tool-deadlines.test.ts`.
- **Change:** wrap the bootstrap handler body in the same sentinel / `Promise.race` / `clearTimeout` pattern as
  `push.ts:73-76,281-308`; return the partial payload where possible rather than a bare error.
- **Effort:** M · **Risk:** low. **Verify:** a bootstrap block in `read-tool-deadlines.test.ts` — "core fetch
  hangs → structured deadline-exceeded response".
- **Rollback:** env-set the deadline very high. **Addresses:** F-C1-5.

### R30 · P2 · Read-path degraded signal instead of confident zeros
- **Files:** `src/tools/status.ts`, `src/tools/analytics.ts`. **Change:** on a non-`Not found` error emit a
  `DOC_READ_DEGRADED` diagnostic and return `null` for the affected fields rather than 0.
- **Effort:** S · **Risk:** low. **Verify:** "resolveDocPath rejects with a 401 → fields null +
  DOC_READ_DEGRADED". **Rollback:** revert. **Addresses:** F-C1-14.

### R28 · P2 · `prism_push` must reject an empty `files[]`
- **Files:** `src/tools/push.ts`. **Change:** add `.min(1, "at least one file required")` to the zod array.
- **Effort:** S · **Risk:** low. **Verify:** "files: [] → isError". **Rollback:** revert. **Addresses:** F-C1-12.

### R29 · P2 · Slug resolution must not guess-then-write
- **Files:** `src/tools/bootstrap.ts`. **Change:** on a partial match collect all candidates — if more than one,
  return an error naming them rather than binding the first; require a minimum normalized match length (≥ 6)
  before accepting a substring match, before any boot-test/enrollment write.
- **Effort:** S · **Risk:** low. **Verify:** "two repos both substring-match → error naming both, no write".
- **Rollback:** revert. **Addresses:** F-C1-13.

### R32 · P2 · Bound the interactive draft race at the MCP ceiling
- **Files:** `src/config.ts`, `src/tools/finalize.ts`, `tests/finalize-draft-timeout.test.ts`.
- **Change:** bound the `action=draft` race at `MCP_SAFE_TIMEOUT` while leaving `fullPhase`'s own race on the
  longer constant; state the background semantics in the `action=full` tool description.
- **Effort:** S · **Risk:** med (a 50s draft ceiling may trip on large projects — pair with the
  `SYNTHESIS_DRAFT_TRANSPORT` guidance). **Verify:** the draft-action race uses `MCP_SAFE_TIMEOUT`.
- **Rollback:** env-set `FINALIZE_DRAFT_DEADLINE_MS`. **Addresses:** F-C1-7.

### R24 · P2 · A retry budget for `fetchWithRetry`
- **Files:** `src/github/client.ts`, `tests/github-client-timeouts.test.ts`. **Change:** thread a deadline /
  `AbortSignal` budget (or cap total elapsed retry time at a new `GITHUB_RETRY_BUDGET_MS`, default ~20s) and
  stop retrying once exceeded. **Effort:** M · **Risk:** low. **Verify:** "Retry-After: 60 with 3 retries →
  returns within the budget, not 300s". **Rollback:** revert. **Addresses:** F-C1-8.

### R25 · P2 · Structural identity in `safeMutation`'s landed-commit detection
- **Files:** `src/utils/safe-mutation.ts`, `tests/safe-mutation.test.ts`. **Change:** verify identity by
  tree/blob SHA (or append a per-call nonce trailer to the commit message and match on that) instead of by
  message equality. **Effort:** M · **Risk:** low. **Verify:** "409, HEAD moved to a different commit with an
  identical message → does NOT return ok; retries". **Rollback:** revert. **Addresses:** F-C1-9.

### R26 · P2 · Wire the shutdown reaper
- **Files:** `src/index.ts` (+ a small tracker). **Change:** pass `onDrain` that marks still-`running` dispatch
  records interrupted via `dispatch-store.ts` and awaits a bounded registry of in-flight background synthesis
  promises. **Effort:** M · **Risk:** low. **Verify:** the `index`-level registration supplies an `onDrain`
  (`graceful-shutdown.test.ts`). **Rollback:** pass no `onDrain`. **Addresses:** F-C1-10.

### R27 · P2 · Extract two pure modules from `finalize.ts`
- **Files:** `src/tools/finalize.ts` → `src/tools/finalize/banner.ts` + `src/tools/finalize/audit.ts`.
- **Change:** move the banner-assembly block (`:2098-2362`) and the audit/unfetched-doc classification
  (`:274-554`) — both pure/near-pure — leaving `commitPhase` in place. (The full 6-way split is Deferred.)
- **Effort:** M · **Risk:** low. **Verify:** the existing `tests/finalize*.test.ts` suite passes with
  re-pointed imports. **Rollback:** revert the move. **Addresses:** F-C1-11, F-A2-13.

### R9 · P2 · Make `KERNEL_SPLIT_DRIFT` rule-aware
- **Files:** `src/tools/bootstrap.ts`. **Change:** extend the manifest check with rule-level anchors (a fixed
  list of required literals: the `[S{session} · Ex {N} ·` status-line shape, the tier table, the ⛔ finalize
  line) checked against `behavioralRules`, so a Rule-9-shaped deletion inside `## Session Lifecycle` fires the
  diagnostic. Ship warn-only. **Effort:** S · **Risk:** low. **Verify:** a Rule-9-stripped fixture fires
  `KERNEL_SPLIT_DRIFT`; the live kernel does not. **Rollback:** revert (diagnostic-only). **Addresses:**
  F-A1-8, F-D17.

### R17 · P2 · Register `visualize:show_widget` as a render-surface expectation
- **Files:** `src/tool-registry.ts`, `src/tools/bootstrap.ts`. **Change:** add a `render` category naming
  `visualize:show_widget` in `expected_tool_surface` (documentational, no MCP registration) and extend the
  Rule 1 Tool Surface line to report `render ✓|✗`. **Effort:** M · **Risk:** low. **Verify:** a boot with the
  visualize MCP down emits `render ✗`. **Rollback:** drop the fields. **Addresses:** F-A2-9.

### R18 · P2 · Nullable `docCount` in the error-banner fallback
- **Files:** `src/utils/banner.ts`, `src/tools/finalize.ts`. **Change:** render `?/10 docs (unverified)` on
  deadline/hard-error shapes instead of `0/10`. **Effort:** S · **Risk:** low. **Verify:**
  `banner-fallback-integration.test.ts` asserts no `0/10` on those shapes. **Rollback:** revert.
  **Addresses:** F-A2-11.

### R19 · P2 · Cap `banner_data.deliverables`
- **Files:** `src/tools/finalize.ts`. **Change:** cap the array (12) and each `text` (160 chars) via
  `normalizeBannerText`, emit `BANNER_DELIVERABLES_TRUNCATED` when it bites. **Effort:** S · **Risk:** low.
  **Verify:** a 40-item call yields ≤ 12 rows + the diagnostic. **Rollback:** revert. **Addresses:** F-A2-12.

### R70 · P2 · Stop `HANDOFF_ITEM_OVERSIZE` firing 5/5 every boot
- **Files:** `src/config.ts` (or `src/tools/bootstrap.ts`). **Change:** raise `HANDOFF_ITEM_BUDGET_BYTES`
  toward the measured mean (~800) or aggregate to one diagnostic naming the N worst items. **Effort:** S ·
  **Risk:** none (warn-only). **Verify:** a prism boot emits ≤ 1 `HANDOFF_ITEM_OVERSIZE`. **Rollback:**
  `HANDOFF_ITEM_BUDGET_BYTES` env. **Addresses:** F-B11.

### R-DOCS-MS · P2–P3 · Server doc/config truth-up (batch)
- **Files:** `docs/model-bump.md`, `CLAUDE.md`, `docs/cost-rearchitecture/d275-rollout.md`,
  `docs/cost-rearchitecture/d275-callsite-inventory.json`, `src/models.ts`, `src/llm/pricing.ts`.
- **Change (one commit, several small edits):** (a) F-B7 — route `provider-registry.ts:16` at
  `SYNTHESIS_MODEL_ID`, replace the `cc-subprocess.ts` `claude-sonnet-5` literal with a comparison against
  `RECOMMENDATION_MODELS.executional.id`, and key `pricing.ts` off the registry (or add it to the model-bump
  §1 table as an explicit exception); (b) F-B8 — add a `MODEL_CAPABILITIES` row + a
  `DEFAULT_CONTEXT_WINDOW_TOKENS` row to the SOP/CLAUDE.md with the per-surface provenance rule; (c) F-B9 —
  bump `RECOMMENDATION_MODELS` to opus-5 or add a dated hold comment; (d) F-B10 — rewrite `d275-rollout.md` §3
  to invoke INS-370's 5 steps + the INS-371 preconditions and fix the failure ladder; (e) F-B14 — fix
  `CLAUDE.md:323` trigger-state path to `~/.trigger/state/...`; (f) F-B17 — refresh
  `d275-callsite-inventory.json`'s SHA + citations; (g) F-B21/C2 — correct the env count and add the ~5 most
  load-bearing missing rows (`SYNTHESIS_INPUT_*`, `DEFAULT_CONTEXT_WINDOW_TOKENS`, `CC_DISPATCH_EFFORT`,
  `LLM_ROUTING_PROFILE`); (h) F-G-A11 — add `pricing.ts` rows for `deepseek-v4-pro` and `sonar-pro`.
- **Effort:** S (each edit) · **Risk:** low. **Verify:** `docs/model-bump.md:25` grep prints nothing;
  `grep -c MODEL_CAPABILITIES docs/model-bump.md ≥ 1`; `estimateCostUsd` non-null for the two providers.
- **Rollback:** revert. **Addresses:** F-B7, F-B8, F-B9, F-B10, F-B14, F-B17, F-B21, F-G-A11.

### R75 · P3 · Diagnostic on the archived-rule exclusion
- **Files:** `src/utils/standing-rules.ts`. **Change:** anchor the archived/dormant test to the first body line
  after the `### ` header and emit `logger.info("standing rule excluded as archived", {id})` on the skip.
  **Effort:** S · **Risk:** low. **Verify:** a fixture with "archived rule" mid-body parses as active; each
  real exclusion logs once. **Rollback:** revert. **Addresses:** F-B18.

### R31 · P3 · GitHub client pagination/body hygiene
- **Files:** `src/github/client.ts`. **Change:** add `if (repos.length < 100) break;` + a hard page cap, and
  `await res.body?.cancel()` on the two early-return paths. **Effort:** S · **Risk:** low. **Verify:** "a
  99-item page issues no second request". **Rollback:** revert. **Addresses:** F-C1-15.

---

## prism-framework (one implementation brief) — kernel-byte sequencing note

Several kernel-side edits below need bytes the 31 B headroom cannot supply. **Land R36 first** (it records the
byte-gate provenance at zero kernel cost and is the decision hook), then take the kernel edits either by (a)
the D-279 re-derivation (Deferred), (b) a second recorded `KERNEL_BYTE_LIMIT` raise, or (c) relocating the
restored text into Band-3 `reference/` (zero kernel bytes) where the finding allows. Each kernel-touching rec
below names its byte posture.

### R10 · P0 · Make the banner branch render-outcome-aware + add an inline fallback directive
- **Files:** `_templates/core-template-mcp.md` (`:69`, `:80`, `:150`), `_templates/rules-session-end.md`
  (`:34`, `:55-63`). **Change:** add a third branch to both boot and finalize render rules — "if the
  `show_widget` call fails, errors, or times out, render `banner_text` inline in the SAME turn and note the
  failure in one clause; make ONE attempt per turn, never retry; never omit the banner because the widget
  channel is down"; promote the skip-after-first-timeout policy from a per-session KI workaround to protocol.
  Zero-or-near-zero kernel bytes (rewording). **Immediate zero-deploy mitigation for KI-29:** set
  `BOOT_MASTHEAD_SVG=off` on Railway (env-only, see R-ENV-MAST).
- **Effort:** S · **Risk:** low. **Verify:** with the visualize MCP down, boot still emits a fenced session
  name matching `^.+ — Session \d+: … CST$` + the rename line, and Probe F on the next 5 sessions returns
  `finalize_contract = pass` via the inline fallback while KI-29 remains active.
- **Rollback:** revert the template edit (propagates on next boot, no deploy). **Addresses:** F-A2-1, F-A2-2.

### R4 · P1 · Port the corrected Rule 9 window map (+ Opus 5 + disclosure) to the fallback
- **Files:** `_templates/core-template.md` (`:68`, `:261`), `_templates/CHANGELOG.md`,
  `tests/rule9-context-meter-stability.test.mjs` (version pins). **Change:** replace the fallback's window map
  with the kernel's corrected one (add the Opus 5 → 1M row), port the "model absent from map → floor and the
  boot line MUST disclose it" clause and the cross-surface ban, drop the stale INS-306 clause; bump 2.29.2 →
  2.30.0. **Effort:** S · **Risk:** low. **Verify:** both templates contain an Opus-5 chat row and a
  disclosure clause; `node --test tests/*.test.mjs` green. **Rollback:** revert. **Addresses:** F-A1-4, F-D1.

### R3 · P1 · Restore the D-85 closer enumeration
- **Files:** `_templates/core-template-mcp.md` (kernel end) or `_templates/reference/context-economy.md`
  (Band-3, zero kernel bytes), + `tests/rule9-context-meter-stability.test.mjs`. **Change:** restore the
  "no exceptions for short / tool-call-only / clarification — every response; a constant mechanical behavior,
  not a conditional check" enumeration and the auto-compaction consequence. Prefer the Band-3 location to
  avoid the byte gate, with a one-line kernel pointer. **Effort:** S · **Risk:** low. **Verify:** the pinned
  phrases appear in the delivered chain and are asserted in the rule9 test; one soak session graded by Probe C.
  **Rollback:** revert. **Sequencing:** if placed in-kernel, needs R36. **Addresses:** F-A1-1, F-D16.

### R15 · P1 · Restore D-263's rationale + remedial self-check
- **Files:** `_templates/core-template-mcp.md:150` (or Band-3). **Change:** restore the one-sentence rationale
  ("banners are tool-returned data, not server output; an unrendered banner is invisible") and the remedial
  clause ("if not rendered, add the render before submitting"). ~180 B in-kernel → needs R36, or land in
  Band-3. **Effort:** S · **Risk:** low. **Verify:** kernel byte gate green; Probe F pass-rate improves over 5
  sessions. **Rollback:** revert. **Addresses:** F-A2-7, F-D19 (add the D-263 CHANGELOG citation here too).

### R13 · P1 · Make audit-harness Probe B branch-aware (v5)
- **Files:** `_templates/modules/audit-harness.md:52-59`. **Change:** "if `boot_masthead_html` was emitted that
  session, B1/B2 are `n-a` and B3 grades the HTML masthead including its copy control; else grade B1–B4 as
  today"; bump to schema v5, record the spec-era boundary. **Effort:** S · **Risk:** low. **Verify:** re-grading
  S174 (a known pass) and one post-3.1.4 session both return `pass`. **Rollback:** filter audit rows by
  `harness_version`. **Addresses:** F-A2-5.

### R14 · P1 · Author Probe H + run the harness over the S181–S203 gap
- **Files:** `_templates/modules/audit-harness.md`, `prism:.prism/audit-trail.md` (prism-side data — folds into
  the prism brief). **Change:** author Probe H (module-load compliance) and add the `rule9_window_declared` /
  `rule9_window_correct` grades from R-PROBE-W; then run the harness over S181–S203 and append rows. **Effort:**
  M · **Risk:** low. **Verify:** ≥ 5 post-S202 rows with non-`inconclusive` `finalize_contract`. **Rollback:**
  n/a (additive data). **Addresses:** F-A2-6.

### R-PROBE-W · P1 · A probe that grades the denominator W
- **Files:** `_templates/modules/audit-harness.md` (Probe B/C), `tests/rule9-context-meter-stability.test.mjs`.
- **Change:** add `rule9_window_declared` (the boot `Running:` line names a `{window}`) and
  `rule9_window_correct` (that window matches the kernel map for the self-reported model+surface;
  `floor_undisclosed` when the model is absent and the disclosure clause is missing). **Effort:** S · **Risk:**
  low. **Verify:** a known-good Opus 5 session scores `ok`; a synthetic 200K-denominator transcript scores
  `mis-scaled`. **Rollback:** filter by `harness_version`. **Addresses:** F-A1-5.

### R33 · P1 · Add a compose-mode branch to the finalize rules
- **Files:** `_templates/rules-session-end.md` (Steps 3–5). **Change:** when the draft response carries
  `draft_files`, commit via `use_draft_files: true` and pass only per-file overrides in `files[]`; keep the
  existing ⛔ text as the legacy-response branch (feature-detected on field presence). **Effort:** S · **Risk:**
  low. **Verify:** the framework text names `use_draft_files` and `draft_files`; one live finalize commits
  without a full `files[]`. **Rollback:** revert. **Addresses:** F-D2.

### R35 · P1 · Teach the kernel to consume `session_state_manifest`
- **Files:** `_templates/core-template-mcp.md` (Rule 1). **Change:** replace the bare "(D-156 manifest)" line
  with a field-named one — `session_state_manifest.rules.index` is the Tier-B/C lookup key for
  `prism_load_rules`; `.docs` is the `prism_fetch` map; absent (older server) → `standing_rules_index`. Swap
  bytes, don't add (R36). **Effort:** S · **Risk:** low. **Verify:** `git grep session_state_manifest
  origin/main` non-empty; one soak boot before the `compact` env flip. **Rollback:** env `BOOT_INDEX_MODE=full`.
  **Addresses:** F-B2, F-D5.

### R34 · P1 · Reconcile project-instructions with the kernel
- **Files:** `_templates/core-template-mcp.md` (Boot source metadata + Rule 1 null branch),
  `_templates/project-instructions.md`. **Change:** (a) extend the `Running:` grammar with an
  `identity {Project Knowledge|slug}` segment (or relax PI-13 to fold into `source_path`); (b) add PI-11's
  mutation-freeze clause to the kernel Rule 1 null branch. **Effort:** S · **Risk:** low (the `Running:` line
  is test-pinned; pins move in-commit; needs R36 for the added segment). **Verify:** both templates + the
  identity test green; one live boot shows the segment. **Rollback:** revert. **Addresses:** F-D4.

### R16 · P2 · Fix `banner-spec.md`'s self-contradiction + versions
- **Files:** `_templates/banner-spec.md` (notes 2/6/10, version line), `README.md`. **Change:** rewrite Note 6
  branch-conditional, extend Note 2 to "whichever masthead field is present", append the 4.3 history entry, set
  README to 4.3. **Effort:** S · **Risk:** low. **Verify:** no sentence asserts the fence is unconditional; every
  banner version token equals `BANNER_SPEC_VERSION`. **Rollback:** revert. **Addresses:** F-A2-8, F-D11.

### R38 · P2 · Four-category Tool Surface line
- **Files:** `_templates/core-template-mcp.md:54`, `_templates/banner-spec.md:136`. **Change:** `(core ✓A/A |
  railway deferred | cc deferred | gh deferred)`. **Effort:** S (~14 B, fits headroom) · **Risk:** low.
  **Verify:** the format segment count equals `Object.keys(getExpectedToolSurface(...))` (4). **Rollback:**
  revert. **Addresses:** F-D10.

### R44 · P2 · Correct the `total_boot_percent` mechanism in the carriers
- **Files:** `_templates/reference/context-economy.md:83`, `_templates/core-template.md:263`. **Change:** state
  "the server's `DEFAULT_CONTEXT_WINDOW_TOKENS` default (500K at the current server), env-overridable — not the
  session's window"; drop the fixed 200K/5× multiplier. **Effort:** S · **Risk:** none. **Verify:** grep finds
  no `200K default` literal in either file. **Rollback:** revert. **Addresses:** F-A1-12, F-D7.

### R7 · P2 · Stop the kernel mismatch-flag firing on every boot
- **Files:** `_templates/core-template-mcp.md:120` (or handle server-side via R1 + R2). **Change:** narrow to
  "flag only when the server figure exceeds the map figure" (~0 net bytes). **Effort:** S · **Risk:** low.
  **Verify:** one Opus 5 boot with no mismatch flag. **Rollback:** revert. **Addresses:** F-D8 (R1+R2 largely
  subsume this).

### R8 · P2 · Reconcile D-227 with the declared-model contract
- **Files:** `_templates/core-template-mcp.md:120` (+ the prism decision edit is in the prism brief). **Change:**
  amend the kernel to distinguish the legacy `context_estimate.context_window_tokens` (not authoritative) from
  a provenance-tagged `context_window` (authoritative when `source ≠ server_fallback`). **Effort:** S · **Risk:**
  low (pairs with R1). **Verify:** the kernel phrase is pinned in the rule9 test. **Rollback:** revert.
  **Addresses:** F-A1-11.

### R36 · P2 · Record the kernel byte-gate provenance
- **Files:** `_templates/reference/context-economy.md`. **Change:** record 18 000 (S202, derived against a
  believed 200K window) → 19 000 (D-279, deliberate interim), the owed re-derivation, and the recorded-decision
  requirement. Zero kernel bytes; unblocks/decides the kernel edits above. **Effort:** S · **Risk:** none.
  **Verify:** byte gate green; grep for `19,000` and `D-279` in the file. **Rollback:** revert. **Addresses:**
  F-D6, F-B13, F-A1-7. (The re-derivation itself is Deferred.)

### R37 · P2 · Regenerate `mcp-tool-surface.md` (19 → 32) + add a load trigger
- **Files:** `_templates/reference/mcp-tool-surface.md`, `_templates/core-template-mcp.md` (one Band-3 trigger
  row, needs R36). **Change:** regenerate the tables from `prism-mcp-server:src/tool-registry.ts`, update counts
  + `Last updated`, add a `> Load trigger:` header. **Effort:** M · **Risk:** low. **Verify:** the doc's tool
  count equals `grep -c "server.tool(" src/tools/*.ts` (32). **Rollback:** revert. **Addresses:** F-D9.

### R39 · P2 · README refresh
- **Files:** `README.md`. **Change:** auto-derive the tree from `git ls-tree`, replace the single Template
  Version pin with the two live pins, add a three-band paragraph. **Effort:** S · **Risk:** none. **Verify:**
  module/reference counts match `ls-tree | wc -l`. **Rollback:** revert. **Addresses:** F-D12.

### R40 · P2 · Un-orphan the two module files
- **Files:** `_templates/core-template-mcp.md` Module Triggers (needs R36 headroom, or land in `core-template.md`
  interim). **Change:** add rows for `trigger-retrofit.md` ("Enrolling an existing project in the Trigger
  daemon") and `metaswarm-integration.md` Mode B. **Effort:** S · **Risk:** low. **Verify:** every file under
  `modules/` is named by a trigger row or triggered by another module. **Rollback:** revert. **Addresses:**
  F-D13, F-B19.

### R41 · P2 · Band-3 trigger table for the unreachable reference docs
- **Files:** `_templates/core-template-mcp.md:171` (needs R36). **Change:** a 3–4 row Band-3 trigger table
  (commit composition → `commit-prefixes.md`; unfamiliar tool category → `mcp-tool-surface.md`; authoring a CC
  launch command → `claude-code-config.md`). **Effort:** S · **Risk:** low. **Verify:** each named Band-3 file is
  reachable. **Rollback:** revert. **Addresses:** F-D14.

### R42 · P2 · Resolve the ⛔-load vs Rule 6 collision
- **Files:** `_templates/core-template-mcp.md` (`:41`/`:43` or Rule 6 at `:99`). **Change:** name the required
  section in the pre-dispatch mandate ("§ Pre-dispatch and § Account selection") so the summary-first path lands
  correctly, or add a Rule 6 exception for ⛔-mandated loads. **Effort:** S · **Risk:** low. **Verify:** the
  mandate names a section, or Rule 6 names the exception. **Rollback:** revert. **Addresses:** F-D15.

### R43 · P2 · Add the operator-utterance finalize trigger to the kernel
- **Files:** `_templates/core-template-mcp.md:146` (needs R36; pairs with R11). **Change:** one line — operator
  says "finalize session" (or 🔴) → `prism_finalize(audit)` first; Rules 10–15 arrive with it. **Effort:** S ·
  **Risk:** low. **Verify:** the kernel names the audit-first sequence. **Rollback:** revert. **Addresses:**
  F-D18.

---

## trigger (one implementation brief)

### R45 · P0 · Add a launch-model pin + preflight verification
- **Files:** `src/config/schema.ts`, `src/types/index.ts`, `src/worker/worker.ts`, `src/worker/preflight.ts`,
  `src/startup/orchestrator.ts`. **Change:** (a) add `default_model` to the environment block (+ a
  `TRIGGER_DEFAULT_MODEL` env fallback) and resolve `frontmatter.model ?? config default` so every launch emits
  `--model`; (b) add a preflight model gate (assert the resolved pin is non-empty; fail closed when neither pin
  nor default exists); (c) stamp the resolved pin into `execution.model_used` at launch. **Effort:** S ·
  **Risk:** low (additive; default preserves today's behavior when set to the string CC would have picked).
  **Verify:** a brief with no `model:` builds a command containing `--model <configured default>` and the
  journal's `model_used` is non-null. **Rollback:** unset `default_model` restores byte-identical behavior.
  **Addresses:** F-E1.

### R46 · P1 · Accept `xhigh` and warn on unknown effort
- **Files:** `src/types/index.ts` (`BriefEffort`), `src/poller/frontmatter.ts:39`. **Change:** add `'xhigh'` to
  the union + `VALID_EFFORT`; log a warn (not a silent drop) on any unrecognized effort. **Effort:** S · **Risk:**
  low (confirm the launched CC version accepts `xhigh` — see open question). **Verify:** `parseFrontmatter('effort:
  xhigh')` returns `'xhigh'` and the built command contains `xhigh`. **Rollback:** revert. **Addresses:** F-E2.

### R47 · P1 · Log the resolved model/effort at dispatch
- **Files:** `src/worker/worker.ts` (launch log ~`:1025`). **Change:** log the resolved `{model, effort,
  max_budget_usd, max_turns}` on the launch line (fields, never the command string — it carries the account
  selector) and thread the resolved values into `execution`. **Effort:** S · **Risk:** none. **Verify:** a dispatch
  produces one info line carrying `model` and `effort`, and the journal's `model_used` matches it. **Rollback:**
  trivial. **Addresses:** F-E3.

### R48 · P1 · Gate the retry-eligibility log on file presence
- **Files:** `src/poller/index.ts` (the `poll` loop `:352` / log `:382-390`). **Change:** pass the present-on-branch
  id set into the eligibility check so the "retrying" line is emitted only for ids whose file is actually on the
  brief branch; add a newsyslog/plist rotation note for the launchd sinks. **Effort:** S · **Risk:** low. **Verify:**
  after one poll with a history-only terminal record and no queue file, zero `poller: retrying <that-id>` lines.
  **Rollback:** revert. **Addresses:** F-E4.

### R49 · P1 · Name stuck terminal ids once, and fix retry-frontmatter's model
- **Files:** `src/poller/index.ts:363-370`, `src/state/manager.ts:56-70`. **Change:** promote the block reason to
  a deduped `info` (once per id per daemon lifetime); have `buildRetryFrontmatter` fall back to the R45
  `default_model` rather than propagating `undefined`. **Effort:** S · **Risk:** low. **Verify:** a terminal record
  with a present queue file emits exactly one info line naming id+reason per lifetime; a retried record's rebuilt
  frontmatter carries a non-empty model. **Rollback:** revert. **Addresses:** F-E5.

### R51 · P1 · Re-notify and surface detection-death
- **Files:** `src/startup/orchestrator.ts:2184-2212`, `src/cli/commands/status.ts`. **Change:** re-emit the
  `brief_branch_unfetchable` ntfy on an interval (24h/slug) instead of once per lifetime; clear the slug on the
  first successful poll and emit a `recovered` info; surface a `detection_dead` count in `trigger status`.
  **Effort:** S · **Risk:** low. **Verify:** a project whose brief branch is removed shows detection-dead in
  `trigger status` and re-notifies after the interval. **Rollback:** revert. **Addresses:** F-E7.

### R50 · P1 · A heartbeat + opt-in hard ceiling for the silent no-marker/no-PR leg
- **Files:** `src/scheduler/index.ts:718`, `src/startup/orchestrator.ts:1866-1899`. **Change:** (a) a deduped
  `debug`/`info` heartbeat on the no-marker/no-PR path carrying elapsed minutes; (b) an opt-in
  `max_execution_hours_hard` (default off) that terminalizes to a distinct `stalled` status after N× the warn
  threshold, keeping the warn-only default. **Effort:** M · **Risk:** med (a hard ceiling can kill a legitimate
  long brief — hence opt-in + a separate threshold). **Verify:** a synthetic active with no marker/PR emits an age
  log each tick and, with the ceiling set, terminalizes exactly once past it. **Rollback:** leave
  `max_execution_hours_hard` unset. **Addresses:** F-E6.

### R55 · P2 · Don't check the operator's HEAD off the merged branch
- **Files:** `src/dispatch/clone-sync.ts:221`. **Change:** narrow `daemonOwnsHead` to `branch === MAIN_BRANCH`
  only; treat the merged branch as foreign (ref-only ff of `main`) unless an explicit
  `TRIGGER_CLONE_SYNC_CHECKOUT_MERGED=true` opts in. **Effort:** S · **Risk:** low. **Verify:** merging a PR while
  HEAD sits on that PR's branch leaves HEAD on the branch and `main` fast-forwarded. **Rollback:** revert.
  **Addresses:** F-E11.

### R52 · P2 · Bound brief discovery to direct children of `brief_dir`
- **Files:** `src/poller/index.ts:536`. **Change:** require the file to be a direct child of `brief_dir` (reject
  any path with a `/` after the prefix), or add an explicit `brief_depth`/`exclude_dirs` knob defaulting to depth
  1. **Effort:** S · **Risk:** low (verify every live marker is flat first — all current markers are). **Verify:**
  a fixture with `queue/_archived/brief-x.md` yields zero `newBriefs`. **Rollback:** revert. **Addresses:** F-E8.

### R54 · P2 · Drop the retired `notify` action from generated markers
- **Files:** `src/github/post-merge.ts` (the generated marker template) + the two live `.prism/trigger.yaml`
  markers (the prism-mcp-server marker edit rides in the server brief). **Change:** remove `notify` from the
  generated template and both markers. **Effort:** S · **Risk:** none. **Verify:** a post-merge run records no
  `notify` in `action_outcomes`. **Rollback:** re-add. **Addresses:** F-E10.

### R53 · P2 · True-up the runtime config template
- **Files:** the chezmoi template `home/private_dot_config/trigger/trigger.config.yaml.tmpl` (in the machine-setup
  repo) + `trigger:trigger.config.yaml`. **Change:** delete the retired blocks, correct or delete the false
  precedence comment, and add the four live knobs with their in-code defaults written explicitly. **Effort:** S ·
  **Risk:** none (all no-ops today). **Verify:** the daemon boots and `trigger status` reports identical behavior
  with the retired keys removed. **Rollback:** restore the template. **Addresses:** F-E9.
  *(Note: this touches a separate repo; if the implementation is one-brief-per-repo, route this edit with the
  trigger brief and flag the machine-setup file for the operator.)*

### R56 · P3 · Log the daemon build identity
- **Files:** `src/index.ts` (boot), `src/cli/commands/status.ts`, `package.json` (build script). **Change:** inject
  `GIT_SHA` at build time (or read `git rev-parse HEAD` best-effort at boot), log it once at boot, surface it in
  `trigger status`. **Effort:** S · **Risk:** none. **Verify:** boot log and `trigger status` print the SHA the
  running `dist/` was built from, and it differs after a rebuild. **Rollback:** remove. **Addresses:** F-E13, INS-369.

### R-TRIG-PANE · P3 · Periodic orphan-pane reaping
- **Files:** `src/startup/pane-reaper.ts` call site. **Change:** run the reaper on a low-frequency timer (hourly)
  gated on "brief terminal in history AND pane label matches", independent of `keepPanesOpen` for terminal briefs.
  **Effort:** S · **Risk:** low. **Verify:** a pane for a merged brief is closed within one reap interval.
  **Rollback:** remove the timer. **Addresses:** F-E12.

---

## prism (living docs — one implementation brief)

### R58 · P1 · Rewrite the handoff against merged reality
- **Files:** `.prism/handoff.md`. **Change:** update Meta (Session Count → 203, Template Version → 3.1.6), rewrite
  Critical Context / Where We Are / Next Steps so no step references an already-merged PR or already-landed fix,
  and delete the duplicate bare `## Recommended Session Settings` block (`:18-22`), leaving the fenced one.
  **Effort:** S · **Risk:** low. **Verify:** no Next Step references a merged PR; `Template Version` equals the
  live kernel; exactly one settings block. **Rollback:** `.prism/handoff-history/handoff_v212_*.md`. **Addresses:**
  F-B4, F-B20.

### R59 · P1 · Backfill the missing session-log entries
- **Files:** `.prism/session-log.md` (full-file write — KI-26 forbids `prism_patch` here). **Change:** backfill
  S190, S192 (partial), S202, S203 entries and restore heading order. **Effort:** M · **Risk:** low. **Verify:**
  `grep -c "Session 202" session-log.md` ≥ 1 and headings are monotonically ordered. **Rollback:** git revert.
  **Addresses:** F-B5.
  *(Server-side companion — a `FINALIZE_MISSING_SESSION_LOG` guard — is a separate small server add; see Deferred
  note.)*

### R57d · P1 · Normalize the 11 `DECIDED` rows (if R57 chooses normalize)
- **Files:** `.prism/decisions/_INDEX.md`. **Change:** one-column edit of D-270…D-280 `DECIDED` → `SETTLED` (or
  leave as-is if R57 widens the validator). **Effort:** S · **Risk:** low. **Verify:** `validateDecisionIndex`
  errors empty. **Rollback:** revert. **Addresses:** F-B6.

### R65 · P1 · Reconcile the OpenRouter-sites membership record
- **Files:** `.prism/insights.md` (INS-371), `.prism/task-queue.md:79`, `.prism/decisions/_INDEX.md` (D-277 → log
  a superseding D-281). **Change:** the operator reads the live `LLM_ROUTING_OPENROUTER_SITES` once via
  `railway_env` (the documented INS-370 step 3/4); then reconcile all surfaces to one truth in a single pass —
  amend INS-371 with the outcome, strike-or-complete the task-queue item, and log D-281. **Effort:** S · **Risk:**
  none (docs; requires the operator's one env read). **Verify:** all four surfaces state the same membership and
  cite the same read-back timestamp. **Rollback:** n/a. **Addresses:** F-B3.

### R60 · P2 · Bring `standing-rules.md` under its tripwire
- **Files:** `.prism/standing-rules.md`, `.prism/task-queue.md` (INS-363 status). **Change:** move the six retired
  entries' marker stubs into a compact table and either raise the tripwire with a recorded decision or schedule
  Tier-B/C body extraction to `standing-rules-archive.md`; update INS-363. **Effort:** M · **Risk:** low
  (`extractStandingRules` parser round-trip is the existing gate). **Verify:** `wc -c` < `STANDING_RULES_WARNING_SIZE`
  OR a decision row justifies the ceiling. **Rollback:** git revert. **Addresses:** F-B12.

### R61 · P2 · Refresh the glossary against current reality
- **Files:** `.prism/glossary.md`. **Change:** add entries for kernel, band (Band 1/2/3), Kernel-Manifest,
  session_state_manifest, standing_rules_index, BOOT_INDEX_MODE, FINALIZE_COMPOSE_MODE, context-meter; update the
  stale Rule 9 "Anchored estimation" and "Smart prefetch" entries and the Core-template version cell. **Effort:**
  S–M · **Risk:** low. **Verify:** the listed terms are present and current. **Rollback:** revert. **Addresses:**
  Axis F glossary anomalies.

### R63 · P2 · Correct KI-26's function name
- **Files:** `.prism/known-issues.md`. **Change:** the resolution names the wired fix as `sanitizeContentField()`;
  correct it to `sanitizeContent` (the actually-wired function). **Effort:** S · **Risk:** none. **Verify:** the
  named function matches the wired function. **Rollback:** revert. **Addresses:** Axis F KI-26 anomaly.

### R64 · P3 · Regenerate the decisions-index domain summary
- **Files:** `.prism/decisions/_INDEX.md` (`:4`). **Change:** regenerate the domain summary line (123 → 232, add
  `infrastructure` and `process`) and add a note on the D-91…D-138 gap. **Effort:** S · **Risk:** none. **Verify:**
  the summary sums to the row count across the correct domains. **Rollback:** revert. **Addresses:** Axis F index
  anomalies.

---

## Operator env actions (no code)

- **R2 · P1 · Clear `DEFAULT_CONTEXT_WINDOW_TOKENS` on Railway** (pairs with R1 so the 500K code default / resolved
  cell applies). Verify: a live boot's `context_window_tokens` equals the code default / resolved cell. Rollback:
  re-set the env var. Addresses: F-A1-3.
- **R-ENV-FLIP · P2 · Flip `BOOT_INDEX_MODE=compact`** after R35 lands + one soak (removes the measured 20 908 B
  duplicate). Verify: a compact boot shows `session_state_manifest` present, `standing_rules_index` absent,
  `response_bytes` down ≈ 15 KB. Rollback: `BOOT_INDEX_MODE=full`. Addresses: F-B2 / F-D5 / F-G redundancy.
- **R-ENV-MAST · P2 · Immediate KI-29 mitigation: set `BOOT_MASTHEAD_SVG=off`** (both masthead fields null → the
  text-banner path with the session-name fence returns) while R10 lands. Also the standing evaluation of a
  masthead knob split (F-A2-10). Rollback: unset. Addresses: F-A2-1, F-A2-10.

---

## Deferred — out of scope (larger than M; excluded from the implementable set)

- **The full 6-way split of `finalize.ts`** (F-C1-11). R27 does the two pure extractions (banner + audit) at M;
  the remaining split (draft/commit/archive-lifecycle) is L.
- **The D-279 `KERNEL_BYTE_LIMIT` re-derivation** against the corrected 1M window (F-D6/F-B13) — its own analysis +
  recorded-decision brief. R36 records the provenance now at zero cost; the re-derivation is L.
- **The s202c fallback-side three-band split of `core-template.md`** (F-B15, 52 KB monolith) — L. The in-scope S
  alternative is a decision recording the divergence as permanent (and deleting the CHANGELOG promise), routed
  with the framework brief.
- **Full registry curation / Tier-B/C body-extraction lifecycle for `standing-rules.md`** if taken end-to-end
  (F-B12/F-G-A8) — L. R60 does stub-compaction + a tripwire decision at M.
- **A server-side `FINALIZE_MISSING_SESSION_LOG` enforcement guard** (companion to R59) — a small server add, but
  it belongs to the server brief, not the prism living-docs brief; sequence it after R59's backfill so it does not
  block existing finalize flows.

<!-- EOF: recommendations.md -->
