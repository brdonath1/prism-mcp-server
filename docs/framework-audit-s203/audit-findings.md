# Framework-wide audit S203 — findings

> **Brief:** s203b (READ-ONLY, evidence-first). Single exhaustive audit of the PRISM protocol
> framework — prism-mcp-server, prism-framework, trigger, and the prism project's living docs —
> producing this evidence-backed findings report and a single-pass-implementable recommendation
> backlog (`recommendations.md` + `backlog.json`). Analysis only; no code/template/env/living-doc
> changes were made outside `docs/framework-audit-s203/`.

## HEAD SHAs audited (INS-283)

| Repo | `origin/main` HEAD | Access mode |
|---|---|---|
| prism-mcp-server | `66b68ee9b23f3016e2f39dad19240aedb3febca1` | local tree == origin/main (clean) — direct read |
| prism-framework | `6829ccbb932f491e1d91a5bd2ed085d6ba67751a` | `git show origin/main:` (local on side branch) |
| trigger | `83bed9c41749998500cb88612962836481608883` | `git show origin/main:` |
| prism | `b309d566fceb82aeb25b7ff7b45f0e549539f2c6` | `git show origin/main:` (local behind) |

Cross-repo runtime install `~/.trigger` inspected read-only (names/set-status only, never secret values).
The briefs-branch queue copy of this brief (`origin/briefs` @ `82116b8`) is byte-identical to the
dispatched file — no mid-flight update.

## Model routing table (operator directive — supersedes the D-34 class map)

| Axis / role | Model | One-line reason |
|---|---|---|
| **Lead** — all synthesis, adjudication, risk calls, recommendation design | **Claude Fable 5** | Binding judgment stays apex per brief directive; final composition never delegated. |
| A1 Rule 9 context-meter chain | opus | Cross-repo causal trace; judgment-bearing. |
| A2 banner delivery chain | opus | Cross-repo causal trace; judgment-bearing. |
| B post-D-278 coherence sweep | opus | Intent-vs-shipped adjudication over 8+ PRs. |
| C1 server code health | opus | Code-review class. |
| C2 server mechanical inventory | sonnet | Grep/tally/byte breadth; no judgment. |
| D prism-framework audit | opus | Contract-fidelity judgment over kernel/templates. |
| E trigger daemon audit | opus | Reliability analysis + incident reconstruction. |
| F living-docs hygiene | sonnet | Mechanical staleness tables; no judgment. |
| G efficiency & cost measurement | sonnet | Byte arithmetic; estimates flagged. |

Rationale: apex (opus) for judgment-bearing cross-repo causal traces, code review, and contract
adjudication; cheap (sonnet) for mechanical grep/byte/tally breadth. Sub-agent effort inherited from
the session (max). The Fable 5 lead independently verified the three highest-severity findings
(§ Verification evidence).

Severity key: **P0** live protocol surface actively broken · **P1** will break soon or actively
misleads · **P2** waste/drift/debt · **P3** polish.

---

## Executive summary — the two operator symptoms, traced end-to-end

### Symptom 1 — Rule 9 context-meter omitted / mis-scaled across projects

Two independent failure families, both confirmed against code:

**(a) Mis-scaled.** `prism_bootstrap` ships a flat `context_estimate.context_window_tokens =
DEFAULT_CONTEXT_WINDOW_TOKENS` (`prism-mcp-server:src/tools/bootstrap.ts:1778`), whose in-code default
is 500 000 (`src/config.ts:73-74`) but which multiple in-repo sources assert is overridden to 200 000
on Railway (`tests/bootstrap-budget.test.ts:130-132`; `docs/boot-context-refactor/s202-boot-context-audit.md:34-37`).
The PR #114 model-capability registry that would serve a correct per-model, per-surface window is
**inert on production main** — because **PR #115, the wiring that reads the registry, merged into
#114's feature branch and never reached `main`** (a stacked-PR merge-order race; see F-B1/F-A1-2).
`resolveContextWindow` has zero callers outside its own tests. On the bash+cURL fallback template,
Opus 5 is entirely absent from the Rule 9 window map and falls through to the 200 000 floor with **no
disclosure clause** — a silent 5× under-report (F-A1-4/F-D1). No audit probe grades the denominator,
so a 5× mis-scaled meter still scores `rule9_calibration = ok` (F-A1-5).

**(b) Omitted.** The S202 kernel split (template v3.0.0) deleted D-85's "Mandatory Response Closer" —
the end-of-template Rule 9 restatement built specifically to defeat omission through redundancy —
compressing it into one mid-document line and dropping the "no exceptions for short / tool-call-only /
clarification — every response" enumeration and the stated auto-compaction consequence, neither of
which now reaches a live MCP session (F-A1-1/F-D16). Probe C's every-response grade defaults to
`inconclusive` (it needs a full transcript export), so omission is undetectable by PRISM's own
instrument (F-A1-6).

### Symptom 2 — finalization banner renders hit-or-miss (mostly miss)

Root cause is **KI-29**: the `visualize:read_me` / `visualize:show_widget` MCP render channel has hung
with a 4-minute client timeout for four-plus consecutive sessions (S198–S201) on the operator's
machine (`prism:.prism/known-issues.md:48-52`). The kernel directive branches on **field-nullness,
not render success**: `boot_masthead_html non-null → omit items 1–2, item 3 leads`
(`prism-framework:_templates/core-template-mcp.md:69`), and the finalize render mandate branches only
on `finalization_banner_html === null` (`:150`). When the field is non-null but the widget call dies,
there is **no instructed fallback**, and the FORBIDDEN list bans re-enumerating the banner content in
prose — so the model improvises and correctness is luck (F-A2-1/F-A2-2). Three structural amplifiers:
the finalize render rules (Rule 11 Step 6, FORBIDDEN, FALLBACK) are lazy-delivered **only** on
`action=audit`, so every commit-only / full / `use_draft_files` fast path never receives them
(F-A2-3/F-D3); **four** finalize response shapes — all on the D-275 F-1 `use_draft_files` approve path,
the current default — emit no banner field at all (F-A2-4); and D-263's dedicated ⛔ banner-render
section was compressed, losing its rationale and remedial self-check (F-A2-7). Detection is broken:
Probe B grades a spec-correct post-brief-715 boot as `fail` (F-A2-5), the S202 verification gate never
ran, Probe H was never authored, and 8 of 11 `finalize_contract` rows are `inconclusive` (F-A2-6) — so
"mostly miss" is currently unfalsifiable from PRISM's own instruments.

### The meta-finding — why s203a launched on the wrong model

