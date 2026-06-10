---
brief: 451
title: "Standing-rule parser hardening — end-anchored tier tags + title-suffix qualification for insights.md (INS-310)"
affects:
  - src/utils/standing-rules.ts
  - src/utils/standing-rules-union.ts
  - tests/standing-rules.test.ts
  - tests/standing-rules-union.test.ts
complexity: medium
---

# Brief 451 — Standing-rule parser hardening (INS-310 root cause)

## Context

S163 boot reported STANDING_RULES_TIERED `tier_a=25 / tier_b=92 / tier_c=20 / total=137` against the PR #23 (brdonath1/prism, manifest v2) expected `23/92/21/136`. Root cause is fully diagnosed (prism INS-310) — two parser behaviors in `src/utils/standing-rules.ts` collide with self-referential rule titles:

1. **Tier extraction is unanchored first-match.** `headerMatch[2].match(/\[TIER:([A-Z])\]/i)` captures the FIRST `[TIER:*]` occurrence in the title. prism's INS-179 title contains a backticked `` `[TIER:X]` `` literal mid-title BEFORE its real trailing `— STANDING RULE [TIER:C]` tag, so the parser captures letter `X`, warns "unknown tier letter", and defaults the rule to Tier A. The title-cleanup `.replace(/\s*\[TIER:[A-Z]\]\s*/i, '')` then strips the mid-title literal instead of the real tag, mangling the visible title.
2. **Qualification is a substring test over the whole section.** `if (/standing\s+rule/i.test(section))` makes any insights.md entry that merely MENTIONS the phrase qualify as a rule. prism's INS-308 qualifies via the quoted `'STANDING RULE'` in its own title; INS-310 (logged S163) qualifies via `'standing rule'` in its title. Both then default to Tier A (INS-308's only tier-ish token is the invalid `[TIER:X]`; INS-310's `[TIER:]` has no letter).

Net effect on the live prism corpus: A +3 / C −1 / total +2 relative to the manifest (the boot above predates INS-310; the corpus as of this brief boots 26/92/20/138).

## Required pre-flight (do these reads BEFORE writing code)

1. Read `src/utils/standing-rules.ts` and `src/utils/standing-rules-union.ts` in full, plus the call site in `src/tools/bootstrap.ts` and both test files in `affects`. Determine which layer applies qualification to `.prism/standing-rules.md` vs `.prism/insights.md`. The fix for behavior change B below must land at the layer that handles insights.md WITHOUT altering standing-rules.md semantics.
2. Fetch the LIVE fixture files from brdonath1/prism at current main and record the commit SHA in the PR body (multi-repo read currency per prism INS-283):
   ```
   gh api repos/brdonath1/prism/commits/main --jq .sha
   gh api -H "Accept: application/vnd.github.raw" repos/brdonath1/prism/contents/.prism/standing-rules.md?ref=main > /tmp/fixture-standing-rules.md
   gh api -H "Accept: application/vnd.github.raw" repos/brdonath1/prism/contents/.prism/insights.md?ref=main > /tmp/fixture-insights.md
   ```
3. Locate every consumer of the literal `STANDING RULE` outside rule qualification — in particular the insights.md ARCHIVAL protection pin (finalization/archival code). That path's semantics are OUT OF SCOPE and must not change. List the locations checked in the PR body.

## Behavior changes (spec, not prescriptive diffs — implement at the correct layer found in pre-flight)

**A. Tier extraction (both host files).** A tier tag is recognized ONLY as a trailing tag at the end of the title line: the title ends with `[TIER:A|B|C]`, optionally preceded by `— STANDING RULE`. Mid-title `[TIER:*]` occurrences (including backticked literals and invalid letters) are ignored for both tier extraction AND title cleanup. Title cleanup strips only the trailing `— STANDING RULE [TIER:X]` / trailing `[TIER:X]` form. Unknown letters in a TRAILING tag keep the existing warn-and-default-A behavior.

**B. insights.md qualification.** An insights.md section qualifies as a standing rule ONLY when its title line carries the suffix form: ends with `— STANDING RULE` optionally followed by the trailing tier tag. Mentions of the phrase elsewhere in the title or anywhere in the body must NOT qualify. Archived/dormant exclusion (D-48) is unchanged.

**C. standing-rules.md qualification UNCHANGED.** Every `### INS-N:` section in standing-rules.md counts as a rule; untagged sections default to Tier A (INS-308 ground truth). The 14 untagged KEEP-A rules must remain Tier A after this change.

**D. No other behavior changes.** Topics parsing, procedure extraction, tier selection for boot/load_rules, and archival pin semantics stay as-is.

## Tests

Add cases using the three VERBATIM title lines copied from the fetched live fixtures (do not retype them):
- INS-179 (standing-rules.md): must parse tier C; visible title must retain the mid-title backticked literal and lose only the trailing tag.
- INS-308 (insights.md): must NOT qualify as a standing rule.
- INS-310 (insights.md): must NOT qualify as a standing rule.
- A tagged insights rule (e.g. INS-304 / INS-305 lines from the fixture): must still qualify with correct tier.
- An untagged standing-rules.md section: must still qualify as Tier A.
Update any existing tests whose expectations encode the old first-match/substring behavior — module-boundary test alignment is in scope (prism INS-28). If main has pre-existing test failures unrelated to this change, record them verbatim in the PR body and do not "fix" them here (prism INS-26).

## Verification + PR evidence (REQUIRED in the PR body — this is the only observability channel)

1. `npm test` full-suite counts before and after the change.
2. A census run of the union parser against the two fetched live fixture files printing per-tier counts. Required result: `tier_a=23 / tier_b=92 / tier_c=21 / total=136`, with INS-179 listed under C, INS-308 and INS-310 absent from the qualifying set, and exactly 14 untagged standing-rules.md sections resolving to Tier A. Paste the census output and the fixture commit SHA.
3. The list of `STANDING RULE` consumers checked in pre-flight step 3 with a one-line "unchanged" note each.

## Push directive (exactly one)

Create branch `brief/451-standing-rule-parser-hardening` off `origin/main`, commit all changes, push, and open a PR to `main` titled `fix(standing-rules): end-anchored tier tags + title-suffix insights qualification (brief-451 / INS-310)` with the evidence block above in the body. Do not push to main directly. Do not open more than one PR.

## Out of scope

- Any edits to brdonath1/prism living documents (no title rewrites of INS-179/308/310).
- Archival/finalization pin logic.
- Boot payload size levers (KEEP-A trims, template slimming) — separate queued work.
