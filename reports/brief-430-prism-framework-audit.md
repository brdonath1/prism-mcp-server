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
| 9 | Complete, enforceable boot + finalization banner spec (Phase 8 deliverable; first Phase-B brief) | Medium | **Medium** |

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
<!-- EOF: brief-430-prism-framework-audit.md -->
