# PR 1 Brief — Server Tier-Tag Parsing for Standing Rules

> **Authored:** Session 66 (04-26-26)
> **Parent design:** D-156 (S66) + brief at `.prism/briefs/s66-phase2-brief.md`
> **Target repo:** `brdonath1/prism-mcp-server`
> **Branch:** `feat/standing-rule-tiers`
> **Dispatch path:** Local Claude Code per INS-163. Multi-file refactor + new test file. Operator at keyboard for visibility.
> **Push directive:** Push the feature branch to `origin` and open a PR titled "Phase 2 PR 1 — standing-rule tier-tag parsing". **Do NOT merge** — operator review required before PR 2 can land.

---

## 0. Mission Summary

Add tier-tag parsing infrastructure to `extractStandingRules` and the bootstrap handler so that `### INS-N: Title — STANDING RULE [TIER:A|B|C]` headers are recognized and selectively delivered. **Back-compat is mandatory: this PR must not change observable behavior in production until PR 2 (insights migration) lands.** Every existing rule has no tier tag yet, so the parser must default to Tier A, and Tier A always loads — current bootstrap output stays identical.

The selection logic, topic keyword map, and `topicMatch` helper all land in this PR even though they have no behavioral effect today. PR 2 flips the behavior by adding tags to `.prism/insights.md` in the `prism` repo.

---

## 1. Pre-Flight

Read the following files BEFORE making any changes. Quote the exact line numbers in your Pre-Flight summary so verification later confirms you read them.

