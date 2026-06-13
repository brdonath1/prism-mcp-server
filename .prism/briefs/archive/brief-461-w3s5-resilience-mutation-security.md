---
brief: 461
title: "W3-S5 (split) — GitHub transient-error handling (M-009) + action=full orchestration / mutation-safety redesign (M-010) + security hardening minus the auth-composition flip (M-011 ∖ SRV-36)"
parallel: false
affects:
  - src/
  - tests/
complexity: high
workflow: metaswarm
---

# Brief 461 — W3-S5 (split): GitHub resilience + mutation safety + security hardening (prism-mcp-server)

**Status: PENDING**
**Repo:** prism-mcp-server (queue repo — your working tree; the daemon pulls it current at dispatch)
**Origin:** D-257 wave 3, backlog rows 17/19/23 (`prism:.prism/audits/s168-wave3-backlog.md`, batch W3-S5 = M-009 + M-010 + M-011). Prior wave-3 server briefs landed: W3-S1 (PR #75), W3-S2 (PR #77), W3-S3 (PR #78), W3-S4 (PR #79, brief-460).

**SCOPE SPLIT — READ FIRST (chat-session decision, S174).** This brief is W3-S5 **minus one item**. The M-011 auth **OR→AND composition flip (SRV-36)** and its auth-composition behavioral test are **explicitly OUT OF SCOPE** here. Reason: daemon PRs auto-merge on green CI and prism-mcp-server redeploys from `main`, and the live server currently has **no Bearer token and no IP-allowlist env var configured** (verified S174 via railway_env: 30 vars, zero auth vars) — access is carried by the baked-in default Anthropic-CIDR allowlist under today's OR-composition. Flipping to AND-composition would require a Bearer that is configured nowhere and would lock out the live server (this MCP session included) on auto-deploy. SRV-36 is deferred to a separate, operator-gated deploy. **DO NOT change the auth composition logic in this brief.** Every other M-011 item (SRV-26, 37, 55, 66, 83) is in scope — they harden without changing the live access path.

**THE WHY (verbatim from the operator charter — it is your ranking lens):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 / INS-319 + INS-320 — run before ANY other action)

Run exactly this as your first action and ensure its full output is visible in the pane:

```bash
claude auth status --text 2>&1; echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"; echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question (INS-320): **"Which email address is associated with this Claude Max account?"** — derived EXCLUSIVELY from the `claude auth status` output of THIS session. Print `ACCOUNT EMAIL: <answer>` in the pane. If `--text` lacks an email field, use the JSON form and extract ONLY identity fields (email/account/organization/plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. Prohibited sources: ~/.claude.json, macOS Keychain, shell history, memory.

Copy the Step-0 output AND the ACCOUNT EMAIL line VERBATIM into the PR body under `## Account attestation`. Never print token or key values, prefixes, or fragments — presence/absence only. Either token-presence reading is normal (INS-329: pane token presence is non-uniform). `ANTHROPIC_API_KEY: present` is a RED FLAG — complete the attestation, mark it in pane + PR body, and continue.

## Hard constraints

