# PRISM Intelligence Layer — Design Document

> **Session:** S22 (04-01-26)
> **Decision:** D-44 (Opus 4.6 Backend Intelligence Layer)
> **Status:** Approved — implementation via Claude Code
> **Cost model:** ~$0.25-0.40 per session (Opus 4.6 standard pricing, no caching)

---

## Problem Statement

PRISM successfully maintains structural continuity (files, decisions, task state) across sessions. However, **operational intelligence** — how workflows are performed, what mistakes to avoid, what patterns matter — is systematically lost at session boundaries. Evidence from PlatformForge v2 sessions 88-94:

- **S93:** Claude reinvented the CC brief workflow from scratch instead of following the established 90+ session pattern. Required INS-10 to codify what should have been known.
- **S94:** One session after INS-10 was written, Claude pushed a brief via `prism_push` instead of the GitHub Contents API to the `briefs` branch, used wrong section names, and missed the metadata header.
- **S88:** Claude used training knowledge about API patterns (wrong Perplexity client, wrong Grok model) instead of checking production code.

**Root cause:** The handoff (~6KB) tells Claude *where we are* but not *how we work*. Insights and operational knowledge exist in living documents but are only loaded reactively — Claude must already know something is relevant before searching for it.

---

## Architecture Overview

Two tracks, implemented together:

### Track 1: Standing Rules Auto-Loading (No API dependency)
Scan `insights.md` at bootstrap for entries tagged `STANDING RULE`. Include them in the bootstrap response so every session starts with operational procedures loaded.

### Track 2: Opus 4.6 Backend Synthesis (API integration)
After finalization commit, load ALL living documents into Opus 4.6's 1M context window via the Anthropic API. Produce an AI-synthesized `intelligence-brief.md` that is automatically loaded at the next bootstrap. One API call per session, stored as a living document.

### Data Flow

```
FINALIZATION:
  Claude commits living docs → prism_finalize(commit)
    → Server pushes files to GitHub ✓
    → Server loads ALL living docs (~30-120K tokens)
    → Server calls Opus 4.6 API with synthesis prompt
    → Server pushes intelligence-brief.md to project repo
    → Returns finalization result (synthesis runs async — does not block response)

BOOTSTRAP:
  Claude calls prism_bootstrap(slug, message)
    → Server fetches handoff, decisions, template (existing)
    → Server fetches intelligence-brief.md (NEW)
    → Server scans insights.md for STANDING RULE entries (NEW)
    → Returns everything in one response
```

---

## New Files

### 1. `src/ai/client.ts` — Anthropic API Client

```typescript
// Thin wrapper around @anthropic-ai/sdk
// - Initializes with ANTHROPIC_API_KEY from env
// - Single function: synthesize(systemPrompt, userContent, maxTokens)
// - Error handling: log and return null on failure (graceful degradation)
// - No retry logic (finalization is not blocked by synthesis failure)
```

### 2. `src/ai/prompts.ts` — Synthesis Prompts

Two prompts:

**FINALIZATION_SYNTHESIS_PROMPT** — System prompt for post-finalization intelligence brief generation. Instructs Opus to read all living documents and produce a structured intelligence brief with these sections:

1. **Project State** — What is this project, where is it right now, what just happened in the latest session
2. **Standing Rules & Workflows** — Operational procedures extracted from insights.md (entries tagged STANDING RULE) plus any implicit operational patterns identified from session history
3. **Active Operational Knowledge** — Patterns, user preferences, gotchas, and working conventions that are relevant NOW (not historical)
4. **Recent Trajectory** — Narrative of what happened over the last 3-5 sessions (not bullet points — connected narrative showing momentum and direction)
5. **Risk Flags** — Concrete things the next Claude should be careful about: active KIs, functional gaps, configuration concerns, user sensitivities
6. **Quality Audit** — Honest assessment of documentation gaps, things discussed but not captured, drift between what docs say and what's actually true

