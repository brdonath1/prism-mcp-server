# Brief 405 — Model-recommendation classifier (boot banner + finalization banner)

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-mcp-server (this repo) + cross-repo edit on `brdonath1/prism-framework`
**Origin:** PRISM session S106 (2026-05-01), implements adjacent-feature scope of D-191 on `brdonath1/prism`

## Context

D-191 (PRISM project, optimization domain) defines a five-phase token-reduction strategy. This brief implements one cross-cutting feature called out in that decision: a deterministic keyword-based classifier that recommends a model + thinking setting for the next PRISM session, surfaced in two places — the finalization banner (primary, pre-boot signal) and the bootstrap response (secondary, safety net).

The recommendation is advisory, not enforced. Operator overrides freely. The goal is to avoid the wasted-boot scenario where a session starts on Opus 4.7 + Adaptive on for what turns out to be 30 turns of mechanical work.

## Required Changes

### 1. New module: `src/utils/session-classifier.ts`

Deterministic, no LLM, no GitHub I/O. Pure function input → output.

**Public API:**

```typescript
export type RecommendedModel = "opus-4-7" | "sonnet-4-6" | "haiku-4-5";
export type RecommendedThinking = "adaptive-on" | "adaptive-off";
export type SessionCategory = "reasoning_heavy" | "executional" | "mixed";

export interface SessionRecommendation {
  category: SessionCategory;
  model: RecommendedModel;
  thinking: RecommendedThinking;
  rationale: string;       // ≤80 chars, surfaces in banners
  display: string;         // e.g. "Opus 4.7 · Adaptive off"
  scores: {                // for debug/observability
    reasoning_heavy: number;
    executional: number;
  };
}

export function classifySession(input: {
  next_steps: string[];          // from handoff next_steps or task-queue Up Next
  critical_context?: string[];   // from handoff critical_context (boot path only)
  opening_message?: string;      // boot path only; weight 2x when present
}): SessionRecommendation;
```

**Keyword sets (initial; tunable):**

- *Reasoning-heavy triggers:* `design`, `architect`, `architecture`, `brainstorm`, `investigate`, `debug`, `evaluate`, `decide whether`, `follow-up on`, `analyze`, `audit` (when paired with `report` / `findings`), `propose`, `compare`, `tradeoff`, `strategy`.
- *Executional triggers:* `cleanup`, `rename`, `patch`, `push`, `log`, `backfill`, `apply`, `verify`, `re-tier`, `demote`, `consolidate`, `update`, `bump`, `sync`, `archive` (when about archiving content), `enroll`, `restart` (when about daemon restart).

Case-insensitive. Score each step/context item by counting keyword hits, summed across the input bundle. `opening_message` gets 2x weight when present (it reflects current intent, not stale queue state).

**Decision rule:**

```
ratio = reasoning_heavy_score / max(executional_score, 1)

if ratio >= 1.5    → reasoning_heavy   → Opus 4.7 + Adaptive on
if ratio <= 0.67   → executional       → Sonnet 4.6 + Adaptive off
otherwise (mixed)  → mixed             → Opus 4.7 + Adaptive off  (the "strong default")
```

**Rationale string formatting (examples):**

- reasoning_heavy: `"Queue includes design / multi-doc investigation"`
- executional: `"Queue is mechanical cleanup / patches"`
- mixed: `"Mixed queue — execution with some judgment"`

If a specific item dominates the score, the rationale may name it (e.g., `"INS-223 cleanup + dead-config follow-up"`) — ≤80 chars, not load-bearing.

**Tests:** `tests/utils/session-classifier.test.ts` covering at least: pure executional input → executional verdict; pure reasoning input → reasoning_heavy verdict; mixed → mixed; empty input → mixed (safe default); opening_message overrides queue (e.g., reasoning queue + executional opening_message → mixed or executional depending on ratio); keyword case-insensitivity; multi-keyword same-step (counts each keyword hit).

### 2. Wire into `src/tools/bootstrap.ts`

Locate the response-construction block (where the function returns the bootstrap object containing `handoff_version`, `template_version`, `critical_context`, `next_steps`, `intelligence_brief`, etc.). Add a new field:

```typescript
recommended_session_settings: classifySession({
  next_steps: <handoff next_steps array, already in scope>,
  critical_context: <critical_context array, already in scope>,
  opening_message: <opening_message argument, already in scope>,
})
```

Field placement in the response: alongside `expected_tool_surface` and `post_boot_tool_searches`. Do NOT include this in the boot test push — it's metadata only.

Update the boot banner code-fence content (Block 3 per Rule 2 of `core-template-mcp.md`) to include a new line below the existing Tool Surface line:

```
Suggested: Opus 4.7 · Adaptive off — Queue is mechanical cleanup
```

The line is appended to `banner_text` (the plain-text banner string the response returns). Do NOT add it to the HTML banner — keep that as-is. The framework template's Rule 2 Block 3 already has machinery for inserting a Tool Surface line conditionally; mirror that for `Suggested:`. If `recommended_session_settings` is null/missing (older client), omit the line entirely without leaving a blank.