- **Base gate-check:** record `git rev-parse HEAD` (must equal `origin/main`, post-PR-#79 / brief-460). Verify `src/utils/sanitize-content.ts` at HEAD exports `detectZwsHeaders` (the #79 / M-007 detection primitive). If absent, ABORT with evidence in the pane — wrong/stale base; the chat session must investigate.
- **Suite baseline before any change:** expected **1459 passed | 5 skipped** at post-#79 main. Run it, record actual. Any pre-existing failure: record per INS-26 (no new failures may hide behind it) and proceed only if the failure set is clearly pre-existing.
- **Input pins:**
  1. LOCAL: `.prism/audits/s167-server-audit.md` — 199,606 B pin (the SRV-* finding definitions, fix specs, and each finding's `missing_test` line). This is your normative spec for every SRV item below.
  2. prism repo, fetch+show only (INS-283/INS-44/INS-189 — never checkout/pull the daemon-managed clone): `git -C /Users/brdonath/development/prism fetch origin main` then `git -C /Users/brdonath/development/prism show origin/main:.prism/audits/s168-master-findings.md` (53,942 B pin — M-009/M-010/M-011 master definitions) and `origin/main:.prism/audits/s168-wave3-backlog.md` (15,142 B pin — rows 17/19/23 + the W3-S5 batch contract). Record post-fetch SHAs + actual bytes; note deltas vs pins and proceed.
- Evidence computed, not eyeballed (INS-166/INS-170). Account for tooling behavior in greps (bold markers, fences) per INS-8.
- **Re-verify each SRV against HEAD before fixing it.** W3-S2/S3/S4 already landed and closed adjacent finalize/archival/security items; some SRV findings below may already be fixed at HEAD. The chat session re-read `src/tools/finalize.ts` at HEAD (S174) and confirmed: **SRV-47** (validation runs before injected archive/prune content) is STILL PRESENT; the **deadline-abandon class (SRV-48/49)** — `Promise.race` returns the deadline sentinel but the underlying `commitWork`/`draftWork` keeps running and can commit AFTER the error response — is STILL PRESENT; the **"warnings computed then discarded" item (SRV-18 class)** appears CLOSED (`commitPhase` now returns `warnings`). For ANY SRV you judge already-fixed, the per-finding disposition table must say so with file:line evidence — do not re-implement a landed fix, and do not skip a still-present one.

## Task A — M-009: GitHub transient-error classification (SRV-35 primary; +SRV-14, 40, 44, 45)

Per the pinned audit fix specs:
- Transient 401s are never retried anywhere and are misdiagnosed as a dead PAT (the INS-311 surface). Add bounded retry + correct classification so a transient 401 is retried, not reported as credential death.
- 403 rate-limit responses are misdiagnosed as a scope/permission failure — classify rate-limit vs permission and handle (back off on rate-limit).
- `fileExists`' documented `timeout→false` path is dead code (it catches the wrong exception name) — fix so the timeout path actually fires.
- `resolveDocPath` conflates operational errors with not-found — distinguish so a transient fetch error is not reported as "doc absent".
- `deleteRef` treats every 422 as already-absent (a protected-branch deletion refusal reports `deleted: true`) — distinguish 422-already-gone from 422-refused.

Cover every listed source finding per its audit definition; per-finding disposition table (file:line) in the PR body.

## Task B — M-010: action=full orchestration + mutation-safety redesign (SRV-41 primary; +SRV-20, 42, 47, 48, 49, 58, 59, 64, 65, 96, 97)

This is the deferred-from-brief-460 `action=full` orchestration redesign. Per the pinned audit fix specs (re-verifying each at HEAD per the hard constraint):
- **Mutation retry-idempotence (SRV-41):** a landed-but-unreported commit must not double-apply on retry — make `safeMutation`'s retry idempotent against an already-applied write.
- **Deadline cancellation (SRV-48/49) — CONFIRMED PRESENT at HEAD:** a fired deadline must actually cancel (or fence) the in-flight work so a "timed-out / failed" finalize can NOT commit after the error response is returned. Today `fullPhase` and the commit/draft handlers `Promise.race` a deadline sentinel while the underlying work keeps running. Plumb cancellation (AbortSignal or a committed-state fence) per the audit spec.
- **Transport-timeout double-execution (INS-326/INS-331/INS-314):** the `action=full` path exceeds the MCP client/proxy window — the transport drops ("connection lost") while the handler completes, and a retry double-appends (duplicate session-log/archive entries). Bring the full-action under the client ceiling and/or make it return early per the audit + the brief-460 Task-C / `mode=generate` precedent, and make a re-execution non-duplicating.
- **Errored-turn finalize retry duplicates archive entries (SRV-20 / INS-314):** archival must be idempotent across a retried finalize.
- **Validation ordering (SRV-47) — CONFIRMED PRESENT at HEAD:** `validateFile` runs at `commitPhase` step 3, but the archive lifecycle (3b) and the task-queue prune mutate `files[]` afterward, so injected archive + pruned content is committed unvalidated. Validate AFTER all content mutations (or re-validate injected content).
- **Deadlines at/above the MCP client ceiling (SRV-58/59):** check `FINALIZE_*_DEADLINE_MS` in `src/config.ts` against the real client ceiling and bring them safely under it.
- **No SIGTERM handler (SRV-64):** add graceful shutdown to the server entry point so an in-flight mutation is not killed mid-commit.
- **Scale has no wall-clock deadline (SRV-65):** add one to `prism_scale_handoff`.
- **`safeMutation`'s docstring contract is false (SRV-96/97):** correct it to match real behavior.

Re-verify each at HEAD; per-finding disposition table (file:line) — including any judged already-closed.

## Task C — M-011 (partial): security hardening EXCEPT the auth-composition flip (SRV-26, 37, 55, 66, 83 — SRV-36 EXCLUDED)

Per the pinned audit fix specs:
- **SRV-37 — CIDR prefix-range validation:** out-of-range prefixes silently WIDEN the mask (a `/33` typo admits half of IPv4). Validate/reject invalid prefixes so a typo cannot widen the allowlist. (Inert at today's config — no CIDR env is set — but ship the guard.)
- **SRV-26/55 — subprocess secret allowlist:** dispatched CC subprocesses inherit ALL server secrets with `bypassPermissions` and the PAT in the clone URL; `railway_env get` echoes unmasked secrets. Allowlist the env passed to the cc_dispatch subprocess to only what it needs (e.g. the clone PAT, the OAuth token, model vars) and mask `railway_env get` output. **Preserve cc_dispatch functionality — do not strip a secret the worker actually needs; prove cc_dispatch still works with a test.**
- **SRV-66 — PAT scrubbing:** push-error paths must scrub the PAT from messages/logs.
- **SRV-83 — behavioral security tests:** convert the in-scope security checks (CIDR validation, subprocess allowlist, PAT scrub) to BEHAVIORAL tests (the source-string greps are how SRV-37 shipped).
- **EXCLUDED — SRV-36 (auth OR→AND composition) and its auth-composition behavioral test.** Do NOT touch the auth composition logic. If the `railway_env`-masking or subprocess-allowlist work tempts an auth-middleware edit, stop at the auth-composition boundary and note it in the disposition table as "SRV-36 — deferred (operator-gated deploy), not in this brief."

Per-finding disposition table (file:line) for SRV-26, 37, 55, 66, 83; the SRV-36 row says "deferred".

## Verification (computed)

- Tests before/after with counts (start 1459 | 5 skipped). New named tests REQUIRED for: transient-401 retry + classification, 403 rate-limit classification, `fileExists` timeout→false path, `resolveDocPath` operational-vs-not-found, `deleteRef` 422-refused-vs-gone, mutation retry-idempotence (no double-apply), deadline cancellation (no commit-after-error), `action=full` non-duplicating re-execution, validation-covers-injected-content, scale wall-clock deadline, SIGTERM graceful shutdown, CIDR prefix-range rejection, subprocess env allowlist (+ cc_dispatch still functional), PAT scrubbing, `railway_env get` masking. Plus every `missing_test` line named in the pinned audit definitions for the in-scope SRV findings.
- `npx tsc --noEmit` clean · lint zero warnings · zero new failures (INS-26).

## PR body (evidence — GitHub is the only observability, INS-148)

`## Account attestation` (verbatim Step-0 output + ACCOUNT EMAIL line) · start HEAD + computed baseline · per-finding disposition table for all in-scope SRV findings + the SRV-36 "deferred" row (file:line each) · which SRV items were already-fixed-at-HEAD (with evidence) vs newly-fixed · tests before/after with the new test names · prism-repo pin SHAs/bytes · self-dequeue commit SHA.

## Push directive (exactly one)

Create branch `brief/461-w3s5-resilience-mutation-security` off `origin/main`, commit the implementation + tests, push, and open a single PR to `main` titled `fix(server): GitHub transient-error handling + action=full orchestration/mutation safety + security hardening (brief-461, W3-S5 split, D-257 wave 3)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR. CI must be green; the watcher auto-merges daemon PRs on green CI — that is the normal, expected path for this brief.

IMMEDIATELY after the PR is open — SELF-DEQUEUE (INS-324 §2): on the `briefs` branch, in ONE commit (message `chore: dequeue brief-461 (INS-324 self-dequeue)`), MOVE `.prism/briefs/queue/brief-461-w3s5-resilience-mutation-security.md` to `.prism/briefs/archive/brief-461-w3s5-resilience-mutation-security.md`. On a 409/422 push race, re-fetch and retry up to 3×. Never touch any other queue file. Record the dequeue commit SHA in the PR body. A later post_merge archive no-op or `archive_failed` event for this brief is EXPECTED (file already archived) and non-fatal.

## Out of scope

- **SRV-36 (auth OR→AND composition flip) + its auth-composition behavioral test** — deferred to a separate operator-gated deploy (Bearer token set on Railway + claude.ai connector confirmed to send it). Do not change auth composition logic.
- Payload diet, read-path, synthesis cost work (M-012/13/14/05 — W3-S6); docs/version discipline + dead-code (M-015/17/18 — W3-S7).
- Any change in any other repo; any living-document edit beyond what the fixes' own docs require.

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Opus 4.8 + max effort, post the 06-13 Fable→Opus emergency swap; INS-309/INS-332). Fable is disabled; do not pin it.
- Work from the HEAD the daemon pulled; do not pull mid-run. prism-repo reads are fetch+show only.
- No concurrent worker is expected on prism-mcp-server; a W3-P-series worker may run on the prism repo (disjoint — no coordination).

<!-- EOF: brief-461-w3s5-resilience-mutation-security.md -->
