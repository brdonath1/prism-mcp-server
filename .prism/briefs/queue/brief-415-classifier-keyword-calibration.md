# Brief 415 — Classifier keyword calibration (re-queue of brief-413)

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-mcp-server
**Origin:** PRISM session S109 (2026-05-01) — calibration audit of `src/utils/session-classifier.ts` against last 12 sessions of observed character.
**Reference decision:** D-191 (token-reduction strategy, classifier is Phase 1's core lever) and D-193 (banner discrepancy fix; this is the deferred Piece-3-adjacent calibration follow-up, distinct from per-task tagging).
**Re-queue note:** Originally pushed as brief-413 at 2026-05-01T18:30Z. Daemon picked up at 19:14Z and ran for ~12 min before being abandoned by an operator-initiated daemon restart (during brief-600 work on the trigger repo). Per INS-191, the daemon's `knownBriefIds` cache treats abandoned IDs as already-processed, so brief-413 cannot be re-dispatched under that ID. Re-queued as brief-415 with identical scope. Once D-196 Pieces 1+2 ship via [trigger PR #38](https://github.com/brdonath1/trigger/pull/38), the pane-liveness check will recover this class of mid-execution interruption automatically.

## Context

The keyword-based session classifier (`classifySession` in `src/utils/session-classifier.ts`, shipped via brief-405 / D-191 Phase 1) ran cleanly through S106→S109 boots. S108→S109 was the first session to use the persisted-recommendation pipeline (brief-411 / D-193 Piece 1) end-to-end. The S109 boot recommendation matched the actual character of S109's queued work (`mixed → Opus 4.7 · Adaptive off`) — but **the verdict was reached via the empty-input default branch**, not via genuine keyword scoring. Both `reasoning_heavy` and `executional` scores were 0 against the 6-item `next_steps` array.

Manual audit of the keyword lists against the past 12 sessions (S97–S108 plus S109) surfaced a small set of high-impact calibration misses. Most relate to a single root cause: the `\b{keyword}\b` word-boundary regex matches verb forms but misses the noun derivatives that PRISM `next_steps` overwhelmingly use. The other findings are isolated keyword-list gaps and one over-restrictive conditional.

This brief implements the calibration. It is **NOT** a structural change to the classifier — the scoring pipeline, ratio thresholds, category mapping, decision rule, and recommendation block format all remain as-is. Only the keyword lists, the conditional-keyword qualifier list, and one regex shape change.

## Findings (audit evidence)

The audit traced each finding to a specific class of false negative observed in real `next_steps` text from `brdonath1/prism:.prism/handoff.md` and `.prism/session-log.md` covering S97–S108. Inputs reconstructed from the session-log "Focus" + "Key outcomes" framing plus the corresponding handoff `## Resumption Point` content where retrievable.

**F1 — Word-boundary regex misses noun derivatives.** Highest-impact finding by frequency. The current `\bverify\b` matches "verify" but NOT "verification". Likewise `\barchitect\b` does NOT match "architectural" (because `t` to `u` is word-character to word-character — no boundary). The same pattern affects `analyze`/`analysis`, `propose`/`proposal`, `evaluate`/`evaluation`, `compare`/`comparison`, `investigate`/`investigation`, `debug`/`debugging`. Reading PRISM next_steps shows the noun forms appear roughly 3–5x more often than the verb forms (e.g., "boot verification gates", "architectural fix", "diagnosis chain", "synthesis cost analysis" — all noun-form, all currently 0-hit).

The fix is NOT to add every derivative as a separate keyword — that's brittle and the list balloons. The fix is to relax the regex to match the keyword as a prefix that can be followed by common English suffixes, OR to add an explicit `STEM_KEYWORDS` list that uses prefix-match semantics distinct from `WHOLE_WORD_KEYWORDS`. Recommended: prefix-match list (clearer semantics, no regex magic).

**F2 — `audit` conditional is over-restrictive.** Currently fires only when paired with "report" or "findings". PRISM next_steps regularly use phrasings like "audit the keyword lists", "audit Tier A standing rules" (S107), "audit Orchestrator for non-cancellable calls" (S59 parking-lot), none of which carry those qualifiers. The actual pattern: when `audit` is followed by an object noun (a list, a file, a system), the work is reasoning-heavy. The current qualifier list is a documentation-style filter, not a work-character filter.

Fix: extend `requiresAny` to include broader reasoning-work qualifiers ("list", "lists", "rules", "keywords", "code", "system", "behavior"), OR drop the conditional entirely and add `audit` to the unconditional reasoning list. Recommended: expand `requiresAny`. Dropping the conditional risks false positives like "audit log file" or "audit trail" (executional contexts where `audit` is a noun).

**F3 — Missing reasoning keywords.** `scope` recurs in S106/S108/S109 next_steps and resumption-point text ("scope D-193 Piece 3 brief", "re-scope after observation", "audit-harness scoping brief") — always reasoning work, currently 0-hit. Add `scope` to `REASONING_KEYWORDS`.

`diagnose`/`diagnosis` appears in S98/S102 narratives — pure reasoning work (root-cause investigation). Currently no match — `debug` is the closest existing keyword but doesn't catch this. Add `diagnose` (with prefix-match per F1, this also catches `diagnosis`, `diagnosing`).

**F4 — `verify` is not the calibration problem the carry-over note assumed.** The S108 carry-over flagged `verify` for "tighten or qualify". The actual data: `verify` rarely matches at all because PRISM next_steps overwhelmingly use "verification". When `verify` DOES match, it's typically in a context that's substantively reasoning-heavy (e.g., "verify D-187 boot gate" → triggered the S102 viper-static-config diagnosis). Lowering its weight or making it conditional would be wrong: the better fix is F1 (prefix-match makes "verification" match too) and accepting that verification work is genuinely mixed-character. No action on `verify` itself.

**F5 — Missing executional keywords.** Common verbs in PRISM execution-phase next_steps but absent from the list: `dispatch`, `merge`, `delete`, `redeploy`, `pin`, `wire`, `migrate`, `close`. Each of these denotes a deterministic action with a clear success criterion — the canonical signal of executional work. `restart` is already conditional; it should remain conditional (the qualifier "daemon"/"trigger"/"service" correctly distinguishes operational restart from `restart the conversation`).

`bump` is already in the list — keep. `archive` is already conditional — keep with current qualifiers.

**F6 — `follow-up on` phrase is too narrow and the wrong polarity.** Currently flagged as a reasoning phrase. Audit shows "follow-up" in PRISM next_steps is roughly evenly split between reasoning (deciding what to do next) and executional (closing out a known item). Variants like "follow-on work", "carry-over", "follow-up to" wouldn't match the literal substring anyway. Recommended: remove `follow-up on` from `REASONING_PHRASES`. It's adding noise without consistent signal.

**F7 — `opening_message` 2x-weight code path is dead post-D-193.** `classifySession` still has the conditional that doubles `opening_message` scores. Per brief-411, finalize never passes `opening_message` and bootstrap's back-compat fallback also passes only `next_steps`. The 2x weight is dead code. Not a bug — but it's misleading for future readers and a calibration audit is the natural moment to remove it. Drop the entire `if (input.opening_message)` block. The `ClassifySessionInput` interface should also drop `opening_message?` (and `critical_context?` while we're there, for the same reason — D-193 Piece 1 made both inputs unreachable).

## Required Changes

### Part A — Calibrate keyword lists in `src/utils/session-classifier.ts`

#### A.1. Introduce prefix-match keyword list (F1)

Replace the current `REASONING_KEYWORDS` and `EXECUTIONAL_KEYWORDS` constants with split lists:

```typescript
// Keywords matched as whole words via word-boundary regex.
// Use this list for short keywords where prefix-match would over-fire
// (e.g. "log" should not match "login" or "logical").
const REASONING_WHOLE_WORD = [
  "brainstorm",
  "tradeoff",
  "strategy",
] as const;

// Keywords matched as prefix-then-letters. Catches noun/gerund/adjective
// derivatives without listing each one separately. Pattern: \b{kw}[a-z]*\b
// Examples: "verify" matches "verify", "verifies", "verification", "verifying".
const REASONING_PREFIX = [
  "architect",   // catches architecture, architectural
  "investigat",  // catches investigate, investigation, investigating
  "debug",       // catches debug, debugging, debugger
  "evaluat",     // catches evaluate, evaluation, evaluating
  "analyz",      // catches analyze, analysis, analyzing (note: drops the e)
  "propos",      // catches propose, proposal, proposing
  "compar",      // catches compare, comparison, comparing
  "design",      // catches design, designing (whole-word safe — design[a-z]* does not over-fire on "designate" given audit data)
  "scope",       // F3 — new; catches scope, scoping, rescoping
  "diagnos",     // F3 — new; catches diagnose, diagnosis, diagnosing, diagnostic
] as const;

const EXECUTIONAL_WHOLE_WORD = [
  "log",
  "sync",
  "bump",
  "pin",     // F5 — new
  "wire",    // F5 — new
] as const;

const EXECUTIONAL_PREFIX = [
  "cleanup",
  "renam",      // catches rename, renaming
  "patch",
  "push",
  "backfill",
  "appl",       // catches apply, applies, applying, application — see note below
  "verif",      // F4 — catches verify, verifies, verification, verifying
  "demot",      // catches demote, demotion, demoting
  "consolidat", // catches consolidate, consolidation, consolidating
  "updat",      // catches update, updating
  "enroll",
  "dispatch",   // F5 — new
  "merg",       // F5 — new; catches merge, merging, merged
  "delet",      // F5 — new; catches delete, deleting, deletion
  "redeploy",   // F5 — new
  "migrat",     // F5 — new; catches migrate, migration, migrating
  "clos",       // F5 — new; catches close, closing, closure (note: also "clothes" — but that doesn't appear in PRISM next_steps)
] as const;
```

**Implementation detail:** `appl` as prefix is risky — it catches "apply" but also "application" and "applies". Audit shows PRISM next_steps that mention "application" are typically followed by an object that's executional in spirit ("apply pending-doc-updates", "applying the proposals"), so the prefix is acceptable. Document this in the comment.

The matching function changes accordingly:

```typescript
function countHits(
  text: string,
  wholeWord: ReadonlyArray<string>,
  prefix: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;

  for (const phrase of phrases) {
    let idx = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      hits++;
      idx += phrase.length;
    }
  }

  for (const kw of wholeWord) {
    const re = new RegExp(`\\b${escapeForRegex(kw)}\\b`, "g");
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }

  for (const kw of prefix) {
    // \b{prefix}[a-z]*\b — prefix followed by zero+ letters then word boundary.
    const re = new RegExp(`\\b${escapeForRegex(kw)}[a-z]*\\b`, "g");
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }

  return hits;
}
```

Update `scoreItem` to call `countHits` with both lists for each bucket. Drop the old `REASONING_KEYWORDS` / `EXECUTIONAL_KEYWORDS` constants.

#### A.2. Expand `audit` conditional qualifier list (F2)

```typescript
const CONDITIONAL_KEYWORDS: ConditionalKeyword[] = [
  {
    keyword: "audit",
    requiresAny: [
      "report", "findings",   // existing
      "list", "lists", "rules", "keywords",   // F2 new — meta-work qualifiers
      "code", "system", "behavior", "session", "sessions",  // F2 new — investigation qualifiers
    ],
    bucket: "reasoning",
  },
  { keyword: "archive", requiresAny: ["content", "session", "insights", "log"], bucket: "executional" },
  { keyword: "restart", requiresAny: ["daemon", "trigger", "service"], bucket: "executional" },
];
```

The conditional check `lower.includes(q.toLowerCase())` is already string-includes — these new qualifiers don't need word-boundary precision because the conditional is already gated on the `\baudit\b` whole-word match.

#### A.3. Drop `follow-up on` phrase (F6)

```typescript
const REASONING_PHRASES = [
  "decide whether",
  // "follow-up on" removed S109 — no consistent signal in audit.
] as const;
```

Empty arrays are fine; the iteration loop in `countHits` will simply not contribute.

#### A.4. Remove dead-code paths (F7)

In `classifySession`:

```typescript
export interface ClassifySessionInput {
  next_steps: string[];
  // critical_context and opening_message removed — D-193 Piece 1 made both
  // inputs unreachable from finalize and bootstrap. Restoring them would
  // re-introduce the S107→S108 banner-discrepancy class of bug.
}

export function classifySession(input: ClassifySessionInput): SessionRecommendation {
  let reasoningScore = 0;
  let executionalScore = 0;

  for (const step of input.next_steps ?? []) {
    const s = scoreItem(step);
    reasoningScore += s.reasoning;
    executionalScore += s.executional;
  }

  // (drop the for-of over critical_context — interface no longer permits it)
  // (drop the if (input.opening_message) 2x-weight block — interface no longer permits it)

  const ratio = reasoningScore / Math.max(executionalScore, 1);
  // ... existing decision rule unchanged.
}
```

Audit all callers to confirm no caller passes either field. If any test fixture passes them, update the fixture (the fields are now interface errors, surfaced at compile time).

### Part B — Tests

#### B.1. New unit tests in `src/utils/session-classifier.test.ts` (or sibling)

Add a test group `keyword calibration (S109 / brief-415)`:

- **F1 prefix-match correctness.** For each prefix-list entry, write one test with each common derivative form. Examples:
  - `verify` matches; `verification` matches; `verifies` matches; `verified` matches; `verifying` matches.
  - `architect` matches; `architecture` matches; `architectural` matches.
  - `analyze` matches; `analysis` matches; `analyzing` matches.
  Cover at least one whole-word vs prefix-list collision check: ensure `log` (whole-word) does NOT match `login` (per existing intent), but `merg` (prefix) DOES match `merging`.
- **F1 negative cases.** `verifyable` should NOT match if the audit deems it a false positive (it's borderline) — your call, document the choice. `merger` should match `merg` per the prefix design.
- **F2 expanded `audit` conditional.** Test "audit the keyword lists" → matches reasoning. Test "audit log file" → does NOT match (no qualifier — confirms expanded list doesn't blanket-fire). Test each new qualifier ("list", "rules", "code", "system", "behavior", "session") with one positive case each.
- **F3 new keywords.** Test "scope the brief" → reasoning. Test "diagnose the regression" → reasoning. Test "diagnostic chain" → reasoning (catches the noun derivative via prefix-match).
- **F5 new executional keywords.** Test "dispatch the brief" → executional. Test "merge the PR" → executional. Test "delete the env var" → executional. Test "migrate the layout" → executional. Test "close the issue" → executional.
- **F6 phrase removal.** Test that "follow-up on the verification" no longer fires the reasoning-phrase counter (it should still hit `verify` prefix-match, so the verdict from this single phrase is ambiguous — the test asserts the phrase-counter contribution specifically).
- **F7 interface change.** TypeScript compile errors on attempts to pass `critical_context` or `opening_message` are sufficient — no runtime test needed, but include one test that constructs `ClassifySessionInput` from a real S108→S109 next_steps sample and asserts the verdict is `mixed` (this becomes the regression guard for the calibration as a whole).

#### B.2. Update existing tests

Any existing test fixture that passes `critical_context` or `opening_message` to `classifySession` must be updated to drop those fields. The expected verdicts may shift — re-baseline against actual classification output post-calibration. Document any verdict changes inline in the test description so the diff makes the calibration impact visible.

#### B.3. Regression guard against historical sessions

Add a fixture-driven test that scores 5 representative `next_steps` arrays from the historical record (one each for `reasoning_heavy`, `executional`, and 3 `mixed`-character sessions). Use `next_steps` text reconstructed from `.prism/handoff.md` history or `.prism/session-log.md` resumption-point quotes. Assert that the post-calibration verdict matches the actual session character. Sessions to use:

- S98 next_steps → expected `reasoning_heavy` (forensic root-cause work, INS-225 logged).
- S104 next_steps → expected `executional` (trigger-channel.md authoring + enrollment audit; both deterministic application).
- S101 next_steps → expected `mixed` (boot verification + 17-branch sweep, plus emergency D-187 pin).
- S106 next_steps → expected `reasoning_heavy` (D-191 five-phase strategy, brainstorming session).
- S109 next_steps → expected `mixed` (verification gates + scoping decision + audit).

Source the actual `next_steps` text from `brdonath1/prism:.prism/handoff.md` history. If retrieving historical handoffs is impractical at test-authoring time, hand-curate the fixture inline with a comment citing the session-log.md resumption-point text the fixture is reconstructing from.

### Part C — Server version bump

Bump `SERVER_VERSION` in `src/config.ts` from `"4.2.0"` to `"4.3.0"` with a comment block describing brief-415 (classifier keyword calibration, originally drafted as brief-413).

## Verification Steps

1. `npm run lint` clean.
2. `npm run build` clean.
3. `npm test` — all existing tests pass with any necessary fixture updates per B.2; new tests per B.1 and B.3 pass.
4. PR description must explicitly note:
   - "Prefix-match catches noun derivatives (verification, architecture, etc.) — fixes F1 (highest-impact miss)."
   - "Drops dead-code 2x weight on opening_message and unreachable critical_context input — D-193 Piece 1 already made both unreachable."
   - "Expands `audit` conditional qualifiers to reach the meta-work cases that prompted this calibration."
5. After merge: Railway deploy. The S110 boot will be the first live verification surface — boot banner's `Suggested:` line will reflect post-calibration scoring on the persisted block written by S109's finalize. (Persisted block is written at finalize time using the same shared `classifySession` function, so the calibration takes effect at finalize, not bootstrap.) Operator reconnect of MCP connector required per INS-227 only if behavioral_rules cache needs flushing — not strictly necessary for this brief since no surface-level tool changes ship.

## Out of Scope

- D-193 Piece 3 (per-task `[mechanical]`/`[mixed]`/`[reasoning]` tagging in task-queue.md and next_steps). This brief is a pure-keyword calibration; tagging is a structural classifier change and remains gated on observation evidence per D-194 (S109).
- Tightening or removing `verify` / `verif` per F4. Audit data does not support that change; flagged for explicit discard, not action.
- Replacing the keyword-matching approach with an LLM-based classifier. The deterministic keyword classifier is intentionally cheap, deterministic, and inspectable; the calibration this brief ships is a refinement, not a replacement.
- Dropping the `scores` field from `SessionRecommendation`. It's still useful for diagnostics even though `parsePersistedRecommendation` returns `0/0` for it. Keep.

## Failure Modes to Avoid

- Do NOT add `critical_context` or `opening_message` back to the `ClassifySessionInput` interface, even with comment-tagged "preserved for back-compat". The whole point of D-193 Piece 1 is that those inputs are gone from the classifier's contract. Future readers should hit a compile error if they try.
- Do NOT use prefix-match for `log` — it would over-fire on "login", "logging", "logical", "logger", "logout". Keep `log` in the whole-word list.
- Do NOT silently drop the `follow-up on` phrase removal from the PR description. The audit reasoning matters for future reference — F6 is the kind of finding that gets re-discovered if the rationale isn't in the commit history.
- Do NOT bundle this with D-193 Piece 3 (per-task tagging) even though both touch the classifier. Tagging is a structural change with operator-burden implications and remains gated. This brief is calibration-only.
- Do NOT introduce a separate `recommendation-parser.ts` file for this brief. The parser already lives in `session-classifier.ts` per brief-411 — keep it co-located.

<!-- EOF: brief-415-classifier-keyword-calibration.md -->
