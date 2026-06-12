---
brief: 456
title: "W3-S2 — intelligence-loop write integrity (M-002 + M-004 + M-003, D-257 wave 3)"
parallel: true
affects:
  - src/
  - tests/
complexity: large
workflow: metaswarm
---

# Brief 456 — W3-S2: intelligence-loop write integrity (M-002/M-004/M-003)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** prism D-257 wave 3 (dispatched S170). Execution queue: `.prism/audits/s168-wave3-backlog.md` on brdonath1/prism · master ledger: `.prism/audits/s168-master-findings.md` (same repo).

**THE WHY (verbatim, the ranking lens for every judgment call):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 · INS-319 + INS-320 · mandatory, BEFORE any other action)

Run as a single bash step; the full output must appear in the pane AND be copied verbatim into the PR body under `## Account attestation`:

```bash
claude auth status --text 2>&1
echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"
echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question — "Which email address is associated with this Claude Max account?" — derived ONLY from the `claude auth status` output of THIS session. Print it in the pane as `ACCOUNT EMAIL: <email>` and copy it verbatim into the PR body's attestation section. If `--text` lacks an email field, run the JSON form and extract ONLY identity fields (email / account / organization / plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly: `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. PROHIBITED answer sources: ~/.claude.json, macOS Keychain, shell history, memory. NEVER echo token or key values, prefixes, or fragments — presence/absence only. `ANTHROPIC_API_KEY: present` is a red flag — report it prominently and continue. `CLAUDE_CODE_OAUTH_TOKEN: absent` should be noted; on Railway-side runs the env chain differs from Trigger panes — report what you observe, do not fail on it.

## Context

S167's audit identified the headline systemic theme: **the intelligence loop fails silently.** Pushes that fail are recorded as success (false provenance — the pending-doc-updates batch was destroyed this way), the PDU auto-apply has rejected 100% of conformant synthesis output since inception (prompt↔parser contract mismatch — every S170-era boot shows `PDU_AUTO_APPLY_NOOP` with "no Apply instruction in proposal body" skips), and a synthesis failure can overwrite a good intelligence-brief.md with a refusal. This brief closes the write-integrity core of that theme.

Full finding specs (file:line evidence, fix directions, missing_test lines) are in `.prism/audits/s167-server-audit.md` on main in THIS repo (199KB — read it locally, every listed finding ID in full, before writing code).

## Task A — M-002: unchecked pushes record success-on-failure

Findings: **SRV-02 (primary)** + SRV-15, SRV-16, SRV-18, SRV-75. Every GitHub write path must check the actual API result before recording success; a failed push must surface as a failure to the caller and in any provenance/journal records. No silent success-on-failure anywhere in the write surface.

## Task B — M-004: synthesis/finalize output guards + failure visibility

Findings: **SRV-07 (primary)** + SRV-19, SRV-32, SRV-51, SRV-52, SRV-80. A failed/refused synthesis must never overwrite a good `intelligence-brief.md`; the finalize `full` action must not discard a generated draft on downstream failure; failures must be visible (diagnostics/log lines), not swallowed.

## Task C — M-003: PDU prompt↔parser contract — auto-apply has never worked

Finding: **SRV-10**. The synthesis prompt and the auto-apply parser disagree on the proposal format ("Apply instruction" / "Body instruction" expectations vs what the prompt actually elicits). Fix BOTH SIDES into one written contract: the prompt must elicit exactly what the parser consumes, and a contract test must generate a conformant proposal and prove the parser applies it. Live evidence for the repro: the S170 prism boot's `PDU_AUTO_APPLY_NOOP` diagnostic skipped all 7 proposals from the S168 synthesis ("no Apply instruction in proposal body" ×4, "no Body instruction for glossary term" ×3) — your fixture should mirror that batch's shape.

## Verification (computed, not eyeballed — INS-166 / INS-170)

1. Record `git rev-parse HEAD` at start; PR body carries it plus a one-line suite-baseline statement (expected: post-W3-S1 main at/after `07921ff`, 1294 tests — state the observed count explicitly).
2. Full suite before any change; exact counts. Pre-existing failures listed by name; none may be NEW (INS-26).
3. Regression tests for every in-scope finding with a `missing_test` line. Minimum bar regardless: a push-failure-recorded-as-failure test, a synthesis-refusal-does-not-overwrite-brief test, a finalize-full-draft-not-discarded test, and the PDU prompt↔parser round-trip contract test.
4. Full suite after; before/after counts + new-test list in the PR body. `npx tsc --noEmit` clean; lint zero warnings.

## Push directive (exactly one)

Create branch `brief/456-intelligence-loop-write-integrity` off `origin/main`, commit, push, and open ONE PR to `main` titled `fix(server): intelligence-loop write integrity (brief-456, W3-S2, D-257 wave 3)`. The PR body MUST contain: `## Account attestation` (verbatim), HEAD SHA + baseline statement, per-finding disposition table (finding ID → change → file:line), test counts before/after + new-test list, and a one-line note that the fix deploys via Railway on merge. Do not push to main. Do not open more than one PR. Do not touch your queue file — the daemon terminalizes you after merge (self-dequeue boilerplate retired S170, brief-613 observation PASS).

## Out of scope

- M-008/M-006 (W3-S3), M-007/M-016 (W3-S4), M-009/M-010/M-011 (W3-S5), payload/cost items (W3-S6), parsing/docs/dead-code (W3-S7).
- No CI workflow changes (W3-S1 landed the gate — do not touch `.github/workflows/`).
- No template or prism-repo edits.

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC default (Fable 5 through 2026-06-21, INS-309).
- `parallel: true`, `affects: src/ + tests/` — serializes against later wave-3 server briefs.

<!-- EOF -->
