---
brief: 460
title: "W3-S4 — ZWS sanitizer redesign (M-007) + scale_handoff data-safety (M-016) + finalize/synthesize post-mortem named findings"
parallel: false
affects:
  - src/
  - tests/
complexity: high
workflow: metaswarm
---

# Brief 460 — W3-S4 sanitizer redesign + scale data-safety (prism-mcp-server)

**Status: PENDING**
**Repo:** prism-mcp-server (queue repo — your working tree; the daemon pulls it current at dispatch)
**Origin:** D-257 wave 3, backlog rows 11–12 (`prism:.prism/audits/s168-wave3-backlog.md`): W3-S4 = M-007 (ZWS sanitizer redesign — SRV-03 +29,46,53,77,78,98) + M-016 (scale_handoff data-safety — SRV-09 +25,43), plus three named findings from the S170/S172 finalize+synthesize post-mortems (Task C below). Prior wave-3 server briefs landed: W3-S1 (PR #75), W3-S2 (PR #77), W3-S3 (PR #78, merged 2026-06-12T20:57:12Z).

**THE WHY (verbatim from the operator charter — it is your ranking lens):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 / INS-319 + INS-320 — run before ANY other action)

Run exactly this as your first action and ensure its full output is visible in the pane:

```bash
claude auth status --text 2>&1; echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"; echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question (INS-320): **"Which email address is associated with this Claude Max account?"** — derived EXCLUSIVELY from the `claude auth status` output of THIS session. Print `ACCOUNT EMAIL: <answer>` in the pane. If `--text` lacks an email field, use the JSON form and extract ONLY identity fields (email/account/organization/plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. Prohibited sources: ~/.claude.json, macOS Keychain, shell history, memory.

Copy the Step-0 output AND the ACCOUNT EMAIL line VERBATIM into the PR body under `## Account attestation`. Never print token or key values, prefixes, or fragments — presence/absence only. Either token-presence reading is normal (INS-329: pane token presence is non-uniform). `ANTHROPIC_API_KEY: present` is a RED FLAG — complete the attestation, mark it in pane + PR body, and continue.

## Hard constraints

