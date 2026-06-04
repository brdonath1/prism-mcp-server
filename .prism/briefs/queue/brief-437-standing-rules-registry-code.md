---
brief: 437
title: "R2-B — standing-rule registry support in standing-rules.md (code only)"
parallel: false
depends_on: []
affects:
  - src/tools/load-rules.ts
  - src/tools/bootstrap.ts
  - src/tools/log-insight.ts
  - tests/tools/load-rules.test.ts
  - tests/tools/log-insight.test.ts
complexity: high
workflow: metaswarm
model: claude-opus-4-8
effort: max
---

# Brief 437 — R2-B: standing-rule registry support (code only)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 §6.3, table row R2-B. Brief 2 of the
archival chain (R2-A → R2-B → R3-imm → R3-dur). **CODE ONLY** — the live data
migration of `prism/insights.md` (move standing rules out + prune to ~20KB) is
R3-imm and runs against the `prism` repo, not here.

## Context
~78% of a mature `insights.md` is STANDING-RULE entries, which
`INSIGHTS_ARCHIVE_CONFIG.protectedMarkers: ["STANDING RULE"]` pins permanently,
so R2-A's archival can only evict the ~16% chronological tail. The fix is to
give standing rules their own file, `.prism/standing-rules.md`, so insights.md
can later (R3-imm) archive to ~20KB.

Standing rules live in **each project's** insights.md and are parsed by the
shared, **format-driven** `extractStandingRules()` in
`src/utils/standing-rules.ts` (it does NOT hardcode insights.md — it parses
whatever string it's handed). So this brief changes only the *source* the
server reads/writes; the parser, tiers, and topic matching are untouched.

This brief MUST be safe to deploy before any project migrates data: a project
with no standing-rules.md yet must keep resolving its rules from insights.md.
Achieved via a union read (below).

## Required Changes
**Investigate first.** Read `src/tools/load-rules.ts` (the
`resolveDocPath(slug,"insights.md")` → `extractStandingRules` path),
`src/tools/bootstrap.ts` (its standing-rules extraction — same shared helper;
leave bootstrap's *other* insights.md reads for the intelligence-brief /
pre-fetch untouched), `src/tools/log-insight.ts` (`parseExistingInsightIds`
dedup + the `## Active` insertion + `freshStarter`), and
`src/utils/standing-rules.ts` (reference only — confirm no change needed).

1. **Read path (load-rules + bootstrap):** resolve standing rules from a
   **union** of `standing-rules.md` and `insights.md` — `extractStandingRules`
   on each, dedup by INS-N, prefer `standing-rules.md` on conflict. When
   `standing-rules.md` is absent, behavior is identical to today
   (insights.md only). Tier A boot-load and Tier B/C topic load operate on the
   unioned set.
2. **Write path (log-insight):** when `standing_rule: true`, write to
   `.prism/standing-rules.md`'s `## Active` (create from a fresh-starter with
   `## Active`, `## Formalized`, and `<!-- EOF: standing-rules.md -->` if
   absent); non-standing insights still go to insights.md unchanged. Dedup must
   scan **both** files (INS-N is one shared sequence).
3. **finalize.ts — NO CHANGE.** `standing-rules.md` is auto-exempt (it's not in
   the `applyArchive(...)` call list). KEEP the `"STANDING RULE"` protected
   marker: it's harmless once a project's insights.md has no standing rules,
   and it still protects projects that haven't migrated. Do NOT remove it.
4. **standing-rules.ts / archive.ts — NO CHANGE** (confirm via zero diff).

## Verification (hard block — land all evidence in the PR body)
1. Read-path tests: standing rules resolve correctly (a) when only insights.md
   has them, (b) when only standing-rules.md has them, (c) when both have them
   (union, standing-rules.md wins on INS-N conflict). The (b)/(c) cases must
   FAIL against current `main`, PASS with the change.
2. Write-path test: `prism_log_insight(standing_rule:true)` lands in
   standing-rules.md; dedup rejects an INS-N already present in insights.md.
3. Full suite green; `tsc` + lint clean; report test counts (N → M).
4. Confirm zero diff to `src/utils/archive.ts` and `src/utils/standing-rules.ts`,
   and zero diff to `src/tools/finalize.ts`.
5. **No data migration here.** Do not create or modify any project's live
   insights.md / standing-rules.md. Code + tests only.

## Out of Scope
- Migrating `prism/insights.md` (move standing rules out + prune to 20KB) → **R3-imm**.
- Removing the `"STANDING RULE"` protected marker (unnecessary and unsafe until
  every project has migrated — keep it).
- Promoting standing-rules.md to a tracked living document (audit/currency,
  docs_total → 11).
- The Trigger dead-marker / misleading-comment cleanup (separate; Parking Lot, D-241).

## PR Title / Body Hint
Title: `prism(R2-B): standing-rules.md registry support, union read (D-240 Phase B)`
Body: the 78%-protection problem, the union-read design (safe pre-migration
deploy), the write+dedup-both change, the red→green tests, counts N→M,
confirmation that archive.ts / standing-rules.ts / finalize.ts are byte-identical.

## Brief Author Notes
- Grounded against current `main`: `standing-rules.ts` `extractStandingRules`
  (format-driven; tiers via `[TIER:X]`, topics via `<!-- topics: -->`);
  `load-rules.ts` `resolveDocPath(slug,"insights.md")`; `log-insight.ts`
  `parseExistingInsightIds` + `## Active` insertion; `finalize.ts`
  `INSIGHTS_ARCHIVE_CONFIG` + the two `applyArchive(...)` calls.
- Tier: **CHECKPOINT**, but code + tests only — no live-memory mutation.
- Model pinning (R4): confirm in the PR body that CC launched on
  `claude-opus-4-8`; if the `--model` string is rejected, report it — do not
  silently fall back.
- Transient state after deploy (old rules in insights.md, new ones in
  standing-rules.md) is intentional and handled by the union read until R3-imm
  consolidates.

<!-- EOF -->