1. `/src/tools/bootstrap.ts` — full file. Pay attention to:
   - Lines 75–123: `StandingRule` interface + `extractStandingRules` function
   - Lines 37–40: input schema (`opening_message` is the parameter you'll consume)
   - Lines 44–55: `determinePrefetchFiles` (precedent for keyword-driven selection)
   - Lines 451–459: handler call site for `extractStandingRules`
   - Lines 532–538: response composition for the tokens-estimation JSON (where `standing_rules: standingRules` appears)
   - Lines 555–563: response `result` object where `standing_rules` is exposed
   - Lines 591–595: `componentSizes` log object including the `standing_rules` size
2. `/src/config.ts` — full file. Pay attention to:
   - The `PREFETCH_KEYWORDS` constant (`Record<string, string>`) — your new constant follows the same shape but with a `Record<string, string[]>` signature.
3. `/tests/bootstrap-parsing.test.ts` — full file. This is your test-pattern reference.
4. `/tests/bootstrap-budget.test.ts` — first 100 lines for additional test patterns.
5. `/src/utils/diagnostics.ts` — locate the methods on `DiagnosticsCollector` (`info`, `warn`, etc.) so you know how to emit the new diagnostic fields.

Verify the existing test suite passes BEFORE starting changes:

```bash
npm install
npm test 2>&1 | tail -30
```

Expected baseline: 716 tests pass + 1 pre-existing acceptable failure (`cc-status.test.ts > lists recent dispatches` — known env-stub bug per INS-26 / S64 record). Any other failure means something is wrong with the local environment — stop and report before proceeding.

Capture the test count from the baseline run. Your post-change verification (§4.6) compares against this exact number.

---

## 2. Changes

All edits are additive or back-compat-safe modifications. No deletions.

### 2.1 `src/config.ts` — add `STANDING_RULE_TOPIC_KEYWORDS`

Append a new exported constant immediately AFTER the existing `PREFETCH_KEYWORDS` block (so it groups with related boot-time keyword maps). Use this exact shape and content:

```ts
/**
 * Topic keyword map for Tier B standing-rule selection at bootstrap (D-156 / Phase 2 PR 1).
 *
 * Each topic maps to a list of keywords that, when present in the opening_message
 * (case-insensitive substring match), triggers inclusion of Tier B standing rules
 * tagged with that topic. Tier A rules always load; Tier C rules never load at boot.
 *
 * Schema: `Record<topic, string[]>`. Topics are stable identifiers used in insights.md
 * `<!-- topics: foo, bar -->` comment lines.
 */
export const STANDING_RULE_TOPIC_KEYWORDS: Record<string, string[]> = {
  cc_dispatch: ["cc_dispatch", "dispatch", "claude code", "cc brief", "pr ", "pull request", "merge"],
  mcp_server: ["mcp server", "prism-mcp-server", "deploy", "railway", "tool change", "tool surface"],
  trigger: ["trigger", "daemon", "marker file", "brief_dir", "trigger.config"],
  prism_push: ["prism_push", "prism_patch", "living doc", "artifact push"],
  auth: ["oauth", "api key", "keychain", "anthropic_api_key", "claude_code_oauth_token"],
  ci_workflow: [".github/workflows", "workflow", "actions", " ci "],
};
```

Notes:
- The space-padded `"pr "` and `" ci "` are intentional — they prevent `pr` matching `prepare`/`approach` and `ci` matching `circle`/`recipe`. Other keywords are distinctive enough not to need padding.
- All keywords MUST be lowercase. Matching is done after `openingMessage.toLowerCase()`.
- This map is the single source of truth for topic-to-keyword mapping. PR 4 (`prism_load_rules`) will reuse the topic IDs as the user-facing parameter, so do not rename topics without coordinating across PRs.

### 2.2 `src/tools/bootstrap.ts` — extend `StandingRule` interface

Replace the existing interface (lines 75–80) with the extended version. Use `str_replace`-style precision; match the existing JSDoc comment too.

**Before:**
```ts
/** Standing rule extracted from insights — procedure-only (D-47) */
export interface StandingRule {
  id: string;
  title: string;
  procedure: string; // D-47: procedure-only, not full content
}
```

**After:**
```ts
/** Standing rule extracted from insights — procedure-only (D-47), tier-aware (D-156) */
export interface StandingRule {
  id: string;
  title: string;
  procedure: string; // D-47: procedure-only, not full content
  tier: "A" | "B" | "C"; // D-156: A=always-load, B=topic-load, C=reference-only. Default A when tag absent (back-compat).
  topics: string[];      // D-156: topics this rule applies to. Empty array when not specified. Used for Tier B selection.
}
```

### 2.3 `src/tools/bootstrap.ts` — modify `extractStandingRules` (lines 87–123)

Replace the function body to parse the optional `[TIER:X]` tag from the section header AND the optional `<!-- topics: ... -->` comment from the section body.

**Required behavior:**
- Header regex must match BOTH the legacy form `### INS-N: Title — STANDING RULE` and the new form `### INS-N: Title — STANDING RULE [TIER:A]` (and `[TIER:B]`, `[TIER:C]`).
- When `[TIER:X]` is absent, `tier` defaults to `"A"`.
- When `[TIER:X]` is present with an unknown letter (anything other than A, B, C), log a warning via the existing `logger` and default to `"A"`. Do not throw — robustness matters at the parsing layer.
- The `title` string must NOT include the `[TIER:X]` token. Strip it the same way the existing code strips `— STANDING RULE`.
- Topics are parsed from a `<!-- topics: foo, bar, baz -->` comment line ANYWHERE in the section body. Multiple topics comma-separated. Whitespace tolerant. When the comment is absent, `topics` is an empty array.
- All other existing behavior (D-47 procedure-only extraction, D-48 archived/dormant exclusion) stays exactly as it is.

**Reference implementation:**

```ts
export function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    // D-48: Skip archived or dormant entries
    if (/archived\s+(standing\s+)?rule/i.test(section) || /dormant\s+(standing\s+)?rule/i.test(section)) {
      continue;
    }

    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        // D-47: Extract procedure-only — find "Standing procedure:" and take everything after
        let procedure = '';
        const procStart = section.search(/\*\*Standing procedure:\*\*/i);
        if (procStart !== -1) {
          procedure = section.slice(procStart)
            .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
            .trim();
        }

        // D-156: Parse tier tag from header (defaults to "A" when absent)
        let tier: "A" | "B" | "C" = "A";
        const tierMatch = headerMatch[2].match(/\[TIER:([A-Z])\]/i);
        if (tierMatch) {
          const letter = tierMatch[1].toUpperCase();
          if (letter === "A" || letter === "B" || letter === "C") {
            tier = letter;
          } else {
            logger.warn("standing rule has unknown tier letter; defaulting to A", { id: headerMatch[1], tierLetter: letter });
          }
        }

        // D-156: Strip both — STANDING RULE and [TIER:X] from the visible title
        const title = headerMatch[2]
          .replace(/\s*\[TIER:[A-Z]\]\s*/i, '')
          .replace(/\s*—\s*STANDING RULE\s*/gi, '')
          .trim();

        // D-156: Parse topics from <!-- topics: foo, bar --> comment in section body
        let topics: string[] = [];
        const topicsMatch = section.match(/<!--\s*topics:\s*([^-]+?)\s*-->/i);
        if (topicsMatch) {
          topics = topicsMatch[1]
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
        }

        rules.push({
          id: headerMatch[1],
          title,
          procedure,
          tier,
          topics,
        });
      }
    }
  }

  return rules;
}
```

**Notes for verification:**
- The title-strip uses `gi` flag on the `— STANDING RULE` replacement (not just `i`) so that doubled tags (the existing INS-34/35/167/171 cosmetic bug) are both removed. PR 2 will physically remove the doubled tags from insights.md, but PR 1's parser must tolerate them.
- The topics regex `[^-]+?` is non-greedy and excludes `-` characters from the captured group, which prevents accidental over-capture across the comment-end `-->`. The trade-off: topic identifiers cannot contain `-`. This is fine for the topics defined in §2.1 (all underscores). If a future topic needs hyphens, the regex must be revised.

### 2.4 `src/tools/bootstrap.ts` — add `topicMatch` helper

Add immediately AFTER `extractStandingRules`:

```ts
/**
 * Match a standing rule's topics against an opening message via STANDING_RULE_TOPIC_KEYWORDS (D-156).
 * Returns true if any topic on the rule has at least one keyword present in the opening message
 * (case-insensitive substring match). Returns false when openingMessage is empty/undefined or
 * the rule has no topics.
 */
export function topicMatch(openingMessage: string | undefined, ruleTopics: string[]): boolean {
  if (!openingMessage || ruleTopics.length === 0) return false;
  const lower = openingMessage.toLowerCase();
  for (const topic of ruleTopics) {
    const keywords = STANDING_RULE_TOPIC_KEYWORDS[topic];
    if (!keywords) continue; // Unknown topic on the rule — no match (and worth a future cleanup signal)
    for (const kw of keywords) {
      if (lower.includes(kw)) return true;
    }
  }
  return false;
}
```

Add `STANDING_RULE_TOPIC_KEYWORDS` to the import line at the top of the file (line 21):

**Before:**
```ts
import { CC_DISPATCH_ENABLED, DOC_ROOT, FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, RAILWAY_ENABLED, resolveProjectSlug } from "../config.js";
```

**After:**
```ts
import { CC_DISPATCH_ENABLED, DOC_ROOT, FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, RAILWAY_ENABLED, STANDING_RULE_TOPIC_KEYWORDS, resolveProjectSlug } from "../config.js";
```

### 2.5 `src/tools/bootstrap.ts` — add `selectStandingRulesForBoot`

Add immediately AFTER `topicMatch`:

```ts
/**
 * Select which standing rules to deliver at bootstrap based on tier (D-156).
 *
 * Selection rules:
 * - Tier A: always include (behavioral judgment rules effective across every session)
 * - Tier B: include if topicMatch returns true (rule's topics overlap with opening_message keywords)
 * - Tier C: never include at bootstrap (reference-only; available via prism_load_rules in PR 4)
 *
 * Returns a new array — does not mutate the input. Order is preserved from the input.
 */
export function selectStandingRulesForBoot(
  rules: StandingRule[],
  openingMessage: string | undefined,
): StandingRule[] {
  return rules.filter(rule => {
    if (rule.tier === "A") return true;
    if (rule.tier === "B") return topicMatch(openingMessage, rule.topics);
    return false; // tier C
  });
}
```

### 2.6 `src/tools/bootstrap.ts` — wire selection into the handler

Replace the existing line 456 region. Note: the rule that PRE-EXISTS this PR is exactly:

```ts
        const standingRules = extractStandingRules(insightsContent);
        if (standingRules.length > 0) {
          logger.info("standing rules extracted", { count: standingRules.length, ids: standingRules.map(r => r.id) });
        }
```

Replace it with:

```ts
        const allStandingRules = extractStandingRules(insightsContent);
        const standingRules = selectStandingRulesForBoot(allStandingRules, opening_message);

        // D-156: Tier accounting for diagnostics + log
        const tierA = allStandingRules.filter(r => r.tier === "A");
        const tierB = allStandingRules.filter(r => r.tier === "B");
        const tierC = allStandingRules.filter(r => r.tier === "C");
        const tierBSelected = standingRules.filter(r => r.tier === "B");
        const tierBExcluded = tierB.length - tierBSelected.length;
        const topicsMatched = Array.from(new Set(tierBSelected.flatMap(r => r.topics)));

        if (allStandingRules.length > 0) {
          logger.info("standing rules extracted", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_loaded: tierBSelected.length,
            tier_b_excluded: tierBExcluded,
            tier_c_excluded: tierC.length,
            topics_matched: topicsMatched,
            ids: standingRules.map(r => r.id),
          });
        }

        // D-156: Diagnostics field surfacing tier accounting
        diagnostics.info("STANDING_RULES_TIERED", "Standing rules selected by tier", {
          total: allStandingRules.length,
          delivered: standingRules.length,
          tier_a: tierA.length,
          tier_b_loaded: tierBSelected.length,
          tier_b_excluded: tierBExcluded,
          tier_c_excluded: tierC.length,
          topics_matched: topicsMatched,
        });
```

**Important:** The `diagnostics.info` call requires that `DiagnosticsCollector` actually has an `info` method. If your Pre-Flight read of `src/utils/diagnostics.ts` shows that the class only exposes `warn` (not `info`), substitute `diagnostics.warn` and use code `STANDING_RULES_TIERED` with a non-warning-level message — OR add an `info` method matching the pattern of existing ones. Check before assuming.

The `standingRules` variable downstream (lines 535, 561) keeps the same name and now refers to the filtered set. No further wiring changes are needed in the response composition because the existing code already uses `standingRules`.

### 2.7 `tests/bootstrap-parsing.test.ts` — add tier parsing tests

Append new `describe` blocks at the end of the existing file (before the final `});` if there is one). Use the established vitest patterns (`describe/it/expect`) already in the file. Do not modify or remove existing tests.

```ts
describe("standing rule tier parsing", () => {
  it("defaults to tier A when no [TIER:X] tag is present (back-compat)", () => {
    const content = `### INS-99: Test rule — STANDING RULE
- Discovered: Session 1
- Description: A test rule.
**Standing procedure:**
1. Do something.
`;
    const rules = extractStandingRules(content);
    expect(rules).toHaveLength(1);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].topics).toEqual([]);
  });

  it("parses [TIER:A] explicitly", () => {
    const content = `### INS-100: Tier A rule — STANDING RULE [TIER:A]
**Standing procedure:** do A.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("A");
    expect(rules[0].title).toBe("Tier A rule");
  });

  it("parses [TIER:B]", () => {
    const content = `### INS-101: Tier B rule — STANDING RULE [TIER:B]
<!-- topics: cc_dispatch -->
**Standing procedure:** do B.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("B");
    expect(rules[0].topics).toEqual(["cc_dispatch"]);
  });

  it("parses [TIER:C]", () => {
    const content = `### INS-102: Tier C rule — STANDING RULE [TIER:C]
<!-- topics: trigger, auth -->
**Standing procedure:** do C.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("C");
    expect(rules[0].topics).toEqual(["trigger", "auth"]);
  });

  it("strips [TIER:X] from the visible title", () => {
    const content = `### INS-103: Title here — STANDING RULE [TIER:B]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].title).toBe("Title here");
  });

  it("strips a doubled — STANDING RULE tag from the title (cosmetic-bug tolerance)", () => {
    const content = `### INS-104: Title — STANDING RULE — STANDING RULE
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].title).toBe("Title");
  });

  it("defaults to tier A on unknown tier letter (e.g., [TIER:Z])", () => {
    const content = `### INS-105: Bad tier — STANDING RULE [TIER:Z]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].tier).toBe("A");
  });

  it("returns empty topics array when no <!-- topics: --> comment present", () => {
    const content = `### INS-106: No topics — STANDING RULE [TIER:B]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules[0].topics).toEqual([]);
  });

  it("preserves D-48 archived/dormant exclusion", () => {
    const content = `### INS-107: Archived — ARCHIVED STANDING RULE [TIER:A]
**Standing procedure:** ok.
`;
    const rules = extractStandingRules(content);
    expect(rules).toHaveLength(0);
  });
});
```

### 2.8 `tests/standing-rule-tiers.test.ts` (new) — selection logic tests

Create a new file. Use this exact content:

```ts
// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { selectStandingRulesForBoot, topicMatch, type StandingRule } from "../src/tools/bootstrap.js";
import { STANDING_RULE_TOPIC_KEYWORDS } from "../src/config.js";

