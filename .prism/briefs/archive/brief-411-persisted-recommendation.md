# Brief 411 — Persisted recommendation + concise-response default

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-mcp-server (this repo) + cross-repo edit on `brdonath1/prism-framework`
**Origin:** PRISM session S108 (2026-05-01), implements D-193 Pieces 1 + 4 on `brdonath1/prism`

## Context

Two distinct issues observed in S107→S108 transition share a common workstream:

1. **Banner discrepancy.** S107 finalize banner displayed `Suggested: Opus 4.7 · Adaptive off`. S108 boot banner displayed `Suggested: Sonnet 4.6 · Adaptive off`. Same handoff (v113), same `Next Steps` content. Verified root cause via source read: `src/tools/finalize.ts` calls `classifySession({ next_steps })` only; `src/tools/bootstrap.ts` calls `classifySession({ next_steps, critical_context, opening_message })`. Different inputs → different verdicts. Critical Context contains historical past-tense executional language ("executed", "deployed", "reconnect") that has no business steering future-session recommendations.

2. **Verbose response default.** Recent sessions have shown response patterns trending toward novice-explanatory framing — option-listing, preamble, "let me explain why" scaffolding. Original framework framing assumed novice operator; operator is well past that. Verbosity costs context faster than necessary and degrades signal-to-noise.

D-193 (logged S108) settled the four-piece integrated solution. This brief implements Pieces 1 + 4 only (the two pieces touching `prism-mcp-server` + `prism-framework`). Pieces 2 (active model awareness) and 3 (per-task tagging) are queued as future briefs.

## Required Changes

### Part A — Persist the recommendation in handoff.md

#### A.1. Update `src/tools/finalize.ts` — write recommendation block to handoff.md

In `commitPhase()`, after the existing `classifySession` call that produces the `recommendation` for the banner (around line ~640 in current source), inject the recommendation as a structured markdown block into the handoff.md content **before** the file is pushed.

The block format (verbatim, including the HTML-comment delimiters):

```markdown
## Recommended Session Settings

<!-- prism:recommended_session_settings -->
- Model: {model display string, e.g. "Opus 4.7"}
- Thinking: {Adaptive on | Adaptive off}
- Category: {reasoning_heavy | executional | mixed}
- Rationale: {rationale text, capped at 80 chars per existing classifier output}
<!-- /prism:recommended_session_settings -->
```

Insertion point in handoff.md: **immediately after the `## Meta` section, before `## Critical Context`**. If the section already exists in the inbound handoff.md content (operator-edited handoff or re-finalize), replace it in place. If it does not exist, insert it.

The handoff.md content is in the `files` array passed to `commitPhase` — locate it by path matching `handoff.md` or `.prism/handoff.md`, mutate the `content` field in place. Apply this mutation BEFORE the validation step so the existing EOF/validation logic runs against the final form.

**Behavioral contract:**
- If `classifySession` succeeds → write the block.
- If `classifySession` throws → log warn, do not write the block, proceed with finalize. Banner may still render without the suggested section per existing defensive contract.
- If the inbound handoff.md does not contain a `## Meta` section header (legacy projects) → log warn, do not write the block, proceed. Do not invent a Meta section.

#### A.2. Update `src/tools/bootstrap.ts` — read persisted recommendation, drop redundant classification

Replace the existing `classifySession` block in `prism_bootstrap` (currently around line ~360, the block that calls `classifySession({ next_steps, critical_context, opening_message })`) with a parser that extracts the recommendation block from the fetched handoff.md content.

New helper function in `src/utils/session-classifier.ts` (or a new `src/utils/recommendation-parser.ts` if preferred):

```typescript
/**
 * Parse the persisted recommendation block from handoff.md content.
 * Returns null if the block is absent or malformed.
 */
export function parsePersistedRecommendation(handoffContent: string): SessionRecommendation | null {
  // Match the delimited block.
  const match = handoffContent.match(
    /<!-- prism:recommended_session_settings -->([\s\S]*?)<!-- \/prism:recommended_session_settings -->/
  );
  if (!match) return null;

  const body = match[1];
  const modelDisplay = body.match(/^- Model:\s*(.+)$/m)?.[1]?.trim();
  const thinkingDisplay = body.match(/^- Thinking:\s*(.+)$/m)?.[1]?.trim();
  const category = body.match(/^- Category:\s*(\w+)$/m)?.[1]?.trim();
  const rationale = body.match(/^- Rationale:\s*(.+)$/m)?.[1]?.trim();

  // Reconstruct full SessionRecommendation. Fail closed if any field missing.
  if (!modelDisplay || !thinkingDisplay || !category || !rationale) return null;
  if (!["reasoning_heavy", "executional", "mixed"].includes(category)) return null;

  // Map display strings back to model/thinking enum values via existing tables
  // (DISPLAY_BY_CATEGORY etc. in session-classifier.ts).
  // ... reuse the existing mapping tables; do not parse free-form display strings.

  return {
    category: category as SessionCategory,
    model: MODEL_BY_CATEGORY[category as SessionCategory],
    thinking: THINKING_BY_CATEGORY[category as SessionCategory],
    rationale,
    display: `${modelDisplay} · ${thinkingDisplay}`,
    scores: { reasoning_heavy: 0, executional: 0 },  // Not preserved; informational only
  };
}
```

