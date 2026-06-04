---
brief: 443
title: "R7-b + R-intel-SLO — richer boot payload + intelligence SLO instrumentation"
parallel: false
affects:
  - src/tools/bootstrap.ts
  - tests/
complexity: high
workflow: metaswarm
model: claude-opus-4-8
effort: max
---

# Brief 443 — R7-b + R-intel-SLO: richer boot payload + SLO

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-240 Phase B, audit brief-431 rows R7-b + R-intel-SLO.
**Re-dispatch of brief-440** (S148-overnight; failed at the daemon's git-fetch step before preflight — transient, never executed; content unchanged; re-numbered 440→443, and the original `depends_on: [439]` dropped because #439 has merged). **CODE.**

## Context
The 500K-context rationale (D-240) intentionally REVERSES the D-47 / D-193-Piece-4
token-economy slimming of the boot payload — this is coherent and must NOT be
re-optimized back down. Today bootstrap compacts the intelligence brief (D-47,
~line 670 per INS-249 — only 3 of 6 sections reach Claude), caps recent_decisions and
guardrails low, caps prefetch at 2, and delivers only Tier A standing rules (Tier B
excluded at boot). There is no instrumentation of boot-payload completeness.

Note (R3-imm landed S149): standing rules now live in `.prism/standing-rules.md` (126
rules), resolved via the R2-B union read; `insights.md` is now ~18KB. When delivering
"Tier A + Tier B + Tier-C index" below, source from the union read, not a parse of
insights.md.

## Required Changes
**Investigate first.** Read `src/tools/bootstrap.ts`: the D-47 `intelligence_brief`
compaction block (~line 670), the `recent_decisions` / `guardrails` slicing, the
prefetch cap (2), and the standing-rules tier delivery (currently Tier A only).

1. **Un-compact the intelligence brief (reverse D-47):** deliver the FULL
   intelligence-brief.md content in the bootstrap `intelligence_brief` field (all 6
   spec sections), not the 3-section compaction.
2. **recent_decisions -> 15** (from the current cap).
3. **guardrails -> 20** (from the current cap).
4. **Prefetch cap -> raise or remove** the current limit of 2 prefetched documents.
5. **Standing rules:** deliver all **Tier A + Tier B** standing rules at boot, plus a
   **Tier-C index** (IDs + titles, not full bodies). Today only Tier A is delivered.
   Source from the R2-B union read (standing-rules.md ∪ insights.md), per R3-imm.
6. **R-intel-SLO:** instrument + emit an intelligence SLO block in the bootstrap
   response `diagnostics`: boot completeness % (sections/fields delivered vs spec),
   brief age in sessions (target <= 2), and continuity coverage (handoff / decisions /
   insights present). Log-only; no behavior gating.

## Verification (HARD BLOCK — land all evidence in the PR body)
1. Tests: `intelligence_brief` field contains all 6 sections (not 3); recent_decisions
   returns up to 15; guardrails up to 20; prefetch cap raised/removed; standing-rules
   delivery includes Tier A + Tier B + a Tier-C index. Assert against fixtures.
2. SLO block emitted with the three metrics; test the completeness computation.
3. Full suite green; tsc + lint clean; report counts (N -> M).
4. Confirm no re-introduction of D-47 compaction (this brief intentionally REVERSES it
   per D-240 — cite that in the PR body).

## Out of Scope
- Banner unification (brief-439, merged). Synthesis input bounding (brief-445 / R3-dur).
- Server-hygiene bundle (brief-444).

## PR Title / Body Hint
Title: `prism(R7-b + R-intel-SLO): richer boot payload + intelligence SLO (D-240 Phase B)`
Body: the deliberate D-47 reversal under 500K, the un-compacted brief, decisions->15 /
guardrails->20 / prefetch cap raised / Tier A+B + Tier-C index, the SLO block, tests,
counts N->M, confirmation CC launched on claude-opus-4-8.

## Brief Author Notes
- The D-47 reversal is INTENTIONAL (D-240 / task-queue note) — do not treat it as a
  regression or re-slim it.
- bootstrap's compactor matches headers literally (INS-249) — when un-compacting,
  ensure the full brief flows through without the header-name coupling breaking.
- Model pinning (R4): confirm CC launched on claude-opus-4-8 in the PR body.
- Tier: AUTO. CI gates the merge.

<!-- EOF -->
