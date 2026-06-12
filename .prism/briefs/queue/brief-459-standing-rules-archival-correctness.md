---
brief: 459
title: "W3-S3 — standing-rules parser/writer + archival correctness (M-008 + M-006, D-257 wave 3)"
parallel: true
affects:
  - src/
  - tests/
complexity: large
workflow: metaswarm
---

# Brief 459 — W3-S3: standing-rules parser/writer + archival correctness (M-008/M-006)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** prism D-257 wave 3 (dispatched S171). Execution queue: `.prism/audits/s168-wave3-backlog.md` on brdonath1/prism · master ledger: `.prism/audits/s168-master-findings.md` (same repo). Re-issues brief-458 verbatim — 458 went abandoned_pane_dead during the S171 INS-328 transient-401 window (pane identity changed during recovery attempts); the clone is verified clean on main and interactive auth is verified healthy.

**THE WHY (verbatim, the ranking lens for every judgment call):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 · INS-319 + INS-320 · mandatory, BEFORE any other action)

Run as a single bash step; the full output must appear in the pane AND be copied verbatim into the PR body under `## Account attestation`:

```bash
claude auth status --text 2>&1
echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"
echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question — "Which email address is associated with this Claude Max account?" — derived ONLY from the `claude auth status` output of THIS session. Print it in the pane as `ACCOUNT EMAIL: <email>` and copy it verbatim into the PR body's attestation section. If `--text` lacks an email field, run the JSON form and extract ONLY identity fields (email / account / organization / plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly: `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. PROHIBITED answer sources: ~/.claude.json, macOS Keychain, shell history, memory. NEVER echo token or key values, prefixes, or fragments — presence/absence only. `ANTHROPIC_API_KEY: present` is a red flag — report it prominently and continue. Either reading of `CLAUDE_CODE_OAUTH_TOKEN` (present or absent) is normal in panes — INS-329: pane token presence is NON-UNIFORM; report what you observe, do not fail on it.

## Context

S167's audit root-caused the standing-rules census drift (SRV-01, byte-for-byte reproduction): the WRITER (`prism_log_insight`'s composer) appends "— STANDING RULE" AFTER an operator-embedded `[TIER:X]` (log-insight.ts:136,140), while the READER's `TRAILING_TIER_TAG` (standing-rules.ts:42) accepts suffix-then-tag only → silent Tier A default; and sections are split only on `^###` with no terminator → procedure bodies bleed into following content. brief-451 (PR #71) hardened the READ side (end-anchored trailing tags; insights.md title-suffix qualification, +15 tests) — the writer side and the shared grammar were never unified, so the drift keeps reproducing through the writer.

Live repro evidence, current as of the S171 boot (today): the boot-delivered INS-328 procedure body carries the file's trailing `## Formalized` header AND the `<!-- EOF: standing-rules.md -->` sentinel inside it (the no-terminator bleed), and INS-328/INS-329 — minted untagged via the writer — defaulted to Tier A, producing the census drift the v179 handoff itself warns about. S167 boot: INS-316 delivered Tier A despite an end-anchored `[TIER:B]`.

M-006 is the INS-316 archival class: archival/rotation paths that can lose NEWEST state. brief-453 (PR #73) shipped the `mostRecentAt: "auto"` layout auto-detect for session-log archival; the satellites remain open and the audit marks the corruption "queued to fire" — orientation-aware retention edge cases, numeric version sort, EOF-sentinel handling through archival, and rotation newest-state preservation.

Full finding specs (file:line evidence, fix directions, missing_test lines) are in `.prism/audits/s167-server-audit.md` on main in THIS repo — read every listed finding ID in full, before writing code. Do not regress brief-451's parser tests or brief-453's "auto" detect.

## Task A — M-008: standing-rules parser/writer grammar; topics; by-ID path; empty procedures

Findings: **SRV-01 (primary)** + SRV-11, SRV-12, SRV-13. Implement the audit's four-part fix spec with its repro fixtures. Outcome: ONE written grammar for standing-rule sections that the writer provably emits and the parser provably consumes — tier-tag placement (trailing AND title-embedded), title suffixes, topics arrays, a reliable by-ID retrieval path, defined empty-procedure handling, and an explicit section terminator so a procedure can never bleed into following headers or the EOF sentinel. **This brief gates prism W3-P1 (the M-040 retier manifest): topics parse + by-ID path must be proven by tests, not asserted.**

## Task B — M-006: newest-state loss — orientation/sort/sentinel/rotation

Findings: **SRV-04 (primary)** + SRV-05, SRV-06, SRV-22, SRV-23, SRV-30, SRV-31, SRV-79. Outcome: no archival, rotation, or retention path can discard newest state — orientation-aware retention (building on 453's "auto", not replacing it), numeric version sort everywhere versions are compared (no lexicographic v-compare), a single trailing EOF sentinel preserved through archival, and rotation that provably keeps the newest records.

## Verification (computed, not eyeballed — INS-166 / INS-170)

1. Record `git rev-parse HEAD` at start; PR body carries it plus a one-line suite-baseline statement (expected: post-W3-S2 main at/after `b891ca8e`, 1352 tests — state the observed count explicitly).
2. Full suite before any change; exact counts. Pre-existing failures listed by name; none may be NEW (INS-26).
3. Regression tests for every in-scope finding with a `missing_test` line. Minimum bar regardless: (a) writer→parser round-trip — log_insight with `standing_rule: true` and `[TIER:B]` (trailing and title-embedded variants) parses back at Tier B with topics intact (the INS-316 repro); (b) untagged-mint default behavior is explicit in the grammar and tested (the INS-328 repro); (c) terminator test — a final rule followed by `## Formalized` and the EOF sentinel yields a clean procedure body (the S171 boot repro); (d) by-ID retrieval path; (e) empty-procedure handling; (f) archival on chronological AND reverse-chronological fixtures retains the NEWEST entries; (g) numeric version sort (v9 < v10); (h) single trailing EOF sentinel after archival.
4. Full suite after; before/after counts + new-test list in the PR body. `npx tsc --noEmit` clean; lint zero warnings.

## Push directive (exactly one)

Create branch `brief/459-standing-rules-archival-correctness` off `origin/main`, commit, push, and open ONE PR to `main` titled `fix(server): standing-rules parser/writer + archival correctness (brief-459, W3-S3, D-257 wave 3)`. The PR body MUST contain: `## Account attestation` (verbatim), HEAD SHA + baseline statement, per-finding disposition table (finding ID → change → file:line), test counts before/after + new-test list, and a one-line note that the fix deploys via Railway on merge. Do not push to main. Do not open more than one PR. Do not touch your queue file — the daemon terminalizes you after merge.

## Out of scope

- M-002/M-004/M-003 (landed as PR #77, W3-S2) — do not re-work them beyond what the shared grammar strictly requires.
- M-007 ZWS sanitizer redesign + M-016 scale_handoff data-safety (W3-S4) — adjacent code, hard boundary; M-009/M-010/M-011 (W3-S5); payload/cost items (W3-S6); parsing/docs/dead-code (W3-S7).
- No CI workflow changes (W3-S1 landed the gate — do not touch `.github/workflows/`).
- No template or prism-repo edits. The prism-repo straggler delete (M-041) depends on this brief's sort fix and belongs to W3-P2 — do not perform it here.

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC default (Fable 5 through 2026-06-21, INS-309).
- `parallel: true`, `affects: src/ + tests/` — serializes against later wave-3 server briefs.
- Daemon injects M-047 cost-guard defaults (50 USD / 1000 turns) — no frontmatter overrides needed.

<!-- EOF -->