The trigger daemon has **no launch-model pin, default, or verification anywhere** (F-E1). An unpinned
brief (this brief's frontmatter carries no `model:` key) launches on whatever Claude Code's resolution
chain produces, records `execution.model_used: null`, and is unobservable at the command level (F-E3).
The Task 0.0 self-report gate in this brief is a workaround for a structural daemon gap. Relatedly,
`xhigh` is silently downgraded to `max` because the daemon's effort enum lacks it (F-E2).

### The single highest-value fix

Re-landing PR #115 (F-B1/F-A1-2) resolves the mis-scaled half of Symptom 1 server-side, activates
the entire 781-line registry + test investment from #114/#115, and unblocks the framework de-duplication
(brief-s5 step 3). The lead verified the recovery is conflict-free (§ Verification evidence).

---

## Axis A1 — Rule 9 context-meter delivery chain

Chain: `prism-framework:_templates/core-template-mcp.md` (kernel v3.1.6, boot-resident, band § Session
Lifecycle) → delivered whole as `behavioral_rules` (`prism-mcp-server:src/tools/bootstrap.ts:876→:1701`,
verified untruncated) → `context_estimate` block (`bootstrap.ts:1772-1779`) → session emits
`[S{n} · Ex {N} · {emoji} ~{percent}%]` every reply → detection via `audit-harness.md` Probes B/C/F.

- **F-A1-1 · P0 · The S202 split deleted D-85's anti-omission redundancy.** The pre-split kernel
  carried `## ⛔ Mandatory Response Closer (Rule 9 restatement — D-85)` as a separate final H2
  (`core-template-mcp-v2-archive.md:299`, `:307` "No exceptions for short / tool-call-only /
  clarification questions. Every response."). The live kernel has no closer section; Rule 9 sits at
  `:109` of 179 with 70 lines after it, and the enumeration survives only on the fallback side
  (`core-template.md:258`). `CHANGELOG.md:73` records the merge. D-85's own rationale
  (`prism:.prism/decisions/architecture.md:179-187`) is that omission is attention-dilution and the
  end-of-template restatement was the load-bearing redundancy layer. Timeline (S202 → now) matches the
  symptom.
- **F-A1-2 · P0 · PR #115 is MERGED but never reached `main`.** `gh pr view 115` → base
  `prism-s5-model-capability-registry` (not main), merged 2026-08-02T14:54:45Z; #114 merged that same
  base to main 2m21s earlier (`66b68ee`). `git merge-base --is-ancestor 2093625 66b68ee` → false. Grep
  for `client_model|client_surface|resolveContextWindowOverride|CONTEXT_WINDOW_OVERRIDE|CONTEXT_WINDOW_STALE`
  across `src/` → zero. `resolveContextWindow` (`src/models.ts:451`) has no non-test callers. The whole
  brief-s5 window contract is absent from production. (Independently confirmed by C1/B/G; lead-verified.)
- **F-A1-3 · P1 · The window divisor is a single static number, prod-pinned to 200K with no alarm.**
  `bootstrap.ts:1768,1778` divide by / report `DEFAULT_CONTEXT_WINDOW_TOKENS`; on an Opus 5 / Sonnet 5
  chat session (true 1M) that is 5× too small. PR #115's `CONTEXT_WINDOW_OVERRIDE` warn — the thing that
  would make the override impossible to forget — is the orphaned code in F-A1-2.
- **F-A1-4 · P1 · Fallback Rule 9 map has no Opus 5 row and no disclosure clause.**
  `core-template.md:261` maps Sonnet 5→1M, Opus 4.8/4.7/4.6+Sonnet 4.6→500K, else→200K;
  `grep -c "Opus 5"` = 0. The MCP kernel has the corrected row and a disclosure mandate
  (`core-template-mcp.md:118`); the fallback has neither, so an Opus 5 fallback session silently reports
  against 200K. The failure class is already documented as a production incident
  (`reference/context-economy.md:29`: "64% reported against a true ≈13%").
- **F-A1-5 · P1 · No probe grades the denominator W.** `audit-harness.md:67` `rule9_calibration` checks
  only emoji-vs-percent internal consistency; a session at W=200K on a 1M model emits a self-consistent
  `🟠 ~74%` and passes while the truth is ~15%. Highest-leverage detection gap for the mis-scale symptom.
- **F-A1-6 · P1 · Probe C's every-response grades default to `inconclusive`.** `audit-harness.md:62,:125`
  require a full transcript artifact (which the harness itself says not to commit); live rows show all
  `inconclusive` (`prism:.prism/audit-trail.md:71`). The omission symptom is undetectable in steady state.
- **F-A1-7 · P2 · Kernel byte gate saturated at 31 B.** `kernel-byte-gate.test.mjs:36` limit 19 000;
  kernel measures 18 969 (`CHANGELOG.md:86`). Rule 9's §Estimation block (~1.4 KB) is the obvious next
  donor, and the D-279 re-derivation is owed. (See F-D6/F-B13/F-G-A1.)
- **F-A1-8 · P2 · `KERNEL_SPLIT_DRIFT` only checks H2 sections.** `bootstrap.ts:928-932`
  `findMissingKernelSections` compares six manifest names against `^##` headings; Rule 9's whole body
  (block, closer, tier table, §Estimation map) could be deleted with every manifest section still present
  and no diagnostic. (See F-D17.)
- **F-A1-9 · P2 · Nothing ties the registry's chat column to the kernel's prose map.** Two hand-maintained
  chat maps now exist (`src/models.ts:141-146`; kernel `:118`) plus a stale third on the fallback and a
  fourth static number in config — the duplication that caused the original 5× drift, intact.
- **F-A1-10 · P2 · Registry staleness computed by a function nobody calls.** `resolveContextWindow`
  returns `stale`/`stale_days` but has no caller (F-A1-2), and `model-freshness.yml` runs weekly-only.
- **F-A1-11 · P2 · D-227 vs brief-s5 unreconciled.** D-227 (SETTLED, `prism:.prism/decisions/operations.md:1108`)
  says the server cannot know the model so the field is transparency-only; brief-s5 resolves that (client
  declares the model) but D-227 is un-superseded and the kernel still encodes its distrust posture at
  `:120`.
- **F-A1-12 · P2 · Fallback asserts a server behaviour false in code.** `core-template.md:263` states the
  percent is "computed against a fixed 200K default"; the in-code default is 500K (`src/config.ts:73`).
  (See F-D7.)
- **F-A1-13 · P3 · README claims semantic parity that is false for the Rule 9 map** (`README.md:16`).
- **F-A1-14 · P3 · The Rule 9 regression test pins meter arithmetic but not the mandate, tier table, or map**
  (`rule9-context-meter-stability.test.mjs:206-219`).
- **F-A1-15 · P3 · prism's own handoff Meta pins the fallback version track** (Template Version 2.29.0 while
  booting kernel 3.1.6; `prism:.prism/handoff.md:4-7`).

**Verified healthy:** Rule 9 is boot-resident (not lazy); `behavioral_rules` is delivered whole and
untruncated; the mandate wording is genuinely mandatory not advisory; monotonic high-water math is
identical in both templates and unit-tested; `resolveContextWindow` never throws and discloses its
fallback; Fable 5's chat window is correctly floor-held on both sides; kernel and registry agree on every
chat figure they both carry; no boot-loaded standing rule contradicts the map (INS-306 is archived);
the S202 boot-lean knobs do not touch the meter.

## Axis A2 — boot + finalization banner delivery chain

- **F-A2-1 · P0 · Rule 2's masthead branch keys on field-nullness, not render success.** Under the live
  KI-29 outage every boot on the affected client takes the omit-items-1-2 path (field is non-null) and
  then cannot render item 3, losing the copyable session-name fence and the rename directive — the S157
  boot-contract collapse re-created by construction (`core-template-mcp.md:69,:80`;
  `prism:.prism/known-issues.md:48-52`; `bootstrap.ts:1637-1651`). Immediate zero-deploy mitigation:
  `BOOT_MASTHEAD_SVG=off` (both fields null → the six-item text path with the fence returns).
- **F-A2-2 · P0 · No directive covers "the widget call failed."** The finalize render mandate branches
  only on `finalization_banner_html === null` (`core-template-mcp.md:150`; `rules-session-end.md:34`),
  and the server almost always sets it non-null on the commit surface — so the `banner_text`-inline
  branch is effectively dead code, and a dead `show_widget` leaves the model with no instructed fallback
  while the FORBIDDEN list bans prose re-enumeration. S178 passed only because the model improvised the
  right fallback (`prism:.prism/audit-trail.md:61`) — correctness is luck. This is the direct "mostly
  miss" mechanism.
- **F-A2-3 · P1 · Rule 11 Step 6 (the detailed finalize render structure) is delivered only by
  `action=audit`.** `finalize.ts:2890-2951` fetches `rules-session-end.md` inside the `audit` branch
  only; the kernel forbids memorizing Rules 10–15 from boot (`core-template-mcp.md:148`). Any commit-only
  / full / `use_draft_files` path reaches a banner-bearing response holding only the one-line kernel
  obligation. (See F-D3.)
- **F-A2-4 · P1 · Four finalize response shapes return no banner field at all** — all on the D-275 F-1
  `use_draft_files` approve path (the current default): `finalize.ts:3073-3080` (no persisted draft),
  `:3083-3090` (draft carries no files), `:3093-3101` (stale/session mismatch), `:3129-3141` (no-files
  commit). Every other failure path routes through `assembleFinalizeErrorBannerFields` (`:2326-2344`);
  these four were added without it, and no test asserts a banner field on them.
- **F-A2-5 · P1 · Audit-harness Probe B is stale against framework v3.1.4** — it grades a spec-correct
  post-brief-715 boot (which omits B1/B2 by design) as `fail` (`audit-harness.md:56,:58` vs
  `core-template-mcp.md:69`), corrupting the only instrument that could measure this axis.
- **F-A2-6 · P1 · The S202 verification gate never ran.** `CHANGELOG.md:73` promised an audit-harness v4
  gate with a new Probe H and a same-day-revert rule; `grep -c "Probe H"` = 0; the last graded session is
  S180 (~23 stale); `finalize_contract` is graded on only 3 of 11 rows. "Mostly miss" is unfalsifiable
  from PRISM's own instrumentation.
- **F-A2-7 · P1 · D-263's dedicated ⛔ banner-render section was compressed to one kernel line** — its
  rationale ("a returned banner that is never rendered is invisible") and its remedial self-check ("add
  the render before submitting") now live only in the never-delivered archive
  (`core-template-mcp-v2-archive.md:313-322` vs `core-template-mcp.md:150`).
- **F-A2-8 · P2 · `banner-spec.md` self-contradicts** on whether the session-name fence survives the
  HTML-masthead branch (Note 6 vs Note 10, `:176`/`:179`) and its version history ends at 4.2 while the
  server emits 4.3.
- **F-A2-9 · P2 · `visualize:show_widget` — the single render channel for both banners — has zero presence
  in the server's tool-surface contract** (`tool-registry.ts:117-125`, no widget keyword), so a dead
  render channel is invisible to the boot Tool Surface check and the server logs record generation, never
  display (`bootstrap.ts:1647`).
- **F-A2-10 · P2 · Both mastheads ship on every boot under one knob (~9.7 KB) though Rule 2 renders exactly
  one** (`bootstrap.ts:1637-1651`); the SVG (~2.3 KB) is dead weight on any server that also emits the HTML
  field. (Fleet-version-skew caveat — see G.)
- **F-A2-11 · P2 · The error-banner fallback hardcodes `docCount: 0`** so deadline/hard-error banners
  assert "0/10 docs" even when the atomic commit landed (`finalize.ts:2334-2343,:3198-3201`).
- **F-A2-12 · P2 · `banner_data.deliverables` is uncapped** in both schema and renderer while `llm_usage`
  is capped at 8 (`finalize.ts:2869-2872` vs `:2314-2322`) — the one unbounded operator-controlled input
  on the banner path.
- **F-A2-13 · P2 · `finalize.ts` is 3 301 lines with the banner-render block duplicated verbatim at two
  sites and the error-banner shape at three** — the structural reason F-A2-4 shipped. (See F-C1-11.)
- **F-A2-14 · P3 · `config.ts:150-151` cites a stale template line range** for the masthead fallback path.
- **F-A2-15 · P3 · `normalizeFinalizationLlmUsage` truncates operator rows silently** — no diagnostic,
  unlike every other truncation (`finalize.ts:2311-2322`).

**Verified healthy:** one shared data contract feeds all three renderers (they cannot disagree by
construction); masthead render failures are independently isolated; `assembleFinalizeBanner` never throws;
the `banner_spec_version` drift handshake is live and quiet at 4.3; all banner interpolation is escaped;
the boot HTML copy control has no silent-failure branch; no response-size cap or truncation on the finalize
path can drop the banner (6.3 KB widget ≈ 1.6K tokens, far under the 25K ceiling); status/push/scale
correctly attach no banner fields; Probe F's definition is sound.

## Axis B — post-D-278 coherence sweep

- **F-B1 · P1 (P0 candidate) · PR #115 merged into #114's branch, never `main`** — see F-A1-2. The entire
  model-capability contract is absent from production; the framework hard-coded a distrust workaround
  (`core-template-mcp.md:120`) that now fires on every Opus 5 chat boot.
- **F-B2 · P1 · `session_state_manifest` has zero consumers fleet-wide; the boot-lean bundle is net +11 889 B
  at defaults.** PR #109 measured branch-defaults 79 419 B vs main 67 530 B; `compact` = 60 918 B. The
  precondition ("s202c template merge") landed (`prism-framework` `beb8f86`, 2026-07-14) but never taught
  the template to read the field: `git grep session_state_manifest origin/main` and `standing_rules_index`
  both return zero across the entire framework repo. The `compact` flip has no recorded soak or execution.
  (See F-D5, F-G redundancy.)
- **F-B3 · P1 · Three living-doc surfaces disagree on the current `LLM_ROUTING_OPENROUTER_SITES` membership.**
  `prism:.prism/insights.md:135-138` (INS-371), `task-queue.md:79`, `decisions/_INDEX.md:236` (D-277), and
  `d275-rollout.md:19,:43` say the kill-switch stands (2 sites); `handoff.md:28,:40` and
  `s202-refactor-proposals.md:322-323` say it was reverted (3 sites, "read-back verified S202"). The
  repository cannot answer whether `synthesis_brief` is on GLM today; a single `railway_env` read-back
  settles it. (Names/set-status only — value not read.)
- **F-B4 · P1 · The live prism handoff is a 30-day-old pre-merge snapshot** — all five Next Steps are done
  or moot (monitor already-merged PRs, verify already-landed fixes), Template Version 2.29.0 is two majors
  behind the live kernel 3.1.6, and it still boot-loads as Critical Context (`prism:.prism/handoff.md:4-6,:43-47`).
- **F-B5 · P1 · `session-log.md` has no S202 or S203 entry** — the S202 finalize commit (`75555984`) touched
  only `handoff.md`. The most consequential session in the window left no session-log entry, compounding
  known S190/S192 backfill debt.
- **F-B6 · P1 (P0 if `_INDEX.md` in any finalize `files[]`) · `prism_log_decision` mints statuses the
  server's own validator rejects.** `src/validation/decisions.ts:9` `VALID_STATUSES` lacks `DECIDED`;
  `:79-83` pushes it to blocking `errors`. Eleven rows (D-270…D-280) carry `DECIDED`. `log-decision.ts`
  writes via `safeMutation` with no validation, so the drift accumulated invisibly; any `prism_push` /
  finalize that includes `decisions/_INDEX.md` now hard-fails with 11 errors. (Lead-verified — §
  Verification evidence.)
- **F-B7 · P2 · `docs/model-bump.md`'s "single switch" is no longer true** — its own pin-audit predicate
  prints 8 lines at the pinned SHA (`provider-registry.ts:16` pins Opus 4.8; `cc-subprocess.ts:87-93`
  branches on `claude-sonnet-5`; `pricing.ts:38-40`).
- **F-B8 · P2 · `MODEL_CAPABILITIES` is documented nowhere** — a bump per the SOP silently drops the new
  model to the 200K floor.
- **F-B9 · P2 · `src/models.ts` recommends Opus 4.8 while documenting Opus 5 as a current chat model**
  (`:68-72` vs `:241-243`) — every banner recommends a generation behind the server's own docs.
- **F-B10 · P2 · `d275-rollout.md` §3 is a pre-S201 SOP** — it omits the INS-370 gate entirely and its
  failure ladder addresses the wrong failure class.
- **F-B11 · P2 · `HANDOFF_ITEM_OVERSIZE` fires on 5 of 5 items every prism boot** — the budget (300 B,
  `config.ts:141-146`) is below the measured 708 B mean; a permanently-firing diagnostic re-introduced
  in the same merge train that fixed the last one.
- **F-B12 · P2 · `standing-rules.md` is 319 147 B against a 150 000 B tripwire and grew across the S202
  curation pass** (retirement replaces bodies with markers in place while new rules land). (See F-B60/G-A8.)
- **F-B13 · P2 · The Band-1 kernel sits 31 bytes under its gate and D-279's owed re-derivation has no
  brief** (`kernel-byte-gate.test.mjs:36`). Blocks several framework-side fixes.
- **F-B14 · P2 · `CLAUDE.md`'s Trigger-state pointer is stale** — it names `state/prism-mcp-server.json`
  in the trigger repo, which has no `state/` (migrated to `~/.trigger/state/` at the S151 cutover).
- **F-B15 · P2 · The s202c "fallback-side follow-up" never landed** — non-MCP boots still carry the 52 KB
  monolith (`CHANGELOG.md:73`); a promise declared temporary is now permanent by default.
- **F-B16 · P2 · brief-s5 "step 3" is blocked behind F-B1** and the kernel's distrust stopgap is now
  load-bearing.
- **F-B17 · P3 · `d275-callsite-inventory.json` citations are pinned to a superseded SHA.**
- **F-B18 · P3 · The archived-rule exclusion matches anywhere in a rule's body and emits no diagnostic**
  (`standing-rules.ts:163`) — no false positive today, but a future active rule discussing archival would
  be silently dropped.
- **F-B19 · P3 · `trigger-retrofit.md` is orphaned** — no trigger row anywhere in `_templates/`. (See F-D13.)
- **F-B20 · P3 · `prism:.prism/handoff.md` carries two conflicting `## Recommended Session Settings`
  sections** (`:9-16` fenced Sonnet 5 vs `:18-22` bare opus-4-8); the fenced one wins but the duplicate is
  permanent until hand-removed.
- **F-B21 · P3 · `CLAUDE.md`'s env-surface disclaimer undercounts** — "~40 reads" vs 90 unique names read
  in `src/` (C2). (See C2 exception list.)

**Merge-train ledger** (PR → intent → shipped? → residue): #108 s202a docs ✅ (residue: compact flip +
steps 3/5 unexecuted, stale trigger-state pointer never acted on); #109 s202b knobs ✅ (+11 889 B redeemed
only by the unflipped `compact`; 300 B item budget fires 5/5); #110 truncation ✅ (satisfies INS-371
precondition, retest never recorded); #111 tolerant Kernel-Manifest ✅ fully correct; #112 boot_masthead_html
✅ (+7 464 B, flagged, unretired); #113 CLOSED (brief ran anyway, step 3 blocked, operator prereq untracked);
#114 registry data-only ✅ (still inert, undocumented, self-contradictory recommendation); **#115 merged into
#114's branch ❌ not on main**; fwk #38 kernel v3.0.0 ✅ (never added manifest consumption, fallback follow-up
never queued); fwk #39 synthesis-quality-gate ✅ (d275-rollout §3 never learned it exists); fwk #49/50 Rule 9
map + D-279 ✅ (31 B headroom, re-derivation unscheduled); prism #338/#339 curation ✅ (file grew 298→319 KB);
prism finalize S202 ⚠️ handoff-only (no session-log S202/S203).