- **Base gate-check:** record `git rev-parse HEAD` (must equal `origin/main`, post-PR-#78). Verify `src/utils/standing-rules.ts` at HEAD contains `parseTitleDecorations` (the #78 grammar). If absent, ABORT with evidence in the pane — wrong/stale base; the chat session must investigate.
- **Suite baseline before any change:** expected **1352 passed | 5 skipped** at post-#78 main. Run it, record actual. Any pre-existing failure: record per INS-26 (no new failures may hide behind it) and proceed only if the failure set is clearly pre-existing.
- **Input pins:**
  1. LOCAL: `.prism/audits/s167-server-audit.md` — 199,606 B pin (the SRV-* finding definitions, fix specs, and each finding's `missing_test` line). This is your normative spec for every SRV item below.
  2. prism repo, fetch+show only (INS-283/INS-44/INS-189 — never checkout/pull the daemon-managed clone): `git -C /Users/brdonath/development/prism fetch origin main` then `git -C /Users/brdonath/development/prism show origin/main:.prism/audits/s168-master-findings.md` (53,942 B pin — M-007/M-016 master definitions) and `origin/main:.prism/audits/s168-wave3-backlog.md` (15,142 B pin — rows 11–12 scope contract). Record post-fetch SHAs + actual bytes; note deltas vs pins and proceed.
- Evidence computed, not eyeballed (INS-166/INS-170). Account for tooling behavior in greps (bold markers, fences) per INS-8.

## Task A — M-007: ZWS sanitizer redesign (SRV-03 primary; +SRV-29, 46, 53, 77, 78, 98)

Redesign the prism_patch/prism_push content sanitizer per the SRV-03 fix spec in the audit report: **level- and fence-aware**. Requirements, all from the pinned audit definitions:

- Legitimate `###`+ subsection headers inside patch/push content must survive untouched — the current sanitizer ZWS-neutralizes them, silently and permanently corrupting living documents (the live task-queue.md S171/S172 blocks carry this exact damage class).
- The KI-26 header-injection defense (the original reason the sanitizer exists, brief-421) must be PRESERVED for the attack shapes it was built against — prove with regression pins, not assertion.
- Fence-aware: content inside code fences is handled per the audit spec, never blind-stripped.
- Correct behavior on the **unattended channel** (cc workers / prism_push) where no operator can catch corruption — per the SRV finding that names it.
- Any time sanitization mutates content, emit a **visible diagnostic** naming what changed and why — silent mutation is the defect class this brief exists to kill.
- Cover EVERY listed source finding (SRV-03, 29, 46, 53, 77, 78, 98) per its audit definition. Your PR body carries a per-finding disposition table (file:line). If you judge any of the seven out of W3-S4's scope, the table must say exactly why and where it goes instead — no silent drops.
- **Out of scope here:** repairing the already-ZWS-corrupted bytes in prism's living documents — that is M-041 (W3-P2, prism repo). Your job is that new contamination becomes impossible and existing contamination becomes detectable (ship the detection primitive/diagnostic if the audit spec calls for one).

## Task B — M-016: scale_handoff data-safety (SRV-09 primary; +SRV-25, 43)

Fix prism_scale_handoff per the pinned audit definitions:

- SRV-09: the fullText loss path — scaled content must never silently drop handoff text.
- SRV-25/43: fallback ordering — after a destination write fails, the tool currently pushes a REDUCED handoff (newest-state loss in the same family W3-S3 closed elsewhere). Fix the ordering/atomicity so a failed redistribution can never leave the handoff smaller than it started; failures must be truthful in the response (no success-on-failure — the W3-S2/PR #77 standard applies).

## Task C — Post-mortem named findings (S170 + S172, chartered fold-in)

These three are operator-chartered carries from the finalize/synthesize post-mortems. Source statements verbatim:

1. **Phased-finalize schema requirement.** "The phased commit path requires the `## Meta` (Handoff Version / Session Count / Template Version / Status) + `## Where We Are` schema" — an undocumented hard requirement discovered when the phased fallback ran live (S170/S171). Document it where the tool is consumed (tool description + CLAUDE.md) AND replace the silent failure with an explicit diagnostic when the schema is absent from the supplied handoff content.
2. **Backup-pair race.** "The phased path's own backup pair can race the atomic commit into a MUTATION_CONFLICT retry" (observed S170, backup pair 12:34:34–36Z). Fix the ordering so the backup writes cannot conflict with the main commit (sequence them or share one tree mutation).
3. **INS-331 transport-timeout class (S172, measured).** `prism_synthesize mode=generate` blocked in-request for the full synthesis duration; the MCP client transport dropped ("Anthropic proxy: MCP server connection lost") while the handler survived and completed both generator legs (brief at 107s; PDU ~8 min). Fix: **mode=generate returns immediately** — kick synthesis off fire-and-forget exactly like the finalize-commit synthesis leg (INS-178 ¶8 pattern in finalize.ts), responding with a started/accepted payload that points at `mode=status` for completion checks. Pin the immediate-return behavior with a test. The deeper `action=full` orchestration redesign (deadline cancellation etc.) is **W3-S5 / M-010 — record, do not fix here.**

## Verification (computed)

- Tests before/after with counts (start 1352 | 5 skipped). New named tests REQUIRED for: legitimate-header round-trip through the new sanitizer (###/#### inside patch content, byte-identical), fence-aware cases, KI-26 injection-defense regression pins, sanitization-mutation diagnostic emission, scale fallback failure-ordering (handoff never shrinks on destination failure), fullText preservation, phased-schema-missing diagnostic, and generate-returns-immediately. Plus every `missing_test` line named in the pinned audit definitions for the ten SRV findings in scope.
- `npx tsc --noEmit` clean · lint zero warnings · zero new failures (INS-26).

## PR body (evidence — GitHub is the only observability, INS-148)

`## Account attestation` (verbatim Step-0 output + ACCOUNT EMAIL line) · start HEAD + computed baseline · per-finding disposition table for all ten SRV findings + the three Task C items (file:line each) · tests before/after with the new test names · prism-repo pin SHAs/bytes · self-dequeue commit SHA.

## Push directive (exactly one)

Create branch `brief/460-w3s4-sanitizer-scale-safety` off `origin/main`, commit the implementation + tests, push, and open a single PR to `main` titled `fix(server): ZWS sanitizer redesign + scale data-safety + post-mortem fixes (brief-460, W3-S4, D-257 wave 3)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR. CI must be green; the watcher auto-merges daemon PRs on green CI — that is the normal, expected path for this brief.

IMMEDIATELY after the PR is open — SELF-DEQUEUE (INS-324 §2): on the `briefs` branch, in ONE commit (message `chore: dequeue brief-460 (INS-324 self-dequeue)`), MOVE `.prism/briefs/queue/brief-460-w3s4-sanitizer-scale-safety.md` to `.prism/briefs/archive/brief-460-w3s4-sanitizer-scale-safety.md`. On a 409/422 push race, re-fetch and retry up to 3×. Never touch any other queue file. Record the dequeue commit SHA in the PR body. A later post_merge archive no-op or `archive_failed` event for this brief is EXPECTED (file already archived) and non-fatal.

## Out of scope

- Repairing ZWS-corrupted bytes already in prism's living documents (M-041 / W3-P2).
- `action=full` finalize orchestration redesign, deadline cancellation, GitHub retry classification (M-010/M-009 — W3-S5).
- Payload diet, read-path, synthesis cost work (W3-S6); docs/dead-code (W3-S7).
- Any change in any other repo; any living-document edit beyond what the fixes' own docs require.

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Fable 5 + max effort through 2026-06-21) per INS-309.
- Work from the HEAD the daemon pulled; do not pull mid-run. prism-repo reads are fetch+show only.
- A W3-P1 worker (brief-709) is running concurrently on the prism repo — disjoint repo, no coordination needed; do not touch its files.

<!-- EOF: brief-460-w3s4-sanitizer-scale-safety.md -->
