# S29 Full-Stack Remediation Brief

> **Target:** `prism-mcp-server`, `prism-framework`, `prism` (all 3 repos)
> **Input:** `prism-mcp-server/reports/s29-context-intelligence-audit.md` (798-line audit report)
> **Goal:** Implement every fix identified in the audit report — all Quick Wins, all Medium Effort, and all feasible Architectural changes. Leave nothing unaddressed.
> **Constraint:** All 166 existing tests must continue passing. New tests required for every change.

---

## Pre-Flight

1. Sync all three repos:

```bash
cd ~
git clone https://github.com/brdonath1/prism-mcp-server.git 2>/dev/null || (cd ~/prism-mcp-server && git pull origin main)
git clone https://github.com/brdonath1/prism-framework.git 2>/dev/null || (cd ~/prism-framework && git pull origin main)
git clone https://github.com/brdonath1/prism.git 2>/dev/null || (cd ~/prism && git pull origin main)
```

2. Read the full audit report:

```bash
cat ~/prism-mcp-server/reports/s29-context-intelligence-audit.md
```

3. Load the entire codebase from all three repos into context. Every source file, every template, every test, every living document. You need full context to make safe changes.

4. Run the existing test suite to establish baseline:

```bash
cd ~/prism-mcp-server && npm test
```

All 166 tests must pass before you begin any changes.

---

## Phase 1: Quick Wins (prism-mcp-server)

Implement ALL of the following. Each is a small, isolated change.

### QW-1: Remove `banner_data` from bootstrap response when `banner_html` is present

**File:** `src/tools/bootstrap.ts`

**What:** When `banner_html` is successfully rendered (non-null), do NOT include the `banner_data` field in the response object. The `banner_data` field is redundant — it contains the same structured data that was used to render the HTML. Claude reads both into context, wasting ~130 tokens.

**How:**
- Find where the response object is assembled (the final return statement)
- Add conditional: if `banner_html` is truthy, omit `banner_data` from the response
- If `banner_html` is null (render failure), include `banner_data` as fallback

**Test:** Add a test asserting that when `banner_html` is present, `banner_data` is absent from the response. Add a test asserting that when `banner_html` is null, `banner_data` IS present.

### QW-2: Compact JSON for all tool responses

**What:** Switch all tool responses from pretty-printed JSON (`JSON.stringify(result, null, 2)`) to compact JSON (`JSON.stringify(result)`). The audit found this wastes ~1,000-1,500 tokens on the bootstrap response alone due to indentation whitespace.

**How:**
- Search the entire `src/tools/` directory for all instances of `JSON.stringify` with pretty-print arguments (`null, 2` or similar)
- Replace with compact `JSON.stringify(result)` — no second or third argument
- Also check `src/utils/`, `src/ai/`, and any other directories that construct tool responses
- **IMPORTANT:** Do NOT change `JSON.stringify` calls used for file content being pushed to GitHub (those should remain readable). Only change calls that format MCP tool RESPONSES back to Claude.

**Test:** Add a test for bootstrap response that verifies the response string contains no unnecessary indentation (no lines starting with spaces followed by `"`). Or more simply, verify `JSON.stringify(JSON.parse(response))` equals the response (round-trip compact check).

### QW-3: Prune overly generic prefetch keywords

**File:** `src/config.ts` — the `PREFETCH_KEYWORDS` map

**What:** Remove 6 overly generic keywords that cause false-positive document prefetches. The audit identified these specific keywords:

| Keyword to REMOVE | Why it's problematic |
|---|---|
| `next` | Triggers on "Begin next session", "What's next" |
| `plan` | Triggers on "Let's plan our approach" |
| `session` | Triggers on any mention of "session" — universal word |
| `previous` | Triggers on "pick up from previous" |
| `issue` | Triggers on "let's address this issue" (user's topic, not KI) |
| `error` | Triggers on "I got an error" (user's error, not KI) |

**Keep** all specific keywords like `architecture`, `bug`, `task`, `guardrail`, `decision`, `glossary`, etc.

**Test:** Add a test that verifies "Begin next session" as `opening_message` does NOT trigger any prefetch. Add a test that verifies "fix the architecture bug" DOES trigger `architecture.md` and `known-issues.md` prefetch.

### QW-4: Add prefetch budget cap

**File:** `src/tools/bootstrap.ts` — the prefetch logic

**What:** Add a hard cap of **2 documents maximum** per prefetch operation. Even if multiple keywords match multiple documents, only the first 2 unique documents should be fetched. This prevents keyword-dense opening messages from triggering 5+ document fetches.

**How:**
- Find where matched documents are collected from keyword hits
- After deduplication, slice to max 2 entries
- Add a comment explaining the cap and referencing finding PF-3

**Test:** Add a test with an opening_message containing 5+ trigger keywords. Verify only 2 documents are prefetched.

### QW-5: Remove `component_sizes` from bootstrap response

**File:** `src/tools/bootstrap.ts`

**What:** The `component_sizes` field is monitoring/diagnostic data. It's useful for audits but does not help Claude during a session. Remove it from the response to save ~270 tokens.

**How:**
- Find where `component_sizes` is added to the response object
- Remove it from the response
- Optionally, log it to server logs instead for monitoring purposes

**Test:** Add a test asserting `component_sizes` is NOT present in the bootstrap response.

### QW-6: Shorten tool descriptions

**Files:** All 12 tool registration files in `src/tools/`

**What:** Reduce tool description verbosity by ~30%. Tool descriptions are registered as MCP tool schemas and persist in Claude's context for the entire conversation (~2,260 tokens total). Shorter descriptions that preserve callable accuracy will save ~300-500 tokens.

**How:**
- For each tool's `.description` string in its Zod schema / MCP registration:
  - Remove redundant phrases ("This tool...", "Use this to...")
  - Condense multi-sentence descriptions to 1-2 sentences
  - Keep parameter descriptions concise but accurate
  - Preserve all parameter names and types exactly
- **CRITICAL:** Do NOT change parameter names, types, or required/optional status. Only change description strings.

**Test:** After changes, run the full test suite. Then manually verify each tool's description is still clear enough for Claude to understand when to use it.

---

## Phase 2: Medium Effort Changes (prism-mcp-server + prism-framework)

### ME-1: Replace `banner_html` with text-only boot status

**Files:**
- `prism-mcp-server/src/tools/bootstrap.ts`
- `prism-mcp-server/src/utils/banner.ts` (or wherever `renderBannerHtml` lives)

**What:** The HTML banner costs ~1,450 tokens and is viewed once at session start but carried in context forever. Replace it with a compact text-based boot status that conveys the same verification data at ~200 tokens.

**The new `banner_text` field should contain a compact, human-readable status block like:**

```
PRISM v2.9.0 | Session 29 | 04-03-26 07:47:30 CST
Handoff v33 (4.4KB) | 65 decisions (10 guardrails) | 10/10 docs healthy
✓ bootstrap | ✓ push verified | ✓ template loaded | ✓ no scaling needed

Resumption: All S28 work complete. Verify IP allowlist...

Next:
▸ Verify IP allowlist deploy (S28) [priority]
▸ Implement D-48 server-side (S26)
▸ Bootstrap threshold advisory (S26)
```

**How:**
- Create a new function `renderBannerText(bannerData)` that produces the compact text format above
- In bootstrap response assembly: replace `banner_html` with `banner_text`
- Keep `banner_data` available as the data source for `banner_text` rendering, but remember QW-1 — don't include `banner_data` in the response when `banner_text` is present
- **Do NOT delete `renderBannerHtml` or `banner-spec.md` yet** — keep them for potential future use. Just stop calling/returning HTML in bootstrap.
- The `banner_html` field in the response should be set to `null`
- Add a new field `banner_text` with the compact text output

**Impact on Claude-side behavior:** The core-template-mcp.md Rule 2 currently says "If `banner_html` is present, pass it to `visualize:show_widget`." With this change, Claude will see `banner_html: null` and `banner_text` present. Claude should display the text directly — no widget needed. The template update in Phase 3 will handle this.

**Test:** Add a test that verifies `banner_text` is present and `banner_html` is null. Verify `banner_text` contains session number, handoff version, doc count, and resumption point. Verify `banner_text` is under 500 bytes.

### ME-2: Deduplicate resumption_point and next_steps

**File:** `src/tools/bootstrap.ts`

**What:** `resumption_point` and `next_steps` currently appear in three places:
1. Root response fields (from handoff parsing)
2. `banner_data` object (assembled for banner rendering)
3. `banner_html` / `banner_text` (rendered output)

With QW-1 removing `banner_data` and ME-1 replacing `banner_html` with `banner_text`, the triple delivery is already partially addressed. However, verify that the root-level `resumption_point` and `next_steps` fields are the ONLY source — the `banner_text` rendering should READ from these root fields, not duplicate them.

**How:**
- Verify `renderBannerText()` takes `resumption_point` and `next_steps` as inputs from the root response fields
- Do NOT store separate copies in any intermediate objects
- The response should have exactly ONE instance of each piece of data

**Test:** Serialize the full bootstrap response. Count occurrences of the resumption point text. It should appear at most twice (once in root field, once in banner_text rendered output). The raw data should NOT appear a third time.

### ME-3: Implement D-48 — Standing Rule Lifecycle Filtering

**File:** `src/tools/bootstrap.ts` — the standing rules extraction logic

**What:** Currently, all insights tagged `STANDING RULE` are extracted and included in bootstrap. D-48 specifies that rules tagged `ARCHIVED RULE` or `DORMANT RULE` should be excluded from bootstrap. This prevents the standing rules payload from growing unbounded.

**How:**
- Find the standing rules extraction logic (searches `insights.md` for `STANDING RULE` tagged entries)
- Add exclusion logic: if an entry's header contains `ARCHIVED RULE` or `DORMANT RULE`, skip it
- The extraction regex/parser should match `STANDING RULE` but NOT match `ARCHIVED RULE` or `DORMANT RULE`
- Handle edge cases: `ARCHIVED STANDING RULE`, `DORMANT STANDING RULE` should also be excluded

**Test:** Add test with mock insights.md containing:
- 2 entries tagged `STANDING RULE` (should be included)
- 1 entry tagged `ARCHIVED RULE` (should be excluded)
- 1 entry tagged `DORMANT RULE` (should be excluded)
- 1 entry tagged `ARCHIVED STANDING RULE` (should be excluded)
Verify only the 2 active standing rules appear in output.

### ME-4: Move session-end rules out of boot payload

**What:** Rules 10-14 (Session End + Recovery) consume ~550 tokens but are only needed at finalization time. The audit found 23 always-active directives at boot — nearly double the G-1 threshold. Moving session-end rules out of the boot payload reduces always-active directives to ~18, within the safe zone.

**How — this is a two-part change:**

**Part A — Framework template (`prism-framework/_templates/core-template-mcp.md`):**
- Remove Rules 10-14 from the `### SESSION END` and `### RECOVERY` sections
- Replace with a single line: `Rules 10-14 (Session End + Recovery) are delivered by \`prism_finalize\` when finalization is triggered.`
- This reduces the template from ~13.3KB to ~12KB

**Part B — Server tool (`prism-mcp-server/src/tools/finalize.ts`):**
- When `prism_finalize` is called with mode `audit` (the first finalization step), prepend the session-end rules (Rules 10-14) to the response
- Store Rules 10-14 text as a constant in the server (or fetch from a new framework file `_templates/rules-session-end.md`)
- This way, Claude receives the finalization rules exactly when needed — not before

**Part C — Create rules file (`prism-framework/_templates/rules-session-end.md`):**
- Extract Rules 10-14 verbatim from the current core-template-mcp.md
- Store as a standalone file that the server can cache and inject during finalization
- Include the EOF sentinel: `<!-- EOF: rules-session-end.md -->`

**Test:**
- Verify `core-template-mcp.md` no longer contains Rules 10-14 full text
- Verify `core-template-mcp.md` contains the replacement pointer line
- Verify `prism_finalize` audit response includes Rules 10-14 text
- Verify `rules-session-end.md` contains the complete Rules 10-14

### ME-5: Add context budget estimation to bootstrap

**File:** `src/tools/bootstrap.ts`

**What:** Add a `context_estimate` field to the bootstrap response that estimates the total context window consumption at boot. This enables accurate Rule 9 tracking from exchange 1.

**How:**
- After assembling the full response, calculate:
  - `bootstrap_tokens`: total response size in bytes / 3.5 (average for mixed content)
  - `platform_overhead_tokens`: 5000 (conservative estimate for system prompt + PI + memory)
  - `tool_schema_tokens`: 2500 (conservative estimate for 12 tool schemas)
  - `total_boot_tokens`: sum of above
  - `total_boot_percent`: `(total_boot_tokens / 200000) * 100`, rounded to 1 decimal
- Add to response:
```json
"context_estimate": {
  "bootstrap_tokens": 9500,
  "platform_overhead_tokens": 5000,
  "tool_schema_tokens": 2500,
  "total_boot_tokens": 17000,
  "total_boot_percent": 8.5
}
```

**Test:** Verify `context_estimate` is present. Verify `total_boot_percent` is a number between 5 and 25. Verify `total_boot_tokens` equals the sum of the three component fields.

---

## Phase 3: Framework Template Updates (prism-framework)

### FW-1: Update Rule 2 for text-only banner

**File:** `prism-framework/_templates/core-template-mcp.md`

**Current text (in Rule 2):**
> Boot banner (MCP mode). After bootstrap, render the boot banner. If `banner_html` is present, pass it to `visualize:show_widget`. For fallback rendering when `banner_html` is null, follow `brdonath1/prism-framework/_templates/banner-spec.md`.

**Replace with:**
> Boot banner (MCP mode). After bootstrap, display the `banner_text` field directly in your response. No widget rendering needed — the text format is designed for inline display. If `banner_text` is null, construct a minimal status line from the response fields (session number, handoff version, doc count).

### FW-2: Update Rule 9 context estimation

**File:** `prism-framework/_templates/core-template-mcp.md`

**In the Rule 9 "Estimation formula" section, replace the current formula with:**

> **Estimation formula:**
> At session start, use `context_estimate.total_boot_percent` from bootstrap as your baseline instead of the fixed 15%.
> `context% ≈ context_estimate.total_boot_percent + (exchange_count × 0.75%) + fetch_total`
>
> If `context_estimate` is not available, fall back to: `context% ≈ 15% + (exchange_count × 0.75%) + fetch_total`

### FW-3: Update Rule 11 for deferred rules

**File:** `prism-framework/_templates/core-template-mcp.md`

**Add a note to Rule 11's header:**
> Note: The full text of Rules 10-14 is delivered by `prism_finalize` in the audit response. You do not need to memorize them from boot — they will be provided when finalization begins.

### FW-4: Update the full fallback template

**File:** `prism-framework/_templates/core-template.md`

**Apply the same Rule 2/Rule 9 changes (FW-1 and FW-2) to the fallback template.** The fallback template should remain consistent with the MCP template on behavioral rules, even though it uses different tooling.

---

## Phase 4: Living Document Cleanup (prism repo)

### LD-1: Archive resolved known issues

**Files:**
- `prism/known-issues.md` — remove resolved issues, keep active only
- `prism/known-issues-archive.md` — new file, receives resolved issues

**What:** Move all 11 resolved issues (KI-1, KI-2, KI-4, KI-5, KI-6, KI-7, KI-8, KI-9, KI-10, KI-11, KI-12, KI-14, KI-15, KI-16) to `known-issues-archive.md`. Keep only active issues (KI-3, KI-13) in the main file.

**The archive file format:**
```markdown
# Known Issues Archive — PRISM

> Resolved issues moved from known-issues.md to reduce fetch size.
> Reference only — not loaded at bootstrap.

## Resolved

[paste all resolved KI entries here, preserving full content]

<!-- EOF: known-issues-archive.md -->
```

**The trimmed known-issues.md should keep:**
- Header and description
- `## Active` section with KI-3 and KI-13 only
- `## Resolved` section with a single line: `> Resolved issues archived to \`known-issues-archive.md\`. [count] issues resolved.`
- EOF sentinel

**Expected size reduction:** ~7KB removed from known-issues.md (from ~11KB to ~4KB).

### LD-2: Trim architecture.md build history

**File:** `prism/architecture.md`

**What:** The "Build History" section contains 14 entries documenting every CC session's changes (~800 tokens). Move entries older than the last 5 to a build history section at the bottom marked as archival, or to a separate `build-history.md` file.

**How:**
- Keep the 5 most recent build history entries in architecture.md
- Move older entries to `prism/build-history-archive.md`
- Add pointer: `> Full build history: \`build-history-archive.md\``

---

## Phase 5: New Tests

Add the following tests to the prism-mcp-server test suite. These should be NEW test files or additions to existing test files as appropriate.

### T-1: Bootstrap response size budget test

**File:** `src/__tests__/bootstrap-budget.test.ts` (new file)

```
Tests to include:
- Bootstrap response JSON string length < 50,000 bytes (50KB hard cap)
- behavioral_rules field length < 15,000 bytes (15KB cap)
- banner_text field length < 500 bytes (500B cap)
- banner_html field is null
- banner_data field is absent when banner_text is present
- component_sizes field is absent
- context_estimate field is present and valid
- standing_rules array length < 10 entries
- prefetched_documents array length <= 2 entries
```

### T-2: Prefetch keyword accuracy tests

**File:** `src/__tests__/prefetch-keywords.test.ts` (new file)

```
Tests to include:
- "Begin next session" triggers 0 prefetches
- "fix the architecture bug" triggers architecture.md and known-issues.md
- "review the task queue" triggers task-queue.md
- Message with 5+ trigger keywords results in max 2 prefetched documents
- Generic words (next, plan, session, previous, issue, error) are NOT in keyword map
- Specific words (architecture, bug, task, guardrail, decision, glossary) ARE in keyword map
```

### T-3: Standing rule lifecycle tests

**File:** Add to existing `src/__tests__/bootstrap-parsing.test.ts`

```
Tests to include:
- STANDING RULE entries are included in standing_rules output
- ARCHIVED RULE entries are excluded
- DORMANT RULE entries are excluded
- ARCHIVED STANDING RULE entries are excluded
- Entry with no lifecycle tag is excluded (not a standing rule)
```

### T-4: Banner text format tests

**File:** `src/__tests__/banner-text.test.ts` (new file)

```
Tests to include:
- renderBannerText returns a string under 500 bytes
- Output contains session number
- Output contains handoff version
- Output contains doc count with health status
- Output contains resumption point (truncated if >200 chars)
- Output contains at least 1 next step
- Output contains tool verification status
```

### T-5: Template size regression tests

**File:** `src/__tests__/template-budget.test.ts` (new file)

This test should read the actual template file from the framework repo (via file system, not GitHub API) and verify size constraints:

```
Tests to include:
- core-template-mcp.md file size < 13,000 bytes (should be ~12KB after ME-4)
- core-template-mcp.md does NOT contain "Rule 10", "Rule 11", "Rule 12", "Rule 13", "Rule 14" as full rule sections
- rules-session-end.md file exists and contains Rules 10-14
- rules-session-end.md file size < 3,000 bytes
```

Note: These tests may need to be skipped in CI if the framework repo isn't available. Use conditional test logic.

---

## Phase 6: Update Server Version

**File:** `prism-mcp-server/package.json`

**Bump version to `2.10.0`** — this is a minor version bump (new features, no breaking changes to tool schemas). The tool parameter interfaces are unchanged; only response fields and internal behavior changed.

**File:** `prism-mcp-server/src/config.ts`

Update `SERVER_VERSION` constant to match `2.10.0`.

---

## Verification

After ALL changes are complete:

1. Run the full test suite:
```bash
cd ~/prism-mcp-server && npm test
```
All existing tests (166) + all new tests must pass.

2. Verify file sizes:
```bash
wc -c ~/prism-framework/_templates/core-template-mcp.md
# Should be < 13,000 bytes

wc -c ~/prism-framework/_templates/rules-session-end.md  
# Should exist and be < 3,000 bytes

wc -c ~/prism/known-issues.md
# Should be < 5,000 bytes (down from 11,010)
```

3. Verify no regressions in template content:
```bash
grep -c 'Rule' ~/prism-framework/_templates/core-template-mcp.md
# Should still reference all rules but 10-14 should be pointers, not full text
```

4. Verify all keyword removals:
```bash
grep -E '"(next|plan|session|previous|issue|error)"' ~/prism-mcp-server/src/config.ts
# Should return NO matches (these keywords should be removed)
```

---

## Post-Flight

1. Commit all prism-mcp-server changes:
```bash
cd ~/prism-mcp-server && git add -A && git commit -m "fix: S29 full-stack remediation — context optimization, prefetch pruning, banner text, D-48 lifecycle, deferred rules, new budget tests" && git push origin main
```

2. Commit all prism-framework changes:
```bash
cd ~/prism-framework && git add -A && git commit -m "fix: S29 remediation — template v2.10.0, deferred session-end rules, updated Rule 2/9 for text banner and context estimation" && git push origin main
```

3. Commit all prism (project state) changes:
```bash
cd ~/prism && git add -A && git commit -m "chore: S29 — archive resolved KIs, trim build history" && git push origin main
```

4. Print a summary of all changes made, organized by repo, with file counts and test results.

---

## Expected Outcomes

After this remediation:
- **Bootstrap token cost:** ~11,000 → ~7,000-8,000 tokens (30-35% reduction)
- **Always-active directives:** 37 → ~25 (32% reduction, within G-1 safe zone)
- **Prefetch false positives:** Eliminated for common opening messages
- **Banner context cost:** ~1,450 → ~150 tokens (90% reduction)
- **Redundant data:** ~800-1,500 → ~0 tokens wasted
- **Living document fetch cost (known-issues):** ~2,750 → ~1,000 tokens (64% reduction)
- **Standing rule lifecycle:** D-48 implemented, preventing unbounded growth
- **Context estimation:** Accurate from exchange 1 via server-side calculation
- **Total estimated savings:** ~4,000-7,000 tokens per session at boot

<!-- EOF: s29-full-stack-remediation.md -->