**Verified healthy:** the Kernel-Manifest handshake is exactly consistent both sides (PR #111 correct); the
retired-rule exclusion works (the s202a "INS-319 still boot-loads" finding is closed — six markers, replay
excludes exactly the six intended rules); `boot_masthead_html` is genuinely consumed; the D-275 provider wall
matches its normative source exactly and CS-4/CS-5 are structurally unreachable; the tool count (32) and
server version (4.13.0) are accurate everywhere; provider credential/model env names are complete; the
CHANGELOG is current for both live template versions.

## Axis C — prism-mcp-server code health (C1 correctness + C2 inventory)

### C1 — correctness / robustness

- **F-C1-1 · P1 (P0 if Railway appends XFF) · Auth can reduce to a client-controlled header.**
  `src/middleware/auth.ts:41-53` — the `MCP_AUTH_TOKEN` block rejects only *inside* the
  `authHeader?.startsWith("Bearer ")` branch; a request with no Authorization header falls through to the
  IP check, which trusts the leftmost (client-settable) `X-Forwarded-For` (`:23-29`), and then to `next()`
  (`:72`) when `ENABLE_IP_ALLOWLIST` is false. The fall-through is unconditional in code; exploitability is
  conditional on Railway's XFF handling and the allowlist state. The reject-on-missing-header fix is
  unconditionally correct and cheap. (Lead-verified — § Verification evidence.)
- **F-C1-2 · P1 · A transient GitHub error makes `prism_log_decision` / `prism_log_insight` overwrite a
  living document with a one-entry starter and report success.** `log-decision.ts:118` `} catch {` treats
  any error as "domain absent" and writes a starter file (`:239-245`); `doc-resolver.ts:44-48` deliberately
  rethrows non-404 errors, so a transient 401/403/timeout is misread as absent. The INS-360 recreate guard
  (`finalize.ts:238-271`) exists but was never applied to the log tools. Silent data loss on 3 of the 10
  mandatory docs, reported as success.
- **F-C1-3 · P1 · `action=full` commits `handoff.md` alone and reports `draft: ok` when the model JSON fails
  to parse.** `finalize.ts:987-995` returns `success: true` with `raw_content` on parse failure; the bridge
  and `draft_recovery` are both gated on `"drafts" in draftResult` (`:2622,:2799`), so the raw text is
  dropped with no `DRAFT_FAILED` signal.
- **F-C1-4 · P1 · The PR #114 registry has zero production consumers; the boot payload still reports a flat
  500K window.** Same root as F-A1-2/F-B1, from the code-health angle: 377 lines + a 30-day staleness clock +
  a CI drift job guarding a value nothing reads.
- **F-C1-5 · P1 · `prism_bootstrap` — the heaviest tool — is the only I/O-heavy tool with no wall-clock
  deadline.** Every peer (push/finalize/analytics/search/status/fetch/patch/scale) has one; bootstrap runs
  slug resolution + core fetches + a boot-test push + a trigger-marker write + a cross-repo state read + a
  Railway log query + prefetches + a possible commit with no deadline race, so a hang returns a bare
  transport timeout instead of the structured envelope.
- **F-C1-6 · P1 · `draftPhase`'s outer `catch {}` also swallows compose/persist exceptions and mislabels
  them as a JSON parse failure** (`finalize.ts:888-995`) — a transient 403 persisting the draft surfaces to
  the operator as "Could not parse structured JSON" with `success: true`.
- **F-C1-7 · P2 · The finalize draft deadlines (180s / 300s) are 3–6× the MCP client ceiling**, so the
  structured timeout response can never be delivered and a slow `action=draft` triggers a retry + a second
  synthesis (`config.ts:429-445`; `finalize.ts:2956-2965`).
- **F-C1-8 · P2 · A single `fetchWithRetry` call can burn ~360s** — 6× the whole MCP budget
  (`client.ts:194-197`, unbounded per-call backoff; the 120s per-sleep cap is 2.4× `MCP_SAFE_TIMEOUT`).
- **F-C1-9 · P2 · `safeMutation`'s landed-but-unreported detection identifies commits by message, and PRISM
  messages are templated** (`safe-mutation.ts:211-223`) — under the concurrent-write protocol a genuine 409
  whose HEAD carries the other actor's identically-templated commit is read as "our commit landed," dropping
  the mutation while reporting success.
- **F-C1-10 · P2 · Graceful shutdown is wired without its reaper** (`index.ts:237` passes no `onDrain`,
  `shutdown.ts:5-9`) — on every Railway deploy, in-flight background synthesis is SIGKILLed with no log and
  async `cc_dispatch` records are stranded at `running` forever.
- **F-C1-11 · P2 · `finalize.ts` is 3 301 LOC with an 813-line `commitPhase`; ~6 distinct responsibilities.**
  Pure/near-pure extraction seams: `finalize/banner.ts` and `finalize/audit.ts` (the full 6-way split is L —
  deferred).
- **F-C1-12 · P2 · `prism_push` with an empty `files[]` returns `all_succeeded: true` and no `isError`**
  while the underlying commit fails (`push.ts:34-40,:242,:264` — no `.min(1)`).
- **F-C1-13 · P2 · Dynamic slug resolution can substring-match an arbitrary repo, and bootstrap then writes a
  boot-test file (and, under `TRIGGER_AUTO_ENROLL`, an enrollment marker) into it** (`bootstrap.ts:783-786,:1039-1040`).
- **F-C1-14 · P2 · Read-path catches convert transient GitHub failures into confident-looking zeros**
  (`status.ts:200-206`, `analytics.ts:355-361`) — during a blip `prism_status` reports `handoff_version: 0,
  session_count: 0` with no diagnostic.
- **F-C1-15 · P3 · GitHub client hygiene** — unbounded repo pagination, a missing `< 100` short-circuit, and
  two un-cancelled response bodies (`client.ts:475-488,:504-506,:645-651`).
- **F-C1-16 · P3 · Body parsing runs before authentication** (`index.ts:58-60`).

**C1 top-5 riskiest functions:** `authMiddleware` (auth.ts:33-73), `registerLogDecision`'s resolve block +
`computeMutation` (log-decision.ts:112-253 + log-insight twin), `commitPhase` (finalize.ts:1255-2054),
`draftPhase` (finalize.ts:742-996), `fetchWithRetry` (client.ts:167-230).

**C1 verified healthy:** `safeMutation`'s deadline fencing prevents post-deadline commits; validation is
ordered after in-memory mutation and before any write; the INS-360 recreate guard is correct; synthesis
refuses to overwrite a good brief with truncated output; provider errors are scrubbed of credentials before
logging; the routing master switch fails safe; `resolveContextWindow` never throws; CIDR parsing rejects
out-of-range octets and `/33` prefixes; bootstrap attaches its oversize diagnostic last so it ships in-payload;
`pushFile` discriminates a genuine 404 from an operational error.

### C2 — mechanical inventory (supporting data)

- **LOC:** src/ 29 000 (92 prod files); tests 39 341; grand total 68 341. Largest: `finalize.ts` 3 301
  (3.6× the next), `bootstrap.ts` 1 838, `scale.ts` 1 608, `github/client.ts` 1 198, `analytics.ts` 1 004.
- **Tool registry:** `TOOL_REGISTRY` (32) is byte-identical to the 32 `server.tool(...)` registrations and
  matches CLAUDE.md's 14/10/2/6 breakdown exactly — **no drift**, none registered-but-undocumented or
  documented-but-unregistered.
- **Env surface:** 90 distinct `process.env` names read in `src/`; **31 are absent from both CLAUDE.md and
  `.env.example`** (all `*_DEADLINE_MS`, `DEFAULT_CONTEXT_WINDOW_TOKENS`, the oversize/cap thresholds, the
  `RECOMMENDATION_MODEL_*` cluster, `CC_DISPATCH_EFFORT`, and others), and 34 of the 90 are read entirely
  outside `src/config.ts`, so CLAUDE.md's "the surface lives in config.ts" pointer does not cover them. No
  var is documented-but-never-read.
- **Dead-code candidates:** the confirmed live-but-inert item is the model-capability registry
  (`MODEL_CAPABILITIES`/`resolveContextWindow`, test-only — F-A1-2). **The rest of C2's cross-file-import
  heuristic list contains false positives for same-file-only-used exports** (e.g. `escapeMarkup`,
  `OPENROUTER_MECHANICAL_SURFACES`, `parseOpenrouterSites` are live per A2/B); this list requires per-item
  confirmation before any removal and is **not** carried into the implementable set.
- **Zero TODO/FIXME/HACK/XXX markers** in `src/` or `tests/`.
- **Tests:** 156 files, 1 786 `it`/`test` calls. The `gh_*` tool-registration wrappers (create/update release,
  delete branch/tag) have no direct test (coverage is via lower-level `github/client.ts` functions).
- **Deps:** `@anthropic-ai/claude-code` has no `import` (consumed as a spawned CLI binary — expected).

## Axis D — prism-framework

Byte-budget headline: Band-1 kernel `core-template-mcp.md` = **18 969 B / 19 000 B gate → +31 B headroom**
(0.16%). The superseded S202 ceiling (18 000) is still stated at `reference/context-economy.md:11`, and
D-279 (the owed re-derivation against the corrected 1M window) is recorded only in a decision row and a test
comment. Band-2 modules: 12 files, 84 970 B. Band-3 reference: 14 files, 107 924 B. Fallback `core-template.md`:
52 341 B.

- **F-D1 · P1 · Fallback Rule 9 map omits Opus 5 → silent 5× over-report** — framework-side confirmation of
  F-A1-4.
- **F-D2 · P1 · `rules-session-end.md`'s ⛔ DRAFT PASS-THROUGH hard rule contradicts the live
  `FINALIZE_COMPOSE_MODE=files` contract.** `:18` mandates pulling draft content back through the model into
  `files[]` "no exceptions"; `finalize.ts:947` offers `use_draft_files: true` with no `files[]`. The
  framework term for `use_draft_files`/`draft_files` appears zero times. Ambiguity + the exact token
  round-trip F-1 eliminated.
- **F-D3 · P1 · Kernel forbids memorizing Rules 10–15 but the server delivers them only on `action=audit`**
  — framework-side confirmation of F-A2-3.
- **F-D4 · P1 · `project-instructions.md` (Tier-1, test-pinned) mandates two behaviors the kernel has no slot
  for and one it contradicts** — PI-13's identity self-report (`:13`) has no slot in Rule 2's fixed grammar
  and its FORBIDDEN list arguably bans it; PI-11 (`:11`) declares a null `behavioral_rules` a failed identity
  canary with a mutation freeze, while the kernel (`:50`) treats the same condition as a routine alternate
  source path.
- **F-D5 · P1 · `session_state_manifest` ships every boot with zero framework references** — framework-side
  confirmation of F-B2; the `compact` precondition reads as satisfied when it is not.
- **F-D6 · P2 · The kernel is 31 B under a budget its own rationale carrier states as 18 000 B, and D-279 is
  unrecorded there** (`context-economy.md:11` vs `kernel-byte-gate.test.mjs:36`).
- **F-D7 · P2 · Both the Band-3 rationale carrier and the fallback state a wrong mechanism for
  `total_boot_percent`** (5× vs the real 2×; `context-economy.md:83`, `core-template.md:263`) — the server
  changed the default 200K→500K and the carriers never followed.
- **F-D8 · P2 · The kernel's "flag the mismatch" rule fires on every Opus 5 / Sonnet 5 chat boot** — a
  permanently-firing advisory (`core-template-mcp.md:120` vs the server's always-500K field).
- **F-D9 · P2 · `reference/mcp-tool-surface.md` documents 19 tools; the server registers 32** (13 undocumented:
  x_sentiment, 6 Railway provisioning, 6 gh_*), and the kernel has no trigger to load it (2 months stale).
- **F-D10 · P2 · Three-way disagreement on the Tool Surface line's category list** (`core-template-mcp.md:54`
  shows three and drops cc; `banner-spec.md:136` shows three and drops gh; the server ships four).
- **F-D11 · P2 · Banner spec version claimed three ways** (banner-spec.md title 4.2, kernel/rules 4.3,
  README 4.1; server 4.3).
- **F-D12 · P2 · README is stale** on version (2.20.6), module count (8 vs 12), tree, and the entire band
  architecture — a re-flag of an unremediated S167 finding.
- **F-D13 · P2 · Two Band-2 modules (13.4 KB) appear in no Module Triggers table** — `metaswarm-integration.md`
  is reachable via onboarding, `trigger-retrofit.md` is fully orphaned.
- **F-D14 · P2 · 12 of 14 Band-3 reference docs have no MCP-kernel load trigger**, including the commit-prefix
  rules the server hard-enforces (`commit-prefixes.md`) — an MCP session composing a push has no boot-resident
  prefix list and no route to one.
- **F-D15 · P2 · The kernel's ⛔ pre-dispatch load mandate collides with Rule 6's >15 KB summary-first rule**
  (`trigger-channel.md` is 33.7 KB and the v3.1.6 design relies on full possession of its § Account selection).
- **F-D16 · P2 · Rule 9's loophole-closing enumeration and its motivating harm were dropped, not relocated** —
  framework-side confirmation of F-A1-1; "nothing was deleted, it was moved" (`context-economy.md:17`) is
  violated for these two sentences.
- **F-D17 · P2 · The Kernel-Manifest drift guard has H2-only resolution** — framework-side confirmation of
  F-A1-8 (the PR #111 fix is correct; the residual is granularity — `## Session Lifecycle` carries 4 of 6 ⛔
  mandates and its whole body could vanish silently).
- **F-D18 · P2 · The kernel SESSION END band carries no operator-utterance finalize trigger** — its only ⛔
  presupposes a finalize call already happened.
- **F-D19 · P3 · D-263 is cited nowhere in the framework** ("D-85 sibling" only).
- **F-D20 · P3 · The fallback declares no `Banner-Spec-Version`, exempting it from the drift handshake**
  (defensible today, silent).

**Verified healthy:** the Kernel-Manifest handshake is exactly consistent both sides; version pins agree in
lockstep (kernel 3.1.6, fallback 2.29.2, all six test pins); `Banner-Spec-Version` 4.3 is consistent across
the two files the server checks; Rule 9 tier thresholds and meter mechanics are identical and test-pinned;
the masthead branch logic matches the server's null semantics; Rule 2A's kernel pointer + archive mirror the
server payload; both banner mandates enumerate every outcome state; all three `docs/` legacy files carry
DEPRECATED banners; every Band-2 module is self-describing; the Rule 9 chat map agrees cell-for-cell with the
registry.

## Axis E — trigger daemon

- **F-E1 · P0 · No daemon-side launch-model pin, default, or verification exists anywhere.**
  `worker.ts:368-388` emits `--model` only when the brief frontmatter carries one; `frontmatter.ts:84-85`
  reads `model` only from YAML; no config or env key defines a default; the s203a/s203b records show
  `execution.model_used: null`. `briefs/archive/brief-434-model-effort-pinning.md:9` documents the intent
  ("whatever the CC default resolves to at dispatch time — non-deterministic … by luck, not by pin"). This
  is the structural cause of the s203a wrong-model launch and is armed for s203b.
- **F-E2 · P1 · The daemon hard-caps effort at `max` and silently shadows the operator's machine-wide `xhigh`
  standard.** `frontmatter.ts:39` `VALID_EFFORT` lacks `xhigh` (→ silently `undefined`); `worker.ts:379`
  emits the `CLAUDE_CODE_EFFORT_LEVEL` prefix unconditionally, so every dispatched pane runs one tier below
  the operator directive and `effort: xhigh` in a brief is silently downgraded.
- **F-E3 · P1 · The dispatch is unobservable at the model/command level** — the launch log carries only
  `{workerId, briefId, paneId, account}` (`worker.ts:1025-1035`) and the journal records `model_used:
  record.model ?? null` (`:1226`), the pin not the resolved model.
- **F-E4 · P1 · ~132 000 false "poller: retrying …" INFO lines for briefs whose queue file does not exist**,
  and the launchd stdout is 794 MB unrotated. `poller/index.ts:352` iterates history only; `:382-390` logs
  "retrying … unbounded while queue file exists" for ids whose file is gone (verified: `origin/briefs` queue
  holds only `.gitkeep` + this brief). The parenthetical is affirmatively false for every one of these lines.
- **F-E5 · P1 · Terminal brief_ids are auto-burned by the poller with only a `trace`-level trace, and the
  retry-frontmatter reproduces the original defect.** `poller/index.ts:311` blocks terminal statuses;
  `:363-370` logs at `trace`; `buildRetryFrontmatter` (`manager.ts:56-70`) carries `model: record.model`
  forward, so `trigger retry brief-s203a` relaunches on the same absent pin. (INS-368 is half-fixed: the
  S198 latch is gone and the CLI is a genuine exit.)
- **F-E6 · P1 · "No exit-marker AND no PR" is a fully silent leg** — `scheduler/index.ts:718-720` bare
  `return` with no log; the registration watchdog is nested inside `if (marker)`; the only backstop is a
  warn-only 4h age ntfy. A brief held the active slot for 8.5h before `abandoned_pane_dead`.
- **F-E7 · P1 · Brief-branch detection death is announced once per daemon lifetime, then degrades to `debug`
  forever** (`orchestrator.ts:2191-2211`); two enrolled projects are currently detection-dead and silent.
- **F-E8 · P2 · Nested subdirectories under `brief_dir` are still queueable by construction** — the PF2
  76-brief incident class is latent, fixed only in one project's config (`poller/index.ts:83-90,:536-537`
  recursive `ls-tree` + basename match, depth never bounded).
