---
model: claude-fable-5
effort: max
affects:
  - docs/boot-context-refactor
---

# Brief s202a — PRISM boot-context burn audit + refactor design (S202)

> **Purpose:** Operator-priority (S202): Claude.ai PRISM sessions are consuming an unacceptable share of the operator's Max-plan context/tokens at boot — the first exchange lands near 30–50% of a 200K window before any work happens, forcing early finalization and destroying subscription utilization. This brief is a thorough, comprehensive, exhaustively detailed READ-ONLY audit of everything that enters a PRISM chat session's context window (at boot and per-protocol during the session), plus a refactor design that lets sessions boot with a dramatically cleaner context window with ZERO loss of quality, fidelity, or behavioral compliance in the PRISM protocol stack. It intentionally is NOT an implementation: no src/ changes, no template changes, no env changes. Output is docs only.

## Context & pinned evidence (verify, don't trust — INS-40)

- S202 live measurement (prism project boot): `prism_bootstrap` `context_estimate` = `{ bootstrap_tokens: 33868, platform_overhead_tokens: 5000, tool_schema_tokens: 2500, total_boot_tokens: 41368, total_boot_percent: 20.7 }` — and that EXCLUDES the chat-surface additions: Claude.ai system prompt + Project Instructions, three `post_boot_tool_searches` responses (~32 full tool schemas re-delivered as text), the Codex sidecar fetch (~14.5KB), and the Rule 2 boot response itself. Observed real first-exchange usage this session: ~29%; operator reports some boots near 50%.
- Prior art you MUST read and reconcile against (do not re-derive from scratch): `docs/cost-rearchitecture/d275-audit-design.md` §6 row F-3 (boot payload ~115KB ≈ ~33K tokens/session, ~825K chat tokens/mo standing cost, risk HIGH re behavioral fidelity); brief-433 (boot-context-budget, PR #55), brief-449 (bootstrap-payload-diet, PR #69), brief-443 (richer boot payload SLO, PR #60), brief-465 W3-S6 server payload diet M-012 (PR #81), and `docs/` artifacts they produced. State plainly what those already tried, what they saved, and why the standing cost is still ~40K+ tokens.
- Primary code surfaces: `src/tools/bootstrap.ts` (payload assembly), `src/utils/banner.ts` + masthead SVG renderer, `src/utils/standing-rules.ts` (+ union), `src/utils/summarizer.ts`, prefetch logic, `src/config.ts` payload knobs.
- Framework surface: `brdonath1/prism-framework:_templates/core-template-mcp.md` (v2.29.0, ~42.6KB `behavioral_rules` re-delivered VERBATIM in every single boot) and `core-template.md`.
- Project-repo surface (worked example): `brdonath1/prism` living docs — standing-rules.md ~303.7KB (17 Tier-A bodies boot-loaded; INS-363 oversize), glossary.md ~82KB, task-queue.md ~30KB, handoff.md, intelligence-brief.md, decisions/_INDEX.md.

## Task

Read repos via `git show origin/main:<path>` after `git fetch` (working trees of non-queue repos untouched); record the HEAD SHA of every repo read (INS-283).

**A — Measured component inventory.** Enumerate EVERY component that enters chat context under the PRISM protocol, with measured bytes and est tokens (chars/3.5) for the prism project as the worked example, and mark each per-session vs amortized: bootstrap payload fields one by one (behavioral_rules, standing_rules Tier-A bodies, standing_rules_index, intelligence_brief, handoff fields incl. critical_context/current_state/recent_decisions/guardrails/next_steps, prefetched_documents, boot_masthead_svg, banner_text, autonomous_work_loop, expected_tool_surface, diagnostics, warnings); post-boot tool_search schema deliveries; sidecar reconciliation fetch; module/reference loads (trigger-channel.md etc.); per-response protocol overhead (Rule 2 boot response, Rule 9 line, banner rendering); finalization-phase context cost (audit/draft/commit payloads, INS-178 wall). Emit this inventory BOTH as prose and as machine-readable JSON.

**B — Value/redundancy analysis per component.** For each: what behavior does it actually drive, how often is it consumed vs merely carried, and where is it redundant? Specifically analyze: (1) behavioral_rules — the same static 42.6KB text every boot; how much is boot-critical kernel vs reference that could be lazy-loaded, and how much duplicates standing rules or server-enforceable checks; (2) Tier-A standing rules — which of the 17 are genuinely always-load vs demotable to Tier B/C, and duplication with the template; (3) prefetch — hit rate vs cost (S202 prefetched an 82KB glossary summary the session never used); (4) intelligence_brief + handoff overlap; (5) masthead SVG vs text banner; (6) tool-surface verification (3 × 20-result searches) vs a server-delivered checksum; (7) diagnostics/index fields.

**C — Refactor proposals (the deliverable that matters).** Design options to make boot lean without losing fidelity. MUST evaluate at minimum, with est. tokens saved/session, fidelity risk + mitigation, migration path, and env-or-template-only rollback for EACH: (1) machine-readable session state — a compact JSON (and/or SQLite artifact fetched on demand) manifest replacing prose duplication: hashes + section pointers so the session lazy-loads only what the work needs (operator explicitly wants the JSON / light-SQL direction assessed honestly, including where it does NOT help because the model must still read the text to obey it); (2) behavioral-rules kernel split — a minimal always-boot kernel (lifecycle, Rule 2/9, hard gates) + on-demand modules, with a server-delivered version hash so unchanged rules need not be re-read... note this is bounded by the statelessness of chat sessions — quantify the floor; (3) tiered/deferred delivery of handoff+brief (headline block at boot, full sections via prism_fetch on demand); (4) prefetch policy fix (opt-in, summaries capped, no >20KB doc bodies at boot); (5) standing-rules retirement/demotion pass mechanics (INS-363); (6) banner/tool-surface slimming; (7) server-side enforcement replacing in-context prose where a validator can carry the rule instead of the model's context. Reconcile every proposal with D-253 lessons and F-3's HIGH-risk flag; for each, specify the audit-harness verification (existing behavioral-compliance probes) that proves zero fidelity loss before/after.

**D — Phased implementation plan.** Ordered phases from quick wins (config/template-only, zero-code) to structural changes; per phase: scope, est. saving, verification gate, rollback, and the brief that would implement it. Include a target end-state budget (e.g., boot ≤ 12–15K tokens total) and show the arithmetic that gets there.

## Deliverables (docs-only)

- `docs/boot-context-refactor/s202-boot-context-audit.md` (Tasks A+B, with repo HEAD SHAs and prior-art reconciliation)
- `docs/boot-context-refactor/s202-refactor-proposals.md` (Tasks C+D)
- `docs/boot-context-refactor/s202-component-inventory.json` (machine-readable Task A)

## Hard constraints

- DO NOT modify any file outside `docs/boot-context-refactor/` in this repo. No `src/`, no `tests/`, no env reads or values, no template edits, no changes in any other repo.
- DO NOT add any account-attestation / "Step 0" section to your work or PR body (retired by D-267).
- Read prism-framework and prism via `git fetch` + `git show origin/main:<path>` only; record HEAD SHAs; do not mutate those working trees.
- Every quantitative claim carries a measurement or a file:line citation; assumptions are labeled as assumptions (INS-40, INS-304).
- Stay under 120 turns.

## Finishing up

- Branch from `main`: `git checkout main && git pull origin main && git checkout -b docs/brief-s202a-boot-context-audit`
- Commit message: `docs: brief-s202a boot context burn audit + refactor design`
- Push and open PR. Title: `docs: brief-s202a boot context burn audit + refactor design`. Body: deliverable list + repo HEAD SHAs read + headline finding (current boot tokens, proposed end-state budget).
- Immediately after the PR is opened, self-dequeue (INS-324 §2): fetch the `briefs` branch, delete `.prism/briefs/queue/brief-s202a-boot-context-audit.md`, push; on 409/422 race re-fetch and retry up to 3x; never touch other queue files. Record the dequeue commit SHA in the PR body.
- Daemon archives on PR merge.

<!-- EOF: brief-s202a-boot-context-audit.md -->
