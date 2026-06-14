---
brief: 464
title: "W3-S6 — server payload diet (M-012) + read-path efficiency/fidelity (M-013) + synthesis cost/content (M-014) + synthesis transport/model/budget config hardening (M-005)"
parallel: false
affects:
  - src/
  - tests/
complexity: high
workflow: metaswarm
---

# Brief 464 — W3-S6: payload diet + read-path + synthesis cost + transport config hardening (prism-mcp-server)

**Status: PENDING**

**Re-issue note (S174):** This is the W3-S6 brief re-numbered to 464 (lineage: 462 → 463 → 464). 462 and 463 each dispatched once and hit a daemon-pane "Claude API / 401 Invalid authentication credentials" at launch. **S174 diagnosis (resolved):** this was NOT a stray API key. The daemon already scrubs `ANTHROPIC_API_KEY` on every launch (worker.ts emits `unset ANTHROPIC_API_KEY` before `claude`) and the operator's `.zshrc` wrapper unsets it again; a full scan found no stray `ANTHROPIC_API_KEY`/`apiKeyHelper` in global shell env, CC config (`~/.claude/*`), the project clone (`.claude`/`.env*`/`.mcp.json`), or launchd. The failure was a **transient stale-OAuth-token moment at dispatch time** — the daemon's exact pane-launch mechanism (`osascript … create window with default profile` + write-text) was reproduced live and authenticates on `oauth_token` / firstParty when the token is fresh. Each 401-burned brief-id is permanently skipped by the poller as previously-processed (TRG-36), so re-runs MUST renumber — hence 464. The work, baseline, and all constraints below are unchanged. **DURABLE follow-up (separate, NOT this brief):** the Max OAuth token goes stale on a cycle with nothing re-minting it for the daemon (M-047 token-refresh gap) — that is the lasting fix and is tracked separately.

**Repo:** prism-mcp-server (queue repo — your working tree; the daemon pulls it current at dispatch)
**Origin:** D-257 wave 3, backlog rows 30/31/35/36 (`prism:.prism/audits/s168-wave3-backlog.md`, batch W3-S6 = M-012 + M-013 + M-014 + M-005). Prior wave-3 server briefs landed: W3-S1 (#75), W3-S2 (#77), W3-S3 (#78), W3-S4 (#79), W3-S5 (#80). This is the token-efficiency batch of the charter.

**Builds on existing machinery — extend, do not reinvent (read these archived briefs first):** brief-449 (bootstrap-payload-diet — the server payload-diet path already exists), brief-443 (richer-boot-payload SLO), brief-445 (bound-synthesis-inputs), brief-418 (cc-subprocess zero-token guard + [1m] opt-in — the [1m] infra exists; M-005 hardens it), brief-450 (model-registry single switch). Find them in `.prism/briefs/archive/` on the `briefs` branch.

**FIDELITY GUARD — READ FIRST (chat-session constraint, S174).** Tasks A (M-012 payload diet) and B (M-013 read-path) change **what the server returns to live MCP clients**. This brief auto-merges on green CI and prism-mcp-server redeploys from `main`, so a bad trim reaches the next real session's boot. Unlike S5's auth flip this is degraded-and-revertible, not a lockout — but it is still gated hard:
- **No field any consumer requires may be dropped.** Trim only aliases, redundant duplication, and genuinely over-cap content. A `prism_bootstrap` round-trip test MUST prove a session still boots with every required section present (Meta, Where We Are, standing_rules_index, decisions, task-queue, handoff, etc.) on the trimmed payload — byte-smaller, field-complete.
- **No standing_rules_index restructuring that depends on the not-yet-landed W3-F2/M-021 payload contract.** Server-side mechanical trims only; the formal index consumer contract is a framework brief that has not merged. If a change needs that contract, record it as out-of-scope for F2/F3, don't do it here.

**THE WHY (verbatim from the operator charter — it is your ranking lens):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 / INS-319 + INS-320 — run before ANY other action)

Run exactly this as your first action and ensure its full output is visible in the pane:

```bash
claude auth status --text 2>&1; echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"; echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question (INS-320): **"Which email address is associated with this Claude Max account?"** — derived EXCLUSIVELY from the `claude auth status` output of THIS session. Print `ACCOUNT EMAIL: <answer>` in the pane. If `--text` lacks an email field, use the JSON form and extract ONLY identity fields (email/account/organization/plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. Prohibited sources: ~/.claude.json, macOS Keychain, shell history, memory.

Copy the Step-0 output AND the ACCOUNT EMAIL line VERBATIM into the PR body under `## Account attestation`. Never print token or key values, prefixes, or fragments — presence/absence only. Either token-presence reading is normal (INS-329). `ANTHROPIC_API_KEY: present` is a RED FLAG — complete the attestation, mark it in pane + PR body, and continue.

## Hard constraints

- **Base gate-check:** record `git rev-parse HEAD` (must equal `origin/main`, post-PR-#80 / brief-461). Verify `src/shutdown.ts` exists at HEAD (the SIGTERM/SIGINT handler shipped in #80) AND `safeMutation` accepts an `AbortSignal` (also #80). If either is absent, ABORT with evidence in the pane — wrong/stale base; the chat session must investigate.
- **Suite baseline before any change:** expected **1510 passed | 5 skipped** at post-#80 main. Run it, record actual. Any pre-existing failure: record per INS-26 (no new failures may hide behind it) and proceed only if the failure set is clearly pre-existing.
- **Input pins:**
  1. LOCAL: `.prism/audits/s167-server-audit.md` — 199,606 B pin (the SRV-* finding definitions, fix specs, and each finding's `missing_test` line). Normative spec for every SRV item below.
  2. prism repo, fetch+show only (INS-283/INS-44/INS-189 — never checkout/pull the daemon-managed clone): `git -C /Users/brdonath/development/prism fetch origin main` then `git -C /Users/brdonath/development/prism show origin/main:.prism/audits/s168-master-findings.md` (53,942 B pin — M-005/012/013/014 cluster defs + the PRM-23 cross-reference for M-014) and `origin/main:.prism/audits/s168-wave3-backlog.md` (15,142 B pin — rows 30/31/35/36 + the W3-S6 batch). Record post-fetch SHAs + actual bytes; note deltas vs pins and proceed.
- Evidence computed, not eyeballed (INS-166/INS-170). Account for tooling behavior in greps (bold markers, fences) per INS-8.
- **Re-verify each finding at HEAD before fixing — MEASURE, don't assume.** S2–S5 landed and #80 changed `src/config.ts` (deadline configs), `finalize`, `client`, and added `shutdown.ts`; some surfaces may have shifted. For the efficiency findings, take a real before/after measurement at HEAD — in particular the M-014 double-bundle (below) must be measured in tokens before and after, not asserted.

## Task A — M-012: server payload diet + instrumentation + registry lifecycle (SRV-39 primary; +28,68,69,74,85,86,109)

Server-side only (the template-content diet rides W3-F2/M-021 + W3-F3/M-019 — out of scope here). Per the pinned audit fix specs, and extending brief-449's payload-diet path:
- Alias removal (drop duplicate/aliased fields the payload emits redundantly).
- Response/aggregate caps where the audit specifies them.
- Payload attribution / instrumentation (byte-attribution so future drift is measurable — SRV-39).
- Registry lifecycle correctness (alias removal, caps, attribution per the audit).
- SRV-86 (delivery/cache) co-verifies with W3-F3/M-019 — implement the server side; note the framework dependency.
**FIDELITY GUARD applies** — the bootstrap round-trip test is part of this task's DoD. Per-finding disposition table (file:line) in the PR body.

## Task B — M-013: read-path efficiency + response fidelity (SRV-70 primary; +17,54,63,71,76,81,82)

Per the pinned audit fix specs:
- Confident-omission fix: the read path must not silently omit data it judges redundant/known without flagging that omission to the consumer.
- Aggregate response caps where specified.
- Correct `isError` flagging on tool responses (errors must set the MCP `isError` flag, not return success-shaped payloads).
**FIDELITY GUARD applies.** Per-finding disposition table (file:line).

## Task C — M-014: synthesis cost/content (SRV-73 primary; +27,72,89; PRM-23)

Per the pinned audit fix specs:
- **Dedup the double bundle.** The S167 audit measured a ~103K-token bundle sent **twice** to synthesis. Re-measure at HEAD (record the actual token count), then dedup so the bundle is constructed/sent once. Report the measured before/after token delta in the PR body — this is the headline efficiency win.
- Restore dropped sections (sections the synthesis input silently omits).
- Fix registry input (the registry content fed to synthesis).
- Add the provenance line (PRM-23 cross-reference — the synthesized-from provenance marker).
Per-finding disposition table (file:line) + the measured token delta.

## Task D — M-005: synthesis transport/model/budget config hardening (SRV-50 primary; +60,61,62,67)

Per the pinned audit fix specs, extending brief-418's [1m] opt-in infra:
- `[1m]` context-window guard (guard the 1M-token opt-in against misconfiguration / misuse).
- Transport gate (validate the synthesis transport selection).
- Ratio validation (the audit's ratio guard).
- Draft budget hardening (the synthesis draft token budget).
**NOTE:** #80 just changed deadline configs in `src/config.ts` — re-read `src/config.ts` at HEAD and harden the synthesis **transport/model/budget** configs specifically (these are distinct from the deadline configs #80 touched; do not regress those). Per-finding disposition table (file:line).

## Verification (computed)

- Tests before/after with counts (start 1510 | 5 skipped). New named tests REQUIRED for: the bootstrap fidelity round-trip (field-complete on trimmed payload), payload alias removal + caps + attribution, read-path confident-omission flagging, read-path aggregate caps, `isError` correctness, synthesis double-bundle dedup (assert single bundle + the measured token reduction), dropped-section restoration, registry-input fix, provenance line, [1m] guard, transport gate, ratio validation, draft-budget hardening. Plus every `missing_test` line named in the pinned audit definitions for the in-scope SRV findings.
- `npx tsc --noEmit` clean · lint zero warnings · zero new failures (INS-26).

## PR body (evidence — GitHub is the only observability, INS-148)

`## Account attestation` (verbatim Step-0 output + ACCOUNT EMAIL line) · start HEAD + computed baseline · the **measured M-014 token delta** (before/after) · the bootstrap fidelity round-trip result · per-finding disposition table for all in-scope SRV findings (file:line each) · which SRV items were already-fixed-at-HEAD (with evidence) vs newly-fixed · tests before/after with the new test names · prism-repo pin SHAs/bytes · self-dequeue commit SHA.

## Push directive (exactly one)

Create branch `brief/464-w3s6-payload-readpath-synthesis` off `origin/main`, commit the implementation + tests, push, and open a single PR to `main` titled `perf(server): payload diet + read-path efficiency/fidelity + synthesis cost dedup + transport config hardening (brief-464, W3-S6, D-257 wave 3)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR. CI must be green; the watcher auto-merges daemon PRs on green CI — that is the normal, expected path for this brief.

IMMEDIATELY after the PR is open — SELF-DEQUEUE (INS-324 §2): on the `briefs` branch, in ONE commit (message `chore: dequeue brief-464 (INS-324 self-dequeue)`), MOVE `.prism/briefs/queue/brief-464-w3s6-payload-readpath-synthesis.md` to `.prism/briefs/archive/brief-464-w3s6-payload-readpath-synthesis.md`. On a 409/422 push race, re-fetch and retry up to 3×. Never touch any other queue file. Record the dequeue commit SHA in the PR body. A later post_merge archive no-op or `archive_failed` event for this brief is EXPECTED (file already archived) and non-fatal.

## Out of scope

- Template-content payload diet and the standing_rules_index consumer contract (W3-F2/M-021 + W3-F3/M-019 — framework briefs, not landed). Server-side mechanical trims only.
- Parsing-correctness, docs/version discipline, dead-code, and DIRECTIVE(c) (M-015/17/18/48 — W3-S7).
- Any change in any other repo; any living-document edit beyond what the fixes' own docs require.

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Opus 4.8 + max effort, post the 06-13 Fable→Opus emergency swap; INS-309/INS-332). Fable is disabled; do not pin it.
- Work from the HEAD the daemon pulled; do not pull mid-run. prism-repo reads are fetch+show only.
- No concurrent worker is expected on prism-mcp-server; a W3-P-series worker may run on the prism repo (disjoint — no coordination).

<!-- EOF: brief-464-w3s6-payload-readpath-synthesis.md -->