- **F-E9 · P2 · Runtime config carries five retired key families the validator ignores, one documenting a
  precedence rule that does not exist, and four live knobs are absent** from the runtime config
  (`~/.config/trigger/trigger.config.yaml` vs `src/config/schema.ts`).
- **F-E10 · P2 · Both live markers list the retired `notify` post_merge action** (`post-merge.ts:23-28`
  records a phantom `skipped`).
- **F-E11 · P2 · Post-merge clone sync still checks the operator's HEAD back to `main` when the tree is clean
  and HEAD sits on the merged branch** (`clone-sync.ts:221,:245-259`) — the dirty-tree gate protects
  uncommitted work, not a committed-but-unpushed branch checkout.
- **F-E12 · P3 · `TRIGGER_KEEP_PANES_OPEN=true` + a boot-only orphan-pane reaper** → spent panes accumulate.
- **F-E13 · P3 · INS-369 (deploy verification) has zero code-level mitigation** — the daemon never logs which
  commit its `dist/` was built from (`index.ts:195-217` logs the CLI version, not the daemon's).

**Verified healthy:** INS-367's primary defect is fixed (full-brief-id boundary-anchored matching) and its
instrumentation added (`pr_registration_miss`); INS-364's repo-invisible-preflight and preflight-budget-latch
classes are addressed; INS-368's recovery path is fixed; state writes are atomic (temp+rename); in-process
state-branch writes are serialized; concurrent-transition guards re-load before writing; a transient PR-lookup
failure can never terminalize; terminal cleanup handles the already-dequeued case; all osascript/tmux
subprocesses are wall-clock bounded; clone sync never discards uncommitted work; boot auth fails closed;
explicit-config-wins over marker discovery is intentional and documented.

## Axis F — prism living-docs hygiene

All 10 mandatory docs present at `.prism/`, all with valid EOF markers. Nine of the ten were last touched
≤ 2026-07-14; only `decisions/_INDEX.md` has commits after (through 2026-08-13).

- **Handoff (F-B4):** 9 228 B (under target). Meta Session Count 202 with no session-log entry; Template
  Version 2.29.0 vs live kernel 3.1.6. Two conflicting `## Recommended Session Settings` blocks (F-B20).
- **Session-log (F-B5):** no S202/S203 entry; entries out of chronological order per the S192-restoration
  preamble.
- **Decisions index:** parses clean, 232 rows, no duplicate IDs; **11 rows carry the invalid status `DECIDED`
  (D-270…D-280) (F-B6)**; the domain summary line (`:4`) sums to 123 across 9 domains while the table has 232
  across 11 (omits `infrastructure`, `process`); D-N gap D-91…D-138 (48 IDs).
- **Standing rules / insights (F-B12):** `standing-rules.md` = 319 147 B, 2.13× the 150 000 B tripwire and
  larger than the 303.7 KB figure INS-363 cites as the trigger, despite two same-day retirement passes;
  INS-363 remains Active with unchanged text.
- **Task-queue:** last committed 2026-07-14, no D-279/D-280 trace; lists brief-s202a `[DISPATCHED]` while the
  handoff says CANCELLED; Recently-Completed leads S193 while the index is at S203.
- **Glossary:** 84 060 B (outlier); zero entries for kernel / band / Kernel-Manifest / session_state_manifest /
  standing_rules_index / BOOT_INDEX_MODE / FINALIZE_COMPOSE_MODE / context-meter; stale "Anchored estimation"
  (D-56) and "Smart prefetch" (D-45); "Core template v2.28.0."
- **Known-issues:** KI-26's resolution names the wired fix as `sanitizeContentField()`, but the wired function
  is `sanitizeContent` (`log-decision.ts:13`, `log-insight.ts:18`, `patch.ts:16-19`); `sanitizeContentField`
  has no non-test callers.
- **Archives:** `known-issues-archive.md` and `eliminated.md` last touched 2026-04-05 despite subsequent
  Resolved entries; no migration.

## Axis G — efficiency & cost (measured; tok = chars/3.5 proxy, flagged)

**Boot-payload totals (measured via offline re-execution of the real pure functions against real prism data):**

| Combination (knobs) | wire bytes | `bootstrap_tokens` |
|---|---:|---:|
| current-default (full / dedup / opening_only / masthead-on) | 106 353 (103.9 KB) | **28 665** |
| all-lean (compact / dedup / opening_only / masthead-off) | 76 023 (74.2 KB) | **20 041** |
| legacy (full / legacy / legacy / on) | 109 889 (107.3 KB) | 29 651 |

**D-278 targets vs measured:** the design-doc §3 (current) target is ~11.6–12.4K tok; the living-docs target
~10–12K. **Even the fully-lean combination (20 041 tok) is +7.6–8.4K tok over target.** The residual gap is
dominated by two components no audited knob controls: the rules-index/manifest overshoot (14 685 B / ~4 196
tok, 3.2× its own design target) and the untracked `boot_masthead_html` (~7.3–7.5 KB / ~2.1K tok, added after
the D-278 cost model and absent from its budget line). Two irreconcilable "S202 measured baseline" numbers
circulate (41 368 vs 33 879 tok — a 22% discrepancy that changes "% reduction achieved" from ~24% to ~42%).

**Cheap wins (measured):** flipping `BOOT_INDEX_MODE=compact` once the manifest is consumed removes the
20 908 B legacy `standing_rules_index` with zero information loss (it and `session_state_manifest.rules.index`
ship the same 106 rules simultaneously today). `standing-rules.md` (319 147 B) is fetched and regex-parsed in
full every boot to deliver 8 of 114 rules (96.5% discarded post-parse) — a server compute/IO cost, not a
payload cost.

**Synthesis routing economics (names/defaults only):** `synthesis_draft`/`brief`/`pdu` default to Anthropic
`messages_api` on `claude-opus-4-8` with thinking on; all six alternate providers are dead-by-default
(`LLM_ROUTING_ENABLED` unset). `cc_dispatch` is Claude-only permanently (routing-policy hard-wall).
`x_sentiment` needs four explicit env flips + `XAI_API_KEY` to go live. `pricing.ts` is missing price rows for
`deepseek-v4-pro` and `sonar-pro` (unacknowledged) beyond the acknowledged `grok-4.3`.

---

## Cross-axis convergence (findings confirmed by ≥ 2 independent axes)

| Finding | Axes | Recommendation |
|---|---|---|
| PR #115 never reached main → registry dead, flat window | A1, C1, B, G + lead-verified | R1 |
| Fallback Rule 9 map missing Opus 5 | A1, D | R4 |
| Kernel 31 B headroom / D-279 re-derivation owed | A1, D, B, G | R36 |
| `session_state_manifest` has no consumer | D, B, G | R35 + env flip |
| D-85 closer / Rule 9 enumeration dropped by the split | A1, D | R3 |
| Finalize rules delivered only on `action=audit` | A2, D | R11 |
| D-263 banner section compressed, rationale lost | A2, D | R15 |
| `context_estimate` mechanism wrong in the carriers | A1, D | R44 |
| `DECIDED` status is invalid | B, F + lead-verified | R57 |
| `finalize.ts` oversized | C1, A2 | R27 |
| handoff / session-log frozen at 2026-07-14 | B, F | R58 + R59 |
| `standing-rules.md` 319 KB grew across curation | B, F, G | R60 |
| Two Recommended Session Settings blocks | B, F | R62 (folded into R58) |
| Kernel flag-mismatch fires every boot / registry dead | A1, D, C1, B, G | R1 + R2 |
| mcp-tool-surface / Tool Surface stale | D | R37 + R38 |
| Orphaned `trigger-retrofit` module | D, B | R40 |

---

## Verification evidence (Fable 5 lead, independent of the swarm)

1. **PR #115 recovery is conflict-free.** `git merge-tree --write-tree --messages 66b68ee de46d20` exits 0
   (no conflicts). The recovery delta is exactly `src/config.ts +28`, `src/tools/bootstrap.ts +96`,
   `tests/bootstrap-budget.test.ts +1`, `tests/bootstrap-context-window.test.ts +326` (+449 / −2), and it
   does **not** touch `src/models.ts` — because #114 already landed the registry on main. #114 shipped the
   table; #115 shipped the wiring; the wiring cherry-picks cleanly onto the merged table. The remote branch
   `prism-s5-bootstrap-context-window` (`de46d20`) still exists. Confirms R1 as effort S / risk low.
2. **`DECIDED` status rejection, mechanism confirmed.** `src/validation/decisions.ts:9` `VALID_STATUSES` lacks
   `DECIDED`; `:79-83` pushes to blocking `errors`. `src/validation/index.ts:30-31` validates `_INDEX.md` on
   any `validateFileAndCommit`; `src/tools/push.ts:89-92` invokes it unless `skip_validation`. But
   `src/tools/log-decision.ts` writes via `safeMutation` (no validation route), which is why 11 `DECIDED` rows
   accumulated invisibly. Latent P1: routine logging never trips it; any manual `prism_push` / finalize
   including the index hard-fails with 11 blocking errors. Confirms R57.
3. **Auth fall-through confirmed unconditional in code.** `src/middleware/auth.ts:41-53` — the reject lives
   only inside the `Bearer ` branch; a no-Authorization request reaches the IP check (leftmost-XFF,
   client-settable, `:25`) and then `next()` (`:72`) when the allowlist is off. Exploitability is conditional
   on Railway's XFF handling; the reject-on-missing-header fix (R20) is unconditionally correct.

<!-- EOF: audit-findings.md -->