Rules for the prompt:
- Dense and specific. Every sentence carries information.
- Standing rules include exact steps, not vague references.
- Risk flags are concrete: "KI-49 means persona generation has no endpoint" not "there are some known issues."
- Total output: 2000-4000 tokens. Dense, not verbose.
- Format output as valid markdown with the section headers above.
- Include the `<!-- EOF: intelligence-brief.md -->` sentinel at the end.

**BOOTSTRAP_ENRICHMENT_PROMPT** (future enhancement) — Optional lighter prompt that tailors the intelligence brief to the user's opening message. Not in initial implementation — load the stored brief as-is.

### 3. `src/ai/synthesize.ts` — Synthesis Pipeline

```typescript
// Core function: generateIntelligenceBrief(projectSlug, sessionNumber)
// 1. Fetch ALL living documents via fetchFiles()
// 2. Concatenate into a single context block with file headers
// 3. Call Opus 4.6 via client.synthesize()
// 4. Parse response, validate it has required sections
// 5. Push intelligence-brief.md to project repo
// 6. Return { success, bytes, tokens_used, cost_estimate }
//
// Error handling:
// - If ANTHROPIC_API_KEY is not set → skip silently, log info
// - If API call fails → log error, return { success: false }
// - Never throw — synthesis failure must not break finalization
```

### 4. `src/tools/synthesize.ts` — New MCP Tool (9th tool)

```typescript
// prism_synthesize(project_slug, mode)
// mode: "generate" — manually trigger intelligence brief generation
// mode: "status" — check if intelligence-brief.md exists and when it was last updated
//
// Use case: on-demand regeneration if the brief is stale or after manual doc edits
```

---

## Modified Files

### 5. `src/config.ts`

Add:
```typescript
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-opus-4-6";
export const SYNTHESIS_ENABLED = !!process.env.ANTHROPIC_API_KEY;
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 4096;
```

Update `LIVING_DOCUMENTS` array — add `"intelligence-brief.md"` as the 10th entry. Update comment to reference D-44.

### 6. `src/tools/bootstrap.ts`

Two additions to the bootstrap flow:

**A. Standing rules extraction (Track 1):**
After fetching insights.md (which may already be in the prefetch set), scan for `STANDING RULE` in the text. Extract each INS-N entry that contains this tag. Include as a new `standing_rules` array in the response.

```typescript
// After existing prefetch logic:
const standingRules = extractStandingRules(insightsContent);
// standingRules = [{ id: "INS-10", title: "CC Brief Workflow", content: "..." }, ...]
```

**B. Intelligence brief loading (Track 2):**
Always attempt to fetch `intelligence-brief.md`. If it exists, include its full content in `prefetched_documents` with a flag `is_intelligence_brief: true`. If it doesn't exist (new project, or synthesis not yet run), skip silently.

Add to response object:
```typescript
standing_rules: standingRules,           // Track 1
intelligence_brief: intelligenceBrief,   // Track 2 (full content or null)
```

### 7. `src/tools/finalize.ts`

After successful commit phase, trigger synthesis asynchronously:

```typescript
// In commitPhase, after all files are pushed and verified:
if (SYNTHESIS_ENABLED) {
  // Fire-and-forget — do NOT await this
  generateIntelligenceBrief(project_slug, session_number)
    .then(result => {
      logger.info("post-finalization synthesis complete", {
        project_slug,
        session_number,
        success: result.success,
        tokens: result.tokens_used,
      });
    })
    .catch(err => {
      logger.error("post-finalization synthesis failed", {
        project_slug,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
```

Add to commit phase response:
```typescript
synthesis_triggered: SYNTHESIS_ENABLED,
```

### 8. `src/index.ts`

Add import and registration:
```typescript
import { registerSynthesize } from "./tools/synthesize.js";
// In createServer():
registerSynthesize(server);
```

### 9. `package.json`

Add dependency:
```json
"@anthropic-ai/sdk": "^0.52.0"
```

---

## intelligence-brief.md Schema

