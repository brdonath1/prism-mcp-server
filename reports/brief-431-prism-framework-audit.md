# Brief 431 — Comprehensive PRISM Framework Audit & Intelligence Review

**Model: `claude-opus-4-8` · effort max** (model gate §0 honored — running model recorded per §0.3)
**Phase A of D-240 — analysis only.** No code changed in any repository. This report supersedes the stale-clone `reports/brief-430-prism-framework-audit.md` (deleted in this same branch).
**Date:** 2026-06-03 · **Branch:** `brief-431-prism-framework-audit` · **Author:** autonomous Trigger dispatch (Opus 4.8)

---

## Executive Summary

PRISM's machinery is working *better* than brief-430 reported — the decision/insight **capture pipeline is healthy** (192 decisions through D-240; INS-283; 239 STANDING-RULE markers — all verified against current clones). The real problems are **downstream of capture**: an unbounded `insights.md`, an archival policy that structurally cannot fire, a synthesis layer fed a third of a million tokens per call, and — most importantly for the D-240 autonomous mandate — **an auto-merge loop with no CI gate at any layer.**

### Single most important finding (CRITICAL)
**CI is not a merge gate — at either available layer — so the planned hands-off Phase-B auto-merge loop (INS-281/INS-282) is unsafe as built.** `trigger/src/github/merge.ts` squash-merges on GitHub's conflict-only `mergeable` flag and never inspects check-runs or combined status; `mergeable_state` is captured but never branched on. Independently, **neither `brdonath1/prism-mcp-server` nor `brdonath1/trigger` has any branch protection** (`gh api …/branches/main/protection` → 404 "Branch not protected"; rulesets `[]`). And the `trigger` repo — the component that performs the merges — **has no CI workflow at all.** A regression that turns CI red would merge unnoticed. **This must be fixed before any unattended Phase-B brief merges.**

### Top recommendations (full scoring in the Prioritized Roadmap, Phase 10)

