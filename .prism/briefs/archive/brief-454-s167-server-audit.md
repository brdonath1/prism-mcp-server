---
brief: 454
title: "S167 end-to-end server audit — read-only: parser tier defect root-cause, bootstrap payload composition, full src/tests/prompts/docs/CI pass (D-257 wave 1)"
parallel: false
affects:
  - .prism/audits/
complexity: large
workflow: metaswarm
---

# Brief 454 — S167 prism-mcp-server end-to-end audit (READ-ONLY)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** prism D-257 (S167) — operator-chartered end-to-end audit/optimization program, wave 1 of 4 parallel read-only repo audits.

**THE WHY (carry into your analysis lens, verbatim from the operator charter):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## Hard constraints

- **READ-ONLY audit.** You create exactly ONE new file: the report at `.prism/audits/s167-server-audit.md`. You modify NOTHING else — no src, no tests, no docs, no config. Fix specifications go in the report; implementation is a later wave.
- Record `git rev-parse HEAD` at start; it goes at the top of the report and in the PR body.
- Every finding gets an ID (SRV-01, SRV-02, ...), a class (defect | risk | inefficiency | optimization | doc-drift | dead-code), file:line evidence, why it matters against THE WHY, a recommended fix direction (not implemented), and a fix-size estimate (S/M/L).
- No INCONCLUSIVE/DEFERRED exits on any dimension below. A dimension with zero findings must say "no findings" and list exactly what was examined to conclude that.

## Dimension 1 — SEED DEFECT root-cause (mandatory, distinguishing)

Observed facts from the S167 prism bootstrap (treat as ground truth; the prism repo is NOT in your clone — use these as the fixture spec):

- prism's `.prism/standing-rules.md` ends with rule INS-316 whose title line ends with the end-anchored tag `[TIER:B]`, followed by a `## Formalized` section header and the literal sentinel `<!-- EOF: standing-rules.md -->`.
- Bootstrap delivered INS-316 in the Tier A bodies array with `tier: "A"`, and its `procedure` field contained the bled trailing content (`## Formalized` + the EOF sentinel).
- Census diagnostic: tier_a=26, tier_b_indexed=92, tier_c_indexed=21, total=139, from_standing_rules_file=134, from_insights=5 — versus the S166-expected 25/93/21/139/5. The sole delta is INS-316 classified A instead of B.

Task: read the standing-rules parsing/tiering/delivery path (start from the brief-451 / PR #71 diff — D-255 "end-anchored trailing tier tags" hardening — and follow every consumer through bootstrap assembly). Determine with file:line evidence why a last-rule-before-trailing-section/EOF with an end-anchored `[TIER:B]` is (a) delivered as Tier A and (b) has trailing non-rule content swallowed into its procedure. If the cause is NOT in the parser (e.g., it is in bootstrap-side tier bucketing or a default-on-missing-tag path), follow the code and say so — report what the code proves, not what the hypothesis predicts. Specify the fix and a repro test fixture mirroring the file-tail shape above. This is finding SRV-01.

## Dimension 2 — Bootstrap payload composition (BOOTSTRAP_OVERSIZE)

S167's prism bootstrap response was 114,752 bytes; the BOOTSTRAP_OVERSIZE diagnostic threshold is 100KB; S166 measured 115,803B. Read the bootstrap assembly code and produce a byte-attribution table per payload section (behavioral_rules template, Tier A standing-rule bodies, Tier B/C indexes, intelligence_brief, prefetched documents, handoff/critical-context fields, boot_masthead_svg, banner_text, expected_tool_surface/post_boot_tool_searches, diagnostics, everything else) — derive sizes from the code's data sources and any fixtures/tests, estimating where exact prism-shaped data is unavailable and labeling estimates as such. Identify diet candidates ranked by bytes saved x behavioral risk. Respect D-253: the brief-449 client-cap offload was partially reversed because it broke banner/rules delivery — do not re-propose mechanisms in that rejected family without addressing why D-253 reversed them.

## Dimension 3 — Full src/ correctness + reliability pass

All 25 tools and shared utils. Specifically include: error paths and retry semantics on GitHub mutations (the INS-311 transient-401 surface); `sanitizeContentField` ZWS neutralization — enumerate every call site and every path by which a legitimate markdown header in tool input gets invisibly mangled (the KI-26/R5-c hazard) with a fix specification; archival (`archive.ts` post-brief-453 auto mode) edge cases; doc-guard path handling; slug resolution; finalize commitPhase step ordering and partial-failure behavior (the INS-314 errored-turn surface); synthesis subprocess routing and its failure observability.

## Dimension 4 — Prompt audit

Every LLM-facing prompt string in the repo (synthesis intelligence-brief prompt, pending-doc-updates prompt, finalize draft prompts, cc_dispatch system prompt, model-recommendation classifier keywords, any others you find by grep). For each: token cost, instruction quality, staleness (model names, doc-structure references, dead feature references), and concrete rewrite direction. The charter explicitly targets "every prompt, rule, and command."

## Dimension 5 — Dead code / dead config

Inventory parsed-but-unused config (the trigger-marker concurrency knobs are known dead per prism D-241 — this repo's analog: anything read into config objects but never consulted), unreachable branches, vestigial feature flags (INS-229 class), unused exports. file:line each.

## Dimension 6 — Tests

Baseline `npm test` count at HEAD (expect ~1,294 — record actual). Map coverage against the defect classes found in Dimensions 1, 3 and 5; list the highest-value missing tests. Flag flaky/slow suites with timings.

## Dimension 7 — Docs + CI + env references

`docs/` currency sweep — known: `docs/banner-spec.md` stale at v3.0 with schema name `BannerTextInput` vs shipped `UnifiedBannerInput`; confirm and inventory every other stale doc claim against src. `.github/workflows/`: paths-whitelist correctness (prism INS-18), trigger-noise posture (INS-284), and the required-status-check x docs-only-PR unmergeability interaction (INS-299) — state precisely what happens to a `.prism/audits/`-only PR under the current config. Env-var REFERENCE inventory: every `process.env.X` read, where consumed, plus apparently-dead vars. Names only — NO values anywhere in the report.

## Report + verification (HARD BLOCK — evidence lands on GitHub, the only observability channel)

1. Write `.prism/audits/s167-server-audit.md`: header (HEAD SHA, date, brief id, dimension list), findings sorted by class then severity, the Dimension 2 byte table, the Dimension 4 prompt inventory, and a final prioritized top-10 with fix-size estimates.
2. PR body: HEAD SHA, executive summary (≤300 words), finding counts by class, the top-10 list, and the SRV-01 root-cause paragraph with its file:line citations inline.
3. Baseline test count from Dimension 6 in the PR body (you run tests for measurement only — change nothing).

## Push directive (exactly one)

Create branch `brief/454-s167-server-audit` off `origin/main`, commit the single report file, push, and open a PR to `main` titled `audit(s167): prism-mcp-server end-to-end findings report (brief-454, D-257 wave 1)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR. If required status checks leave a docs-only PR unmergeable, leave the PR open — the committed report plus PR body are the deliverable.

## Out of scope

- Implementing ANY fix (later waves).
- The prism repo's data/living docs (brief-707), framework templates (brief-604), trigger daemon (brief-610).
- Railway environment VALUES (chat-side; names-only references are in scope per Dimension 7).

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Fable 5 + max effort through 2026-06-21) per INS-309.
- Read-only by design: merging the report is additive and safe; auto-merge by the watcher, if checks pass, is acceptable.

<!-- EOF -->