const tierA = (id: string): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "A", topics: [] });
const tierB = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "B", topics });
const tierC = (id: string, topics: string[]): StandingRule => ({ id, title: `t${id}`, procedure: "p", tier: "C", topics });

describe("topicMatch", () => {
  it("returns false when openingMessage is undefined", () => {
    expect(topicMatch(undefined, ["cc_dispatch"])).toBe(false);
  });

  it("returns false when openingMessage is empty string", () => {
    expect(topicMatch("", ["cc_dispatch"])).toBe(false);
  });

  it("returns false when ruleTopics is empty array", () => {
    expect(topicMatch("let me dispatch a CC brief", [])).toBe(false);
  });

  it("returns true when an opening message keyword matches a rule topic's keyword (case-insensitive)", () => {
    expect(topicMatch("Let me DISPATCH a CC brief", ["cc_dispatch"])).toBe(true);
  });

  it("returns true when any one of multiple rule topics matches", () => {
    expect(topicMatch("checking the trigger daemon", ["cc_dispatch", "trigger"])).toBe(true);
  });

  it("returns false when no rule topic's keywords appear in the opening message", () => {
    expect(topicMatch("just a friendly hello", ["cc_dispatch"])).toBe(false);
  });

  it("ignores unknown topic strings on the rule (no match, no throw)", () => {
    expect(topicMatch("any text", ["nonexistent_topic"])).toBe(false);
  });
});

