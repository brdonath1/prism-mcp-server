---
brief: 466
title: "W3-S7 — markdown/analytics parsing correctness (M-015) + server docs/version discipline (M-017) + dead-code/artifact removal (M-018) + cc_dispatch attestation parity DIRECTIVE(c) (M-048)"
parallel: false
affects:
  - src/
  - tests/
  - CLAUDE.md
  - docs/
  - CHANGELOG.md
complexity: high
workflow: metaswarm
---

# Brief 466 — W3-S7: parsing correctness + docs/version + dead-code + DIRECTIVE(c) (prism-mcp-server)

**Status: PENDING**

**Repo:** prism-mcp-server (queue repo — your working tree; the daemon pulls it current at dispatch)
**Origin:** D-257 wave 3, backlog rows 14 / 39 / 47 / 4 (`prism:.prism/audits/s168-wave3-backlog.md`, batch W3-S7 = M-015 + M-017 + M-018 + M-048). Prior wave-3 server briefs landed: W3-S1 (#75), W3-S2 (#77), W3-S3 (#78), W3-S4 (#79), W3-S5 (#80), W3-S6 (#81). This is the parsing-correctness + doc-discipline + dead-code + third-channel-attestation batch — the LAST queued server brief before the coordinated `RECOMMENDATION_MODELS` enum fix (separate item, out of scope here).

**Builds on existing machinery — extend, do not reinvent (read these archived briefs first, on the `briefs` branch):** brief-459 (W3-S3 — standing-rules parser/writer + archival grammar; M-015's `_INDEX.md` multi-table parse shares the markdown-parsing surface), brief-465 (W3-S6 — payload/read-path/synthesis; its analytics/markdown helpers are what M-015 touches), brief-455 (W3-S1 — the docs-only-PR CI unblock that lets this doc-heavy PR merge), brief-450 (model-registry single switch — M-017's CLAUDE.md model references must cite the registry/`src/models.ts`, not a hardcoded model string).

**DOC-FIDELITY NOTE.** Task A (M-015) changes analytics/search/patch parsing returned to live MCP clients; Task B (M-017) and Task C (M-018) edit docs + remove artifacts; Task D (M-048) changes the cc_dispatch prompt the server hands to dispatched workers. This brief auto-merges on green CI and prism-mcp-server redeploys from `main`, so:
- M-015 parsing changes are behavior — every fix needs a regression test with a real fixture, and no currently-correct parse may regress (bootstrap/analytics round-trips must stay green).
- M-017/M-018 must not delete anything a consumer requires. Dead-code removal (M-018) is gated on a per-item zero-consumer proof (grep all of `src/` + `tests/`); a symbol that ONLY its own grep-the-source test references is dead, but verify the `@deprecated`/production split the audit names before deleting.

**THE WHY (verbatim from the operator charter — it is your ranking lens):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 / INS-319 + INS-320 — run before ANY other action)

Run exactly this as your first action and ensure its full output is visible in the pane:

```bash
claude auth status --text 2>&1; echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"; echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, before ANY other command, answer the mandatory first question (INS-320): **"Which email address is associated with this Claude Max account?"** — derived EXCLUSIVELY from the `claude auth status` output of THIS session. Print `ACCOUNT EMAIL: <answer>` in the pane. If `--text` lacks an email field, use the JSON form and extract ONLY identity fields (email/account/organization/plan) — never paste raw auth-status JSON. If neither form exposes an email, answer exactly `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. Prohibited sources: ~/.claude.json, macOS Keychain, shell history, memory.

Copy the Step-0 output AND the ACCOUNT EMAIL line VERBATIM into the PR body under `## Account attestation`. Never print token or key values, prefixes, or fragments — presence/absence only. Either token-presence reading is normal (INS-329; post-INS-337 the expected shape is `authMethod: claude.ai` / Keychain with `CLAUDE_CODE_OAUTH_TOKEN: absent`). `ANTHROPIC_API_KEY: present` is a RED FLAG — complete the attestation, mark it in pane + PR body, and continue.

## Hard constraints