| # | Recommendation | Tier | Axes (Ctx/Spd/Rel) | Risk |
|---|----------------|------|--------------------|------|
| R1 | **Add a real CI merge-gate**: make `merge.ts` require green required-checks on the PR head SHA **and** enable branch protection on both repos' `main` with `required_status_checks`; stand up CI on `trigger`. | Quick→Medium | –/–/**+++** | Human-checkpoint (daemon change) |
| R2 | **Decouple insights archival from the finalize files-array** and run a dedicated, unconditional retention pass; **separate STANDING RULEs from the chronological insight log** so the log can actually shrink. | Medium | **++**/**++**/**+** | Human-checkpoint (irreversible doc moves) |
| R3 | **Bound synthesis inputs**: cap/slice what CS-1/CS-2/CS-3 read (today 175K–325K tokens/call) instead of feeding whole unbounded docs; immediate unblock = archive `insights.md`. | Medium | **++**/**+++**/**++** | Human-checkpoint (synthesis transport) |
| R4 | **Per-brief model+effort**: thread `model:`/`effort:` brief frontmatter into `buildClaudeCommand` (~4-file change); stop relying on luck that the worker launched Opus 4.8. | Quick | **+**/**+**/**++** | Auto-merge safe (additive) |
| R5 | **Brief-lifecycle hygiene**: add a failure-path cleanup so terminal-failed briefs (e.g. `brief-421`, a dead orphan whose KI-26 work already shipped) leave the polled queue; document `*.status.json` as dead. | Quick | –/**+**/**++** | Auto-merge safe |
| R6 | **Resumability**: pane-independent completion detection (exit-marker the dispatched `claude` writes, polled from the tick) so pane-death / daemon-restart don't strand work. | Architectural | **+**/**+**/**+++** | Human-checkpoint (daemon change) |
| R7 | **Exploit the 500K window for richer carryover** (reverse D-47/D-193 slimming): deliver the full intelligence brief + more standing rules + richer banner at boot; fix `DEFAULT_CONTEXT_WINDOW_TOKENS` (200K→500K) and the boot token-estimate numerator. | Quick→Medium | **+++**/–/**+** | Auto-merge safe |
| R8 | **Enforceable boot + finalization banner spec** (Phase 8): one richer, server-rendered, drift-proof spec for both banners; resolve the live fallback contradiction; log D-84/D-85 in the framework CHANGELOG. | Medium | **++**/–/**+** | Auto-merge safe |

**What is NOT a problem (correcting brief-430):** there is **no decision/insight capture gap**. The index holds 192 decisions through D-240; D-240 is a full entry in `decisions/optimization.md`; INS-281/282/283 are present in `insights.md`. brief-430's "tops out at D-234" claim was an artifact of reading a stale `prism` clone (the precise failure INS-283 now codifies). Do not build a "reconcile D-235…D-240" capture-enforcement item; a lightweight finalize-time "referenced-but-unlogged ID" warning is the only defensible safety net, and it is optional.

---

## Methodology

**Currency (Pre-Flight §1 — the entire reason brief-431 exists).** Every repo this audit read was brought to current `origin/main` *before* reading (`git fetch` + `git merge --ff-only origin/main`); all four fast-forwarded cleanly, so **no fresh temp clone was required**. The `prism` clone in particular fast-forwarded `c666165 → 0fc1073`, pulling in a just-logged `insights.md` change — exactly the staleness that made brief-430 read a clone topping out before D-240. Per Pre-Flight §1c, the **HEAD SHA of every repo actually read** is recorded here so the currency of this analysis is verifiable after the fact:

| Repo | HEAD SHA (read) | Short | Date | Source |
|------|-----------------|-------|------|--------|
| `prism-mcp-server` | `519137be55356ea91d6b6ded301ccf22e68bb596` | `519137b` | 2026-06-03 | local clone, fast-forwarded (already current) |
| `prism-framework` | `dce04d66d84f94ea06d6144d39295f073bbdd45e` | `dce04d6` | 2026-05-30 | local clone, fast-forwarded (already current) |
| `trigger` | `daa3e7693ebf050f6c283ccb3b73267bd87b588c` | `daa3e7693e` | 2026-06-03 | local clone, fast-forwarded `f05d196822 → daa3e7693e` |
| `prism` | `0fc1073f9b095032d0ee1f6c55de89fe166a612a` | `0fc1073` | 2026-06-03 | local clone, fast-forwarded `c666165 → 0fc1073` |
| `trigger` (state branch) | `origin/state` | — | 2026-06-03 | read via `git show origin/state:state/*.json` (not checked out) |

The `prism` HEAD is itself **INS-283** — "Audits/multi-repo briefs must bring ALL read-repos to current origin/main … record HEAD SHAs — 'clean + on main' ≠ 'current'" — the lesson learned from brief-430's failure and the direct mandate this brief executes.

**What was analyzed and how.** All four repos' full file trees were loaded into context. The load-bearing server source (`bootstrap.ts`, `config.ts`, `finalize.ts`, `archive.ts`, `banner.ts`, `standing-rules.ts`, the `ai/` synthesis subsystem, `github/client.ts`) was read directly. Five parallel sub-agents performed breadth audits — the Trigger daemon, the framework templates, test/CI + branch-protection state, brief-lifecycle/run-state, and the remaining MCP tool surface — each returning file:line-cited findings that were cross-checked against source. **Two of the brief's stated "ground truth" items were corrected against the current clones** (the brief explicitly directs current-clone truth over prior reports): brief-600 is in fact **correctly archived** (not "merged yet still polled"), and **KI-26 is resolved** (S116, PR #39) so brief-421's work already shipped — making brief-421 a dead orphan rather than pending work. All living-document byte sizes were re-measured against the current files (Appendix A); every brief-430 size figure was understated.

**Verified-current capture & size state** (refuting brief-430's stale figures):

| Metric | brief-430 (stale clone) | **brief-431 (current clone)** |
|--------|-------------------------|-------------------------------|
| Decision index max / count | "tops out at D-234" (false gap) | **D-240; 192 rows in `_INDEX.md`** ✓ |
| D-240 entry | "never recorded" | **full entry, `decisions/optimization.md:438`** ✓ |
| INS-281 / 282 / 283 | "never recorded" | **all present in `insights.md`** ✓ |
| `insights.md` | "448KB" | **461,075 bytes (450KB)** |
| `decisions/operations.md` | "208KB" | **217,436 bytes (212KB)** |
| STANDING RULE markers | "230" | **239** |
| Max INS | "INS-277" | **INS-283 (171 entries)** |

---

## Phase 1 — Mission & intelligence mandate

### 1.1 Mission (one paragraph)
PRISM (Persistent Reasoning & Intelligent State Management) is a framework for long-horizon AI collaboration that solves Claude's zero cross-session memory by maintaining structured external memory in GitHub-backed living documents, so that "Session 100 operates with the same reasoning capacity as Session 1" (`prism-framework/docs/THREE_TIER_ARCHITECTURE.md:538`). Its governing premise — "the context window is a computational resource, not a storage medium … Storage belongs in GitHub. Navigation belongs in native memory. The context window belongs to the work" (`METHODOLOGY_DEEP_DIVE.md:18-19`) — treats Claude as a stateless compute node and GitHub as the persistent store, with the handoff document as serialized project state that deserializes into any Claude instance on any device. It targets a solo operator (Brian) running many long-lived projects concurrently, and is built to eliminate four chronic failure modes: context amnesia, circular re-exploration, logic drift, and silent state corruption (`METHODOLOGY_DEEP_DIVE.md:31-34`). The MCP server is the v2 evolution that offloads all mechanical GitHub work to a dedicated server so Claude stays a pure reasoning agent.

### 1.2 The intended level of carried context/intelligence (the three-tier model)
The canonical model (`THREE_TIER_ARCHITECTURE.md:18-24`, restated in `core-template-mcp.md:270`) carries intelligence across sessions in three tiers:

- **Tier 1 — Structural.** Intelligence embedded in document *schemas and formats* — the handoff schema, decision-record format, guardrail format, repo layout, commit taxonomy, session-compression curve. It "never appears as instructions … it *is* the documents Claude interacts with," and is self-reinforcing (see three well-formatted decisions, produce the fourth identically). Lives in the `.prism/` files themselves.
- **Tier 2 — Behavioral.** A concise set of ~12–15 action rules Claude executes at specific moments (the only "instructions" carried during active work). Lives in the core template (`core-template.md` / `core-template-mcp.md`), loaded every boot.
- **Tier 3 — Situational.** Deep procedures loaded from dedicated module files *only when their trigger conditions are met*; a normal session never loads them. Lives in `_templates/modules/`.

The living-document set (10 mandatory docs) realizes Tier 1; the synthesized **intelligence brief** (D-44) is the per-session distillation; **standing rules** (insights tagged `STANDING RULE`, D-44 Track 1) are the auto-loaded behavioral procedures.

### 1.3 Is the target explicit and measurable? (No — and that is a gap)
**The framework measures its own *overhead*, not the *intelligence it carries*.** The only quantified targets are cost ceilings: framework baseline "2–4% of available context … total framework overhead under 10%" (`THREE_TIER_ARCHITECTURE.md:448-450`) and the handoff ceiling (<10KB target, hard 15KB scaling threshold). The closest thing to a carried-intelligence metric is the **Entropy Score** `(active decisions + open questions) / (settled decisions + completed tasks)`, healthy `<0.5` (`THREE_TIER_ARCHITECTURE.md:128`) — but that tracks *resolution rate*, not how much intelligence survives a session boundary. The carried-intelligence goal is stated only qualitatively ("same reasoning capacity as Session 1"). There is **no SLO of the form "N% of project intelligence must survive a boot."**

**Recommendation (R7-adjacent, low risk):** define an explicit, measurable "intelligence carried over" target now that the window is 500K, e.g.: (a) **boot intelligence completeness** — % of {critical context, settled guardrails, active standing rules, latest intelligence brief, open questions} delivered in the boot payload vs. present in the living docs (target 100% of Tier-A material, with the 500K headroom there is no reason to truncate); (b) **brief freshness** — intelligence brief age ≤ 2 sessions (already surfaced as `brief_age_sessions`, just not enforced); (c) **continuity coverage** — resumption point + next steps non-empty and parseable every boot. These are cheaply computable server-side and would convert the implicit aspiration into a tracked metric.

### 1.4 Where continuity actually breaks (intent vs reality)
1. **Synthesis is being skipped.** The intelligence brief (the situational-intelligence distillation) is the first thing to fail when `insights.md` is large: S145 finalize ran `skip_synthesis=true`; CS-1/CS-2/CS-3 time out at their deadlines (Phase 5). When synthesis is skipped, the next boot carries a *stale* brief — `brief_age_sessions` climbs and the situational tier degrades silently.
2. **Boot deliberately under-delivers intelligence the 500K window could now carry.** D-47 compacts the intelligence brief to three sentences + risk flags; prefetch is hard-capped at 2 docs; `insights.md` is parsed for procedures but the full brief and full standing-rule set are not delivered (Phase 3). This was correct under a 200K budget; under 500K it is leaving carryover on the table — precisely the slimming D-240 reverses.
3. **Behavioral drift is unguarded at the banner boundary.** The Tool Surface and Suggested lines are client-rendered and unenforceable (Phase 8); the model the worker actually launches is unpinned (Phase 7) — so "run this audit on Opus 4.8" depended on luck.
4. **Archival/retention does not fire**, so the situational store (`insights.md`) grows without bound until it breaks synthesis (Phase 6) — the continuity mechanism is being starved by its own un-pruned memory.

The gap is therefore not *capture* (that works) but *distillation and delivery*: PRISM captures intelligence reliably and then fails to (a) keep it bounded, (b) re-synthesize it, and (c) deliver the richest possible version of it at the next boot.

## Phase 2 — Architecture review

### 2.1 Component & dataflow map

```
┌─ claude.ai chat (Brian + Opus 4.8) ──────────────────────────────┐
│  reasoning agent — calls PRISM MCP tools; renders Rule 2/11 banners│
└───────────────┬───────────────────────────────────────────────────┘
                │ MCP Streamable HTTP (stateless, ~60s ceiling)
┌───────────────▼─────────────── PRISM MCP Server (Railway, v4.7.0) ─┐
│  23 MCP tools · stateless proxy · MemoryCache + Anthropic singletons│
│  bootstrap/fetch/push/patch/status/finalize/draft/synthesize/scale/ │
│  search/analytics/log_decision/log_insight/load_rules + railway_* + │
│  cc_dispatch/cc_status + gh_*                                       │
└──┬──────────────────────┬─────────────────────┬───────────────────┘
   │ GitHub API (fetch)    │ Anthropic SDK        │ Agent SDK (OAuth)
   ▼                       ▼                      ▼
┌──────────────────┐  ┌──────────────┐   ┌─────────────────────────┐
│ GitHub repos     │  │ synthesis     │   │ Claude Code subprocess  │
│ • prism (state)  │  │ CS-1 draft    │   │ (cc_dispatch → /tmp     │
│ • prism-mcp-server│ │ CS-2 brief    │   │  clone → PR)            │
│ • trigger        │  │ CS-3 pdu      │   └─────────────────────────┘
│ • prism-framework│  └──────────────┘
│   (templates)    │
└──────────────────┘
        ▲ briefs pushed to .prism/briefs/queue/
        │
┌───────┴─────────────── Trigger daemon (local iTerm, Brian's Mac) ──┐
│  poll(30s) → schedule → worker opens iTerm pane → `claude --effort  │
│  max` (fire-and-forget) → detectPr from state.active → autoMerge    │
│  (squash) → post-merge archive → close pane. State → trigger        │
│  origin/state branch (state/<repo>.json).                           │
└────────────────────────────────────────────────────────────────────┘
```

**Boot → work → persist → finalize dataflow (chat path):**
1. **Boot:** `prism_bootstrap(slug, opening_message)` → server fetches handoff + `decisions/_INDEX.md` + `core-template-mcp.md` (5-min cached) in parallel, then intelligence-brief + insights (for standing-rule extraction) + pending-doc-updates; renders `banner_text`; returns one structured payload (Phase 3). Claude renders the Rule 2 boot response verbatim.
2. **Work:** `prism_fetch` (on-demand docs), `prism_search`, `prism_analytics` (read); `prism_log_decision`/`prism_log_insight` append D-N/INS-N immediately (Rule 5); `prism_patch` for section edits; `prism_push` for whole files. Each write is an atomic Git-Trees commit via `safeMutation` (5 sequential GitHub round-trips).
3. **Persist/checkpoint:** handoff re-pushed at milestones (Rule 8).
4. **Finalize:** `prism_finalize action=draft` (CS-1 synthesis drafts the finalization files) → `action=commit` (backup handoff → validate → archive lifecycle → atomic commit → CS-2 brief + CS-3 pdu fire-and-forget) → renders `finalization_banner_html`. Claude renders the Rule 11 Step-6 finalization response.

**Brief flow through Trigger (autonomous path):** brief authored to `.prism/briefs/queue/brief-NNN.md` on `main` → poller `ls-tree origin/main` finds it (not in state) → scheduler moves it to `state.active` → worker opens an iTerm pane and sends `claude --dangerously-skip-permissions --effort max "execute brief"` then returns → Claude executes, opens a PR → next scheduler tick's `detectPr` (from `state.active`) → `autoMerge` (squash) → `post_merge: [notify, archive]` moves the queue file to `archive/` → pane closed, clone reset to `main` → state pushed to `origin/state`.

### 2.2 Separation of concerns & repo boundaries (D-2, D-8)
The top-level split is clean and correct: **reasoning** (claude.ai) · **mechanics** (MCP server) · **orchestration** (Trigger daemon) · **storage** (GitHub). The MCP server is a genuinely stateless proxy; D-2 project isolation is enforced by slug→repo resolution so no tool reads across project boundaries.

**The framework's own development state is governed by ONE project-state repo (`prism`) spanning THREE code surfaces.** `prism` holds the unified decision/insight history (192 decisions through D-240; INS-1..INS-283) and the 10 living docs. `prism-mcp-server` and `trigger` are *code* repos enrolled in Trigger (each has `.prism/trigger.yaml`) but their decisions are logged into `prism`'s index. `prism-framework` is templates-only and is **not** Trigger-enrolled. This is a coherent design — but two boundary defects exist:

- **Vestigial colliding numberspace (low severity, but it is the exact pattern the brief asked about).** `prism-mcp-server/.prism/` carries an **abandoned** project-state: its own `decisions/_INDEX.md` (only **D-1..D-5**, 5 rows), `handoff.md` (Session Count 4, 2.7KB), plus `architecture.md`/`glossary.md`/`known-issues.md`/`session-log.md`/`task-queue.md`/`eliminated.md` — last meaningfully touched at the **D-67 "consolidate PRISM files into .prism/"** commit. Those D-1..D-5 **numerically collide** with `prism`'s live D-1..D-5 while describing different decisions. It is not actively fragmenting (the server's work is logged in `prism`), but it is dead state that was never archived/removed — a repo-level instance of the same "documents not cleaned up" hygiene problem (Phase 6). Recommend deleting or clearly archiving `prism-mcp-server/.prism/{decisions,handoff.md,architecture.md,…}` (keep only `briefs/` and `trigger.yaml`).
- **State lives in three places** (`prism` repo living docs · `trigger` `origin/state` branch · `prism-dispatch-state` repo for cc_dispatch). Each split is individually justified (the dispatch-state repo avoids Railway auto-deploy loops, per CLAUDE.md A.6; the state *branch* avoids self-dispatch preflight contamination), but it means "where is the truth" has three answers and no single reconciler.

### 2.3 Architectural debt (load-bearing assumptions, fragility)
1. **The worker is fire-and-forget and the dispatched `claude` is not a child of the daemon** (`trigger/src/worker/worker.ts:9-14`; `startup/stale-active-recovery.ts:24-30`). This is *the* load-bearing assumption behind every Trigger failure class (Phase 7): completion is inferred only from a PR appearing or an AppleScript pane probe — never from process supervision. It is documented in code comments but **DESIGN.md still describes the opposite** (synchronous "monitors the process for completion," `trigger/DESIGN.md:603`) — a materially stale spec.
2. **Write latency floor: `createAtomicCommit` is 5 strictly-sequential GitHub round-trips** (`github/client.ts:626-739`: getRef→getCommit→createTree→createCommit→updateRef). At the 15s per-request timeout, worst-case is 75s — above the 60s push/patch deadlines and the ~60s MCP ceiling. Every write pays this floor.
3. **Only 4 of 23 tools carry a wall-clock deadline** (push 60s, patch 60s, scale 50s pre-commit, cc_dispatch 45s sync). `analytics`, `search`, `status`, `fetch`, `log_decision`, `log_insight` have **no tool-level deadline** and several fan out to 24–30 GitHub round-trips (Phase 4) — these can silently exceed the MCP ceiling and surface as client-side timeouts with no server diagnostic.
4. **Dead, unwired path-safety control:** `validation/slug.ts` (`validateProjectSlug`/`validateFilePath`, the null-byte/`..` traversal sanitizers) is defined but imported nowhere; `project_slug`/`path` reach the GitHub client as bare strings. Latent security/correctness debt (low real-world risk because GitHub rejects bad paths, but the guard exists and is bypassed).
5. **Two parallel boot templates** (`core-template.md` v2.2.0 full/fallback vs `core-template-mcp.md` v2.19.1 MCP-primary) with a *third* deprecated description in `docs/THREE_TIER_ARCHITECTURE.md` — Rule 2 differs across them, and MCP template versions 2.10.0–2.18.0 are unlogged in the CHANGELOG. Drift hazard for anyone reading docs/ before _templates/.
6. **Doc drift in the server's own identity:** `CLAUDE.md` says v4.0.0 / 18 tools / Opus 4.6; the code says v4.7.0 / 23 tools / Opus 4.8 (`config.ts:55`, `models.ts:60`). `models.ts:57-58` docstring claims synthesis model is `claude-opus-4-7` while the constant is `claude-opus-4-8`.

## Phase 3 — Boot payload & context-budget (framed for the 500K window)

The whole framing of this phase follows D-240: the window is **500K**, and the goal is to **use the headroom to carry richer intelligence, not to shrink the payload.** The current boot payload is already small (~5% of 500K); several deliberate slimming measures (D-47, D-193) now leave intelligence on the table.

### 3.1 `prism_bootstrap` response, field-by-field (`src/tools/bootstrap.ts:962-1003`)

| Field | Source | Delivered size (prism) | Notes / redundancy |
|-------|--------|------------------------|--------------------|
| `behavioral_rules` | full `core-template-mcp.md` (cached) | **29KB / ~8.4K tok** — largest field | Full template every boot. Correct to keep; it is the Tier-2 contract. |
| `standing_rules` | `insights.md` → `extractStandingRules` → Tier A + matched Tier B (procedure-only, D-47) | ~10–18KB / ~3–5K tok | Server parses the full **461KB** insights.md every boot to extract these. |
| `intelligence_brief` | `intelligence-brief.md` → **compacted** (Project State first 3 sentences + Risk Flags + Quality Audit, D-47) | ~1–2KB | Full brief is **10.5KB**; ~80% is dropped. **Headroom: deliver it whole** (+~2.5K tok). |
| `critical_context` | handoff `## Critical Context` (numbered list) | ~1KB | Also implicitly in `resumption`/`current_state`. |
| `current_state` | handoff `## Where We Are` | ~1KB | Feeds `resumption` (banner) too — mild duplication. |
| `resumption_point` | handoff `## Resumption Point`/`## Next Action` | ~0.5KB | Re-parsed into `banner_text` (`parseResumptionForBanner`). |
| `next_steps` | handoff `## Next Steps` | ~0.5KB | Appears in top-level field **AND** `banner_text` **AND** feeds prefetch **AND** feeds the model recommendation — 4 uses of one parse. |
| `recent_decisions` | `_INDEX.md` → **last 5 only** | ~0.4KB | **Headroom: deliver 10–15** (the index is 192 rows / 25.6KB; only 5 surface). |
| `guardrails` | `_INDEX.md` SETTLED → **first 10 only** | ~0.6KB | **Headroom: more guardrails** is exactly the negative-memory PRISM prizes. |
| `open_questions` | handoff `## Open Questions` | ~0.3KB | — |
| `prefetched_documents` | keyword/next-step match, **hard cap 2** (`:570 .slice(0,2)`) + always pending-doc-updates | ~1–2KB summaries | **Headroom: raise/remove the cap of 2** (D-193-era slimming). |
| `banner_text` | `renderBannerText` | ~0.3–0.5KB | Phase 8. |
| `recommended_session_settings` | persisted handoff recommendation or `classifySession(next_steps)` | ~0.2KB | Advisory model+thinking (D-191). |
| `context_estimate` | computed | ~0.2KB | **Inaccurate — see 3.3.** |
| `expected_tool_surface`, `post_boot_tool_searches` | `tool-registry.ts` | ~1–2KB | D-83 client-side tool-surface verification. |
| `warnings`, `diagnostics`, `trigger_enrollment`, `pdu_applied_at_boot`, `boot_test_verified`, `bytes_delivered`, `files_fetched`, misc scalars | computed | ~1–2KB | Operational. |

**Total delivered ≈ 55–65KB ≈ ~16–19K content tokens; with the server's +5K platform / +2.5K tool-schema adders, ~24–26K boot tokens ≈ ~5% of the 500K window.** There is enormous room (≈ 95%) to carry more.

### 3.2 Prefetch logic & standing-rule tiering — is the right material reaching the session?
- **Prefetch** (`config.ts:270` `PREFETCH_KEYWORDS` + `bootstrap.ts:66`): keyword→doc map over the opening message *and* the handoff's next-steps, deduped, **capped at 2** docs delivered as summaries (D-193/QW-4). Reasonable under 200K; under 500K the cap is now the binding constraint, not the budget.
- **Standing-rule tiering** (D-156, measured current): **[TIER:A]=9, [TIER:B]=62, [TIER:C]=18 explicit + 33 untagged standing-rule headers default to Tier A** → **~42 effective Tier A rules auto-load every boot** (procedure-only). Tier B loads on `opening_message` keyword match; Tier C never at boot (lazy via `prism_load_rules`). **Coverage gap (confirmed):** Tier B rules with an empty `topics[]` (likely many of the 62 — the server has a `STANDING_RULES_TOPICS_UNPOPULATED` diagnostic for exactly this) can **never** be matched by either the boot keyword-expansion path or the explicit-topic path, so they are effectively **unreachable after boot**. Under 500K the simplest fix is to deliver all Tier A+B at boot and treat Tier C as the only lazy tier.

### 3.3 Context-budget accuracy (two real defects, both cheap)
1. **`DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000` (`config.ts:68`)** → the bootstrap response's `context_estimate.total_boot_percent` and `context_window_tokens` are computed against **200K**, so the server-emitted percentage is **2.5× too high** for an Opus-4.8 (500K) session. *Mitigating fact:* the client-side **Rule 9 formula already resolves `W = 500_000` for Opus 4.8/4.7/4.6/Sonnet 4.6** and recomputes the percentage itself from `total_boot_tokens`, so the misleading server field is not load-bearing for the displayed context line — but it is wrong, it confuses anyone reading the raw response, and it is the kind of "200K thinking" D-240 is reversing. **Fix: 200_000 → 500_000** (or emit only the token count and let Rule 9 own the percentage).
2. **The token-estimate numerator omits ~13 delivered fields (`bootstrap.ts:951-956`).** `bootstrapTokens = JSON({project, handoff_version, behavioral_rules, standing_rules, intelligence_brief, banner_text}).length / 3.5` — it does **not** include `critical_context`, `current_state`, `resumption_point`, `recent_decisions`, `guardrails`, `next_steps`, `open_questions`, `prefetched_documents`, `expected_tool_surface`, `post_boot_tool_searches`, `recommended_session_settings`, `warnings`, or `diagnostics`. So `total_boot_tokens` **undercounts the real payload by ~3–6K tokens**, and because **Rule 9 consumes `total_boot_tokens`**, the client's running context estimate is biased low from the first exchange. **Fix: compute the numerator over the actual `responseText`** (the server already serializes it at line 1037) instead of a hand-picked subset.

### 3.4 Where the 500K headroom should buy richer carryover (the D-240 mandate, concretely)
Reverse the 200K-era slimming, in priority order (all trivially affordable — even the richest version below is <10% of 500K):
- **Deliver the full intelligence brief** (un-compact D-47): +~2.5K tok — the single highest-value carryover item, since the brief *is* the situational-intelligence distillation.
- **Raise `recent_decisions` to ~15 and `guardrails` to ~20**, and consider delivering a one-line-per-decision index digest (the 192-row `_INDEX.md` is only 25.6KB).
- **Raise/remove the prefetch cap of 2** and deliver full prefetched docs (not just summaries) when total stays within a generous budget (say 60K tokens).
- **Deliver all Tier A + Tier B standing rules at boot** (closing the empty-`topics` unreachability gap) and surface a Tier-C *index* (id+title) so the session knows what is available to `prism_load_rules`.
- **Fix the estimate (3.3) first** so the richer payload is measured accurately against 500K — otherwise Rule 9 will under-report and the operator won't see the true (still comfortable) usage.

## Phase 4 — Full MCP server: every tool, process, and sub-process

**The server exposes 23 MCP tools, not the 18 documented in CLAUDE.md** (stale). All 23 register on Railway (Railway+CC+GitHub flags set). `getExpectedToolSurface` (`tool-registry.ts:70`) advertises the surface and `POST_BOOT_TOOL_SEARCHES` drives client-side verification.

### 4.1 Tool inventory (inputs · response · size · over-return · deadline · failure modes)

| Tool (file) | Response size | Over-returns? | Deadline | Notable failure modes |
|-------------|---------------|---------------|----------|------------------------|
| `prism_bootstrap` (bootstrap.ts:413) | ~55–65KB | No (Phase 3) | none | handoff fetch required; rest fail-open |
| `prism_fetch` (fetch.ts:52) | **full file bodies** | **YES** — `summary_mode` defaults **false** (`fetch.ts:45`); 5KB summary threshold only when caller opts in. handoff+session-log+insights = 40–80KB | none | per-file `FILE_FETCH_ERROR`/404 (partial OK) |
| `prism_push` (push.ts:60) | ~1–3KB (paths/SHAs, not content) | No | **60s** `PUSH_WALL_CLOCK_DEADLINE_MS` | validation all-or-nothing; `MUTATION_RETRY_EXHAUSTED` |
| `prism_patch` (patch.ts:57) | ~1KB | No | **60s** via `safeMutation` → `DEADLINE_EXCEEDED` | `PATCH_PARTIAL_FAILURE` (file untouched), `Ambiguous section` |
| `prism_status` (status.ts:246) | single ~1KB; **multi = N×block** | mild | none | cache masks staleness (5–10 min) |
| `prism_analytics` (analytics.ts:685) | most ~1–3KB; **`decision_graph` = O(decisions)** | **`decision_graph` over-returns** full adjacency+references | **none** | 30 parallel `getCommit` in `file_churn` |
| `prism_scale_handoff` (scale.ts:925) | medium | plan round-trip | **50s pre-commit** | **atomicity gap** (4.4) |
| `prism_search` (search.ts:180) | ≤ `max_results`×snippet ≈5KB | No | **none** | ~24 GitHub round-trips/call, no cache |
| `prism_synthesize` (synthesize.ts:113) | small | No | synthesis timeouts (Phase 5) | unbounded input (Phase 5) |
| `prism_log_decision` (log-decision.ts:75) | ~0.5KB | No | none | **dedup** rejects existing D-N (`DEDUP_TRIGGERED`) |
| `prism_log_insight` (log-insight.ts:57) | ~0.5KB | No | none | **dedup**; `standing_rule` w/o `procedure`→error |
| `prism_load_rules` (load-rules.ts:47) | small (matched procedures) | No | none | empty-`topics` Tier B unreachable (Phase 3) |
| `cc_dispatch` (cc-dispatch.ts) | sync `result` **unbounded text** | possibly | **45s sync**; **async no deadline** | async failures only via `cc_status` |
| `cc_status` (cc-status.ts) | by-id full record (large `result`) | by-id yes | none | — |
| `railway_logs/status/deploy/env` | small–medium | **`railway_env get` returns unmasked secret** (by design) | none | name→ID resolution |
| `gh_delete_branch/create_release/update_release/delete_tag` | tiny | No | none | guards default branch / open PRs; `delete_tag` idempotent |

### 4.2 GitHub client (`src/github/client.ts`) — the write-path floor
- **`createAtomicCommit` (`:626-739`) = 5 strictly-sequential round-trips** (getRef→getCommit→createTree→createCommit→updateRef). Worst case ~75s at the 15s per-request timeout — above the 60s push/patch deadlines and the ~60s MCP ceiling. This is the dominant cost of every write and cannot be parallelized (each step depends on the prior).
- Rate-limit/retry with backoff up to ~120s (`client.ts:118`) — a single rate-limited request inside an un-deadlined tool (analytics/search/status) can blow well past the MCP ceiling.
- Raw `fetch` (no Octokit), base64 decode, SHA read-modify-write for 409s.

### 4.3 Patch engine — ZWS / `sanitizeContentField` / 409 (INS-240/INS-246/KI-26)
- **`sanitizeContentField` (`utils/sanitize-content.ts:20`)** inserts a **U+200B zero-width space** after leading `#{1,6} ` so user-supplied content cannot splice a real markdown header into the section tree. Wired into `prism_patch` content (`patch.ts:138`) and `prism_log_decision` title/reasoning/assumptions/impact (`log-decision.ts:134-137`). **KI-26 is resolved (S116, PR #39)** — so brief-421 (which targeted KI-26) is a dead orphan (Phase 6). **Gap:** `sanitizeContentField` is **not** applied to `prism_log_insight` fields (`log-insight.ts:103-112` builds the entry raw) — a residual injection surface on the insight path.
- **409 optimistic concurrency:** patch runs its operations *inside* `safeMutation`'s `computeMutation`, so a 409 re-reads the file and re-applies against fresh content (`safe-mutation.ts:106-205`); null HEAD SHA refuses retry. Raced against a 60s deadline sentinel.
- `validateIntegrity` only flags **duplicate** headers (empty sections are warnings) — confirming the rationale for the ZWS approach (novel injected headers would otherwise pass).

### 4.4 Other sub-processes
- **Validation** (`validation/*`): all-`.md` EOF-sentinel + commit-prefix; handoff section/size rules; `_INDEX.md` table/status/no-dup-ID. **`validation/slug.ts` (path-traversal/null-byte guards) is dead code — imported nowhere** (security debt, low real risk).
- **Middleware** (`middleware/auth.ts` + `utils/cidr.ts`): `/health` bypass → timing-safe Bearer → IPv4 CIDR allowlist → dev allow-all. **`cidr.ts` is IPv4-only** — a native-IPv6 token-less client gets a hard 403 (low likelihood; Bearer is set). With a valid Bearer the IP check is skipped.
- **Transport** (`index.ts`): stateless — a fresh `McpServer`+transport per POST `/mcp` (`sessionIdGenerator: undefined`); 5MB request cap.
- **Cache** (`utils/cache.ts`): `templateCache` (5 min) + status caches (5/10 min). Safe in stateless mode (read-only) but introduces up-to-10-min staleness in multi-project status.
- **`scale.ts` atomicity gap (`:907-915`):** when the atomic commit fails and HEAD is unchanged, it falls back to a **sequential `pushFile` loop** — a crash mid-loop leaves handoff+destinations partially written. The 50s safety timeout is checked only *before* network I/O, so the commit itself is un-deadlined.
- **Model classifier (`models.ts`):** **knows Opus 4.8** — `RECOMMENDATION_MODELS` maps `reasoning_heavy`/`mixed`→`opus-4-8`, `executional`→`sonnet-4-6` (`models.ts:47-51`); `SYNTHESIS_MODEL_ID = "claude-opus-4-8"` (`:60`, though the docstring stale-claims 4-7). `session-classifier.ts` scores `next_steps` keywords into a reasoning:executional ratio. This classifier exists in the server but is **not** consulted by Trigger's launch path (Phase 7) — the obvious source for per-brief model pinning.

### 4.5 Error / timeout / slowness hot-spots (file:function → why)
1. `fetch.ts` registerFetch — **over-returns full bodies** (`summary_mode` default false). Primary context-bloat surface on the read path.
2. `analytics.ts decisionGraph` (`:391-475`) — full adjacency+references payload, O(decisions); `fileChurn` (`:302-334`) — 30 parallel `getCommit`; **no tool deadline**.
3. `github/client.ts createAtomicCommit` (`:626-739`) — 5 sequential round-trips; ~75s worst case > deadlines.
4. `search.ts` registerSearch — ~24 GitHub round-trips/call, no cache, no deadline; fresh `RegExp` per term per section.
5. `status.ts` / `analytics.ts healthSummary`/`freshEyesCheck` — N×(probe+fetch) cross-project fan-out; healthSummary lacks status's caching; no deadline.
6. `scale.ts atomicCommitScaled` (`:907-915`) — non-atomic sequential fallback; un-deadlined commit.
7. `cc_dispatch` async (`cc-dispatch.ts:184-200`) — `timeoutMs:0`, unbounded; only visible via `cc_status` poll.
8. **Only 4 of 23 tools carry a wall-clock deadline.** `analytics`/`search`/`status`/`fetch`/`log_decision`/`log_insight` are bounded only by 15s × fan-out — they can exceed the ~60s MCP ceiling and surface as a client timeout with **no server diagnostic**.

## Phase 5 — Synthesis layer

### 5.1 Per-call-site routing & transport selection
`synthesize()` (`ai/client.ts:111`) takes a `callSite ∈ {draft, brief, pdu}` and resolves per-call-site overrides via `resolveCallSiteRouting` (`:63`), reading env vars `SYNTHESIS_{DRAFT|BRIEF|PDU}_TRANSPORT` and `SYNTHESIS_{…}_MODEL`:

| Call-site | Producer | Reads | Output | Default transport / model | Timeout |
|-----------|----------|-------|--------|---------------------------|---------|
| **CS-1 draft** | `finalize.ts draftPhase:424` | `DRAFT_RELEVANT_DOCS` | finalization-file drafts (JSON) | messages_api / `SYNTHESIS_MODEL` (`claude-opus-4-8`) | 150s (`FINALIZE_DRAFT_TIMEOUT_MS`), 180s deadline race |
| **CS-2 brief** | `synthesize.ts generateIntelligenceBrief:97` | **all 10 living docs + 7 decision-domain files** | `intelligence-brief.md` | messages_api / `SYNTHESIS_MODEL` | 240s (`SYNTHESIS_TIMEOUT_MS`) |
| **CS-3 pdu** | `synthesize.ts generatePendingDocUpdates:278` | same as CS-2 (minus brief+pdu) | `pending-doc-updates.md` | messages_api / `SYNTHESIS_MODEL` | 240s |
| **CS-4 dispatch** | `cc_dispatch` | n/a (Agent SDK) | PR | `CLAUDE_CODE_OAUTH_TOKEN` Agent SDK subprocess | 45s sync / unbounded async |

- **Transport selection:** default `messages_api` (uses `ANTHROPIC_API_KEY`); set `SYNTHESIS_*_TRANSPORT=cc_subprocess` to route through the OAuth Claude-Code subprocess (uses `CLAUDE_CODE_OAUTH_TOKEN`). On `cc_subprocess` failure, `synthesize()` **auto-falls back** to messages_api with the default model and logs `SYNTHESIS_TRANSPORT_FALLBACK` (`client.ts:138`) — surfaced at next boot (brief-419). Transport is tagged on the result (`messages_api` / `cc_subprocess` / `messages_api_fallback`).
- **Transport-aware timeouts** (`finalize.ts:42-56`): cc_subprocess uses the wider `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` (600s) and a 300s draft-deadline race because the subprocess adds CLI spawn + OAuth + model-load overhead on top of inference.
- All three synthesis call-sites pass `thinking: true` (adaptive). All are **fire-and-forget per D-78** (CS-2/CS-3 via `Promise.allSettled` in the finalize commit action) — so their latency is invisible to the operator, **but their failure means a stale brief / unapplied PDU at the next boot.**

### 5.2 Root cause of the synthesis timeouts (current measured sizes)

The brief's draft/brief deadlines are blown because **the synthesis input is unbounded and dominated by oversized living docs.** Measured against the *current* files:

| Call-site | Input docs | **Input size** | **≈ tokens** | Dominant contributors | Deadline |
|-----------|-----------|----------------|--------------|------------------------|----------|
| **CS-1 draft** | `DRAFT_RELEVANT_DOCS` (7 docs) | **611KB** | **~175K** | insights.md **75%**, task-queue 11% | 150s / 180s |
| **CS-2 brief & CS-3 pdu** (each, fired in parallel) | all living + decision-domain files | **1,138KB (1.1MB)** | **~325K** | insights.md 40%, operations.md 19%, architecture-decisions 11%, glossary 5%, architecture.md 4%, task-queue 6% | 240s |

**Two distinct causes, as the brief asks them to be separated:**
- **One-time cause:** `insights.md` is **461KB** (40–75% of every synthesis input). It alone pushes CS-1 to ~175K input tokens with adaptive thinking inside 150–180s — enough to blow the deadline. This is why S145 ran `skip_synthesis=true`.
- **Durable cause:** **synthesis reads whole, unbounded living docs with no input bound.** Even if `insights.md` were archived to the 20KB D-80 target, **CS-2/CS-3 input would still be 681KB / ~199K tokens** because `operations.md` (217KB), the architecture decision file (132KB), `glossary.md` (58KB), `architecture.md` (50KB), and `task-queue.md` (71KB) are *also* unbounded and *also* fed in whole. Archiving insights.md is necessary but **not sufficient**; the durable fix is to bound what synthesis reads.

A secondary durable issue: **CS-2 and CS-3 read the same ~1.1MB twice, in parallel**, doubling the inference load at the exact moment of finalize.

### 5.3 Recommendations (immediate unblock + durable fix, with acceptance criteria)

**Immediate unblock (R3-a, Quick):** archive `insights.md` toward the 20KB target (Phase 6 must be done first because today's archival can't reach that — see 6.3). 
*Acceptance:* CS-1 input < 60K tokens; a finalize `draft` completes within 150s on the `prism` project without `skip_synthesis`; `intelligence-brief.md` re-synthesizes with `brief_age_sessions ≤ 1`.

**Durable fix (R3-b, Medium):** bound synthesis inputs independent of doc size:
1. **Exclude or slice the heavy decision-domain files** from CS-2/CS-3 (today `generateIntelligenceBrief`/`generatePendingDocUpdates` pull all 7 domain files including the 217KB `operations.md`). Synthesis needs *recent* decisions, not the full 217KB history — feed `_INDEX.md` + the last N decisions per domain.
2. **Cap each doc's contribution** (e.g., last K entries of insights.md / session-log.md / task-queue.md) so a single file can never dominate. The standing-rule procedures the brief prompt wants "reproduced exactly" should come from the **bounded extracted procedure set** (already computed for boot), not the raw 461KB file.
3. **Don't read insights.md in full for CS-1** — the draft is about handoff/session-log/task-queue; institutional insights are not needed to draft a session log.
4. **Consider serializing CS-2/CS-3** or sharing one fetched bundle so the 1.1MB is read once, not twice.
*Acceptance:* a regression test asserts total synthesis input ≤ a configured ceiling (e.g., 120K tokens) regardless of living-doc sizes; CS-2 and CS-3 each complete within 240s on a project whose raw living docs exceed 1MB; a synthetic 2MB `insights.md` fixture does not change the measured synthesis input size.

## Phase 6 — Living-document lifecycle & archival (TOP PRIORITY)

This is the operator's "documents get reviewed/re-uploaded and are not archived" complaint. The failure is in **archival/retention and brief-lifecycle hygiene**, *not* in capture (capture works — see Methodology). Diagnosed below with current numbers.

### 6.1 Living-document inventory (current byte sizes, `prism` repo)

| Doc | Bytes | KB | Archive exists? | Note |
|-----|------:|---:|-----------------|------|
| **insights.md** | **461,075** | **450** | ❌ **NONE** | 171 INS entries; 239 STANDING-RULE markers; the headline |
| decisions/operations.md | 217,436 | 212 | n/a (decisions never compressed) | 94 rows |
| decisions/architecture.md | 132,071 | 129 | n/a | 38 rows |
| task-queue.md | 70,867 | 69 | n/a | large; `Recently Completed` capped at 15 (brief-422) |
| decisions/optimization.md | 63,242 | 62 | n/a | 20 rows (holds D-240) |
| glossary.md | 58,388 | 57 | n/a | append-only by policy |
| architecture.md | 50,368 | 49 | n/a | append-only by policy |
| known-issues.md | 34,600 | 34 | ✅ known-issues-archive.md (8.8KB) | 14 active KI |
| decisions/_INDEX.md | 25,595 | 25 | n/a (NEVER compressed) | 192 decisions through D-240 |
| pending-doc-updates.md | 12,647 | 12 | ❌ none | synthesis staging — see 6.4 |
| intelligence-brief.md | 10,561 | 10 | n/a | synthesized |
| session-log.md | 9,481 | 9 | ✅ session-log-archive.md | **rotated** (S127 cut ~342 lines) — the counter-example |
| handoff.md | 7,874 | 8 | n/a (handoff-history/) | healthy, <10KB |
| eliminated.md | 1,973 | 2 | n/a (NEVER delete) | — |

The two unbounded outliers are **insights.md (450KB)** and the **decision domain files** (operations 212KB, architecture 129KB) — and `insights.md` is the only large living doc with **no archive file at all.** `session-log.md` proves rotation *can* work; insights.md is the gap.

### 6.2 Why insights.md archival has never fired — THREE stacked causes
The D-80 retention policy is implemented (`INSIGHTS_ARCHIVE_CONFIG`, `finalize.ts:71-84`: threshold 20KB, retention 15, `protectedMarkers: ["STANDING RULE"]`, `activeSection: "## Active"`) and the pure splitter (`archive.ts splitForArchive`) is correct and tested. Yet **`insights-archive.md` does not exist** — archival has produced zero output. Three independent failures, each sufficient on its own:

1. **Coupling to the finalize `files` array (the decisive one).** `applyArchive` runs only if the doc is in the operator-supplied finalize `files` (`finalize.ts:844-847`: `if (liveIdx === -1) return`). But insights are written **out-of-band** by `prism_log_insight` *during* the session (Rule 5/7 "push immediately"), so by finalize time `insights.md` is already committed and **not** in the finalize files array → `applyArchive("insights.md", …)` returns immediately, every time. This is the INS-178 "files array discipline" cutting the wrong way: incremental logging means the doc never rides the finalize commit, so the archival that's wired to that commit never sees it. The absent `insights-archive.md` is the proof.
2. **STANDING-RULE protection covers 78% of the bytes.** Even when `splitForArchive` *does* run, the `protectedMarkers: ["STANDING RULE"]` filter (`archive.ts:239`, `title.includes(m) || body.includes(m)`) protects **120 of 171 entries = 78% of the bytes (359KB)**. Only 51 entries (22%, 99KB) are archivable; with retention 15, just **36 entries / 71KB (16%)** are eligible. **Archiving everything eligible still leaves insights.md at ~378KB — 19× over the 20KB target.** The policy protects exactly the entries that dominate the size, so it is *structurally incapable* of bounding the file. (Minor sub-bug: 3 of the 120 are protected only because their *body* mentions "STANDING RULE" in a cross-reference — `body.includes` over-protects; but fixing that recovers only ~2 entries.)
3. **No documented policy to enforce.** The D-80 retention rule is **absent from the framework templates** — `insights.md` is the only mandatory living doc with no compression-policy line in `finalization.md`'s per-file audit. There is no spec for a maintainer to check the implementation against.

### 6.3 Brief-lifecycle hygiene (the merged-vs-failed asymmetry)
Two orthogonal mechanisms, and the gap is between them:
- **Done-detection is by STATE** (`trigger/src/poller/index.ts blockReasonFromHistory`): a brief is skipped if its id appears in `state/<repo>.json` history with a terminal status. Location is irrelevant.
- **Archival is by LOCATION, gated on MERGE** (`trigger/src/github/post-merge.ts runArchive`): only `post_merge: [archive]` after a *successful merge* moves the file `/queue/ → /archive/` (and it hard-requires the `/queue/` path convention).

**Corrections to the brief's stated ground truth (verified on current clones — the brief directs current-clone truth):**
- **brief-600 is CORRECTLY archived**, not "merged yet still polled." It is in `trigger/briefs/archive/`, state status `merged` with `post_merge.actions_completed: ['archive']`, and is not polled. Its only residue is a stale frontmatter `Status: PENDING` line (decorative; the poller ignores frontmatter status) and a lingering merged branch. **What brief-600 already shipped (do NOT re-recommend):** D-196 Pieces 1+2 — the **wrong-repo guard** (parse `**Repo:**`, quarantine on mismatch) and **pane-liveness recovery** (AppleScript probe → `abandoned_pane_dead` → clear active slot).
- **brief-421 is the real orphan**, and it is worse than "pending": it terminal-failed `abandoned_pane_dead` (recoverable:false) after a 64.7-min run, so it **never merged → never archived**, and it still sits in `prism-mcp-server/.prism/briefs/queue/`. The poller blocks it (terminal status) but never cleans the file. **And its work already shipped** — KI-26 was resolved at S116 (PR #39); `sanitizeContentField` is live. So brief-421 is a **dead orphan whose deliverable already exists elsewhere** — it should simply be deleted, never re-dispatched.

**Root cause:** there is a `merge → archive` path but **no `terminal-failure → cleanup` path.** Pane-dead / unrecoverable-preflight / crash briefs leave their queue files stranded forever. (Secondary piles: `prism-mcp-server/briefs/` (33 legacy), `trigger/briefs/` (13 legacy, explicitly "not polled"), `reports/` accreting 84–92KB audit reports with no rotation, and the `{brief}.status.json` convention is dead — exactly one orphan file across all repos.)

### 6.4 The "re-uploaded / re-reviewed" pattern (two concrete instances)
1. **insights.md monotonic append.** `git log --numstat -- .prism/insights.md` shows every recent commit is `+N / -0` (pure insertion); the file grew **429KB → 461KB over the last 15 commits.** Each `prism_log_insight`/`prism_patch` re-commits the whole growing file — the "re-uploaded, not archived" pattern exactly.
2. **pending-doc-updates.md is an undrained staging area.** It is **overwritten wholesale each synthesis** (CS-3), oscillating 5–13KB, with **no `pending-doc-updates-archive.md`** and **no record of whether proposals were applied or rejected.** The current 12.6KB still proposes "mark INS-250/INS-247 dormant" from S144 — and `git log` shows those dormancy edits were **never applied** (latest insights commits are INS-281/282/283 *additions*). So CS-3 re-proposes, the operator may or may not apply, and the prior batch is silently discarded on the next overwrite — a second "reviewed/re-uploaded but never documented as done" loop, at the proposal layer.

### 6.5 Enforcement design: provably captured-and-archived exactly once
The objective is that **every living document is bounded and every brief reaches a terminal, recorded, file-system-clean state exactly once.** Concretely (each is its own Phase-B brief — see Roadmap):

- **(A) Decouple retention from the finalize files array.** Run a dedicated **maintenance pass** at finalize (and/or a periodic Trigger maintenance brief) that, for each retention-eligible doc, *fetches it unconditionally*, runs `splitForArchive`, and pushes live+archive — regardless of whether the doc was in the session's `files`. *Acceptance:* after a finalize on a project with a 460KB insights.md, `insights-archive.md` exists and `insights.md` shrinks.
- **(B) Separate the STANDING-RULE registry from the chronological insight log** so the log can actually shrink. Move standing rules into their own bounded registry (e.g., `standing-rules.md`, tier-tagged) that boot/`load_rules` read directly; let `insights.md` hold only chronological, archivable insights. This removes the 78%-protected-bytes problem at the root and makes both files bounded. *Acceptance:* `insights.md` ≤ 20KB target reachable; standing-rule extraction reads the registry, not a 460KB file; no standing rule is lost in the move (count before == count after).
- **(C) Add a terminal-failure cleanup action.** Mirror brief-600's wrong-repo quarantine for *all* terminal-failure classes: on `abandoned_pane_dead`/`permanently_failed`/unrecoverable-preflight, move the queue file to `failed/` (or delete with an audit record) and ntfy. *Acceptance:* a simulated pane-dead brief leaves the polled `queue/` empty for that id; brief-421 specifically is removed.
- **(D) Drain pending-doc-updates with provenance.** When CS-3 proposals are applied via `prism_patch`, record the apply (and archive the consumed batch to `pending-doc-updates-archive.md`) so a proposal is provably applied-or-rejected once, never silently overwritten.
- **(E) Document the retention policy in the framework templates** (the missing D-80 line in `finalization.md`) so implementation and spec agree.
- **(F) Lightweight finalize safety net (optional, justified on its own merits — NOT a capture-gap fix):** warn at finalize when a D-N/INS-N is *referenced* in committed prose but not present in the index. This is cheap drift insurance; it is **not** the brief-430 "reconcile D-235…D-240" item (which is premised on a capture gap that does not exist).

## Phase 7 — Trigger reliability layer

The daemon is a single in-process tick loop (`Orchestrator.runTick`, `orchestrator.ts:899`, every 30s): refresh lock → poll (`ls-tree origin/main`) → schedule → dispatch (fire-and-forget worker) → reconcile completions → advance active brief (detectPr → autoMerge → post-merge) → push state every 5 ticks. Two out-of-band timers run a pane-liveness probe (30s) and periodic marker re-discovery (300s). **The central architectural fact: the worker launches `claude` into an iTerm pane and returns — it never awaits Claude, and the dispatched process is not a child of the daemon** (`worker/worker.ts:9-14`, `466-499`). Completion is inferred only from a PR appearing or an AppleScript pane probe — never from process supervision.

### 7.1 Observed failure history (verified from `origin/state:state/prism-mcp-server.json`)
23 briefs processed, **6 failed** (all infrastructure, not logic):

| Failure class | Count | Briefs | Recoverable |
|---------------|------:|--------|-------------|
| `abandoned_daemon_restart` | 3 | brief-412, brief-413, trigger-marker-template | true (but not auto-re-run) |
| `preflight_git_state` (untracked `.env.bak.*`) | 2 | brief-401 (×2) | true |
| `abandoned_pane_dead` | 1 | **brief-421** (64.7 min, then pane vanished) | **false** |

(The `trigger` repo's own state is worse: 16 processed / 12 failed, mostly self-dispatch preflight contamination from writing its own `.bak`/state files into its working tree; it hasn't run since 2026-05-01.)

### 7.2 Failure-class root causes
- **A — Pane death strands work (KI-87, HIGH, by design).** `runInPane` only awaits the osascript that *types* the command (`terminal.ts:242-250`), then the worker returns `executing` (`worker.ts:499`). PR detection is a single `detectPr` per tick from `state.active` (`scheduler/index.ts:435`). If the pane dies *before* a PR exists, `detectPr` returns `null` every tick forever and `state.active` stays `executing` — **absence-of-PR is indistinguishable from still-working.** The only safety net is the pane-liveness probe, which **abandons** (not resumes): on a confirmed `dead` it records `abandoned_pane_dead`, clears the slot, does not re-queue (`state/manager.ts:621-650`). brief-421 is the live example.
- **B — Daemon restart kills the worker (HIGH, by design).** On startup `recoverStaleActive` (`startup/stale-active-recovery.ts:104-204`) moves any `active` brief older than 60s to `abandoned_daemon_restart` — it *cannot* reconnect because the worker is iTerm-parented, not a daemon child. The abandoned status is **not** poller-re-eligible (`poller/index.ts:158-161`), so it is neither resumed nor auto-retried; it only re-runs if the operator re-adds the file or resets state.
- **C — Preflight blocks on any stray file (HIGH, over-broad fail-closed).** `checkGitState` (`git-preflight.ts:111-202`) fails dispatch on wrong-branch, dirty tree, **or any untracked file** (`?? ` porcelain line). Recovery (`git-preflight-recovery.ts:92-100`) only handles the `wrong_branch`-only shape — so a benign untracked `.env.bak.*` / `.DS_Store` / `*.orig` halts **all** dispatch for that project until the operator manually cleans the tree. Highest-friction operational failure; the documented brief-401 `.env.bak` incident is exactly this.
- **D — pane-liveness false-failure (MEDIUM).** The real risk is the `error` path (osascript 5s timeout, or output ≠ the two literals): ~10 consecutive errors fires a spurious operator escalation (it does *not* abandon — correct fail-safe). **The probe is iTerm-only** — on a tmux host the `dead` path never triggers, so stuck-slot recovery silently doesn't work there.
- **E — Merged-not-archived (MEDIUM-HIGH).** `runArchive` hard-requires `/queue/` in the path (`post-merge.ts:229-236`); the statically-configured project (platformforge-v2) uses `docs/briefs/` with no `archive` action, so its merged briefs' files persist (don't re-dispatch, but leak). Archive failures are swallowed (`scheduler/index.ts:652-657`) with **no ntfy** — silent file leaks.
- **F — Terminal-failed-not-cleaned (HIGH).** Covered in Phase 6.3 — `archive` only runs after a *merge*; there is **no fail→cleanup path**, so brief-421's file is stranded forever.
- **Plus:** `detectPr` line-85 does a raw `ref.includes(briefId)` substring match *before* the INS-211-hardened numeric path — an id that is a string-prefix of another (`brief-12` vs `brief-123`) can still mis-attach and **auto-merge the wrong PR** (`pr-manager.ts:81-97`); `detectPr` scans only the 10 newest PRs (a burst can push a brief's PR out of the window → stuck `executing`); `global_max_concurrent` falls back to `Infinity` if host detection misses (`orchestrator.ts:1058-1122`); DESIGN.md is materially stale (claims synchronous monitoring + no auto-retry, both false); the worktree-isolation capability (`worker/worktree.ts`) is **specified but unused** (all markers are `max_parallel_briefs: 1`).

### 7.3 Model/effort launch policy — `--effort max` hardcoded, **no model pinning**
`buildClaudeCommand` (`worker/worker.ts:132-144`) emits, verbatim:
```
cd <workingDir> && unset ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --effort max "<prompt>"
```
`--effort max` is **hardcoded**; there is **no `--model` flag anywhere** (full-tree grep finds only `--effort`). `BriefFrontmatter` (`types/index.ts:65-73`) parses 7 fields — none model/effort. So the model is whatever `claude` resolves at runtime; **this very audit's "must run on Opus 4.8" requirement depended on luck**, and `--effort max` is wasteful for trivial briefs. The server's model-recommendation classifier (Phase 4, *knows Opus 4.8*) is the obvious source but is not consulted.

**Per-brief model+effort is a clean ~4-file change** (daemon agent traced it precisely):
1. `types/index.ts:65-73` — add `model?`, `effort?` to `BriefFrontmatter`.
2. `poller/frontmatter.ts:39-69` — validate+extract them (mirror the `VALID_COMPLEXITY` allow-list).
3. `worker/worker.ts:132-144` — accept `model?`/`effort?`, emit `--model <m>` and `--effort <e>` (default `max`).
4. `worker/worker.ts:478` — pass `brief.frontmatter?.model`/`.effort` (already in scope via the `QueueEntry`).
No scheduler/state plumbing needed. Optionally set `model_used` (currently always `''`) for observability, and tie the default to the server classifier's recommendation.

### 7.4 Resumability — none today; minimal fix
**A brief survives neither pane death nor daemon restart** — both *abandon* in-flight work (7.2 A/B), and absence-of-PR is ambiguous with in-progress. There is no checkpoint/resume, no marker, no PID, no re-attach (KI-87 deliberately removed the marker write to keep the worker non-blocking).

**Recommended minimal fix (Option 1 — pane-independent completion, highest leverage):** have the dispatched command write an **exit marker** the tick polls, e.g. append `; echo "$?" > <statedir>/done/<briefId>.exit` to `buildClaudeCommand`, and add a tick step that reads markers to (a) complete a brief whose PR exists and (b) **distinguish "claude exited with no PR" (terminal failure → free slot + classify + run cleanup) from "still running" (no marker yet).** This closes A's core ambiguity *without* depending on pane liveness or process parentage, and it gives Failure F a deterministic signal to run failure-cleanup. (Option 2, full checkpoint/resume, is higher effort and weaker for the "died before any commit" case.) Either way this is a daemon change → human-checkpoint risk tier.

## Phase 8 — Boot + finalization banner specification (implementation-ready)

### 8.1 History & current state
- **D-35** server-rendered HTML boot banner (`renderBannerHtml`) → **ME-1 (S29)** migrated boot to compact **text** (`renderBannerText`, ~200–500B) to save ~5KB/boot under the 200K budget; **D-83 (S44)** added the client-side Tool Surface line; **D-84** hard-structured the Rule 2 boot / Rule 11 finalization response templates; **D-85** triple-restated Rule 9. **D-46** kept the **finalization** banner as server-rendered **HTML** (`renderFinalizationBanner`, `finalize.ts:1121`, red gradient, passed to `show_widget` verbatim).
- **Provenance gaps (verified):** **D-59 ("locked banner spec") and D-34 ("server-rendered banner") are referenced nowhere in the framework repo**; the boot banner's actual lock authority is ME-1 + D-83 + D-84/D-85 + "code is canonical." **D-84/D-85 are used by the templates but absent from the CHANGELOG**, and MCP template versions 2.10.0–2.18.0 are unlogged.
- **Current split & defects:** **boot = text/inline, finalization = HTML/`show_widget`** — two architectures for one visual family. `finalization-banner-spec.md:3` still cross-references the *deprecated v2.0* boot spec. **A live contradiction:** `finalization-banner-spec.md:19` says construct HTML manually on null fallback; `rules-session-end.md:53` says do **NOT**. The **Tool Surface and Suggested lines are client-rendered and unenforceable** — the one real drift surface the server-render architecture doesn't cover.

### 8.2 What "drift-proof" requires
Determinism comes from **the server computing every value and the client emitting the server's string verbatim** — the client has nothing to drift on because it is pure pass-through. The current design is 90% there; the gaps are (a) the client-rendered Tool Surface/Suggested lines, (b) two divergent architectures, (c) the null-fallback contradiction, (d) no version/integrity handshake so a drifted client is undetectable. The spec below closes all four while exploiting 500K to carry **more** intelligence in the banner.

### 8.3 Unified banner contract (the enforcement mechanism)
1. **Single opaque field per banner.** Server returns `banner_text` (startup) / `finalization_banner_text` (finalization) as a **complete, ready-to-display string**, plus `banner_spec_version` (integer). Deprecate `banner_html`/`banner_data` and the HTML finalization widget in favor of one text contract for both (text is copy-paste-safe across every client and removes the HTML-fallback contradiction; under 500K there is no token reason to prefer the ~200B text over a richer ~1–2KB text, so the banner can be **richer** and still trivially affordable).
2. **Verbatim pass-through (Rule 2 / Rule 11).** Claude emits the server string **inside exactly one fenced code block, byte-for-byte**, with an exhaustive FORBIDDEN list (no added prose, no reordering, no omissions, no markdown headings/widgets). This already exists for both responses — keep it, point it at the single field.
3. **Eliminate client-rendered values.** Either (a) the server computes the Tool Surface line from a `loaded_tools[]` array the client passes into `prism_bootstrap` (making it server-verifiable and drift-proof), or (b) it stays the single explicitly-client-rendered line, clearly delimited, and is the *only* exception. The `Suggested:` line is already server-emitted inside `banner_text` — keep it there.
4. **Integrity handshake.** Claude echoes `banner_spec_version` on its next tool call (or the server stamps it into the response); a mismatch surfaces a `BANNER_DRIFT` diagnostic at next boot. This makes drift *detectable*, not merely discouraged.
5. **One spec file** (`banner-spec.md`) covering both banners; delete the contradictory fallback clause; log D-84/D-85 + a "v4.0 unified text banner" entry in the CHANGELOG.

### 8.4 Startup banner — exact fields & ordering (richer, 500K-enabled)
Server renders these lines in this exact order; conditional sections omitted entirely when empty. (★ = new carryover the 500K headroom enables, reversing ME-1 slimming.)
```
PRISM v{templateVersion} · {ProjectDisplayName} · Session {N} · {MM-DD-YY HH:MM:SS} CST
Handoff v{hv} ({kb}KB) · {decisions} decisions ({guardrails} guardrails) · {docCount}/{docTotal} docs {healthLabel}
{✓/⚠/✗ tool} | {✓/⚠/✗ tool} | …                         ← tool status (server)
Suggested: {model} — {rationale}                          ← server (classifier; omit if none)
Brief: {fresh|N sessions old} · Risk: {top risk flag}     ← ★ from intelligence-brief.md (omit if none)

Resumption: {stripped, ≤400 chars}
Next:
▸ {step 1} [priority]
▸ {step 2…}
Recent: {D-N title; D-N title; …}                          ← ★ last 5–10 decisions (id+short title)
Standing rules: {A active}; new this session: {INS-N …}    ← ★ count + any newly-added
⚠ {warning …}                                             ← conditional
Tool Surface: ✓ N/N loaded (core ✓/… )                    ← the one client line (or server, per 8.3.3)
[S{N} · Ex 1 · 🟢 ~{pct}%]                                 ← Rule 9 context line (client), accurate vs 500K
```
**Formatting rules:** markdown stripped from `resumption`/`next`/`recent`; `resumption` truncated (raise the cap from 200→400 chars now that budget allows); icons `✓`U+2713 / `⚠`U+26A0 / `✗`U+2717 / `▸`U+25B8; the `Brief/Risk`, `Recent`, and `Standing rules` lines are the new intelligence carryover.

### 8.5 Finalization banner — exact fields & ordering (symmetric)
Same single-text contract, finalization values, this order:
```
PRISM v{templateVersion} · {ProjectDisplayName} · Session {N} Finalized · {timestamp} CST
Handoff v{hv} ({handoffLabel}) · {docsUpdated}/{docsTotal} docs updated · {decisions} decisions ({note})
{✓/⚠/✗ audit} | {✓/⚠/✗ draft} | {✓/⚠/✗ commit} | {✓/⚠/✗ verified}   ← finalization steps (server)
Synthesis: {regenerated|skipped|fallback}                  ← server (CS-2/CS-3 outcome)

Deliverables:
▸ {deliverable 1}
▸ {deliverable 2…}
Resumption (next session): {stripped resumption}
Suggested next session: {model} — {rationale}             ← server (omit if none)
Archived: {insights N→M KB; session-log …}                 ← ★ surface what retention actually did (Phase 6)
⚠ {warning …}   /   ✗ {error …}                            ← conditional
[S{N} · Ex {k} · {emoji} ~{pct}%]                          ← Rule 9 context line (client)
```
**Confirmation sentence (Claude, verbatim, after the fenced banner):** `Session {N} finalized. Handoff v{hv} pushed and verified. {X}/10 living documents updated. Memory synced.`

### 8.6 Server vs Claude render split (final)
- **Server renders 100% of the banner body** for both banners (every value computed server-side) and returns it as one string + `banner_spec_version`.
- **Claude renders:** the fenced wrapper + the Rule 9 context line (it knows exchange count) + (until 8.3.3 lands) the single Tool Surface line. Nothing else.
- **Drift-proofing:** pass-through + FORBIDDEN list + version handshake + `BANNER_DRIFT` diagnostic. A self-contained Phase-B brief; **auto-merge-safe** (additive, well-tested banner code path, no daemon/synthesis-transport risk).

## Phase 9 — Test & CI coverage (the autonomous-merge safety net)

### 9.1 CI-as-merge-gate VERDICT (CRITICAL) — determined from source + live API, not assumed
**CI is NOT a merge gate at either available layer. The Phase-B hands-off auto-merge loop (INS-281/282) is unsafe as built — it will merge PRs with red, pending, or entirely-absent CI.**

- **Gate (a) — Trigger's merge code does not inspect CI.** `trigger/src/github/merge.ts autoMerge` decides on `merged`, `mergeable` (boolean), and a bounded poll on `mergeable===null` only (`merge.ts:114-146`). It never reads check-runs, the combined commit status, or required checks. It squash-merges whenever `mergeable===true`, which GitHub sets on **absence of conflicts** — `true` even with failing/running CI when no branch protection requires checks. `mergeable_state` (the one field that *could* reflect CI via `blocked`/`unstable`/`behind`) is captured at `merge.ts:83` / `pr-manager.ts:216` but **never branched on anywhere** in `trigger/src/`. The scheduler calls `autoMerge` directly with no CI check before or after (`scheduler/index.ts:494`, `orchestrator.ts:941`).
- **Gate (b) — GitHub branch protection does not exist.** Verbatim: `gh api repos/brdonath1/prism-mcp-server/branches/main/protection` → **404 "Branch not protected"**; same for `trigger`; `…/rulesets` → **`[]`** on both. So no `required_status_checks` exists on either `main`; GitHub blocks nothing.
- **Synthesis:** neither gate is real → an autonomous loop merges whatever passes conflict detection. Worse, even the CI that exists runs `on: pull_request` **and** `on: push:[main]`, so `prism-mcp-server`'s post-merge CI executes *after* the squash already landed — it cannot retroactively block.

### 9.2 CI workflow & test inventory
| Repo | CI? | Jobs / checks | Tests | Coverage thresholds |
|------|-----|---------------|-------|---------------------|
| **prism-mcp-server** | ✅ `ci.yml` (push+PR to main, paths-filtered, node 18+20) | `build-and-test (18)` / `(20)`: `lint` (biome), `typecheck` (tsc), `npm audit` (**`continue-on-error`**), `build`, `test` (vitest). `model-freshness.yml` weekly. | **91 files** (last 5 CI runs green, 39–48s) | **NONE** (`vitest.config.ts` sets no coverage block) |
| **trigger** | ❌ **NO CI AT ALL** (no `.github/workflows/`) | **59 files / 795 tests pass locally (1.2s)** | 80% (`vitest.config.ts` + `.coverage-thresholds.json`) — but **never run in CI** → advisory only |
| **prism-framework** | ❌ none | 0 | — |

**The repo that performs the merges (`trigger`) has no CI whatsoever** — it merges code into its own `main` with zero automated lint/typecheck/test gate. The check-run names branch protection would reference on `prism-mcp-server` are `build-and-test (18)` and `build-and-test (20)`.

### 9.3 Coverage gaps for high-risk subsystems (what's needed before unattended merges)
- **(a) Synthesis transport — WELL COVERED.** `ai/__tests__/client-routing.test.ts` (cc_subprocess→messages_api fallback, per-call-site namespaces, unknown-transport) + `cc-subprocess.test.ts` (AUTH/TIMEOUT/zero-token/key-scrub). No major gap.
- **(b) Trigger daemon merge — CRITICAL GAP.** `tests/github/merge.test.ts` (7 tests) covers clean-merge / conflict / already-merged / 409 / null-poll but has **zero assertion about CI/check state** — because the code has no such behavior to test. **There is no test that `autoMerge` refuses red or pending CI.** This is the missing regression guard that must accompany the R1 fix. Compounding: none of `trigger`'s 795 tests run in CI, so even existing coverage isn't enforced on change.
- **(c) Patch engine — WELL COVERED.** `apply-pdu.test.ts`, `patch-integration.test.ts` (atomic, 409 re-apply, KI-26 sanitization), `sanitize-content.test.ts` (12, all h1–h6 + ZWS edges), `patch-deadline.test.ts`. No notable gap.
- **(d) Archival — COVERED for the splitter, but not the failure modes Phase 6 found.** `archive.test.ts` exercises under-threshold skip, boundary, oldest-archived, protected preservation, all-protected skip. But there is **no test that archival actually fires end-to-end at finalize when a doc is *not* in the files array** (the decisive Phase-6 coupling bug), and **no test that a real-shaped 78%-protected insights.md reaches the target** — both are required before the R2 retention rework merges unattended.

### 9.4 Load-bearing conclusion
The single highest-severity systemic risk for D-240 is that **CI is not a gate, there is no test that would catch a regression making it worse, and the repo that merges has no CI to run such a test.** Every Phase-B item touching the daemon, synthesis transport, or the patch/archival engine must be tiered **high-risk** and gated behind R1 (a real CI gate: `merge.ts` check-status inspection **and/or** branch protection with `required_status_checks` = `build-and-test (18)`/`(20)` on `prism-mcp-server`, **plus** standing up CI on `trigger`). Until R1 lands, "hands-off auto-merge" should be read as "auto-merge with no safety net."

<!-- EOF: brief-431-prism-framework-audit.md -->