### 3. Wire into `src/tools/finalize.ts` `renderFinalizationBanner`

This is the primary placement (pre-boot signal).

In the commit-phase code path, just before banner rendering:

```typescript
const recommendation = classifySession({
  next_steps: <result.handoff_next_steps or extracted from final handoff.md>,
  // critical_context optional/omitted on finalization path — handoff_next_steps is the primary signal
});
```

In `renderFinalizationBanner`, add a new section between the existing **Resumption Point** and **Deliverables** sections. New CSS class `bn-suggested` (or extend `bn-card` styling). Visual:

```
SUGGESTED FOR NEXT SESSION
Opus 4.7 · Adaptive off
Queue is mechanical cleanup
```

The label text uses the same `bn-section-label` styling as `Resumption point` and `Deliverables`. The display string (e.g., "Opus 4.7 · Adaptive off") is bold and prominent. The rationale string is one line below in muted color. Use the existing `--bn-accent-start` red as a left-border accent or icon to draw the eye — operator should not miss this when reviewing the banner before ending the session.

If `recommendation` is null/undefined for any reason (defensive), omit the section entirely — don't render an empty placeholder.

### 4. Cross-repo edit on `brdonath1/prism-framework`

Update `_templates/core-template-mcp.md` Rule 2 Block 3 to reference the new `Suggested:` banner line. Specifically, the post-boot tool surface paragraph in Rule 1 already documents how the Tool Surface line is computed and where it's inserted. Add a parallel paragraph documenting:

- The bootstrap response now returns `recommended_session_settings`.
- The `Suggested:` line is inserted into the banner code fence directly below the Tool Surface line.
- The line is emitted verbatim from `banner_text` if present; omit if absent.
- The recommendation is advisory; operator overrides via the model selector at session start.

Use `create_or_update_file` from CC's GitHub MCP tools — no clone needed for this single-file edit. Bump the template version metadata at the top of the file from `2.14.0` → `2.15.0`. Bump the version in the EOF sentinel comment if applicable.

Commit message: `prism: surface session-recommendation banner line in Rule 2 Block 3 (S106 D-191)`

### 5. Optional: bump `SERVER_VERSION` in `src/config.ts`

If the version-bump convention for this server applies (it currently sits at 4.0.0), bump to 4.1.0 to reflect new boot/finalization response shape. Reference D-191 in the comment.

## Verification

Before opening the PR:

1. `npm test` — all tests pass; new classifier tests pass; existing tool-surface tests still pass.
2. `npm run lint` — biome clean.
3. `npm run build` — `tsc --noEmit` clean.
4. Spot-check the classifier with hand-constructed inputs: a queue dominated by `design` / `architect` should yield Opus 4.7 + Adaptive on; a queue dominated by `cleanup` / `patch` / `push` should yield Sonnet 4.6 + Adaptive off; mixed should yield Opus 4.7 + Adaptive off.
5. Confirm the cross-repo edit landed: `get_file_contents` on `brdonath1/prism-framework:_templates/core-template-mcp.md` at the new HEAD shows the updated paragraph and version bump.

**Verification asymmetry note (INS-227):** the new `recommended_session_settings` field will appear in bootstrap responses post-deploy, but the framework template's instruction to surface it lives on prism-framework — both must land before the feature works end-to-end. The Trigger daemon does not auto-restart Railway services; operator-side reconnect of the PRISM MCP connector after Railway deploy SUCCESS is the standard verification gate (also INS-227).

## Out of Scope

- Do NOT change the underlying SYNTHESIS_MODEL config or any synthesis prompt — that's Phase 5 of D-191, separate brief if/when scheduled.
- Do NOT add LLM-based classification — the classifier MUST stay deterministic. Heuristic miss rate is acceptable.
- Do NOT enforce the recommendation programmatically — it's advisory.
- Do NOT add UI controls in the Claude.ai client — out of scope; the model selector already exists in the chat client and operator changes it manually.
- Do NOT delete or alter the existing Resumption Point / Deliverables sections — the new section is additive.

## PR Title / Body Hint

Title: `feat(boot+finalize): surface model-recommendation classifier in banners (S106 brief-405 / D-191)`

Body should reference: D-191 on brdonath1/prism (the strategy decision), this brief (brief-405), the cross-repo prism-framework edit, and confirm INS-227 reconnect requirement after Railway deploy.

## Brief Author Notes

Authored from PRISM session S106 (Claude.ai chat session). Per D-191 Phase 3 + INS-230 / framework template CC Channel Discipline, this is substantive cross-repo work and routes through Trigger rather than `cc_dispatch`. The post-merge `archive` action on this repo will move this file from `briefs/queue/` to `briefs/archive/` after PR merge.

If any step here surfaces an environmental blocker (failing existing tests, missing dependencies, schema mismatches with current bootstrap response shape), pause and document the blocker in the PR body rather than working around it — D-191's strategy depends on accurate measurement and the classifier landing cleanly is more valuable than a partial implementation that masks issues.

<!-- EOF: brief-405-model-recommendation-classifier.md -->
