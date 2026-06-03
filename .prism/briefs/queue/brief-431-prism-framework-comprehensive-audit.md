# Brief 431 — Comprehensive PRISM Framework Audit & Intelligence Review (D-240 Phase A, current-clones re-run)

> **Repo:** `prism-mcp-server` (READ-ONLY analysis). This brief makes **NO code changes to any repository.** Its only writes are the report file (on a feature branch, via a normal PR) and the deletion of the now-superseded `brief-430` report.
> **Cross-repo scope:** the audit reads `prism-mcp-server` (this clone) and the sibling repos `prism-framework`, `trigger`, and `prism` (the framework's own project-state repo) — each **brought to current `origin/main` before reading** (Pre-Flight §1), fresh-cloned if it cannot be fast-forwarded.
> **Why this supersedes brief-430:** brief-430 ran to completion but read **stale local clones** of `prism`/`prism-framework`/`trigger` (only `prism-mcp-server` had been fast-forwarded). That produced a **false "decision/insight capture gap"** finding and stale byte measurements. brief-431 re-runs the *entire* audit from verified-current clones and **records each repo's HEAD SHA** so the currency of the analysis is auditable.
> **Goal:** an elite, exhaustive review/audit/analysis of the *entire* PRISM protocol framework and all related repos/components, producing a single prioritized findings-and-recommendations report. This is **Phase A of D-240 — analysis only.** Implementation is Phase B (separate, gated, themed briefs — never one mega-PR).
> **Output:** `reports/brief-431-prism-framework-audit.md` in `prism-mcp-server`, committed **incrementally** (see Checkpointing).

---

## 0. MODEL GATE — do this first, before anything else

This audit was commissioned specifically for **Claude Opus 4.8 at maximum thinking/effort**. The Trigger worker guarantees `--effort max` but does **not** pin a model.

1. As your very first action, state in one line the model you are running as.
2. **If you are NOT Claude Opus 4.8:** STOP. Do no analysis. Create `reports/brief-431-ABORTED-wrong-model.md` containing the model you actually are and the single line `Aborted per brief-431 §0: audit requires Opus 4.8; re-dispatch after pinning the model.` Commit it, open a PR titled `brief-431: ABORTED — wrong model`, and end. Do not attempt the audit on any other model.
3. If you ARE Opus 4.8, record `Model: claude-opus-4-8 · effort max` in the report's executive-summary header and proceed.

## 0b. CHECKPOINTING — survive a mid-run pane death

The Trigger worker does not await your completion; if this pane dies before your PR is opened, any uncommitted work is lost (this is how brief-421 lost a 65-minute run). Therefore:

- Create the feature branch `brief-431-prism-framework-audit` at the start.
- Write the report incrementally and **`git commit` + `git push` after completing EACH phase section.** Do not hold the whole report in the working tree until the end.
- Open the (non-draft) PR only once the full report is complete and the Verification checklist passes. Title it `brief-431: comprehensive PRISM framework audit (D-240 Phase A, current-clones re-run)` so the daemon's PR matcher associates it with this brief.

---

## Verified starting context (do NOT re-derive — these are confirmed facts as of S146)

Treat the following as established ground truth and build on them; spend your effort on root cause and remedy, not on re-confirming that they are true:

1. **Trigger infra-failure rate is high.** `trigger:state/prism-mcp-server.json` records 6 failures in the run history, almost all infrastructure rather than logic: `abandoned_daemon_restart` ×3 (a daemon restart terminates the in-flight worker), `preflight_git_state` ×2 (an untracked `.env.bak.*` file blocked dispatch), `pane_liveness_failed` ×1.
2. **Pane death strands completed work.** `src/worker/worker.ts` (KI-87): the worker sends the `claude` command into the pane and returns; the scheduler-tick PR-detection path drives merge from `state.active`. If the pane dies before a PR is detected, the work is lost with no completion signal.
3. **`--effort max` is hardcoded; the model is not pinned.** `buildClaudeCommand` (`worker.ts:141`) emits `claude --dangerously-skip-permissions --effort max "<prompt>"` with no `--model`, despite a model-recommendation classifier existing in this server.
4. **insights.md is large and breaks synthesis.** `prism_finalize action=draft` and `prism_synthesize` time out at their 180s deadline reading the living docs. The D-80 archival policy (≈20KB target / 15-retention) is NOT enforced. S145 finalize ran `skip_synthesis=true`. (Re-measure the exact current size — see item 7.)
5. **Merged briefs are not reliably archived; failed briefs are never cleaned.** `brief-600-trigger-reliability-hardening` is `status=merged` yet still polled; `brief-421` (terminal-failed) still sits in `prism-mcp-server/.prism/briefs/queue/`. This is the "documents reviewed/re-uploaded, not archived/documented properly" symptom at the pipeline level.
6. **Context window is now 500K on the chat surface, and D-240 deliberately REVERSES the D-47 / D-193-Piece-4 token-slimming.** Do **not** recommend re-slimming the boot payload to save tokens. The mandate is to exploit the 500K headroom to carry MORE and richer context/intelligence across sessions while improving reliability and speed. Optimize for intelligence density and continuity, not minimal payloads.
7. **The capture machinery WORKS — do NOT reproduce brief-430's false "capture gap" finding.** brief-430, reading a **stale** `prism` clone, wrongly claimed the decision index "tops out at D-234" and that D-235/D-236/D-239/D-240 and INS-281 were never recorded. **Verified current truth (S146):** the `prism` decision index holds **192 decisions through D-240**; **D-240 is a full entry** in `decisions/optimization.md`; **INS-281 and INS-282 are present** in `insights.md`. Decisions and insights *are* being logged. Verify capture state against the **current** clone and report the real state; do not assert an unrecorded-decision gap that does not exist. Likewise **re-measure all living-doc byte sizes against the current files** — brief-430's figures (insights.md "448KB", operations.md "208KB", "230 STANDING RULE markers", "max INS-277") were read from the stale clone and are almost certainly understated now. (A real, separate issue may still exist — e.g. standing-rule protection preventing insights archival — diagnose that on its own merits with current numbers.)

---

## Pre-Flight

1. **Bring every read-repo to current `origin/main` before reading — mandatory; this is the reason brief-431 exists.** For each of `prism-mcp-server` (this clone), `prism-framework`, `trigger`, and `prism` under `/Users/brdonath/development/`:
   a. `git -C <repo> fetch origin`, then `git -C <repo> checkout main`, then `git -C <repo> merge --ff-only origin/main`.
   b. If a repo **cannot** be fast-forwarded cleanly (uncommitted changes, ahead of origin, or a checkout that won't switch to `main`) → do **NOT** read the stale clone. `gh repo clone brdonath1/<repo>` into a temp dir and read THAT instead.
   c. Record, in the report's **Methodology**, the **HEAD commit SHA** (`git -C <repo> rev-parse HEAD`) of every repo you actually read, and whether it was the local clone (now current) or a fresh temp clone. This makes the currency of the audit verifiable after the fact.
   Do not push to any repo except the report branch on `prism-mcp-server`.
2. Load the full file trees of all four repos into context before analyzing. This audit requires holistic understanding of how the MCP server, the framework templates, the Trigger daemon, and the accumulated project state interact.
3. Read the framework's own decision/insight history in the `prism` repo (`.prism/decisions/`, `.prism/insights.md`, `.prism/architecture.md`, `.prism/known-issues.md`) so recommendations build on prior decisions rather than relitigating settled ones, and **verify the current decision/insight numbering directly** (per Verified-context item 7) rather than trusting any prior report — including `reports/brief-430-prism-framework-audit.md`, which was produced from stale clones and is being superseded. In particular, read what `brief-600-trigger-reliability-hardening` actually changed and do NOT re-recommend work it already shipped.

---

## Phase 1 — Mission & intelligence mandate

Establish what PRISM is for and whether it is achieving it, in its own terms.

- State the mission in one paragraph: cross-session continuity / persistent reasoning & state management. What problem does it solve and for whom (a solo operator running many long-lived projects across sessions)?
- Define the **target level of context and intelligence** the system intends to carry session-to-session (the three-tier model: structural / behavioral / situational; the living-document set; the synthesized intelligence brief). Is that target explicit anywhere, or only implicit? Recommend an explicit, measurable definition of "intelligence carried over."
- Assess the gap between intent and reality: where does continuity actually break (stale briefs, skipped synthesis, lost context at boot, drift in behavioral compliance)?

## Phase 2 — Architecture review

- Map the full architecture: the MCP server (`prism-mcp-server`), the framework templates/modules (`prism-framework`), the Trigger daemon (`trigger`), and the project-state repos (`prism` and the other managed projects). Produce a component/dataflow description (text or mermaid) showing how a session boots, works, persists, and finalizes, and how briefs flow through Trigger.
- Evaluate the separation of concerns and the repo boundaries (D-2, D-8). Are responsibilities cleanly split, or is there leakage/duplication? (If you find the framework's own development history is fragmented across project states with colliding `D-N` numberspaces, report it — but with current, verified numbers.)
- Identify architectural debt: anything that makes the system fragile, slow, or hard to evolve. Call out load-bearing assumptions that aren't documented.

## Phase 3 — Boot payload & context-budget analysis

- Decompose the `prism_bootstrap` response field-by-field (`src/tools/bootstrap.ts`): what each field contains, where it's sourced, and its token cost. Quantify redundancy across fields (e.g. resumption/next-steps appearing in handoff AND banner data).
- Analyze the prefetch logic and the standing-rules tiering (Tier A auto-load vs B/C lazy-load): is the right material reaching the session?
- Build a full boot token budget against the **500K** window (not 200K). **Frame every finding around using the 500K headroom for richer carryover, not shrinking the payload** (per D-240's reversal of D-47/D-193). Where is there now *room* to carry more intelligence that was previously trimmed? Check the context-window constant (`config.ts` `DEFAULT_CONTEXT_WINDOW_TOKENS`) and the bootstrap token-estimate numerator for accuracy.
- Assess the Rule 9 context-estimation formula for accuracy against the 500K window.

## Phase 4 — Full MCP server: every tool, process, and sub-process

- Inventory every tool the server exposes (bootstrap, fetch, push, patch, status, finalize, draft, synthesize, scale_handoff, search, analytics, log_decision, log_insight, load_rules, the gh_* utilities, the railway_* utilities, cc_dispatch/cc_status). For each: inputs, response shape, typical size/latency, failure modes, and whether it returns more than the caller needs.
- Walk every server process and sub-process: GitHub client (raw vs API, base64, SHA handling, rate-limit/retry), validation, middleware (auth/IP allowlist, logging), config/constants, the synthesis subsystem, the patch engine (the ZWS/`sanitizeContentField` behavior behind INS-240/INS-246/KI-26), the scale-handoff path.
- Flag every place that plausibly contributes to errors, timeouts, or slowness, with the file/function named.

## Phase 5 — Synthesis layer

- Document the per-call-site synthesis routing (CS-1 draft, CS-2 intelligence brief, CS-3 pending-doc-updates, CS-4 dispatch) and the OAuth/`cc_subprocess` vs `messages_api` transport selection, including the env-var control surface (`SYNTHESIS_*_MODEL`, `SYNTHESIS_*_TRANSPORT`) and the transport-aware timeouts (`finalize.ts`).
- Root-cause the synthesis timeouts: the 180s draft/brief deadline vs the insights.md read (use the **current** measured size). Separate the one-time cause (bloated insights.md) from the durable cause (no enforced retention; synthesis reads unbounded living docs). Quantify the total synthesis input size against the current files.
- Recommend both the immediate unblock (archive insights.md to the D-80 target) and the durable fix (enforced retention + bounded synthesis inputs), with acceptance criteria.

## Phase 6 — Living-document lifecycle & archival (the documentation/archival failure)

This phase directly addresses the operator's complaint that documents get reviewed/re-uploaded and are not archived or documented properly.

- Inventory every living document for the `prism` repo with **current** byte sizes; identify which have grown past reason (insights.md is the headline; check session-log.md, decision domain files, the index). Report measured numbers, not brief-430's stale ones.
- Audit the archival mechanisms end to end: the D-80 insights retention policy (**why is it not firing?** — trace `splitForArchive` and the `STANDING RULE` protection filter with current entry/marker counts), the `post_merge: archive` brief flow (why did brief-600 stay polled and brief-421 stay in the queue?), session-log growth bounds, decision-index compaction, resolved known-issues pruning, and the `prism_finalize` "files array" discipline (INS-178) that pushes work into incremental logging.
- Diagnose the "re-uploaded / re-reviewed documents" pattern: identify every point where state can silently fail to persist or fail to archive, and design enforcement so a document is provably captured and archived exactly once. **Note:** the failure is in *archival/retention and brief-lifecycle hygiene*, not in decision/insight *capture* (capture works — item 7); scope the enforcement design accordingly. This is a top-priority deliverable.

## Phase 7 — Trigger reliability layer

- Audit the daemon end to end (`trigger` repo): poller, scheduler tick, worker lifecycle (`worker.ts`), git-state preflight + recovery, `pullLatest`, terminal/pane management, state manager, PR detection/merge, post-merge actions, failover.
- Root-cause each observed failure class from the verified context: daemon-restart-kills-active-worker, pane-death-strands-completed-work (KI-87 design), preflight failures on stray files, terminal-failed-briefs-never-cleaned-from-queue, merged-briefs-not-archived.
- Evaluate the model/effort launch policy: `--effort max` hardcoded for all briefs (wasteful for trivial work) and **no model pinning** (cannot target Opus 4.8 for a specific brief). Recommend a per-brief model+effort mechanism (e.g. brief frontmatter → `--model`/`--effort`), tied to the existing model-recommendation classifier.
- Assess resumability: can a brief survive a pane/daemon restart without losing work? If not, design it (checkpoint/resume, or completion detection that doesn't depend on pane liveness).

## Phase 8 — Boot + finalization banner specification (revive D-59 / D-34 / D-84, richer, 500K-enabled)

- Review the banner history: D-59 (locked banner spec), D-34 (server-rendered banner), D-84 (hard-structured boot/finalization response templates), D-35 (HTML banner), and the current `banner_text`/`banner_html` rendering and the Rule 2 boot-response contract.
- Produce a **complete, strictly-enforced, highly-standardized specification** for both a session-startup banner and a finalization banner, exploiting the 500K window to be richer and more informative than the current text banner while remaining deterministic and drift-proof. Specify exact fields, ordering, formatting, the server-render vs Claude-render split, and the enforcement mechanism (what makes it impossible to drift, per the D-84 motivation). Treat this as a self-contained, implementation-ready spec — it is a natural early Phase B deliverable.

## Phase 9 — Test & CI coverage (safety net for autonomous implementation)

- Inventory existing tests and CI across all repos. **Determine whether Trigger's PR auto-merge is actually gated on CI passing** — read `trigger/src/github/merge.ts` directly (does it inspect check-runs / the combined status / required checks before calling `pulls.merge`?), AND **check whether branch protection with required status checks is actually configured** on `brdonath1/prism-mcp-server` and `brdonath1/trigger` (e.g. `gh api repos/brdonath1/<repo>/branches/main/protection`). Determine whether the load-bearing assumption is *real*, not merely note that it is assumed.
- This is load-bearing: the Phase-B implementation is intended to run as a hands-off autonomous dispatch loop (INS-281, routed entirely through Trigger per INS-282), and that loop's safety depends entirely on CI being a real gate.
- Identify coverage gaps that would let a regression merge unnoticed, and recommend the specific regression tests needed before high-risk changes (synthesis transport, daemon, patch engine) can be merged unattended.

## Phase 10 — Prioritized roadmap (structured for autonomous implementation)

Synthesize all findings into a single prioritized roadmap. **Every recommendation must be written so it can be implemented autonomously as its own themed brief** (per INS-281), which means each one must include:

- a clear target (files/components), the problem, and the proposed change;
- scoring on the three axes: **context + intelligence**, **speed**, **reliability** — plus **impact / effort / risk**;
- explicit **acceptance criteria** (how a reviewer/CI confirms it's done right);
- **dependency ordering** (what must land first) and a **risk tier** (which items are safe for the hands-off auto-merge loop vs. which need a human checkpoint per INS-281 §4 — destructive/irreversible ops, synthesis-transport or daemon changes);
- whether existing CI covers it or new tests are required first.

Group into: Quick wins (low effort), Medium (server/daemon changes), and Architectural (redesigns). Do not collapse these into a single change — they will be shipped as a sequence of separate briefs. Do not include a "capture enforcement / reconcile D-235…D-240" item premised on a capture gap that does not exist (item 7); a lightweight "warn at finalize on referenced-but-unlogged IDs" safety net is acceptable if justified on its own merits.

---

## Verification (complete before opening the PR)

1. [ ] Model gate honored — running model recorded in the report header (or aborted per §0).
2. [ ] All four repos brought to current `origin/main` (or fresh-cloned) BEFORE reading; **each repo's HEAD SHA recorded in Methodology**; `brief-600` changes accounted for.
3. [ ] Every MCP server tool and every server sub-process audited (Phase 4).
4. [ ] Boot payload decomposed field-by-field with a 500K-window token budget (Phase 3), framed as headroom-for-richer-context, not slimming.
5. [ ] Synthesis timeouts root-caused with immediate + durable fixes (Phase 5), using current measured sizes.
6. [ ] Living-document/archival failure diagnosed with enforcement design (Phase 6).
7. [ ] Trigger reliability failures root-caused; model-pinning + resumability addressed (Phase 7).
8. [ ] Complete, enforceable boot + finalization banner spec delivered (Phase 8).
9. [ ] CI auto-merge gating determined from source AND branch-protection state checked directly; coverage gaps + required tests listed (Phase 9).
10. [ ] Every recommendation carries impact/effort/risk + the three-axis scores + acceptance criteria + dependency order + risk tier (Phase 10).
11. [ ] Report committed incrementally (per-phase pushes), NOT a single end-of-run commit.
12. [ ] No code changed in any repo; the only diffs are the new report file and the deletion of the superseded brief-430 report.
13. [ ] Capture state verified against the CURRENT clone (no false capture-gap claim); all living-doc byte sizes re-measured against current files.

---

## Post-Flight

1. The report lives at `reports/brief-431-prism-framework-audit.md` and follows this structure:
   - Executive Summary — model+effort header, the single most important finding, and the top 5–8 prioritized recommendations.
   - Methodology — what was analyzed and how, **including the per-repo HEAD commit SHAs read (Pre-Flight §1c)**.
   - Findings by phase (1–10), each finding with a severity (critical/high/medium/low).
   - Prioritized Roadmap — the Phase 10 table, ordered for sequential autonomous implementation.
   - Appendix — raw measurements (current file/byte sizes, token estimates, named file:function references).
2. Commit incrementally on branch `brief-431-prism-framework-audit` (one commit per completed phase, pushed immediately). **In the same branch, delete the superseded `reports/brief-430-prism-framework-audit.md`** (it was produced from stale clones and is now misleading).
3. When complete and Verification passes, open a non-draft PR titled `brief-431: comprehensive PRISM framework audit (D-240 Phase A, current-clones re-run)` into `main`. Follow all `CLAUDE.md` instructions for PR formatting.
4. Land the evidence (phase-completion summary + verification checklist state + the per-repo HEAD SHAs) in the PR body — this chat session has no visibility into the pane (INS-148).

<!-- EOF: brief-431-prism-framework-comprehensive-audit.md -->
