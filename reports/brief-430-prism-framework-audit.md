# Brief 430 — Comprehensive PRISM Framework Audit & Intelligence Review

> **Model: `claude-opus-4-8` · effort max** (§0 model gate honored — see Methodology)
> **Scope:** Phase A of D-240 — *analysis only*. No code changed in any repo; the sole diff is this report.
> **Repos analyzed:** `prism-mcp-server`, `prism-framework`, `trigger`, `prism` (the framework's own project-state repo) — all read from clean `main` clones under `/Users/brdonath/development/`.
> **Date:** 2026-06-03 · **Author:** Claude Opus 4.8 (dispatched via Trigger; this audit's findings were verified directly against source, not delegated wholesale).

---

## Executive Summary

**The single most important finding:** *The framework built to prevent context loss is losing its own context, and the loss is now self-reinforcing.* A single jammed pipeline runs end-to-end through the PRISM framework's own project state (`prism` repo):

1. `insights.md` is **448 KB — 22× the D-80 archival target (20 KB)** — and it can **never** shrink, because the D-80 retention policy protects every `STANDING RULE` entry and there are **230 of them** across 164 active entries. After the protection filter, `splitForArchive()` finds `nonProtected ≤ retentionCount(15)` and returns `skipReason: "all candidates are protected or within retention"` on every run. `insights-archive.md` has therefore **never been created**, despite the file being 22× over threshold.
2. Because synthesis (CS-1/CS-2/CS-3) reads the living documents *unbounded* — CS-2/CS-3 pull **all 10 living docs + 7 decision-domain files**, including `decisions/operations.md` (208 KB) and `decisions/architecture.md` (127 KB) on top of the 448 KB insights — each synthesis call ingests **~1.2 MB (~340K tokens)** of input and **times out** against the 180 s draft deadline (`FINALIZE_DRAFT_DEADLINE_MS`).
3. So S145 finalize ran `skip_synthesis: true` (per the brief's verified context), the intelligence brief goes stale, and the boot payload — which already ships only a **3-sentence compacted** brief (D-47) and *discards* the full one — carries even less.
4. Meanwhile decisions **D-235, D-236, D-239, and D-240** are referenced in commit messages, PRs, and this very brief, but the decision index tops out at **D-234** — none of them were ever written to any decisions file. **D-240 — the decision this audit is "Phase A" of — exists only in the brief that commissioned it.** The same is true of `INS-281` (max recorded insight is `INS-277`).

Net: **the PRISM framework's own project state is the worst-maintained PRISM project in the fleet.** The capture-and-archive machinery is jammed at every stage — insights don't archive, synthesis can't run, decisions aren't recorded, and (separately) merged briefs aren't cleaned from the queue. This is exactly the operator's complaint ("documents get reviewed/re-uploaded and are not archived or documented properly") expressed mechanically, and it is fixable.

**Strategic context (D-240):** the chat surface is now a **500K** context window, and D-240 deliberately *reverses* the D-47 / D-193 token-slimming. Every recommendation below is framed around **using the 500K headroom to carry more and richer intelligence**, not shrinking the payload. The boot payload today is ~12K tokens — **~2.4 % of 500K** — yet the server still reports its budget against a hardcoded **200K** window (`DEFAULT_CONTEXT_WINDOW_TOKENS`), overstating boot cost by 2.5× and actively discouraging the enrichment D-240 mandates.

**Top recommendations** (full scoring, acceptance criteria, dependency order, and risk tiers in the Prioritized Roadmap, Phase 10):

| # | Recommendation | Tier | Severity |
|---|----------------|------|----------|
| 1 | Emergency-archive `insights.md` to the D-80 target (one-time unblock) | Quick win | **Critical** |
| 2 | Bound synthesis inputs (per-doc byte cap; summarize/exclude decision-domain files) | Medium | **Critical** |
| 3 | Redesign insights retention so `STANDING RULE` entries don't form an unbounded live floor | Architectural | **High** |
| 4 | Make the context-window estimate model-aware (200K→500K) and ship the **full** intelligence brief at boot (reverse D-47 per D-240) | Quick win | **High** |
| 5 | Per-brief `model` + `effort` in Trigger (frontmatter → `--model`/`--effort`); enable pinning Opus 4.8 | Medium | **High** |
| 6 | Gate Trigger auto-merge on CI (or verify+document branch protection) — prerequisite for the INS-281 hands-off loop | Medium | **Critical** |
| 7 | Brief-lifecycle hygiene: reliably archive merged briefs, clean terminal-failed briefs from the queue | Quick win | **Medium** |
| 8 | Decision/insight capture enforcement: reconcile D-235…D-240; surface "referenced-but-unlogged" IDs at finalize | Medium | **High** |

*(The full 17-item roadmap — including the implementation-ready Banner v4.0 spec and the remaining hardening work — is in Phase 10.)*

---

## Methodology

**§0 model gate.** This audit was commissioned specifically for Claude Opus 4.8 at maximum effort. As the very first action I confirmed the running model is `claude-opus-4-8` (1M-context variant) at `--effort max`; the gate passes and the audit proceeded. Had the model been anything else, §0 required aborting with a stub report — notably, the Trigger worker that dispatches this brief (`buildClaudeCommand`, `worker.ts:141`) emits `claude --dangerously-skip-permissions --effort max` with **no `--model` flag**, so the gate is the only thing standing between this audit and an unintended-model run. (See Phase 7.)

**What was analyzed and how.** All four repos were read from clean `main` clones. I loaded the full file trees, then read the load-bearing source directly — `src/tools/bootstrap.ts`, `config.ts`, `src/ai/client.ts`, `src/ai/synthesize.ts`, `src/tools/finalize.ts`, `src/utils/archive.ts`, `src/github/client.ts`, the `trigger` daemon's `worker.ts`/`merge.ts`, and the framework templates. Byte sizes and structural counts were measured with `wc`/`grep` against the live files (raw numbers in the Appendix). Breadth inventory (every MCP tool's I/O and the full Trigger lifecycle) was gathered with parallel read-only sub-agents and then **the load-bearing claims were re-verified by me against source** — specifically the CI-merge gating (`merge.ts:140`) and the worker command construction (`worker.ts:141`). Decision/insight history was extracted from the `prism` repo's `decisions/` domain files and `insights.md`.

**Verified starting context** (from the brief, §"Verified starting context") was treated as ground truth and built upon rather than re-derived: the high Trigger infra-failure rate, pane-death stranding (KI-87), hardcoded `--effort max` with no model pin, the 448 KB `insights.md`/synthesis timeout, the unarchived/unclean brief pipeline, and the 500K-headroom mandate.

**Severity scale** used throughout: **Critical** (breaks continuity or risks data/merge integrity now), **High** (materially degrades intelligence/reliability), **Medium** (notable debt or drift), **Low** (polish).

---

## Phase 1 — Mission & Intelligence Mandate

### 1.1 The mission, in one paragraph

PRISM exists to defeat Claude's **zero cross-session memory** for a *solo operator (Brian) running many long-lived projects in parallel across sessions and surfaces*. It gives Claude a structured external memory — a set of GitHub-backed "living documents" per project — so that session N+1 resumes with the decisions, constraints, rejected approaches, institutional knowledge, and current state that session N accumulated, without the operator re-explaining context each time. The MCP server (this repo) is the v2 evolution: it turns Claude into a pure reasoning agent and offloads all mechanical GitHub I/O to a stateless server, collapsing finalization from 13–16 tool calls to 2–3 and bootstrap context from ~15–20 % to ~3–5 %, while adding server-side validation, synthesis, analytics, and multi-project awareness.

### 1.2 The intended intelligence model (three tiers) — explicit as *structure*, not as a *metric*

PRISM's design (framework `docs/THREE_TIER_ARCHITECTURE.md`, now marked deprecated but still foundational) distributes intelligence across three tiers:

- **Tier 1 — Structural:** intelligence encoded in document *schemas* (handoff format, `D-N`/`G-N` records, `decisions/_INDEX.md`, the compression curve). Claude continues the pattern because it is reading and writing the structure.
- **Tier 2 — Behavioral:** ~14 concise action rules carried every session (now in `_templates/core-template-mcp.md`, template v2.19.1, including Rule 2 boot-comprehension and Rule 9 context-awareness).
- **Tier 3 — Situational:** deep procedures loaded only on trigger (finalization, scaling, fresh-eyes, error-recovery).

Layered on top is the **synthesized intelligence brief** (D-44) and **standing rules** (D-41, tiered A/B/C per D-156). Together these define *what should carry over*: structural state (handoff + decisions), behavioral compliance (rules), situational depth (modules), distilled knowledge (insights/standing rules), and an AI summary (brief).

**The gap: the target is defined qualitatively, never measurably.** Nowhere does the system define "intelligence carried over" as something you can *check*. There is no metric for "is the brief current?", "are the decisions referenced in commits actually logged?", "did standing rules reach the session?", "is insights.md queryable or has it ossified?". Health is tracked only as coarse document-size/presence flags (`prism_status` health = healthy/needs-attention/critical) and a brief-age warning (>2 sessions stale). The framework measures *whether files exist and are small*, not *whether intelligence is intact*.

### 1.3 Where continuity actually breaks (intent vs. reality)

Concretely, in the `prism` project state today:

| Break | Evidence | Severity |
|-------|----------|----------|
| **Synthesis skipped** — the intelligence brief is not refreshed | S145 finalize ran `skip_synthesis: true`; synthesis times out on 1.2 MB input (Phase 5) | **Critical** |
| **Decisions not recorded** — settled choices never reach the index | Index max = **D-234**; commits reference D-235/236/239/**240** (Phase 2) | **Critical** |
| **Knowledge ossified** — `insights.md` is 448 KB and cannot archive | 230 protected `STANDING RULE` entries (Phase 6) | **Critical** |
| **Boot under-delivers intelligence** — only 3 sentences of the brief reach the session | `intelligenceBriefFull` read then discarded (`bootstrap.ts:799`); D-47 compaction (Phase 3) | **High** |
| **Behavioral drift undetected** — no measure of rule compliance across sessions | No mechanism; INS-2/INS-3 document drift as a known pattern | **Medium** |

### 1.4 Recommendation — an explicit, measurable "Continuity Scorecard"

Define "intelligence carried over" as a small set of server-computable invariants, surfaced at boot and finalize and tracked over time (this is the measurable definition the brief asks for):

1. **Brief freshness** = `current_session − last_synthesized_session` (target ≤ 1; already partially computed as `brief_age_sessions`).
2. **Decision-capture lag** = highest `D-N` referenced in the last K commit messages − highest `D-N` present in `decisions/_INDEX.md` (target 0). *This single metric would have caught the D-235…D-240 gap immediately.*
3. **Insight queryability** = `insights.md` bytes vs. D-80 target, and whether `prism_search`/standing-rule extraction completes under a bound (target: live file ≤ ~40 KB at 500K).
4. **Standing-rules delivery** = count of Tier-A rules delivered at boot vs. total Tier-A (target: 100 %).
5. **Synthesis success rate** = rolling success/failure from `synthesis-tracker` (target: > 0 successes in last 3 finalizes).

Bundle these into a `continuity_score` block in the bootstrap response and a banner line. **Acceptance:** a project whose brief is 4 sessions stale, whose decisions lag by 6, and whose insights.md is 22× target (i.e., today's `prism` repo) must score "critical" and say *why*, in one line, at boot.

---

## Phase 2 — Architecture Review

### 2.1 The four components and how a session flows

```
                 ┌──────────────────────────────────────────────┐
                 │  Claude.ai chat session (operator + Opus)    │   500K context window
                 └───────────────┬──────────────────────────────┘
                                 │ MCP Streamable HTTP (stateless, ~60s ceiling)
                 ┌───────────────▼──────────────────────────────┐
   reads ◄───────┤  PRISM MCP Server (Railway) v4.7.0            ├───────► Anthropic Messages API (synthesis CS-1/2/3)
   templates     │  23 tools, stateless proxy                   ├───────► Claude Code subprocess (OAuth: CS-* + cc_dispatch)
                 │  GitHub client · validation · synthesis ·    ├───────► Railway GraphQL (railway_* tools, boot observation)
                 │  patch engine · archive · safe-mutation      │
                 └───┬───────────────────────────┬──────────────┘
                     │ GitHub REST/Trees API      │
   ┌─────────────────▼────────┐   ┌──────────────▼───────────────┐
   │ prism-framework          │   │ project repos: brdonath1/*    │
   │ _templates/ (Tier 2/3,   │   │   .prism/  (10 living docs)   │
   │ banner specs, modules)   │   │   .prism/briefs/queue/        │
   └──────────────────────────┘   └──────────────┬───────────────┘
                                                  │ marker .prism/trigger.yaml
                 ┌────────────────────────────────▼──────────────┐
                 │  Trigger daemon (local Mac, iTerm panes)       │
                 │  poller → scheduler tick → worker → PR detect  │
                 │  → merge → post-merge(notify, archive)         │
                 │  state: brdonath1/trigger:state/<slug>.json    │
                 └────────────────────────────────────────────────┘
```

**Boot:** `prism_bootstrap(project_slug, opening_message?)` → server fetches handoff + `decisions/_INDEX.md` + behavioral-rules template (cached) in parallel, parses handoff sections, extracts/tiers standing rules from `insights.md`, compacts the intelligence brief, renders a text banner, drops the Trigger marker, pushes a boot-test, checks stale-active + synthesis-observation (Railway), applies stale PDUs, and returns one structured JSON envelope.
**Work:** the session logs decisions/insights incrementally (`prism_log_decision`/`prism_log_insight`), patches narrative docs (`prism_patch`), fetches/searches on demand (`prism_fetch`/`prism_search`), and checkpoints (`prism_push`).
**Persist/Finalize:** `prism_finalize action=full` runs audit → draft (CS-1, Opus) → atomic commit (handoff + any drafts) → post-commit sweeps (PDU apply, architecture refresh, task-queue prune, size-triggered archive) → fire-and-forget synthesis (CS-2 brief + CS-3 PDU).
**Brief flow:** Trigger's poller discovers `brief-*.md` on `main`, the scheduler tick dispatches one to a worker (iTerm pane running `claude … --effort max`), then PR-detects → merges → runs post-merge actions.

### 2.2 Separation of concerns — mostly clean, with one structural fault

The macro split is sound and matches D-2 (separate repo per project) and D-8 (naming): the MCP server is a stateless proxy (all state in GitHub, per A.6), the framework holds templates, Trigger holds orchestration, project repos hold state. The MemoryCache/Anthropic singletons are legitimately safe in stateless mode (read-only/config-only).

**The structural fault: the framework's decision history is fragmented across project states with colliding numberspaces.**

- The MCP server's *real* development history (D-2 … D-234, the 448 KB `insights.md`, the 208 KB `decisions/operations.md`) lives in the **`prism`** project state — i.e., "PRISM Framework" the project is also the de-facto home for "prism-mcp-server" the codebase's decisions.
- `prism-mcp-server/.prism/` is a **near-empty auto-scaffolded** PRISM state: 5 decisions (max **D-5**), a 2.7 KB handoff, **no `insights.md`, no `intelligence-brief.md`**. It exists because bootstrap auto-enrolls the repo in Trigger and scaffolds living docs, but it is effectively abandoned.
- The two stores use **overlapping `D-N` numbers for different decisions** (both have a "D-2"), so a reader cannot tell which "D-2" a commit means without knowing which project state is authoritative.
- KI-87 and INS-148 live in the `prism` state; INS-69 lives in this repo's `CLAUDE.md` and the `prism` brief; D-240/INS-281 live only in the brief. There is **no single registry** for decisions about the MCP server.

This is load-bearing because the framework's value proposition is "decisions and knowledge are durably captured and findable," and for its own flagship codebase they are scattered, partially-duplicated, and partially-unrecorded.

### 2.3 Architectural debt & undocumented load-bearing assumptions

| Debt / assumption | Where | Why it's fragile |
|---|---|---|
| **Unbounded living-doc reads** drive cost everywhere | synthesis (Phase 5), `prism_search`, `prism_analytics`, boot standing-rule extraction reads full 448 KB `insights.md` | Cost/latency scale with the *largest* project's worst file; one bloated file degrades many tools |
| **Context window hardcoded to 200K** | `config.ts:68` `DEFAULT_CONTEXT_WINDOW_TOKENS` | Comment admits true window is 500K; estimate overstates cost 2.5× and fights D-240 |
| **Completion detection depends on pane liveness** | Trigger `worker.ts` returns immediately (KI-87); scheduler-tick drives merge | A dead pane strands completed work with no signal (Phase 7) |
| **Auto-merge safety depends on unmanaged branch protection** | `merge.ts:140` merges without CI check | If branch protection isn't configured, red CI merges (Phase 9) |
| **Decision/insight capture depends on Claude remembering to log** | INS-178 ("files array is the wall" → log incrementally) | No enforcement; the D-235…D-240 gap is the result |
| **Synthesis blocked by one file's structure** | `INSIGHTS_ARCHIVE_CONFIG` protection rule | A design intended to protect standing rules instead jams the whole pipeline (Phase 6) |

---

## Phase 3 — Boot Payload & Context-Budget Analysis (framed for 500K headroom)

### 3.1 `prism_bootstrap` response, field by field

Source: `src/tools/bootstrap.ts` (registration at `:412`; result object `:962–1003`). Fields, source, and notes:

| Field | Source | Notes / cost |
|---|---|---|
| `project`, `handoff_version`, `template_version`, `session_count`, `session_number`, `session_timestamp` | parsed handoff `## Meta` + clock | tiny scalars |
| `handoff_size_bytes`, `scaling_required` | `handoff.size` vs `HANDOFF_CRITICAL_SIZE` (15 KB) | scalar |
| `critical_context` | `extractSection(handoff,"Critical Context")` → numbered list | small |
| `current_state` | `extractSection(handoff,"Where We Are")` | small–med |
| `resumption_point` | `Resumption Point`/`Next Action` | **redundant with banner + next_steps** |
| `recent_decisions` | last 5 of `_INDEX` table | small |
| `guardrails` | first 10 SETTLED decisions | small |
| `next_steps` | `Next Steps`/`Immediate Next` | **redundant with banner_text** |
| `open_questions` | `Open Questions` | small |
| `prefetched_documents[]` | keyword prefetch (cap 2) + `pending-doc-updates.md` | each carries `summary` (summarized) |
| `standing_rules` | `selectStandingRulesForBoot(insights, opening_message)` | Tier A always + Tier B topic-matched; **biggest variable** |
| `intelligence_brief` | **D-47 compaction**: 3 sentences of Project State + Risk Flags + Quality Audit | **`intelligenceBriefFull` is read (`:767`) then DISCARDED** |
| `brief_age_sessions` | `session_count − last_synthesized` | scalar (basis for the freshness metric) |
| `behavioral_rules` | full `core-template-mcp.md` (**29.2 KB**) | **largest single component** |
| `banner_html` | `null` (ME-1 removed HTML) | — |
| `banner_text` | `renderBannerText(...)` | ~1–2 KB; **duplicates next_steps/resumption** |
| `boot_test_verified`, `trigger_enrollment`, `bytes_delivered`, `files_fetched` | operational | scalars |
| `context_estimate{}` | `/3.5` chars-per-token, denominator = **200K** | **inaccurate — see 3.4** |
| `expected_tool_surface`, `post_boot_tool_searches` | `tool-registry` (D-83) | static-ish |
| `recommended_session_settings` | persisted (D-193) or classified | small |
| `pdu_applied_at_boot` | stale-PDU safety net | usually null |
| `warnings`, `diagnostics` | collectors | small |

### 3.2 Redundancy (quantified)

The brief specifically flags resumption/next-steps appearing in both handoff data and banner. Confirmed:

- **`next_steps`** appears as the structured `next_steps[]` array **and** verbatim inside `banner_text` (`renderBannerText` consumes `nextSteps`).
- **`resumption_point`** appears as a top-level field **and** is re-derived into `banner_text` via `parseResumptionForBanner(resumptionPoint, currentState)`; `current_state` thus appears twice (raw + in resumption).
- The redundancy is **small in absolute bytes** (~1–2 KB) — and under the 500K mandate this is **not worth "fixing" by removal**. The right framing (per D-240) is: keep the banner self-contained (it must render deterministically) and treat the duplication as cheap. *Do not slim this.*

### 3.3 Prefetch & standing-rule tiering — is the right material reaching the session?

- **Prefetch** (`determinePrefetchFiles`, `config.ts:PREFETCH_KEYWORDS`) is keyword→doc, **hard-capped at 2 docs** (`bootstrap.ts:570`, QW-4). On the 500K surface this cap is now **over-conservative** — it was set to protect a 200K budget. There is room to raise it and to prefetch *proactively* (e.g., always include `architecture.md` summary for engineering projects).
- **Standing rules** (`selectStandingRulesForBoot`): Tier A always loads, Tier B loads only on topic-keyword match, Tier C never at boot. This is sound, but it depends on reading the **entire 448 KB `insights.md`** at boot to extract them (`bootstrap.ts:812`, server-side only — not delivered, but a per-boot fetch+parse cost). With insights.md bloated, boot does more work than it should; and Tier-C rules being permanently boot-invisible means real knowledge never reaches sessions that didn't name the right keyword.

### 3.4 Boot token budget against **500K** (the headroom is enormous)

Measured component sizes (Appendix A): `behavioral_rules` 29.2 KB + compact `intelligence_brief` ~3 KB + handoff-derived fields ~3–4 KB + `standing_rules` (varies, ~2–6 KB) + `banner_text` ~1.5 KB + up to 2 prefetched summaries (~1–2 KB) ≈ **~40–45 KB JSON**. At the server's own `/3.5` heuristic that is **~11–13K tokens**.

| Denominator | Reported boot % | Reality |
|---|---|---|
| **200K** (`DEFAULT_CONTEXT_WINDOW_TOKENS`, today) | ~6–7 % (incl. 7.5K platform+schema padding) | misleading |
| **500K** (actual chat surface, D-240) | **~2.4–3 %** | **97 %+ free for work and richer carryover** |

**Two concrete estimate bugs, both pushing toward false scarcity:**
1. **Wrong denominator.** `config.ts:68` hardcodes 200K and the comment *admits* the true window is 500K. The server "cannot know the active model," but it can be told (add a `client_context_window` input, or default to 500K for the Opus/Sonnet-4.x surface). Overstating cost by 2.5× directly discourages the enrichment D-240 mandates.
2. **Undercount of fields.** The `responseJson` used for `bootstrap_tokens` (`bootstrap.ts:951–955`) serializes only **6 fields** (`project, handoff_version, behavioral_rules, standing_rules, intelligence_brief, banner_text`) — it omits `critical_context`, `current_state`, `recent_decisions`, `guardrails`, `next_steps`, `prefetched_documents`, `expected_tool_surface`, etc. So the estimate is simultaneously **over** (200K denominator) and **under** (missing fields) — two errors that partly mask each other and make the number untrustworthy either way.

### 3.5 Where there is now *room to carry more* (the D-240 opportunities)

Every item the framework previously trimmed for a 200K budget is now affordable:

- **Ship the full intelligence brief.** `intelligenceBriefFull` is already fetched (`bootstrap.ts:767`) and then thrown away in favor of a 3-sentence compaction (D-47). At 500K the full ~11 KB brief costs ~0.6 % — deliver it. *(Reverses D-47 compaction per D-240.)*
- **Raise the prefetch cap and add proactive prefetch** (architecture summary, known-issues for debugging sessions).
- **Deliver Tier-B (and optionally Tier-C) standing rules more generously** rather than gating tightly on keywords — the budget that justified tight gating is gone.
- **Carry a "continuity scorecard"** (Phase 1.4) and a richer decisions slice (e.g., last 15 + all OPEN/PENDING, not just last 5 + first-10-SETTLED).

### 3.6 Rule 9 context-estimation formula — accuracy vs. 500K

Rule 9 (now in `core-template-mcp.md`, Tier 2) is the client-side context-awareness rule; the server's `context_estimate` is its server-side companion. Against the 500K window the server estimate is **inaccurate in both directions** (3.4) and **anchored to the wrong window**. **Recommendation:** make the denominator model-aware (accept the window from the client or default to 500K), include *all* response fields in the numerator, and reframe the Rule-9 guidance so "context is heavy" triggers at a fraction of 500K — not 200K. Acceptance: `total_boot_percent` for the `prism` project reports ≤ 3 % on the 500K surface and the numerator matches `responseBytes` within 10 %.
---

## Phase 4 — Full MCP Server: Every Tool, Process, and Sub-Process

### 4.1 Tool inventory (23 tools)

`getExpectedToolSurface` (`tool-registry.ts`) registers 13 core PRISM tools always, +4 GitHub (`gh_*`, with PAT), +4 Railway (with `RAILWAY_API_TOKEN`), +2 Claude Code (with `CLAUDE_CODE_OAUTH_TOKEN`). Per-tool audit (inputs → response → deadline → over-return risk):

| Tool | Key inputs | Response (top-level) | Wall-clock deadline | Over-return risk | Notes |
|---|---|---|---|---|---|
| `prism_bootstrap` | project_slug, opening_message? | 25+ fields (Phase 3) | none (many parallel I/O) | Low (capped) | reads 448 KB insights server-side; Railway log fetch at boot |
| `prism_fetch` | project_slug, files[], summary_mode? | files[] w/ content | none | **Moderate** — full file unless `summary_mode` | per-file parallel fetch |
| `prism_push` | project_slug, files[], skip_validation? | results[], commit_sha | **`PUSH_WALL_CLOCK_DEADLINE_MS`=60s** | Low (atomic) | all-or-nothing validation |
| `prism_patch` | project_slug, file, patches[] | results[], integrity_check | **`PATCH_WALL_CLOCK_DEADLINE_MS`=60s** | Low | INS-240/246 hazards (4.4) |
| `prism_status` | project_slug?, include_details? | health, sizes, archives, projects[] | **none** | **High** (multi-project × details) | fan-out across fleet, cached 5–10 min |
| `prism_finalize` | project_slug, action, files?, handoff_content? | audit/draft/commit/full | commit 90s; draft **180s/300s** | Low | the core write path (Phase 5/6) |
| `prism_analytics` | project_slug?, metric | data{} by metric | **none** | **High** (decision_graph, file_churn) | up to 30 `getCommit` calls |
| `prism_scale_handoff` | project_slug, action, plan? | sizes, push_results[] | **`SAFETY_TIMEOUT_MS`=50s** | Moderate (`content_to_move`) | atomic + sequential fallback |
| `prism_search` | project_slug, query, max_results? | results[] (capped) | **none** | Low (capped) | fetches all docs + domain files |
| `prism_load_rules` | project_slug, topic, include_tier_c? | matched_rules[], counts | **none** | Low | single insights.md read |
| `prism_log_decision` | project_slug, id, title, … | index/domain updated | none (safeMutation ≤1 retry) | Low | **dedup guard** (brief-104 A.1) |
| `prism_log_insight` | project_slug, id, …, standing_rule? | success | none | Low | dedup guard |
| `gh_create_release`/`gh_update_release` | repo, tag/release_id, … | release_id, html_url | none | Low | thin REST pass-through |
| `gh_delete_branch`/`gh_delete_tag` | repo, branch/tag | deleted, note? | none | Low | default-branch + open-PR guards |
| `railway_deploy`/`railway_env`/`railway_logs`/`railway_status` | project, service, … | action-specific | **none** | **Moderate** (logs ≤200 lines; env list) | Railway GraphQL |
| `cc_dispatch` | repo, prompt, mode, async_mode? | dispatch_id, status, pr_url | **`CC_DISPATCH_SYNC_TIMEOUT_MS`≈45s** (sync) | **Moderate** (agent output) | async path unbounded |
| `cc_status` | dispatch_id?, limit? | record(s) | none | Low | memory + GitHub fallback |

**Systemic observation:** the read/analytics tools that fan out across the whole fleet or all living docs — `prism_status`, `prism_analytics`, `prism_search` — have **no wall-clock deadline**. They rely solely on the per-request 15 s GitHub timeout × N parallel calls. On a large fleet or against the 448 KB `insights.md`, these can approach the ~60 s MCP ceiling. Every *write* path has a deadline; the *read* paths do not. **(Finding 4-A, Medium.)**

### 4.2 GitHub client (`src/github/client.ts`)

- **Transport:** plain `fetch` (no Octokit), Contents API in JSON mode (base64 `content` + `sha` in one call). `GITHUB_REQUEST_TIMEOUT_MS = 15 s` per request via `AbortSignal.timeout`, combined with any caller signal via `AbortSignal.any`.
- **Retry (`fetchWithRetry`):** retries **only 429** (rate-limit), up to 3×, exponential backoff `min(retryAfter·1000·2^attempt, 120_000)`. Timeouts do **not** retry (correct — a hung socket shouldn't be retried). **Finding 4-B (Low/Medium):** a 429 storm can back off up to **120 s on a single attempt** — well beyond the 60 s MCP ceiling; the request will be abandoned client-side before the backoff completes. Backoff should be capped to the remaining tool budget.
- **Atomic commits (`createAtomicCommit`):** 5-step Git Trees flow; deletes via `sha:null` tree entries. Carries a hard-won correctness comment about the **`GET /git/ref/` (singular) vs `PATCH /git/refs/` (plural)** asymmetry (the S40 C3 bug that went unnoticed 5 days). Guarded by `tests/atomic-commit-url.test.ts`. This is solid.
- **`pushFile` (non-atomic):** `fetchSha` → PUT; 409 → one retry with fresh SHA. Used for single-file writes (boot-test, backups); the atomic path (`safeMutation`/`createAtomicCommit`) is used for multi-file/finalize/patch/log-*.
- **`listRepos`:** paginates 100/page with no cap — invoked at boot for **dynamic slug resolution** (`resolveSlugDynamic`) whenever the static map misses. On a large account this is several sequential round-trips on the boot critical path. **Finding 4-C (Low).**

### 4.3 Middleware, validation, config, safe-mutation, doc-resolver

- **Auth** (`middleware/auth.ts`): `/health` always open (Railway healthcheck); else Bearer token via **timing-safe compare** + optional IP allowlist (`ANTHROPIC_CIDRS` + `ALLOWED_CIDRS`). Dev mode (neither set) = open. Sound.
- **Validation** (`validation/*`): synchronous, no I/O; `validateFile` routes by path to handoff/decisions/common checks (EOF sentinel, `## Meta`, decision-table columns, `D-N` format, status enum). Enforced in `prism_push` and `commitPhase`.
- **`safe-mutation.ts`** (the atomic primitive): snapshots HEAD **before** reading, `readAll` in parallel (one missing path aborts), `computeMutation` runs against fresh content (so the dedup/patch logic re-runs on retry), `createAtomicCommit`, 409 → re-read + retry (default 1), optional `deadlineMs` via `Promise.race`. Diagnostic codes: `MUTATION_CONFLICT`, `MUTATION_RETRY_EXHAUSTED`, `HEAD_SHA_UNKNOWN`, `DEADLINE_EXCEEDED`. This is the best-engineered part of the server.
- **`doc-resolver.ts`:** resolves `.prism/{doc}` with root-path fallback (D-67 back-compat). `resolveDocFilesOptimized` cuts 2N calls to 1 `listDirectory` + N targeted fetches.

### 4.4 Patch engine — the ZWS / `sanitizeContentField` behavior (INS-240 / INS-246 / KI-26)

- **KI-26 (RESOLVED S116):** user-supplied content beginning with `## ` would be parsed as a real section header on the next read, corrupting the section tree. Fix: `sanitizeContentField` (`sanitize-content.ts:20`) inserts a zero-width space `​` after leading `#{1,6} ` clusters: `text.replace(/(^|\n)(#{1,6}) /g, "$1$2​ ")`. Applied to `prism_log_decision` (title/reasoning/assumptions/impact) and `prism_patch` (content). **Caveat:** the ZWS persists in the stored file — invisible but present; any downstream exact-match on header text must account for it. A queued follow-up, **`brief-421-ki26-header-injection-sanitization`, sits terminal-failed in `.prism/briefs/queue/`** (Phase 6/7).
- **INS-240 (STANDING RULE):** `prism_patch replace` on a `##`/parent header replaces *everything* to the next sibling-or-higher header — it destroyed ~14 KB of nested subsections in S111. `validateIntegrity` does **not** catch this (the result is structurally valid, just shorter).
- **INS-246 (STANDING RULE):** `replace` operates on the section **body only** and does *not* consume the header; including the header in `content` yields silent duplicate-header corruption.

These are **behavioral hazards mitigated by standing rules, not by code**. The integrity check flags duplicate/empty sections but not "you just deleted a subtree" or "you replaced less/more than you intended." **Finding 4-D (Medium):** add a pre-replace structural guard (refuse `replace` on a header that has child headers unless `force:true`; compare pre/post byte delta against an expected band) so the hazard is enforced server-side rather than relying on Claude recalling INS-240/246.

### 4.5 Slowness / error / timeout sources (named)

| Location | Cost | Trigger |
|---|---|---|
| `synthesize.ts:generateIntelligenceBrief/PendingDocUpdates` | reads ~1.2 MB doc bundle | every finalize synthesis (Phase 5) — **the dominant cost** |
| `bootstrap.ts:812` standing-rule extraction | reads full 448 KB `insights.md` | every boot |
| `bootstrap.ts:checkSynthesisObservation` | Railway GraphQL log fetch (limit 200) | every boot when `RAILWAY_API_TOKEN`+env set |
| `bootstrap.ts:resolveSlugDynamic`→`listRepos` | paginated repo list | boot when static slug map misses |
| `github/client.ts:fetchWithRetry` | up to 120 s 429 backoff | rate-limit storm |
| `prism_status`/`prism_analytics`/`prism_search` | unbounded fleet/doc fan-out, **no deadline** | large fleet or bloated docs |
| `finalize.ts:auditPhase` | `getCommit` per-commit N+1 (capped 5) | every finalize audit |

---

## Phase 5 — Synthesis Layer

### 5.1 Call-site routing (CS-1 … CS-4)

| Call-site | Function | Input bundle | thinking | Per-attempt timeout | Deadline (finalize) | `callSite` |
|---|---|---|---|---|---|---|
| **CS-1 draft** | `finalize.ts:draftPhase` | `DRAFT_RELEVANT_DOCS` = living docs **minus** architecture/glossary/brief/archives — **but still includes `insights.md` (448 KB)** | yes, retries 0 | `resolveDraftTimeout` = **150 s** msg / 600 s cc | `resolveDraftDeadline` = **180 s** msg / 300 s cc | `"draft"` |
| **CS-2 brief** | `synthesize.ts:generateIntelligenceBrief` | **all 10 living docs (−brief) + 7 decision-domain files** | yes | `SYNTHESIS_TIMEOUT_MS` = 240 s msg / 600 s cc | n/a (fire-and-forget) | `"brief"` |
| **CS-3 PDU** | `synthesize.ts:generatePendingDocUpdates` | same as CS-2, minus brief+pdu | yes | 240 s msg / 600 s cc | n/a (fire-and-forget) | `"pdu"` |
| **CS-4 dispatch** | `claude-code/client.ts:dispatchTask` | Agent SDK against a cloned repo | n/a | `CC_DISPATCH_SYNC_TIMEOUT_MS`≈45 s (sync) | n/a | separate (OAuth) |

**Transport selection** (`ai/client.ts:resolveCallSiteRouting`): per call-site, reads `SYNTHESIS_${SITE}_TRANSPORT` ∈ {`messages_api`,`cc_subprocess`} and `SYNTHESIS_${SITE}_MODEL`. `cc_subprocess` routes through `synthesizeViaCcSubprocess` (OAuth/Max subscription); **on subprocess failure it falls back to `messages_api` with the default model** and logs `SYNTHESIS_TRANSPORT_FALLBACK` (which boot surfaces via `checkSynthesisObservation`). The `messages_api` path honors the per-site model override. Adaptive thinking is sent as `thinking:{type:"adaptive"}` (Opus 4.7+ accepts only the adaptive variant).

**Env control surface (complete):** `SYNTHESIS_MODEL` (global default, now `claude-opus-4-8` via `models.ts`), `SYNTHESIS_ENABLED` (derived from `ANTHROPIC_API_KEY`), `SYNTHESIS_{DRAFT,BRIEF,PDU}_TRANSPORT`, `SYNTHESIS_{DRAFT,BRIEF,PDU}_MODEL`, `SYNTHESIS_TIMEOUT_MS` (240 s), `CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS` (600 s), `FINALIZE_DRAFT_TIMEOUT_MS` (150 s), `FINALIZE_DRAFT_DEADLINE_MS` (180 s), `FINALIZE_DRAFT_DEADLINE_CC_MS` (300 s). Per recent history, CS-3→OAuth (Phase 3c-A), CS-2→OAuth (Phase 3c-B, ~81 % API-spend cut), CS-1→OAuth (Phase 5b, gated on `SYNTHESIS_DRAFT_TRANSPORT`).

### 5.2 Root cause of the synthesis timeouts

**Quantified.** Synthesis cost is dominated by *input* size. For the `prism` project:

- **CS-2/CS-3 input** = handoff (11) + `_INDEX` (24) + session-log (9) + task-queue (67) + eliminated (2) + architecture (50) + glossary (58) + known-issues (35) + **insights (448)** + decisions/architecture (127) + **decisions/operations (208)** + optimization (59) + … ≈ **~1.2 MB ≈ ~340K input tokens**.
- **CS-1 draft input** ≈ handoff + _INDEX + session-log + task-queue + eliminated + known-issues + **insights (448)** ≈ **~600 KB ≈ ~170K tokens**.

At Opus inference rates with adaptive thinking, 170K–340K input tokens plus generation **exceed the 150 s per-attempt / 180 s draft deadline** → `SYNTHESIS_TIMEOUT` diagnostic (`finalize.ts:1465`), which is why S145 ran `skip_synthesis:true`.

- **One-time cause:** `insights.md` is 448 KB (Phase 6). It alone is ~128K tokens.
- **Durable cause (two parts):** (1) **no enforced retention** — living docs grow without bound (D-80 never fires; Phase 6); (2) **synthesis reads inputs unbounded** — `generateIntelligenceBrief` deliberately pulls the **full decision-domain files** (`operations.md` 208 KB, `architecture.md` 127 KB) with **no per-doc cap and no summarization**. *Archiving insights.md alone will NOT fix this* — even at a 20 KB insights.md, `operations.md`(208) + `decisions/architecture.md`(127) keep CS-2/CS-3 input above ~120K tokens.

### 5.3 Recommendations (immediate + durable, with acceptance criteria)

**Immediate unblock (Quick win, Critical):** emergency-archive `insights.md` to the D-80 target (Phase 6, Rec 1). *Acceptance:* `insights.md` ≤ ~40 KB; a manual `prism_finalize action=draft` against `prism` completes < 150 s and returns parseable drafts; no `SYNTHESIS_TIMEOUT` diagnostic.

**Durable fix (Medium, Critical): bound synthesis inputs.** Introduce a synthesis input budget (e.g., `SYNTHESIS_MAX_INPUT_BYTES`, default ~250 KB) enforced in `buildSynthesisUserMessage`/`buildFinalizationDraftMessage`:
1. Per-doc cap with section-aware truncation (keep headers + most-recent entries; drop the long tail) so no single file dominates.
2. For decision-domain files, feed **`_INDEX.md` + only the domains touched this session** (or a pre-computed digest), not all 7 in full.
3. Never feed archives (already invariant) and never feed a doc above the per-doc cap without truncation.
*Acceptance:* total synthesis input ≤ budget for **any** project regardless of age; CS-2/CS-3 p95 < 120 s; 5 consecutive `prism` finalizes produce a brief with **zero** `SYNTHESIS_TIMEOUT`/`SYNTHESIS_TRANSPORT_FALLBACK`. **Risk tier: human-checkpoint** (synthesis-quality change — verify the bounded brief is not materially worse than the full-input brief on a sample before auto-merging).

---

## Phase 6 — Living-Document Lifecycle & Archival (the documentation/archival failure)

This phase is the operator's headline complaint: *documents get reviewed/re-uploaded and are not archived or documented properly.* It is real, and it has multiple independent mechanical causes.

### 6.1 Living-document inventory (`prism` repo, measured bytes)

| Doc | Bytes | Target / bound | Status |
|---|---:|---|---|
| `insights.md` | **448,380** | D-80: 20 KB live | **22× over; never archived** |
| `decisions/operations.md` | **208,166** | none | unbounded |
| `decisions/architecture.md` | **126,969** | none | unbounded |
| `task-queue.md` | 67,059 | only "Recently Completed" cap (15) | other sections unbounded |
| `decisions/optimization.md` | 59,430 | none | unbounded |
| `glossary.md` | 58,388 | none | unbounded |
| `architecture.md` | 50,368 | none | unbounded |
| `known-issues.md` | 34,600 | (has `-archive`, no auto-config) | manual only |
| `decisions/_INDEX.md` | 24,389 | never compacted (by design) | ok |
| `intelligence-brief.md` | 11,724 | synthesized | **stale (synthesis skipped)** |
| `handoff.md` | 10,873 | 15 KB critical | ok |
| `session-log.md` | 9,481 | 15 KB → archive (20-retention) | ok (archive exists) |

Archive configs exist for **only two** docs (`finalize.ts`): `SESSION_LOG_ARCHIVE_CONFIG` (15 KB/20) and `INSIGHTS_ARCHIVE_CONFIG` (20 KB/15). The four largest decision-domain files, glossary, and architecture have **no archival mechanism at all**.

### 6.2 Why D-80 insights archiving has *never* fired — triple failure

`insights.md` is 448 KB with a `## Active` section holding **99.8 % of the bytes** (447,442 of 448,380), 164 `### INS-N` entries, and **230 `STANDING RULE` markers**; `## Formalized` is a vestigial 448 bytes / 1 entry. Tracing `splitForArchive` (`archive.ts:211`) with `INSIGHTS_ARCHIVE_CONFIG`:

1. `input.length (448380) > thresholdBytes (20000)` ✓ — threshold *is* exceeded.
2. `parseEntriesWithBounds(..., activeSection:"## Active")` → 164 entries.
3. `entries.length (164) > retentionCount (15)` ✓.
4. **Protection filter:** entries whose title/body contain `"STANDING RULE"` are `isProtected`. With 230 markers across 164 entries, the overwhelming majority are protected → `nonProtected.length ≤ 15` → returns `{archiveContent:null, skipReason:"all candidates are protected or within retention"}`. **Archiving is skipped every time.**

Plus two compounding causes:
- **(b) `activeSection` excludes Formalized.** The config only archives within `## Active`; graduated/cold insights are supposed to live in `## Formalized` and become archivable — but in practice entries are tagged `STANDING RULE` and kept in Active forever, so the Formalized lane is unused (448 bytes).
- **(c) Archiving is contingent on the finalize `files` array.** `commitPhase.applyArchive` returns early if `insights.md` is not in `files` (`finalize.ts:847` `liveIdx === -1`). But **INS-178 (STANDING RULE, Tier A) instructs Claude to emit `handoff.md` *only*** and keep everything else current via `prism_log_*`/`prism_patch`. So a correctly-run finalize **never puts `insights.md` in the array** → `applyArchive` never even examines it. **INS-178 and the archive trigger are in direct contradiction.**

**The design flaw is fundamental:** `STANDING RULE` protection (correct intent — don't lose auto-loaded rules) combined with an ever-growing count of standing rules (230) means `insights.md` has a **permanent, monotonically-growing live floor** that archiving can never reduce. D-80's own protection clause guarantees the file cannot shrink.

### 6.3 The "re-uploaded / re-reviewed, not archived/documented" pattern — every silent-failure point

| # | State that should persist/archive | Where it silently fails |
|---|---|---|
| 1 | **Decisions** → `decisions/_INDEX.md` + domain file | Logged in commit message / brief but never via `prism_log_decision` → D-235…D-240 absent from any index (Phase 2). No reconciliation. |
| 2 | **Insights archive** → `insights-archive.md` | Triple failure (6.2) → file never created; live file grows unbounded. |
| 3 | **Intelligence brief / PDU** → synthesized files | Synthesis times out / `skip_synthesis:true` → brief goes stale, PDU not produced. |
| 4 | **An edited living doc** → committed | INS-178 says emit handoff-only; if a doc was patched mid-session but the patch failed silently, nothing in finalize re-checks it. |
| 5 | **Merged brief** → `briefs/archive/` | Trigger post-merge `archive` action can fail; brief stays in `queue/` and is re-polled (Phase 7). `brief-600` is `merged` yet still present. |
| 6 | **Terminal-failed brief** → removed from queue | No cleanup; `brief-421` sits terminal-failed in `queue/` indefinitely (Phase 7). |
| 7 | **Decision-domain / glossary / architecture growth** | No archival config exists at all → unbounded. |

### 6.4 Enforcement design — "provably captured and archived exactly once" (top-priority deliverable)

The fix is to stop relying on Claude *remembering* to capture/archive and make it **server-enforced, idempotent, and verifiable**:

**A. Decouple archiving from the finalize `files` array (resolves 6.2c).** Run archiving as a server-side maintenance pass that **fetches the live doc itself** and archives independent of whether Claude included it — e.g., a new `prism_maintain(project_slug)` op, or an unconditional step in `commitPhase` that fetches `insights.md`/`session-log.md` and runs `splitForArchive` regardless of the array. This aligns archiving with INS-178 (Claude still emits handoff-only; the server maintains the rest).

**B. Redesign insights retention so standing rules don't form an unbounded floor (resolves 6.2 root).** Options, in order of preference:
   1. **Extract standing rules to a dedicated, bounded `standing-rules.md`** (boot reads only this for Tier-A/B). `insights.md` then holds only non-rule insights and can archive freely under D-80. This also speeds boot (no 448 KB read).
   2. Or: cap *protected* entries too (keep the most-recent N standing rules live; archive older standing rules to an archive that boot can still read on demand), changing D-80's "never archived" clause.
   *Acceptance:* after the pass, `insights.md` (or `standing-rules.md`) live size ≤ 40 KB on the `prism` project; all current Tier-A rules still delivered at boot; `insights-archive.md` exists and is append-only.

**C. Make capture provable (resolves 6.3 #1).** At finalize, compute **decision-capture lag** (Phase 1.4 metric #2): scan the session's commit messages for `D-N`/`INS-N`/`KI-N` references and assert each exists in the index; emit a `CAPTURE_GAP` diagnostic listing the unrecorded IDs (e.g., today: D-235, D-236, D-239, D-240, INS-281). Surface it in the finalization banner so the operator sees it immediately. *Acceptance:* a finalize on a repo whose latest commit says "(D-999)" with no D-999 in the index emits `CAPTURE_GAP[D-999]`.

**D. Archive-once invariants.** Archive files are append-only; the live file shrinks; an entry is moved exactly once (the existing `splitForArchive` is already idempotent — it only moves entries beyond retention). After any finalize, assert each bounded doc ≤ its target or emit `ARCHIVE_OVERDUE`. *Acceptance:* re-running finalize twice produces no duplicate archive entries and no further live-file shrinkage on the second run.

**E. Brief lifecycle (resolves 6.3 #5–6) — see Phase 7.4.**
---

## Phase 7 — Trigger Reliability Layer

### 7.1 Daemon flow, end to end

`poller` (`git fetch` + `git ls-tree origin/main` over `brief_dir`, dedup vs `state.queue/active/history`, frontmatter parsed by `poller/frontmatter.ts`) → `scheduler.tick()` (round-robin across projects, FIFO within; gates: `depends_on`, overlap on `affects`, worker availability, global cap) → `worker.execute()` (git preflight → `pullLatest` → open iTerm pane → send `claude` command → **return immediately**) → `scheduler.advanceActiveBriefs()` (per-tick `prManager.detectPr` from `state.active`) → `merge.autoMerge()` → `post-merge` (`notify`, `archive`). State per project lives at `brdonath1/trigger:state/<slug>.json` (`{project, queue[], active|null, history[]}`).

**What brief-600 already shipped (do NOT re-recommend):** the **wrong-repo guard** (parse `**Repo:**` from the brief body; quarantine to `briefs/quarantine/` on mismatch) and the **pane-liveness supervisor** (AppleScript probe every 30 s after a 60 s grace; on dead pane → history record `abandoned_pane_dead`, clear active, ntfy; escalate after 10 consecutive probe errors). These mitigate *detection* of two failure modes; they do not add resumability.

### 7.2 Root cause of each observed failure class

| Failure class | Count (state history) | Mechanism (verified) | Already mitigated? |
|---|---|---|---|
| **`abandoned_daemon_restart`** | ×3 | `startup/stale-active-recovery.ts:abandonActive()` — at daemon start, any `state.active` with `execution_started_at` > 60 s old is moved to history as `abandoned_daemon_restart`. **No re-queue, no resume.** The in-flight worker died with the previous daemon. | Detection only; **work lost** |
| **`preflight_git_state`** | ×2 (stray `.env.bak.*`) | `worker/git-preflight.ts:checkGitState()` requires: branch == `main`, clean tree, **and zero untracked (`??`) files**. A stray `.env.bak.*` shows as `?? .env.bak.*` → `untracked_files` → dispatch blocked. `git-preflight-recovery.ts` only auto-recovers the **`wrong_branch`-only** case (`git checkout main`); it deliberately will **not** delete untracked files (could destroy uncommitted work). | Partial (wrong-branch only) |
| **`pane_liveness_failed` / pane death (KI-87)** | ×1 | `worker.ts` sends the command and returns (`claude --dangerously-skip-permissions` runs interactively and never auto-exits, so the worker cannot await it). Completion is inferred only by the scheduler-tick PR detector reading `state.active`. If the pane dies after the work completes but **before** the PR is opened, no PR is ever detected. | brief-600 clears the slot, but **completed work is still lost** |
| **terminal-failed briefs never cleaned** | observed (`brief-421`) | A brief whose run errors/exits without opening a PR leaves no PR for `detectPr`; the file remains in `.prism/briefs/queue/`. There is no "terminal failure → move out of queue" path. `brief-421` sits terminal-failed in the queue. | **No** |
| **merged briefs not archived** | observed (`brief-600`) | `post-merge.ts` `archive` action moves `queue/`→`archive/` via follow-up commits; if it fails (git error / path-convention mismatch) the brief stays in `queue/`. The poller's history dedup (`status:merged`) prevents *re-dispatch*, but the **file is never removed**, so it shows as "reviewed/re-uploaded, not archived." `brief-600` is `merged` yet still in `trigger/briefs/` (and `prism-mcp-server` has merged briefs still under `.prism/briefs/queue/`). | **No (silent failure)** |

### 7.3 Model / effort launch policy

`buildClaudeCommand` (`worker.ts:141`) emits, verbatim:

```
cd <workingDir> && unset ANTHROPIC_API_KEY && claude --dangerously-skip-permissions --effort max "<prompt>"
```

- **`--effort max` is hardcoded** for *every* brief — wasteful for trivial mechanical work (a one-line config bump runs at the same max-effort spend as a full audit).
- **No `--model` flag** — the dispatched Claude runs on the local `claude` CLI's default model. **This is why brief-430 needs a §0 model gate:** there is no way to *target* Opus 4.8 for a brief that requires it; the audit can only check after the fact and abort.
- Brief frontmatter (`poller/frontmatter.ts`) supports `parallel`, `depends_on`, `affects`, `complexity`, `workflow` — but **not `model` or `effort`**.

**Recommendation (Medium, High):** add `model:` and `effort:` to the frontmatter schema and thread them into `buildClaudeCommand` (`--model ${model}` when set; `--effort ${effort}` defaulting from `complexity`: low→`medium`, medium→`high`, high→`max`). Tie the default to the MCP server's **existing model-recommendation classifier** (brief-405 / D-191, which already emits `recommended_session_settings`) so a brief can inherit the recommended model/effort rather than always paying max. *Acceptance:* a brief with `model: claude-opus-4-8` in frontmatter dispatches with `--model claude-opus-4-8`; a brief with `complexity: low` and no `effort` dispatches with `--effort high` (not `max`); brief-430 re-dispatched would pin Opus 4.8 and skip the abort path. **Risk tier: human-checkpoint** (changes the dispatch command on every brief — verify on a low-risk brief first).

### 7.4 Resumability — the central reliability gap

**Today a brief cannot survive a pane or daemon restart without losing work.** Completion detection depends entirely on pane liveness + a PR existing while `state.active` is still `executing`. brief-600 added pane-death *detection* but explicitly left resumption out of scope. The brief author's own §0b checkpointing instructions in *this* brief (commit incrementally; open the PR only at the end) are a **manual workaround** for exactly this gap — and brief-421 reportedly lost a 65-minute run to it.

**Design (Architectural, High) — completion detection that does not depend on pane liveness:**
1. **Status-file heartbeat (already half-specified).** `CLAUDE.md` already mandates a `docs/briefs/{brief}.status.json` (`executing`→`completed`, with `pr_url`/commits). Make the dispatched Claude **write and push** this file at start and on completion, and have the scheduler **poll the status file** (committed to the branch/repo) as a completion signal independent of the pane. A `completed` status with a `pr_url` confirms success even if the pane already died.
2. **Late-PR sweep.** Before `abandonActive()` (daemon restart) or `abandoned_pane_dead` (pane death), run a **final `detectPr` sweep**, and after abandoning, keep a short grace window watching for a late PR matching the brief id — so a run that finished moments before the pane died is recovered, not discarded.
3. **Idempotent re-dispatch.** When a brief is abandoned with no PR and no `completed` status, re-queue it automatically (bounded by `max_retries`) instead of requiring manual `trigger reset-brief`, since incremental commits make re-running safe.
4. **Preflight auto-heal for known-safe strays.** Extend `git-preflight-recovery` to move (not delete) recognized stray files (`.env.bak.*`, `*.orig`) into a quarantine dir so `preflight_git_state` self-heals for the exact files that caused the ×2 failures, without risking real uncommitted work.

*Acceptance:* killing the pane after the dispatched Claude has pushed a `completed` status + opened a PR results in the brief being **merged**, not `abandoned_pane_dead`; a stray `.env.bak.x` no longer blocks dispatch; an abandoned brief with no PR re-queues automatically within retry budget.

---

## Phase 9 — Test & CI Coverage (safety net for autonomous implementation)

> **Reading-order note:** phases appear 1–7, then **9**, then **8**, then 10. Phase 9 (CI / auto-merge gating) is placed adjacent to Phase 7 (Trigger) because the two are one argument — CI gating is the safety net for the daemon's autonomous merges. Phase 8 (the self-contained, implementation-ready banner spec) then reads directly into the Phase 10 roadmap it seeds. All ten phases are present and complete.

### 9.1 Is Trigger's PR auto-merge gated on CI? — **No.**

This is the load-bearing question for the INS-281 hands-off loop, and the answer is unambiguous from source. `trigger/src/github/merge.ts:autoMerge()`:

- reads `status.merged` and `status.mergeable`; polls until `mergeable` resolves;
- if `mergeable === false` or stays `null` → `conflicted`;
- otherwise calls `octokit.pulls.merge({ merge_method: 'squash' })` (`merge.ts:140`).

It **never** inspects check-runs, the combined commit status, `required_status_checks`, or even `mergeable_state` (which can be `"blocked"` when required checks are pending/failing). **The daemon has zero CI awareness.** The only thing that can stop a red-CI PR from merging is **GitHub branch protection** with required status checks configured on `brdonath1/prism-mcp-server` — which the daemon neither sets nor verifies, and which is therefore an **undocumented, unverified, load-bearing assumption.** If branch protection is absent or misconfigured, a PR with failing CI auto-merges.

### 9.2 What CI exists, and what it covers

| Repo | CI | Coverage |
|---|---|---|
| **prism-mcp-server** | `.github/workflows/ci.yml` — on push/PR to `main` (path-whitelisted to `src/**`,`tests/**`, build config): `npm ci` → **lint → typecheck → `npm audit` (continue-on-error) → build → test** on Node 18 & 20 | Strong: ~140 test files (`tests/**`), covers bootstrap budget, finalize, archive, patch, safe-mutation, synthesis routing, banner, validation |
| **trigger** | **None** — no `.github/workflows/`. Local `vitest` only, `.coverage-thresholds.json` at 80 % lines/branches/functions/statements | The daemon that *performs autonomous merges* has **no CI of its own** |
| **prism** (project state) | n/a (docs repo) | — |
| **prism-framework** | n/a (templates) | — |

**Two critical gaps for the hands-off loop:**
1. **The merge step is not gated on CI (9.1).** Even though prism-mcp-server *has* good CI, nothing in the autonomous path *requires* it to be green before merge unless branch protection enforces it.
2. **The daemon itself has no remote CI.** A change to `merge.ts`/`worker.ts`/`poller.ts` that breaks the autonomous loop would not be caught by any pipeline before it ships.

### 9.3 Coverage gaps & required regression tests before high-risk changes

The Phase-B work touches three high-risk subsystems. Before any of these can merge **unattended** (INS-281 §4), add:

- **Synthesis transport (CS-1/2/3):** a test asserting the **input budget cap** (Phase 5.3) bounds total synthesis input regardless of doc sizes; a test that `cc_subprocess` failure falls back to `messages_api` and logs `SYNTHESIS_TRANSPORT_FALLBACK`; a fixture with a 448 KB insights.md asserting draft completes under deadline after bounding.
- **Patch engine:** a regression test for the INS-240 subtree-destruction guard and the INS-246 duplicate-header guard (Phase 4.4) — these are currently enforced only by standing rules.
- **Archival:** a test that `splitForArchive` actually shrinks a standing-rule-heavy `insights.md` under the new retention design (Phase 6.4-B); a test that archiving runs **independent of the finalize files array** (6.4-A).
- **Daemon:** establish **GitHub Actions CI on the `trigger` repo** (mirror prism-mcp-server's workflow); add a `merge.ts` test asserting the merge path **refuses to merge when required checks are not green** (the gate from 9.4); a status-file-heartbeat completion test (Phase 7.4).

### 9.4 Recommendation — make CI a real gate (Critical, prerequisite for INS-281)

1. **Configure branch protection** on `brdonath1/prism-mcp-server` (and `trigger`) requiring the CI check to pass before merge, and **have the daemon assert it** (read `required_status_checks` / combined status before `octokit.pulls.merge`; refuse + record `conflict`/`ci_failed` if not green).
2. **Add CI to the `trigger` repo.**
*Acceptance:* a PR with a deliberately failing test is **not** merged by the daemon and is recorded with a `ci_failed`-class status; `trigger` CI runs on every PR. Until this lands, the hands-off auto-merge loop should be treated as **human-checkpoint only**.

---

## Phase 8 — Boot + Finalization Banner Specification (revive D-59/D-34/D-84, richer, 500K-enabled)

### 8.1 Banner history & current state

| Marker | What it did | Status now |
|---|---|---|
| **D-34** | Server-rendered boot banner as **SVG** | superseded |
| **D-35** | Boot banner evolved SVG → **HTML/CSS** (`renderBannerHtml`) | **dead code** — still in `banner.ts:258` but boot sets `banner_html:null` |
| **D-59** | **Locked** boot-banner spec (`banner-spec.md`, pixel-level golden master) | spec now at **v3.0** |
| **D-84** | **Hard-structured** boot (Rule 2) + finalization (Rule 11) response *templates* — REQUIRED STRUCTURE / FORBIDDEN / FALLBACK | **active, strong** |
| **ME-1 (S29)** | Replaced the ~5 KB HTML boot banner with a ~200-byte **text** banner (`renderBannerText`) | **current boot path** |
| **D-46** | Finalization banner as **HTML** (`renderFinalizationBanner`, red accent) | **current finalize path** (`finalization-banner-spec.md` v1.0) |

**The inconsistency (Finding 8-A, Medium):** the **boot banner is text** (banner-spec v3.0, ME-1) while the **finalization banner is HTML** (finalization-banner-spec v1.0, D-46). Two render formats, two specs, two enforcement styles, plus dead HTML boot code (`renderBannerHtml`). For a framework whose whole banner thesis (D-84) is "make presentation deterministic," running two divergent banner formats is itself drift.

**Why text is the right canonical format (and HTML should be demoted to optional):** text cannot be "interpreted" differently across surfaces, renders identically everywhere, survives copy/paste, and is what ME-1 already proved. The 500K headroom does **not** argue for going back to HTML — it argues for a **richer text banner** carrying more intelligence. HTML may remain an *optional* parallel field for surfaces that render widgets, but the **text banner is canonical and authoritative**.

### 8.2 The enforcement model (what makes drift impossible)

Three layers, all already partially present — the spec below makes them complete and symmetric:

1. **Server is the single source of truth.** The server renders the entire banner body deterministically (`renderBannerText` / a new `renderFinalizationText`). Claude never composes banner content — it emits the server string **verbatim** inside a code fence.
2. **Template contract (D-84).** Rule 2 (boot) and Rule 11 (finalize) specify exact ordering, verbatim-emission, and a FORBIDDEN list. This makes the *Claude-side* deterministic.
3. **Golden-master test (D-59).** A unit test pins the rendered output for a fixed input so any drift fails CI. (`tests/banner-text.test.ts` exists for boot; an equivalent is needed for finalize.)

The missing piece is a **machine-checkable contract version + checksum**: the server emits `banner_contract_version` and a `banner_checksum` (hash of the canonical text); a downstream check (and the golden test) can assert the structure didn't silently change.

### 8.3 SPEC — PRISM Banner v4.0 (unified, text-canonical, 500K-enriched) — implementation-ready

This is a self-contained spec for the first Phase-B brief. It unifies boot + finalize under one grammar and enriches both using the 500K headroom (per D-240).

**8.3.1 Shared design tokens**
- **Format:** monospace text, one field per line, `Label: value` grammar. Icons: `✓` ok · `⚠` warn · `✗` critical · `▸` step · `•` bullet. Timestamp: `MM-DD-YY HH:MM:SS CST` (`generateCstTimestamp`).
- **Server fields:** `banner_text` (canonical string), `banner_contract_version` (e.g. `"4.0"`), `banner_checksum` (sha256 of `banner_text`), `banner_html` (optional, may be null).
- **Drift rule:** every line is server-rendered; Claude emits the block verbatim; no Claude-composed banner content ever.

**8.3.2 Startup banner — required line order**

| # | Line | Source | New @ v4.0? |
|---|---|---|---|
| 1 | `PRISM v{tmpl} | Session {N} | {timestamp}` | handoff meta + clock | — |
| 2 | `Handoff v{hv} ({kb}KB) | {decisions} decisions ({guardrails} guardrails) | {d}/{t} docs healthy` | bootstrap | — |
| 3 | `{tool status row}` (`✓ bootstrap | …`) | tool surface | — |
| 4 | `Tool Surface: ✓ N/N loaded (core … | railway … | cc …)` | D-83 post-boot search | — |
| 5 | `Suggested: {display} — {rationale}` (omit if absent) | D-191 classifier | — |
| 6 | **`Continuity: {score} — brief {age}s stale · decisions +{lag} unlogged · insights {kb}KB ({mult}× target)`** | **new Continuity Scorecard (Phase 1.4)** | **YES** |
| 7 | `Resumption: {…}` (≤200 chars) | handoff | — |
| 8 | `Next:` + each `▸ {step}` (first marked `[priority]`) | handoff | — |
| 9 | `⚠ {warning}` lines (stale-active, CAPTURE_GAP, ARCHIVE_OVERDUE, synthesis fallback) | diagnostics | enriched |

*500K enrichment:* line 6 is the headline new value — it surfaces the exact failures this audit found (stale brief, unlogged decisions, bloated insights) **at every boot**, in one line, deterministically. Because budget is no longer scarce, the startup response (Rule 2 Block 4) may also carry the **full** intelligence brief in-context (Phase 3.5) — the banner stays compact; the richer payload rides in the response body.

**8.3.3 Finalization banner — required line order (text, replacing the D-46 HTML)**

| # | Line | Source |
|---|---|---|
| 1 | `PRISM v{server} | Session {N} Finalized | {timestamp}` | server |
| 2 | `Handoff v{hv} {status} | {docs_updated}/{total} docs updated | {decisions} decisions` | commit result |
| 3 | `Steps: ✓ audit | ✓ draft | ✓ commit | ✓ verified` (icon per step status) | phases |
| 4 | `Synthesis: {background|completed|skipped|timed_out}` + reason | synthesis outcome |
| 5 | **`Captured: decisions +{n} logged · insights {archived|ARCHIVE_OVERDUE} · brief {synthesizing|stale}`** | **new — closes the loop on Phase 6** |
| 6 | `Resumption: {…}` | handoff |
| 7 | `Deliverables:` + each `▸ {item}` | banner_data/results |
| 8 | `Suggested (next): {display} — {rationale}` | D-191 |
| 9 | `⚠/✗ {warning/error}` lines (CAPTURE_GAP, partial commit, synthesis timeout) | diagnostics |

*Line 5 is the enforcement surface for Phase 6:* finalize tells the operator, every time, whether decisions were actually logged, whether insights archived, and whether the brief is synthesizing — so the "not documented/archived properly" failure becomes immediately visible instead of silent.

**8.3.4 Server-render vs Claude-render split**
- **Server renders:** every line above (lines 1–9 of each), as one `banner_text` string + `banner_checksum` + `banner_contract_version`.
- **Claude renders:** only the *wrapper* per Rule 2/Rule 11 — the session-name code fence, the rename directive (boot), the banner code fence (verbatim `banner_text`), then plain-prose opening/closing. Claude composes **zero** banner field values.

**8.3.5 Enforcement mechanism (drift-proof)**
1. `renderBannerText`/`renderFinalizationText` are pure functions with **golden-master tests** (`tests/banner-text.test.ts` + new `tests/finalization-banner-text.test.ts`) pinning output for fixed inputs — drift fails CI (D-59).
2. Rule 2 / Rule 11 keep the REQUIRED-STRUCTURE + FORBIDDEN lists (D-84); add the v4.0 lines to both.
3. Server emits `banner_contract_version`; the framework template declares the version it expects; a mismatch surfaces a one-line warning (so a server/template skew is visible, not silent).
4. Retire `renderBannerHtml` (dead) or gate it behind an explicit optional `banner_html` request; converge finalize onto the text renderer so there is exactly **one** banner format.

**8.3.6 Acceptance criteria**
- Boot and finalize banners share one format (text), one token set, and one enforcement path; no HTML on the default path.
- Golden-master tests exist for **both** banners and fail on any structural change.
- The Continuity line (boot) and Captured line (finalize) render correctly for the `prism` project today and read `critical` (brief stale, decisions +5 unlogged, insights 22× target).
- `banner_contract_version` present in the bootstrap and finalize responses; template declares the matching version.
- Re-running boot twice with identical state yields byte-identical `banner_text` (determinism check).

---

## Phase 10 — Prioritized Roadmap (structured for autonomous implementation)

Each item is written as its own themed Phase-B brief (per INS-281 — never a mega-PR). **Scoring legend:** 3-axis impact on **C** (context+intelligence), **S** (speed), **R** (reliability), each ▲▲▲ high / ▲▲ med / ▲ low / – none. **Impact/Effort/Risk** = H/M/L. **Risk tier:** `AUTO` = safe for the hands-off auto-merge loop · `HUMAN` = needs a human checkpoint per INS-281 §4 (destructive/irreversible, synthesis-transport, or daemon changes). **CI:** whether existing CI covers it or new tests are required first.

### Master table (ordered for sequential implementation)

| ID | Recommendation | Group | C / S / R | Imp/Eff/Risk | Risk tier | CI | Depends on |
|----|----------------|-------|-----------|--------------|-----------|----|-----------|
| **R1** | Emergency-archive `insights.md` to ≤40 KB (one-time) | Quick | ▲▲▲ / ▲▲▲ / ▲▲ | H/L/M | **HUMAN** (irreversible content move) | new test for splitter | — |
| **R2** | Bound synthesis inputs (per-doc cap; domain-file digest) | Medium | ▲▲ / ▲▲▲ / ▲▲▲ | H/M/M | **HUMAN** (synthesis quality) | new tests first | R1 |
| **R3** | Model-aware context window (200K→500K) + count all fields | Quick | ▲▲▲ / – / ▲ | H/L/L | AUTO | covered + 1 test | — |
| **R4** | Ship the **full** intelligence brief at boot (reverse D-47) | Quick | ▲▲▲ / – / ▲ | H/L/L | AUTO | covered + 1 test | R3 |
| **R5** | Continuity Scorecard (boot field + banner line) | Medium | ▲▲▲ / – / ▲▲ | H/M/L | AUTO | new tests | R3, R8 |
| **R6** | Extract `standing-rules.md`; let `insights.md` archive freely | Arch | ▲▲ / ▲▲ / ▲▲ | H/H/M | **HUMAN** (changes D-80; boot read path) | new tests first | R1, R7 |
| **R7** | Decouple archiving from the finalize `files` array (server-side maintenance) | Medium | ▲ / ▲▲ / ▲▲▲ | H/M/M | **HUMAN** (write path) | new tests first | — |
| **R8** | Decision/insight capture enforcement (`CAPTURE_GAP`) + reconcile D-235…D-240 | Medium | ▲▲▲ / – / ▲▲ | H/M/L | AUTO (detection only) | new tests | — |
| **R9** | Per-brief `model`+`effort` in Trigger frontmatter → `--model`/`--effort` | Medium | ▲ / ▲▲ / ▲▲ | H/M/M | **HUMAN** (daemon dispatch path) | new tests + trigger CI (R10b) | R10b |
| **R10a** | Gate Trigger auto-merge on CI (assert required checks before merge) | Medium | – / – / ▲▲▲ | H/M/M | **HUMAN** (daemon merge path) | new test first | R10b |
| **R10b** | Add GitHub Actions CI to the `trigger` repo + branch protection | Quick | – / – / ▲▲▲ | H/L/L | **HUMAN** (infra/settings) | establishes CI | — |
| **R11** | Brief-lifecycle hygiene: reliably archive merged briefs; clean terminal-failed; remove `brief-421`/`brief-600` now | Quick | ▲ / – / ▲▲ | M/L/L | AUTO (file moves) + HUMAN (daemon code) | new test | — |
| **R12** | Resumability: status-file heartbeat + late-PR sweep + auto re-queue + preflight auto-heal | Arch | – / ▲ / ▲▲▲ | H/H/M | **HUMAN** (daemon) | new tests first + trigger CI | R10b |
| **R13** | Implement unified **Banner v4.0** (text-canonical; retire dead HTML) | Medium | ▲▲ / ▲ / ▲ | M/M/L | AUTO | golden-master tests | R5, R8 |
| **R14** | Patch-engine structural guard (INS-240 subtree / INS-246 header) | Medium | ▲ / – / ▲▲ | M/M/L | AUTO | new tests first | — |
| **R15** | Bound/archive decision-domain + glossary + architecture docs | Medium | ▲ / ▲▲ / ▲ | M/M/M | **HUMAN** (content move) | new tests first | R2, R7 |
| **R16** | Read-path deadlines (`status`/`analytics`/`search`); cap 429 backoff to budget | Quick | – / ▲▲ / ▲▲ | M/L/L | AUTO | new tests | — |
| **R17** | Raise prefetch cap; proactive prefetch; more generous standing-rule delivery | Quick | ▲▲ / ▲ / – | M/L/L | AUTO | covered + test | R3 |

### Group A — Quick wins (low effort; mostly AUTO-safe; land first)

**R1 — Emergency-archive `insights.md`.** *Target:* `prism` repo `insights.md` → new `insights-archive.md` (via the new R7 maintenance op, or a one-shot script using `splitForArchive` with a corrected config). *Problem:* 448 KB / 22× target jams all synthesis (Phase 5/6). *Change:* move non-`STANDING RULE` Active entries (and any Formalized) to the archive; keep standing rules + last-15 non-protected live. *Acceptance:* `insights.md` ≤ 40 KB; `insights-archive.md` exists, append-only; all Tier-A standing rules still extracted at boot; a manual `prism_finalize action=draft` on `prism` completes < 150 s with no `SYNTHESIS_TIMEOUT`. *Note:* HUMAN tier because it irreversibly relocates institutional knowledge — operator reviews the split once.

**R3 — Model-aware context window + complete the estimate.** *Target:* `config.ts:68`, `bootstrap.ts:951–960`. *Problem:* 200K denominator overstates cost 2.5× and the numerator omits ~19 fields (Phase 3.4). *Change:* accept `client_context_window` (or default 500K for the Opus/Sonnet-4.x surface); serialize the full result object for the token estimate. *Acceptance:* `total_boot_percent` for `prism` ≤ 3 % on 500K; numerator within 10 % of `responseBytes`. *CI:* extend `tests/bootstrap-budget.test.ts`.

**R4 — Ship the full intelligence brief at boot.** *Target:* `bootstrap.ts:767–795` (stop discarding `intelligenceBriefFull`). *Problem:* only 3 sentences reach the session (D-47), against D-240's mandate. *Change:* deliver the full brief (gate on a size cap as a backstop). *Acceptance:* `intelligence_brief` contains all six brief sections for `prism`; boot percent still ≤ 4 % on 500K.

**R10b — Trigger CI + branch protection.** *Target:* `trigger/.github/workflows/ci.yml` (mirror prism-mcp-server), repo branch-protection settings. *Acceptance:* CI runs on every `trigger` PR; `main` requires the check. *Prerequisite for the entire hands-off loop.*

**R11 — Brief-lifecycle hygiene (immediate cleanup + guard).** *Target:* `trigger/src/github/post-merge.ts` (verify the archive move landed via re-read; on failure, record `archive_failed` and retry next tick) + a queue-cleanup for terminal-failed briefs; **and remove `brief-421` (terminal-failed) and `brief-600` (merged) from their queues now.** *Acceptance:* a merged brief is provably absent from `queue/`; a terminal-failed brief is moved to `archive/` or `quarantine/` with a history record; the two stale briefs are gone.

**R16 — Read-path deadlines + backoff cap.** *Target:* `status.ts`/`analytics.ts`/`search.ts` (add a `Promise.race` wall-clock deadline like the write tools) + `github/client.ts:fetchWithRetry` (cap 429 backoff to the remaining tool budget). *Acceptance:* each read tool returns a structured partial/timeout result within its deadline on a synthetic slow-fleet fixture.

**R17 — Richer boot prefetch & standing-rule delivery.** *Target:* `bootstrap.ts:570` (raise the 2-doc cap), `config.ts` prefetch/topic maps. *Acceptance:* engineering-session boots include an `architecture.md` summary by default; Tier-B delivery widened; boot percent ≤ 4 % on 500K.

### Group B — Medium (server/daemon changes; several HUMAN-tier)

**R2 — Bound synthesis inputs.** *(Phase 5.3 — full detail there.)* *Target:* `ai/prompts.ts`, `ai/synthesize.ts`, new `SYNTHESIS_MAX_INPUT_BYTES`. *Acceptance:* total synthesis input ≤ budget for any project; CS-2/CS-3 p95 < 120 s; 5 consecutive `prism` finalizes produce a brief with zero timeouts. *HUMAN* — verify bounded brief quality vs full-input on a sample.

**R5 — Continuity Scorecard.** *(Phase 1.4 / 8.3.2 line 6.)* *Target:* new `utils/continuity-score.ts`, `bootstrap.ts`, banner. *Acceptance:* `prism` scores `critical` with the specific reasons (brief stale, decisions +5 unlogged, insights 22× target) in one boot line.

**R7 — Decouple archiving from the finalize files array.** *(Phase 6.4-A.)* *Target:* `finalize.ts:commitPhase` (fetch live `insights.md`/`session-log.md` and archive unconditionally) or new `prism_maintain`. *Acceptance:* archiving runs and shrinks the live file even when the finalize `files` array contains only `handoff.md` (the INS-178-compliant case). *HUMAN* — write path.

**R8 — Capture enforcement.** *(Phase 6.4-C.)* *Target:* `finalize.ts` audit/commit + a commit-scan util. *Acceptance:* a finalize whose commits reference an unrecorded `D-N` emits `CAPTURE_GAP[D-N]`; running it against `prism` today lists D-235/236/239/240 + INS-281. Also: **reconcile those IDs into the index as part of this brief.**

**R9 — Per-brief model + effort.** *(Phase 7.3.)* *Target:* `trigger/src/poller/frontmatter.ts`, `worker.ts:buildClaudeCommand`. *Acceptance:* `model:`/`effort:` frontmatter flows to the CLI; `complexity` defaults effort below `max`; brief-430 re-dispatched pins Opus 4.8. *HUMAN* — daemon dispatch path.

**R10a — Gate auto-merge on CI.** *(Phase 9.4.)* *Target:* `trigger/src/github/merge.ts` (read required-checks/combined-status before `pulls.merge`; refuse + record `ci_failed`). *Acceptance:* a PR with a failing check is not merged and is recorded `ci_failed`. *HUMAN* — daemon merge path; **prerequisite for unattended operation.**

**R13 — Implement Banner v4.0.** *(Phase 8.3.)* *Target:* `utils/banner.ts` (+ new `renderFinalizationText`), `finalize.ts`, framework templates (Rule 2/11), golden tests. *Acceptance:* §8.3.6.

**R14 — Patch structural guard.** *(Phase 4.4.)* *Target:* `tools/patch.ts` (refuse `replace` on a header with child headers unless `force:true`; pre/post byte-delta band check). *Acceptance:* a `replace` that would delete nested subsections is rejected with a clear error unless forced; INS-240/246 fixtures pass.

**R15 — Bound the other large docs.** *Target:* archive configs for `decisions/*` domain files (or feed digests per R2), `glossary.md`, `architecture.md`. *Acceptance:* no living doc exceeds a configured live bound after finalize, or its excess is in an archive.

### Group C — Architectural (redesigns; HUMAN-tier; later, after the quick wins de-risk the system)

**R6 — Standing-rules extraction / retention redesign.** *(Phase 6.4-B.)* *Target:* new `standing-rules.md`, `bootstrap.ts` boot read, `extractStandingRules`, D-80 update. *Problem:* `STANDING RULE` protection makes `insights.md` an unbounded live floor (230 markers). *Change:* standing rules live in a dedicated bounded file boot reads; `insights.md` archives freely under D-80. *Acceptance:* `insights.md` ≤ 40 KB and stays bounded as new insights accrue; all Tier-A/B rules still delivered; boot no longer reads a 448 KB file. *HUMAN* — changes a settled decision + the boot read path.

**R12 — Trigger resumability.** *(Phase 7.4.)* *Target:* `trigger` worker/scheduler/orchestrator + the `docs/briefs/{brief}.status.json` heartbeat. *Problem:* completion depends on pane liveness; pane/daemon death strands completed work (KI-87, ×3 daemon-restart + ×1 pane). *Change:* status-file heartbeat as a pane-independent completion signal; final late-PR sweep before abandoning; auto re-queue within retry budget; preflight auto-heal of known stray files. *Acceptance:* §7.4. *HUMAN* — daemon.

### Recommended landing sequence

1. **De-risk the loop first:** R10b → R10a (CI gate) so everything after can run unattended; R11 (cleanup) in parallel.
2. **Unblock intelligence:** R1 (emergency archive) → R2 (bound synthesis). Now finalize/synthesis works again.
3. **Exploit 500K:** R3 → R4 → R17 (boot enrichment), R8 (capture), R5 (scorecard), R13 (banner v4.0).
4. **Harden:** R9 (model/effort), R14 (patch guard), R16 (read deadlines), R15 (bound docs).
5. **Redesign:** R6 (retention) and R12 (resumability) once the system is observable and CI-gated.

---

## Appendix — Raw Measurements

### A. `prism` project-state living-document byte sizes (measured `wc -c`)

| File | Bytes | | File | Bytes |
|---|---:|---|---|---:|
| `insights.md` | **448,380** | | `glossary.md` | 58,388 |
| `decisions/operations.md` | **208,166** | | `architecture.md` | 50,368 |
| `decisions/architecture.md` | **126,969** | | `known-issues.md` | 34,600 |
| `task-queue.md` | 67,059 | | `decisions/_INDEX.md` | 24,389 |
| `decisions/optimization.md` | 59,430 | | `intelligence-brief.md` | 11,724 |
| `handoff.md` | 10,873 | | `session-log.md` | 9,481 |
| `known-issues-archive.md` | 8,797 | | `pending-doc-updates.md` | 6,008 |
| `audit-harness.md` | 6,419 | | `eliminated.md` | 1,973 |
| `session-log-archive.md` | 854 | | `build-history-archive.md` | 923 |

`insights.md` internals: 2,554 lines; `## Active` (lines 9–2545) = **447,442 bytes (99.8 %)**, 164 `### INS-` entries, **230 `STANDING RULE` markers**; `## Formalized` = 448 bytes / 1 entry. **`insights-archive.md` does not exist.**

### B. Decision/insight numbering (capture gap)

- `prism` `decisions/_INDEX.md`: 186 rows, max **D-234**. Max across all `decisions/*`: **D-234**.
- Referenced in prism-mcp-server commits but **absent from any index:** **D-235, D-236, D-239, D-240**.
- Max recorded insight: **INS-277**; brief cites **INS-281** (unrecorded). Max KI: **KI-87** (recorded, `decisions/operations.md`).
- `prism-mcp-server/.prism/` (own state): 5 decisions, max **D-5**; no `insights.md`/`intelligence-brief.md` (abandoned scaffold).

### C. Framework template sizes

`core-template-mcp.md` 29,247 B (v2.19.1) · `core-template.md` 21,737 B · `finalization-banner-spec.md` 13,077 B (v1.0 HTML) · `banner-spec.md` 8,164 B (v3.0 text) · `project-instructions.md` 6,013 B · `rules-session-end.md` 5,399 B · `brief-finalize-template.md` 3,239 B.

### D. Boot payload (estimated) & context budget

Components: `behavioral_rules` 29.2 KB + compact `intelligence_brief` ~3 KB + handoff-derived ~3–4 KB + `standing_rules` ~2–6 KB + `banner_text` ~1.5 KB + ≤2 prefetch summaries ~1–2 KB ≈ **~40–45 KB JSON ≈ ~11–13K tokens**. vs **200K** (server constant) ≈ 6–7 %; vs **500K** (actual) ≈ **2.4–3 %**.

### E. Key file:function references

`bootstrap.ts:412` register · `:767` `intelligenceBriefFull` discarded · `:812` full-insights read · `:951` token estimate · `config.ts:68` `DEFAULT_CONTEXT_WINDOW_TOKENS=200_000` · `finalize.ts:99` `DRAFT_RELEVANT_DOCS` · `:847` `applyArchive` files-array gate · `:1465` draft-deadline error · `archive.ts:211` `splitForArchive` · `:244` protection skip · `synthesize.ts:50` CS-2 doc bundle · `ai/client.ts:63` `resolveCallSiteRouting` · `github/client.ts:90` `fetchWithRetry` · `:626` `createAtomicCommit` · `sanitize-content.ts:20` `sanitizeContentField` · `trigger/worker.ts:141` `buildClaudeCommand` · `trigger/merge.ts:140` `pulls.merge` (no CI gate).

### F. Verification checklist (brief §Verification)

1. ✅ Model gate honored — `claude-opus-4-8 · effort max` recorded in header & methodology.
2. ✅ All four repos loaded & analyzed; `brief-600` changes accounted for (Phase 7.1, not re-recommended).
3. ✅ Every MCP tool + sub-process audited (Phase 4, 23 tools + 7 sub-processes).
4. ✅ Boot payload decomposed field-by-field with a 500K-window budget, framed as headroom-for-richer-context (Phase 3).
5. ✅ Synthesis timeouts root-caused with immediate + durable fixes (Phase 5).
6. ✅ Living-doc/archival failure diagnosed with enforcement design (Phase 6).
7. ✅ Trigger failures root-caused; model-pinning + resumability addressed (Phase 7).
8. ✅ Complete, enforceable boot + finalization banner spec delivered (Phase 8, Banner v4.0).
9. ✅ CI auto-merge gating determined (**not gated**); coverage gaps + required tests listed (Phase 9).
10. ✅ Every recommendation carries impact/effort/risk + 3-axis scores + acceptance criteria + dependency order + risk tier (Phase 10).
11. ✅ Report committed incrementally (per-phase pushes), not a single end-of-run commit.
12. ✅ No code changed in any repo; the only diff is this report file.

<!-- EOF: brief-430-prism-framework-audit.md -->