In `prism_bootstrap`, replace the `try { recommendedSessionSettings = classifySession(...) }` block with:

```typescript
let recommendedSessionSettings: SessionRecommendation | null = null;
try {
  recommendedSessionSettings = parsePersistedRecommendation(handoff.content);
  if (!recommendedSessionSettings) {
    // Back-compat fallback: handoff was written by a pre-Brief-411 finalize.
    // Classify on next_steps only (same input bundle as finalize uses) so
    // the boot recommendation matches what finalize WOULD have produced.
    recommendedSessionSettings = classifySession({ next_steps: nextSteps });
  }
} catch (err) {
  logger.warn("recommendation parse/classify failed", {
    error: err instanceof Error ? err.message : String(err),
  });
}
```

**Critical:** The fallback must use `next_steps` only — NOT critical_context or opening_message. This is the bug being fixed. Future-session signal lives in `next_steps`; critical_context describes past state.

#### A.3. Tests

- `src/utils/session-classifier.test.ts` (or sibling): add unit tests for `parsePersistedRecommendation` covering: well-formed block (all three categories), missing block, malformed block (missing field), invalid category value, presence of extra whitespace.
- `src/tools/finalize.test.ts`: add test verifying the recommendation block is injected into the handoff.md content of the `files` array before push. Test all three category outcomes. Test the "block already exists, replaced in place" path. Test the "no Meta section, block not written, warn logged" path.
- `src/tools/bootstrap.test.ts`: add test verifying bootstrap parses the persisted block and surfaces it. Add test for the back-compat fallback path (handoff without block → classifies on next_steps only).
- All existing tests must pass without modification.

### Part B — Concise-response default (cross-repo edit)

#### B.1. Add Tier A standing rule via `prism_log_insight` — actually no, do this manually as a file edit

The brief operator will handle this through a direct repo edit since it's a behavioral rule for the framework, not project state. Edit the framework template:

**File:** `brdonath1/prism-framework:_templates/core-template-mcp.md`

**Insertion point:** Inside the `## Operating Posture` section, append a new bullet at the end of the existing list:

```markdown
- **Concise by default.** Default to short, direct responses. Skip preamble, novice-level scaffolding, and option-listing unless explicitly requested. Expand only when the work genuinely requires depth (briefs, root-cause analyses, decision reasoning, designs the operator must evaluate). One clear answer beats three hedged ones. Verbosity costs context that compounds across long sessions — brevity is operational discipline, not just style.
```

**Version bump:** Change `# PRISM Core Template v2.15.0 (MCP Mode)` heading to `v2.16.0` and update the `> **Template Version:** 2.15.0` line to `2.16.0`.

#### B.2. No code changes required for Part B

This is a pure framework-template change. The MCP server fetches the template at boot per existing logic; cache TTL is 5 minutes, so propagation is automatic on next session boot after the merge.

### Part C — Server version bump

Bump `SERVER_VERSION` in `src/config.ts` from `"4.1.0"` to `"4.2.0"` with a comment block describing brief-411 (persisted recommendation + bootstrap classifier deletion).

## Verification Steps

1. `npm run lint` clean.
2. `npm run build` clean.
3. `npm test` — all existing tests pass; new tests added per A.3 pass.
4. PR description must explicitly note:
   - "Eliminates banner discrepancy by persisting recommendation in handoff.md"
   - "Bootstrap no longer reclassifies — single source of truth is finalize"
   - "Back-compat fallback handles handoffs from pre-411 finalize runs"
5. After merge: Railway deploy, then S109 boot will be the verification gate. Operator reconnect of MCP connector required per INS-227 before the persisted-block parser is reachable from Claude.ai.

## Out of Scope

- Pieces 2 (active model awareness via `current_session_actual` + self-report) and 3 (per-task tagging) per D-193. Those are separate briefs.
- Classifier keyword calibration (adding "scope", tightening "verify", etc.). Logged as parking-lot follow-up; depends on usage data after Pieces 1-3 ship.
- Removing `recommended_session_settings` field from bootstrap response shape. Keep it for back-compat; it now reflects the persisted value rather than a reclassification.
- Removing the duplicate `Suggested:` line from `banner_text` rendering in bootstrap. Keep — it now reflects persisted state.

## Failure Modes to Avoid

- Do NOT pass `critical_context` or `opening_message` to `classifySession` in the bootstrap fallback path. The whole point of this brief is eliminating that input divergence.
- Do NOT remove the existing `classifySession` import from bootstrap.ts — the back-compat fallback still uses it.
- Do NOT mutate handoff.md content AFTER validation. Mutation must precede validation so EOF sentinels and required sections are checked against final form.
- Do NOT silently swallow parse failures. Log via `logger.warn`. The fallback path covers the common case (legacy handoff); harder failures (corrupt block) need to surface.
- Do NOT break the existing `recommended_session_settings` field shape on the bootstrap response. Downstream consumers (banner rendering, future Pieces 2-3) depend on it.

<!-- EOF: brief-411-persisted-recommendation.md -->