```markdown
# Intelligence Brief — {Project Name}

> AI-synthesized session intelligence. Generated by Opus 4.6 at finalization.
> Last synthesized: S{N} ({date})
> Tokens used: {input_tokens} in / {output_tokens} out
> Model: claude-opus-4-6

## Project State
{Dense summary — more contextual than handoff's "Where We Are"}

## Standing Rules & Workflows
{Extracted from insights.md STANDING RULE entries + identified operational patterns}

## Active Operational Knowledge
{Patterns, preferences, gotchas relevant RIGHT NOW}

## Recent Trajectory
{Narrative of last 3-5 sessions}

## Risk Flags
{Concrete things to be careful about}

## Quality Audit
{Documentation gaps, drift, uncaptured knowledge}

<!-- EOF: intelligence-brief.md -->
```

---

## Cost Analysis (Verified)

Opus 4.6 standard pricing: $5/M input, $25/M output (1M context at standard rates, no long-context surcharge as of March 2026).

| Project | Living docs size | Input tokens | Output tokens | Cost/call |
|---|---|---|---|---|
| PRISM | 87KB | ~25K | ~3K | $0.20 |
| PlatformForge v2 | 120KB | ~35K | ~3K | $0.25 |
| Large project (200KB) | 200KB | ~55K | ~4K | $0.38 |

Monthly estimate at 30 sessions: **$6-12/month** without caching.

With prompt caching (system prompt reuse): ~30-40% reduction → **$4-8/month**.

---

## Environment Variables (Railway)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | For Track 2 | (none) | Anthropic API key for Opus 4.6 synthesis |
| `SYNTHESIS_MODEL` | No | `claude-opus-4-6` | Model to use for synthesis calls |

Track 1 (standing rules extraction) works without any new env vars.

---

## Error Handling & Graceful Degradation

1. **No ANTHROPIC_API_KEY set:** Track 1 works normally. Track 2 is silently disabled. Log: `"Synthesis disabled — ANTHROPIC_API_KEY not configured"`
2. **API call fails (timeout, 500, rate limit):** Finalization succeeds normally. Synthesis failure is logged. intelligence-brief.md retains its previous version (stale but still useful).
3. **API returns malformed content:** Log warning, don't push. Previous intelligence-brief.md survives.
4. **intelligence-brief.md doesn't exist at bootstrap:** Skip silently. Bootstrap works exactly as today. This is the expected state for new projects until their first finalization with synthesis enabled.

---

## Testing Strategy

1. **Unit tests for standing rules extraction:** Mock insights.md content with STANDING RULE entries, verify extraction.
2. **Unit tests for synthesis prompt assembly:** Verify all living docs are concatenated correctly with headers.
3. **Integration test for Anthropic client:** Mock API response, verify intelligence-brief.md is valid markdown with required sections.
4. **End-to-end:** Run full bootstrap → work → finalize cycle on a test project. Verify intelligence-brief.md appears. Bootstrap again and verify it's loaded.

---

## Decision Record

**D-44: Opus 4.6 Backend Intelligence Layer**
- Domain: architecture
- Status: APPROVED
- Reasoning: Operational intelligence (workflows, patterns, standing rules) is systematically lost at session boundaries despite being captured in living documents. Root cause: handoff carries *what* and *where* but not *how*. Solution: use Opus 4.6 1M context API to synthesize all living documents into a dense intelligence brief at finalization, loaded automatically at next bootstrap. Track 1 (standing rules extraction) provides immediate tactical improvement without API dependency. Track 2 (AI synthesis) provides transformative intelligence transfer.
- Cost: ~$0.25/session, ~$8-12/month at heavy usage
- Impact: New dependency (@anthropic-ai/sdk), new env var (ANTHROPIC_API_KEY), new living document (intelligence-brief.md — 10th mandatory doc), new MCP tool (prism_synthesize — 9th tool), modified bootstrap response, modified finalization pipeline
- Assumptions: Opus 4.6 API remains at $5/$25 per MTok. Project living doc corpus stays under 200KB (well within 1M window).
- Decided: Session 22