- **Base gate-check:** record `git rev-parse HEAD` (must equal `origin/main`; expected `a2ac66011e5dfad05997e1be58424c2748ef6328`, the W3-S6 / PR #81 merge). Verify the W3-S6 deliverables are present at HEAD: `assembleSynthesisBundle` exists in the synthesis path (SRV-73 dedup) AND the deprecated `standing_rules_tier_c_index` alias is GONE from the bootstrap payload (SRV-109). If either check fails or HEAD ≠ origin/main, ABORT with evidence in the pane — wrong/stale base; the chat session must investigate.
- **Suite baseline before any change:** expected **1563 passed | 5 skipped** at post-#81 main (confirmed — PR #81 merged at 1563 passed | 5 skipped: brief-465 Task-D 1562 + the review-follow-up test). Run it, record the EXACT actual. If the count is below 1562, ABORT (stale base). Any pre-existing failure: record per INS-26 (no new failures may hide behind it) and proceed only if the failure set is clearly pre-existing.
- **Input pins:**
  1. LOCAL: `.prism/audits/s167-server-audit.md` — 199,606 B pin (the SRV-* finding definitions, fix specs, and each finding's `missing_test` line). NORMATIVE spec for every SRV item below. Record actual bytes; note any delta and proceed.
  2. prism repo, fetch+show ONLY (INS-283 / INS-44 / INS-189 — never checkout/pull the daemon-managed clone): `git -C /Users/brdonath/development/prism fetch origin main` then `git -C /Users/brdonath/development/prism show origin/main:.prism/audits/s168-master-findings.md` (53,942 B pin — M-015/017/018 cluster defs in the "Server — prism-mcp-server" ledger section) and `origin/main:.prism/audits/s168-wave3-backlog.md` (15,142 B pin — rows 14/39/47/4 + the W3-S7 batch). Record post-fetch SHAs + actual bytes; note deltas vs pins and proceed.
- Evidence computed, not eyeballed (INS-166 / INS-170). Account for tooling behavior in greps (bold markers, fences) per INS-8.
- **Re-verify each finding at HEAD before fixing — MEASURE, don't assume (INS-339: the s168 audit is imprecise on file paths/line numbers, and was read on the now-22-PRs-stale `brief/454` branch).** S1–S6 landed and reshaped `src/` (config, finalize, client, synthesis, sanitizer, payload, read-path, shutdown, models). For EVERY cited path/symbol/line: confirm it at HEAD first. **If a cited defect no longer exists at HEAD (already fixed by an intervening brief) OR a cited path/symbol cannot be located, STOP that item, record it in the PR body with evidence (already-fixed vs not-found), and DO NOT guess a substitute.** This is the chartered STOP-on-divergence fail-safe — a wrong path/ID would otherwise ship silently because the PR auto-merges on green CI.

## Task A — M-015: markdown/analytics parsing correctness (SRV-08 primary; +21, 24, 33, 34)

Per the pinned audit fix specs (`.prism/audits/s167-server-audit.md`):
- **SRV-08:** `decision_velocity` / `decision_graph` analytics parse a multi-table `_INDEX.md` as ONE table — confidently-wrong analytics on every migrated project. Parse per-table (respect table boundaries / interleaved headings), not as a single contiguous grid.
- **SRV-21:** interior empty cells shift columns — the row parser must preserve empty cells positionally (don't collapse them) so column alignment survives.
- **SRV-24:** inline `<!-- EOF:` mentions (the sentinel string appearing INSIDE a section body, not as the real trailing sentinel) clip sections short and tear lines on patch. The parser/patch must distinguish the TRUE trailing EOF sentinel from an inline mention.
- **SRV-33:** stripped-to-empty query tokens defeat search relevance — a query that sanitizes/normalizes to empty must not silently match-everything / match-nothing; handle the empty-token case explicitly.
- **SRV-34:** unparseable session dates silently drop sessions — a session whose date can't be parsed must not vanish from analytics; surface/retain it (don't silent-drop).
Per-finding disposition table (file:line) in the PR body. A regression test with a real fixture for EACH of the five (multi-table `_INDEX` parse, interior-empty-cell alignment, inline-EOF-mention vs true-sentinel, empty-query-token, unparseable-date retention).

## Task B — M-017: server docs/CLAUDE.md currency + version discipline (SRV-88 primary; +90,91,92,93,94,95,100,101,102,105,106,107)

Per the pinned audit fix specs. Doc/version drift — correct to HEAD truth; verify every claim at HEAD before editing:
- **SRV-88:** the self-declared-authoritative banner spec (`docs/banner-spec.md` or equivalent — locate at HEAD) is frozen at 3.0 vs the SHIPPED Banner-Spec-Version **4.1** (D-256). Bring it current to 4.1 and reconcile its "Status: Authoritative" claim.
- **SRV-90:** `SERVER_VERSION` constant frozen at 4.7.0 across 28+ merged PRs — this also falsifies the framework template's `≥4.7.1` floor check (cross-repo: the CONSTANT, not the capability, fails the floor). Read the current value at HEAD; bump `SERVER_VERSION` so it (a) reflects the real shipped version and (b) satisfies the framework's `≥4.7.1` floor. Apply the version-bump discipline the audit specifies.
- **SRV-91/92/93/94/95:** CLAUDE.md is wrong on tool counts (audit found 23 vs the real registered count — COUNT the actually-registered MCP tools at HEAD and use that number), brief paths (CLAUDE.md cites `docs/briefs/`; the real path is `.prism/briefs/queue/` per `.prism/trigger.yaml`), models (CLAUDE.md cites Opus; cite the model REGISTRY / `src/models.ts` single-switch per brief-450 / D-254 and describe the Railway-env override mechanism — do NOT hardcode a model string), and env-var references. Correct each against HEAD truth.
- **SRV-100/101/102:** CHANGELOG stops cold — backfill to the current version; stale historical docs lack deprecation/"superseded" banners — add them per the audit's list.
- **SRV-105/106/107:** remaining doc-drift items per the pinned spec.
Per-finding disposition table (file:line). **OUT OF SCOPE within M-017:** the `RECOMMENDATION_MODELS` classifier enum / Railway-env model swap (that is the SEPARATE coordinated enum fix, not doc-drift) — do not modify `RECOMMENDATION_MODELS` in `src/models.ts` here beyond citing the registry pattern in CLAUDE.md prose.

## Task C — M-018: server dead-code / artifact removal (SRV-108 primary; +110,111,112,113,114,116,117)

Per the pinned audit fix specs. Each removal gated on a per-item zero-consumer proof at HEAD (grep all of `src/` + `tests/`):
- **SRV-108:** dead boot topic-selection path (maintained as recently as S107 but unreferenced in production) — remove after proving no live caller.
- **SRV-110:** dead batch resolvers pinned ONLY by grep-the-source tests while production uses the `@deprecated` function — remove the dead resolvers AND their grep-the-source tests (verify the `@deprecated`/production split the audit names first).
- **SRV-111:** never-wired cache invalidation — remove.
- **SRV-112:** zero-consumer exports — remove.
- **SRV-113:** permanently-null back-compat fields — remove.
- **SRV-114:** phantom gitlink submodule at repo root — remove the stray gitlink.
- **SRV-116/117:** 15 tracked legacy `.dispatch/` files (and any remaining artifact named in the spec) — remove.
Per-finding disposition table (file:line / path each) + the zero-consumer evidence per removed symbol. Any item whose consumers are NOT actually zero at HEAD → STOP that item, record it, do not force the removal.

## Task D — M-048: DIRECTIVE(c) — cc_dispatch prompt attestation parity (D-259c / INS-319 §5)

The third dispatch channel (`cc_dispatch` on prism-mcp-server) must carry the SAME Step-0 account attestation as Trigger briefs, so an account-mismatch is detectable on the cc_dispatch path too (no pane exists — the attestation lands in the dispatch output / PR per INS-319 §5).
- Locate the cc_dispatch prompt builder at HEAD (the function assembling the user prompt handed to the dispatched CC worker).
- PREPEND the Step-0 attestation preamble (the `claude auth status --text` + presence-only env fingerprint block + the INS-320 "which email" instruction) to every cc_dispatch prompt, in BOTH `query` and `execute` modes, so the dispatched worker runs the attestation first and emits it in its output / PR body.
- This is a server-code change — inject the preamble from a SINGLE source-of-truth constant reused across modes (do not duplicate the text per call site).
Test REQUIRED: assert the constructed cc_dispatch prompt CONTAINS the attestation preamble in both modes. Per-finding disposition (file:line).

## Verification (computed)

- Tests before/after with counts (start ≥1562 | 5 skipped — record exact). New named tests REQUIRED for: **[M-015]** multi-table `_INDEX` parse, interior-empty-cell alignment, inline-EOF-mention vs true-sentinel, empty-query-token handling, unparseable-date retention; **[M-017]** `SERVER_VERSION` ≥4.7.1 floor + (where the audit names one) a guard that CLAUDE.md/banner-spec claims match code, banner-spec 4.1; **[M-018]** a test proving each removed symbol has zero live consumers (or that the removed grep-the-source test is gone); **[M-048]** cc_dispatch prompt contains the attestation preamble (query + execute). Plus every `missing_test` line named in the pinned audit definitions for the in-scope SRV findings.
- `npx tsc --noEmit` clean · lint zero warnings · zero new failures (INS-26).

## PR body (evidence — GitHub is the only observability, INS-148)

`## Account attestation` (verbatim Step-0 output + ACCOUNT EMAIL line) · start HEAD (confirm = a2ac660) + computed baseline · per-finding disposition table for all in-scope SRV findings + M-048 (file:line each) · which SRV items were already-fixed-at-HEAD (with evidence) vs newly-fixed vs STOPPED-on-divergence · `SERVER_VERSION` before→after (and confirmation it satisfies the framework ≥4.7.1 floor) · the registered MCP tool count used for CLAUDE.md · tests before/after with the new test names · prism-repo pin SHAs/bytes · self-dequeue commit SHA.

## Push directive (exactly one)

Create branch `brief/466-w3s7-parsing-docs-deadcode-directive` off `origin/main`, commit the implementation + tests, push, and open a single PR to `main` titled `fix(server): parsing correctness + docs/version discipline + dead-code removal + cc_dispatch attestation parity (brief-466, W3-S7, D-257 wave 3)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR. CI must be green; the watcher auto-merges daemon PRs on green CI — that is the normal, expected path for this brief.

IMMEDIATELY after the PR is open — SELF-DEQUEUE (INS-324 §2): on the `briefs` branch, in ONE commit (message `chore: dequeue brief-466 (INS-324 self-dequeue)`), MOVE `.prism/briefs/queue/brief-466-w3s7-parsing-docs-deadcode-directive.md` to `.prism/briefs/archive/brief-466-w3s7-parsing-docs-deadcode-directive.md`. On a 409/422 push race, re-fetch and retry up to 3×. Never touch any other queue file. Record the dequeue commit SHA in the PR body. A later post_merge archive no-op or `archive_failed` event for this brief is EXPECTED (file already archived) and non-fatal.

## Out of scope

- The coordinated `RECOMMENDATION_MODELS` enum fix (env-overridable in `src/models.ts` + Railway env + core-template enum) — a SEPARATE prism-mcp-server item; do not touch `RECOMMENDATION_MODELS` here.
- All prior W3-S batches (M-001..M-014 + M-005 — landed in #75/#77/#78/#79/#80/#81).
- Any change in any other repo (framework / trigger / prism); any living-document edit beyond what the fixes' own docs require.
- The `standing_rules_index` consumer contract / template diet (framework W3-F2/M-021 + W3-F3/M-019).

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Opus 4.8 + max effort; Fable is disabled post the 06-13 emergency swap, INS-309 / INS-332 — do not pin Fable).
- Work from the HEAD the daemon pulled; do not pull mid-run. prism-repo reads are fetch+show only (INS-283 / 44 / 189).
- No concurrent worker is expected on prism-mcp-server; a prism-framework W3-F worker may run in parallel (disjoint repo — no coordination). A prism W3-P worker must NOT run concurrently with a live prism chat session, but that does not affect this server brief.

<!-- EOF: brief-466-w3s7-parsing-docs-deadcode-directive.md -->