describe("selectStandingRulesForBoot", () => {
  it("includes all Tier A rules unconditionally", () => {
    const rules = [tierA("INS-1"), tierA("INS-2")];
    expect(selectStandingRulesForBoot(rules, undefined)).toHaveLength(2);
    expect(selectStandingRulesForBoot(rules, "")).toHaveLength(2);
    expect(selectStandingRulesForBoot(rules, "anything")).toHaveLength(2);
  });

  it("excludes Tier B rules when openingMessage is undefined", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, undefined);
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("includes Tier B rules when topic keywords match the opening message", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"]), tierB("INS-3", ["trigger"])];
    const out = selectStandingRulesForBoot(rules, "let me dispatch a CC brief");
    expect(out.map(r => r.id).sort()).toEqual(["INS-1", "INS-2"]);
  });

  it("never includes Tier C rules even when topic keywords match", () => {
    const rules = [tierA("INS-1"), tierC("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, "let me dispatch a CC brief");
    expect(out.map(r => r.id)).toEqual(["INS-1"]);
  });

  it("preserves input order", () => {
    const rules = [tierB("INS-3", ["cc_dispatch"]), tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const out = selectStandingRulesForBoot(rules, "dispatch");
    expect(out.map(r => r.id)).toEqual(["INS-3", "INS-1", "INS-2"]);
  });

  it("does not mutate the input array", () => {
    const rules = [tierA("INS-1"), tierB("INS-2", ["cc_dispatch"])];
    const before = rules.length;
    selectStandingRulesForBoot(rules, "");
    expect(rules.length).toBe(before);
  });

  it("back-compat: production-shape inputs (all Tier A by default) deliver everything", () => {
    // Every rule has tier "A" and topics [] (the default when no tag present)
    const rules: StandingRule[] = ["INS-22","INS-32","INS-33","INS-34","INS-35","INS-37","INS-39","INS-40","INS-43"]
      .map(id => tierA(id));
    const out = selectStandingRulesForBoot(rules, undefined);
    expect(out).toHaveLength(rules.length);
  });
});

describe("STANDING_RULE_TOPIC_KEYWORDS map shape", () => {
  it("includes all six topic groups defined in D-156", () => {
    const topics = Object.keys(STANDING_RULE_TOPIC_KEYWORDS).sort();
    expect(topics).toEqual(["auth", "cc_dispatch", "ci_workflow", "mcp_server", "prism_push", "trigger"]);
  });

  it("every topic has at least one keyword", () => {
    for (const [topic, kws] of Object.entries(STANDING_RULE_TOPIC_KEYWORDS)) {
      expect(kws.length, `topic ${topic} has zero keywords`).toBeGreaterThan(0);
    }
  });

  it("every keyword is lowercase (case-insensitive matching depends on this)", () => {
    for (const [topic, kws] of Object.entries(STANDING_RULE_TOPIC_KEYWORDS)) {
      for (const kw of kws) {
        expect(kw, `topic ${topic} has non-lowercase keyword: ${kw}`).toBe(kw.toLowerCase());
      }
    }
  });
});
```

---

## 3. Out-of-Scope Reminders

This PR does NOT do the following — they belong to later PRs:

- Apply tier tags to `.prism/insights.md` in the `prism` repo. That is **PR 2**. Until PR 2 lands, every existing rule has `tier: "A"` (default) and `topics: []`, so `selectStandingRulesForBoot` returns ALL of them — production behavior is unchanged.
- Add the `prism_load_rules` tool. That is **PR 4**.
- Extend `prism_synthesize` for D-155 doc-currency proposals. That is **PR 3**.
- Extend `prism_finalize action="audit"` with the currency check. That is **PR 3**.
- Extend `prism_log_insight` to accept `tier` / `topics` parameters. That is a follow-up to PR 2.

If you find yourself touching code outside `src/tools/bootstrap.ts`, `src/config.ts`, `tests/bootstrap-parsing.test.ts`, or the new `tests/standing-rule-tiers.test.ts` — stop. The change is out of scope.

---

## 4. Verification

Run these in order. Do NOT proceed to step 5 (push) unless every step passes.

### 4.1 Type check

```bash
npx tsc --noEmit
```

Expected: zero errors. The build script in `package.json` may also be `npm run build` — if `tsc` is not directly available, use `npm run build` and confirm the build succeeds.

### 4.2 Imports + interface integrity

```bash
grep -c "STANDING_RULE_TOPIC_KEYWORDS" src/config.ts
# Expected: 2 (one definition, one in JSDoc reference). At least 1 is acceptable; ≥1 confirms the export exists.

grep -c "STANDING_RULE_TOPIC_KEYWORDS" src/tools/bootstrap.ts
# Expected: at least 2 (one in the import line, one in topicMatch).

grep -c '"A" | "B" | "C"' src/tools/bootstrap.ts
# Expected: at least 2 (interface field + selectStandingRulesForBoot return-filter logic if literal-typed).
# If the count is lower than 2, the tier type union may have been emitted differently — review manually.

grep -nE "^export function (extractStandingRules|topicMatch|selectStandingRulesForBoot)" src/tools/bootstrap.ts
# Expected: exactly 3 lines, one per function. ALL THREE must be exported (used in tests).
```

### 4.3 Title-strip behavior

```bash
grep -c "STANDING RULE\\\\s*/gi" src/tools/bootstrap.ts
# Expected: at least 1 (the gi-flagged regex strip for doubled tags).
```

### 4.4 Targeted unit tests

```bash
npx vitest run tests/bootstrap-parsing.test.ts tests/standing-rule-tiers.test.ts --reporter=verbose 2>&1 | tail -60
```

Expected: ALL describe blocks pass. Specifically, the new describes are:
- `standing rule tier parsing` — 9 it blocks
- `topicMatch` — 7 it blocks
- `selectStandingRulesForBoot` — 7 it blocks
- `STANDING_RULE_TOPIC_KEYWORDS map shape` — 3 it blocks

Total new it blocks: **26**. Verify that count in the test summary line.

### 4.5 Existing test back-compat

```bash
npx vitest run tests/bootstrap-parsing.test.ts --reporter=verbose 2>&1 | grep -E "✓|✗" | wc -l
# This counts pass/fail markers in the verbose output. Confirm no existing test in that file now fails.
```

Compare against your Pre-Flight baseline of the same file's pass count. The delta should be exactly +9 (the new tests added in §2.7), no regressions.

### 4.6 Full suite back-compat

```bash
npm test 2>&1 | tail -30
```

Expected outcome:
- Pre-existing acceptable failure (`cc-status.test.ts > lists recent dispatches`) remains. **One known failure is acceptable per S64 baseline (INS-26).**
- Total passing tests = baseline_passing + 26 new tests from §2.8/§2.7 (the +26 figure assumes baseline file count).
- Zero NEW failures beyond the one pre-existing. If any new failure appears, fix it before pushing.

### 4.7 Smoke test against fixture (in-repo only)

Add to your verification (do not commit) — confirm against a synthetic fixture that mirrors production shape:

```bash
cat > /tmp/fixture-insights.md <<'EOF'
### INS-1: Always-load rule — STANDING RULE
**Standing procedure:** A.

### INS-2: Topic-matched rule — STANDING RULE [TIER:B]
<!-- topics: cc_dispatch -->
**Standing procedure:** B.

### INS-3: Reference rule — STANDING RULE [TIER:C]
<!-- topics: trigger -->
**Standing procedure:** C.
EOF

node -e "
process.env.GITHUB_PAT='dummy';
import('./dist/tools/bootstrap.js').then(({ extractStandingRules, selectStandingRulesForBoot }) => {
  const fs = require('fs');
  const c = fs.readFileSync('/tmp/fixture-insights.md', 'utf-8');
  const all = extractStandingRules(c);
  console.log('parsed:', all.map(r => ({ id: r.id, tier: r.tier, topics: r.topics })));
  console.log('boot (no opening):', selectStandingRulesForBoot(all, undefined).map(r => r.id));
  console.log('boot (cc_dispatch):', selectStandingRulesForBoot(all, 'let me dispatch a CC brief').map(r => r.id));
  console.log('boot (trigger):',     selectStandingRulesForBoot(all, 'check the trigger daemon').map(r => r.id));
});
"
```

Expected output:
```
parsed: [
  { id: 'INS-1', tier: 'A', topics: [] },
  { id: 'INS-2', tier: 'B', topics: [ 'cc_dispatch' ] },
  { id: 'INS-3', tier: 'C', topics: [ 'trigger' ] }
]
boot (no opening): [ 'INS-1' ]
boot (cc_dispatch): [ 'INS-1', 'INS-2' ]
boot (trigger):     [ 'INS-1' ]                    // INS-3 is Tier C — never delivered
```

The third case is the load-bearing back-compat assertion: **Tier C is never delivered at boot, even when its topic matches.** If `INS-3` appears in the third output, the selection logic is wrong — fix and re-run.

If `npm run build` is required before this smoke test (because `dist/` is build output), run `npm run build` first.

---

## 5. Push Directive

Exactly one push directive applies to this brief:

```bash
git add -A
git status
# Confirm only the four expected files appear:
#   src/config.ts (modified)
#   src/tools/bootstrap.ts (modified)
#   tests/bootstrap-parsing.test.ts (modified)
#   tests/standing-rule-tiers.test.ts (new)
git commit -m "feat: standing-rule tier-tag parsing (D-156 / Phase 2 PR 1)

Adds tier-aware parsing to extractStandingRules with default-to-A
back-compat fallback. Introduces selectStandingRulesForBoot, topicMatch,
and STANDING_RULE_TOPIC_KEYWORDS map. No production behavior change
until PR 2 applies tags to .prism/insights.md.

- StandingRule interface gains tier and topics fields
- extractStandingRules parses [TIER:X] from header and <!-- topics: ... --> from body
- selectStandingRulesForBoot: A always, B if topic-match, C never
- 26 new tests across two files
- Diagnostics field STANDING_RULES_TIERED surfaces tier accounting"
git push -u origin feat/standing-rule-tiers
gh pr create --title "Phase 2 PR 1 — standing-rule tier-tag parsing" --body "Implements D-156 PR 1 per .prism/briefs/s66-phase2-brief.md §5.1.

**Back-compat property:** No production behavior change until PR 2 applies tier tags to .prism/insights.md. Default tier is 'A' when tag absent; selectStandingRulesForBoot returns all Tier A rules, matching current bootstrap output exactly.

**What's wired in this PR:**
- StandingRule interface extended with tier and topics fields
- extractStandingRules parses [TIER:X] from header, <!-- topics: ... --> from body
- selectStandingRulesForBoot(rules, openingMessage) filters by tier+topic
- topicMatch helper for Tier B keyword matching
- STANDING_RULE_TOPIC_KEYWORDS map in src/config.ts
- 26 new unit tests across tests/bootstrap-parsing.test.ts and tests/standing-rule-tiers.test.ts
- Diagnostic STANDING_RULES_TIERED surfaces tier-A/B/C counts and topics_matched

**Verification ran successfully:**
- npx tsc --noEmit: 0 errors
- Targeted vitest on parsing + new tier tests: 26 new passes
- Full npm test: baseline + 26 new passes, only the one pre-existing acceptable failure (cc-status.test.ts > lists recent dispatches, known env-stub bug per INS-26)
- Synthetic fixture smoke test confirmed Tier A always, Tier B on topic match, Tier C never at boot

**Do NOT merge until operator review.** PR 2 (insights migration in brdonath1/prism) cannot land before this PR is deployed-and-verified on Railway."
```

**No merge.** The brief explicitly does NOT instruct CC to merge. Operator reviews the PR; merge happens manually after review per the deploy ordering in the parent brief (§5.3).

---

## 6. If You Hit Trouble

- **Type errors after editing the interface:** Verify every existing call site that constructs a `StandingRule` (search: `grep -rn "StandingRule" src/`). If any call site builds the object literally without `tier` or `topics`, those need the defaults `tier: "A", topics: []`. Currently only `extractStandingRules` constructs StandingRule objects, so this should be a no-op — but verify before assuming.
- **`logger` is undefined inside `extractStandingRules`:** The unknown-tier-letter warning uses the existing `logger` import. If `logger` isn't imported at the top of `bootstrap.ts` already, locate the real logger import (likely from `../utils/logger.js`) and add it. If a logger isn't readily available, replace the warn line with a `console.warn` — it's a non-critical robustness path.
- **`diagnostics.info` doesn't exist on DiagnosticsCollector:** Use `diagnostics.warn` instead — see §2.6 note. Do not block on this; emit something so the diagnostic field appears in the response.
- **Unexpected new test failures:** The diff is purely additive to extractStandingRules. If existing parsing tests start failing, the most likely cause is the `gi` flag breaking a test expectation that relied on the old `i`-only behavior (single match). Check `bootstrap-parsing.test.ts` for any pre-existing test that asserts on a doubled-tag input — there shouldn't be one, but if there is, that test must be updated to match the new behavior (the doubled tag is being correctly stripped).

<!-- EOF: s66-phase2-pr1-brief.md -->
