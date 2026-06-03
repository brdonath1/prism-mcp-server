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

<!-- EOF: brief-431-prism-framework-audit.md -->
