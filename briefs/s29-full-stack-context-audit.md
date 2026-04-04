# S29 Full-Stack Context & Intelligence Audit Brief

> **Target:** All 3 PRISM repos — `prism-mcp-server`, `prism-framework`, `prism` (project state repo)
> **Goal:** Identify root causes of context bloat, intelligence degradation, and memory quality issues across PRISM-managed sessions. Produce a comprehensive findings report with actionable fixes.
> **Output:** `reports/s29-context-intelligence-audit.md` in `prism-mcp-server` repo.

---

## Problem Statement

PRISM sessions across multiple projects are exhibiting three interconnected symptoms:

1. **Context bloat at boot:** Sessions start consuming ~50% of the token context window before any user work begins. This leaves insufficient room for actual work, conversation depth, and tool use.
2. **Intelligence quality degradation:** Claude's reasoning quality, instruction-following, and behavioral compliance appear to decline as sessions progress — and more severely than expected given context consumption.
3. **Memory and continuity gaps:** Cross-session continuity is inconsistent — resumption context, standing rules, and institutional knowledge are sometimes incomplete or degraded.

These symptoms have emerged gradually and now affect multiple PRISM-managed projects. The root cause may be in the MCP server (what data is assembled and how much), the framework templates (behavioral rules that get injected), the project state (accumulated data in living documents), the Claude.ai platform (changes in model behavior, tool handling, or context window management), or some combination.

---

## Pre-Flight

Before executing any analysis, sync all three repositories:

```bash
cd ~
git clone https://github.com/brdonath1/prism-mcp-server.git
git clone https://github.com/brdonath1/prism-framework.git
git clone https://github.com/brdonath1/prism.git
```

Verify all three repos cloned successfully. Then load the ENTIRE codebase into your context — every file across all three repos. This audit requires holistic understanding of how all pieces interact.

---

## Phase 1: Bootstrap Payload Analysis

The `prism_bootstrap` tool is the single largest contributor to session context. Analyze every byte it delivers.

### 1.1 — Bootstrap Response Composition

**File:** `prism-mcp-server/src/tools/bootstrap.ts`

Analyze the complete bootstrap flow and document:
- Every field in the bootstrap response object — what data it contains, where it's fetched from, and its typical size
- The `component_sizes` breakdown — verify it's accurate by cross-referencing actual content sizes
- What gets prefetched via `opening_message` keyword matching — how the prefetch algorithm works, what it matches, and whether it over-fetches
- The `behavioral_rules` field — is the full core-template-mcp.md being embedded in every bootstrap response? What's its size? Is the 5-minute cache actually reducing anything meaningful given stateless mode?
- The `intelligence_brief` field — full vs. compact mode, what triggers each, and size impact
- The `standing_rules` extraction — how insights tagged STANDING RULE are parsed and embedded
- The `banner_html` field — its size contribution (~6KB per the architecture docs)
- The `banner_data` field — redundancy with `banner_html` (both are delivered — is that necessary?)
- The `prefetched_documents` — what triggers prefetch, how much content is returned, and whether summary_mode is applied appropriately

**Key question:** If the bootstrap response delivers ~46KB (as observed in S29), what is the token-cost breakdown of each component? Estimate token counts, not just byte counts (tokens ≈ bytes/4 for English text, but structured JSON/HTML has overhead).

### 1.2 — Redundancy Analysis

Identify data that appears in multiple places within the bootstrap response:
- `resumption_point` appears in handoff AND in `banner_data` AND in `banner_html` — triple delivery
- `next_steps` appears in handoff AND in `banner_data` AND in `banner_html` — triple delivery
- `recent_decisions` vs. full decision index — overlap assessment
- `critical_context` from handoff — is any of this duplicated by `standing_rules` or `intelligence_brief`?
- `guardrails` — are these also present in the decision index? Redundant delivery?
- `warnings` — present in both response root and `banner_data`

**Key question:** How many tokens are wasted on redundant data delivery within a single bootstrap call?

### 1.3 — Prefetch Efficiency

**File:** `prism-mcp-server/src/tools/bootstrap.ts` — the prefetch logic

Analyze the keyword-matching algorithm:
- What keywords from `opening_message` and `next_steps` trigger document prefetch?
- How many documents get prefetched on average?
- Are prefetched documents returned in full or summarized?
- For the S29 bootstrap (opening_message: "Begin next session"), what triggered the prefetch of `task-queue.md`, `session-log.md`, and `architecture.md`? Was this appropriate?
- What is the total byte/token cost of prefetched documents?

**Key question:** Is the prefetch system adding more context value than the context cost it incurs? Would on-demand fetching (via `prism_fetch`) be more context-efficient?

---

## Phase 2: Behavioral Rules (Template) Analysis

The core template is the behavioral backbone of every session. Analyze it for token efficiency.

### 2.1 — Template Size Audit

**Files:**
- `prism-framework/_templates/core-template-mcp.md` (~13.3KB — the MCP version)
- `prism-framework/_templates/core-template.md` (~22.2KB — the full/fallback version)

For the MCP template:
- Break down token count by section (Operating Posture, Interaction Rules, each Rule 1-14, Module Triggers, Design Constraints)
- Identify verbose or redundant passages that could be tightened without losing behavioral fidelity
- Flag any rules that repeat concepts already covered elsewhere
- Identify rules that are rarely actionable but always loaded (e.g., module triggers for modules never used)
- Assess whether the full Design Constraints section needs to be in behavioral rules vs. loaded on demand

### 2.2 — Rule Conflict and Overlap Analysis

Cross-reference the behavioral rules against:
- Standing rules (INS-6 through INS-14) — do any standing rules duplicate or conflict with core template rules?
- Intelligence brief content — does the brief repeat behavioral guidance already in the template?
- Critical context items — do these overlap with rules?

**Key question:** If a fresh Claude reads the full behavioral rules + standing rules + intelligence brief + critical context, are there contradictions? Are there redundancies that could be consolidated?

### 2.3 — Banner Specification

**File:** `prism-framework/_templates/banner-spec.md` (~15KB)

This file defines the boot banner but is NOT loaded at session start (it's used by the server to generate `banner_html`). Verify:
- Is this file ever fetched during sessions unnecessarily?
- Does the banner HTML itself (~6KB) justify its context cost vs. a simpler text-based status display?

---

## Phase 3: MCP Server — Full Tool Audit

Every tool in the server is a potential source of context bloat or intelligence degradation.

### 3.1 — Tool Inventory and Response Size Analysis

For EACH of the 12 tools, document:
- Input schema (parameters and their sizes)
- Response schema (fields and their typical sizes)
- Average response token cost
- Whether the tool returns more data than the caller needs

**Tools to audit:**
1. `prism_bootstrap` — [Phase 1 covers this in depth]
2. `prism_fetch` — Does it return full file content even when summary would suffice? Is `summary_mode` actually reducing size meaningfully? How does the summary generation work?
3. `prism_push` — Response size after push. Is validation feedback unnecessarily verbose?
4. `prism_status` — Response includes full document inventory. How large is this for projects with 10+ docs?
5. `prism_finalize` — Audit/draft/commit modes. How large are finalization draft responses?
6. `prism_analytics` — Response sizes for different analysis types
7. `prism_scale_handoff` — Response during scaling operations
8. `prism_search` — Snippet sizes, max_results defaults, do results include too much surrounding context?
9. `prism_synthesize` — Intelligence brief generation. How large is the synthesized output?
10. `prism_log_decision` — Response after logging. Is acknowledgment verbose?
11. `prism_log_insight` — Same question
12. `prism_patch` — Response after section-level operations

### 3.2 — GitHub API Client Analysis

**Files:** `prism-mcp-server/src/github/client.ts`, `prism-mcp-server/src/github/types.ts`

Analyze:
- How files are fetched from GitHub (raw vs. API, encoding, size limits)
- The JSON+base64 mode (post-audit B.1 fix) — does decoding add overhead?
- Error handling — are error responses bloated?
- Rate limit handling — does retry logic add latency that could cause timeout issues?
- SHA management for push operations — any race conditions or stale SHA issues?

### 3.3 — Configuration and Constants

**File:** `prism-mcp-server/src/config.ts` (~7KB)

Analyze:
- All configuration constants that affect payload sizes (limits, thresholds, defaults)
- Template cache TTL and behavior — in stateless mode, does the cache actually persist across requests?
- Any hardcoded values that should be configurable

### 3.4 — Middleware Analysis

**Files:** `prism-mcp-server/src/middleware/`

Analyze:
- Auth middleware — IP allowlist implementation, performance impact
- Request logger — does logging add latency?
- Any other middleware that could affect request/response sizes or timing

### 3.5 — Validation Logic

**Files:** `prism-mcp-server/src/validation/`

Analyze:
- What validation runs on push operations
- Validation error message verbosity
- Whether validation adds significant latency to push operations

---

## Phase 4: Project State Analysis (Living Documents)

Accumulated project state can bloat bootstrap and tool responses.

### 4.1 — Living Document Size Inventory

For the `prism` repo (the PRISM framework's own project state), measure the byte size of each:
1. `handoff.md`
2. `decisions/_INDEX.md`
3. `decisions/*.md` (all domain files)
4. `session-log.md`
5. `task-queue.md`
6. `eliminated.md`
7. `architecture.md`
8. `glossary.md`
9. `known-issues.md`
10. `insights.md`
11. `intelligence-brief.md`

**Key questions:**
- Which documents have grown beyond reasonable size?
- Is the session log accumulating without bounds? (29 sessions of entries)
- Are resolved known issues still in the active section?
- Is the decision index still compact or has it bloated after reconciliation (65 decisions + 10 guardrails)?
- How large are the domain decision files?

### 4.2 — Cross-Project State Comparison

If accessible (the PAT has access to all brdonath1 repos), sample 2-3 other PRISM-managed project repos and compare:
- Handoff sizes across projects
- Decision index sizes
- Session log sizes
- Which projects have the worst bloat?

This determines if the problem is systemic (framework/server issue) or project-specific (accumulated state).

### 4.3 — Handoff Efficiency

**File:** `prism/handoff.md`

Analyze:
- Section-by-section size breakdown
- Is the resumption point concise enough?
- Does "Critical Context" contain items that should have graduated to decisions or architectural docs?
- Does "Current State" repeat information available in the session log?
- Are "Next Steps" duplicating task queue entries?

---

## Phase 5: Token Budget Analysis

This is the synthesis phase. Using findings from Phases 1-4, build a complete token budget for a typical PRISM session boot.

### 5.1 — Full Boot Token Accounting

Estimate token counts for every component that enters Claude's context window at session start:

| Component | Source | Est. Tokens | % of 200K |
|-----------|--------|-------------|-----------|
| System prompt (claude.ai) | Platform | ? | ? |
| Project Instructions | Claude project | ? | ? |
| Memory (if any) | Claude memory | ? | ? |
| Bootstrap response | MCP server | ? | ? |
| — handoff content | ↳ nested | ? | ? |
| — behavioral_rules | ↳ nested | ? | ? |
| — intelligence_brief | ↳ nested | ? | ? |
| — standing_rules | ↳ nested | ? | ? |
| — banner_html | ↳ nested | ? | ? |
| — banner_data | ↳ nested | ? | ? |
| — prefetched_docs | ↳ nested | ? | ? |
| — decision index | ↳ nested | ? | ? |
| Tool schemas (12 tools) | MCP tool_search | ? | ? |
| **Total at boot** | | **?** | **?%** |

### 5.2 — Context Window Dynamics

Analyze how context grows during a session:
- Each user message + Claude response adds to context
- Each MCP tool call adds: request params + full response to context
- Tool responses are NOT trimmed — they persist in full for the conversation
- Multiple fetches compound rapidly

**Key question:** Given the boot overhead, how many tool calls can a session make before hitting 70% (conservation mode)? How many exchanges? Is the Rule 9 estimation formula accurate, or does it systematically underestimate?

### 5.3 — Comparison to Pre-MCP Mode

The original PRISM (bash+cURL fallback in core-template.md v2.1.1) had different context characteristics. Compare:
- What was the boot overhead before MCP? (template fetch via cURL + handoff fetch)
- What is it now with MCP? (bootstrap mega-response + tool schemas)
- Has the move to MCP actually improved or worsened context efficiency?

---

## Phase 6: Intelligence and Behavioral Quality Analysis

Beyond raw token counts, investigate factors that affect Claude's reasoning quality.

### 6.1 — Instruction Density Assessment

Research and documented behavior: Claude's instruction-following degrades when context is overloaded with directives. Assess:
- Total number of distinct behavioral directives in the boot payload (core template rules + interaction rules + standing rules + critical context + guardrails)
- Are there directives that contradict or create ambiguity?
- Which directives are "always active" vs. "conditionally relevant"? Could conditional directives be deferred?
- Is the three-tier model (structural/behavioral/situational) actually reducing instruction load, or has Tier 2 grown to subsume what should be Tier 3?

### 6.2 — Tool Schema Overhead

Each of the 12 MCP tools registers a JSON schema. These schemas persist in context for the entire conversation:
- What is the total token cost of all 12 tool schemas?
- Are tool descriptions unnecessarily verbose?
- Could tool descriptions be shortened without losing callable accuracy?
- Are there tools that are rarely used but always loaded? (e.g., `prism_analytics`, `prism_scale_handoff`)

### 6.3 — Response Format Efficiency

Analyze whether MCP tool responses use token-efficient formats:
- JSON vs. plain text — JSON has structural overhead (keys, braces, quotes)
- Are large text blocks (like behavioral_rules) embedded as JSON string values? String escaping adds token overhead
- Could any responses use a more compact format?

### 6.4 — Claude.ai Platform Considerations

Document any known or suspected platform-level factors:
- Does claude.ai add its own system prompt that consumes context? (The Project Instructions are user-visible, but there may be platform-level instructions)
- How does the tool_search/deferred tool loading work? Does it add context overhead beyond the schemas themselves?
- Does the MCP connector add overhead (connection metadata, session management)?
- Has Anthropic changed how tool responses are handled in the context window recently?

---

## Phase 7: Optimization Opportunities

Based on all findings, propose specific, actionable optimizations.

### 7.1 — Quick Wins (No architectural changes)

Identify optimizations that can be implemented with minimal code changes:
- Remove redundant data from bootstrap response
- Tighten verbose text in templates/rules
- Reduce default prefetch aggressiveness
- Compress or eliminate banner_html in favor of text-only boot status
- Shorten tool descriptions

### 7.2 — Medium Effort (Server-side changes)

Propose server-side optimizations:
- Lazy loading: which bootstrap components could be deferred to on-demand fetch?
- Response streaming: could the bootstrap response be split into essential (small, fast) and supplementary (large, deferred)?
- Tiered bootstrap: a "light boot" for simple sessions vs. "full boot" for complex ones
- Tool consolidation: could any tools be merged to reduce schema count?
- Context budget tracking: could the server estimate total context impact and warn when approaching thresholds?

### 7.3 — Architectural Changes (Breaking changes or redesigns)

If the analysis reveals fundamental issues, propose larger changes:
- Restructuring the three-tier intelligence model
- Changing how behavioral rules are delivered (e.g., progressive loading)
- Redesigning the handoff format for compactness
- Splitting the bootstrap into multiple phases
- Moving some intelligence to server-side processing rather than in-context delivery

### 7.4 — Living Document Lifecycle Management

Propose strategies for managing document growth:
- Session log archival (how many sessions should be in the active log?)
- Decision index compaction (65+ decisions — should older ones move to archive?)
- Known issues pruning (resolved issues moving out of the main file)
- Insights lifecycle (INS-14 mentions ARCHIVED/DORMANT tags — but D-48 isn't implemented)

---

## Phase 8: Test Suite Review

### 8.1 — Existing Test Coverage

**Files:** `prism-mcp-server/tests/` or `prism-mcp-server/src/**/*.test.ts`

Analyze:
- Current test count and coverage
- What's tested vs. what's not
- Are bootstrap payload sizes tested? (e.g., assertions that bootstrap response < X KB)
- Are tool response sizes tested?
- Are there integration tests that simulate a full session lifecycle?

### 8.2 — Recommended Tests

Propose new tests specifically targeting the issues identified:
- Bootstrap response size regression tests
- Tool response size budget tests
- Template size budget tests
- Prefetch accuracy tests
- Context budget estimation accuracy tests

---

## Verification

After completing all phases, verify:

1. [ ] All three repos were fully loaded and analyzed
2. [ ] Every tool in the MCP server was audited
3. [ ] Bootstrap response was decomposed to individual field level
4. [ ] Token estimates are provided (not just byte counts)
5. [ ] Redundancy across bootstrap fields is quantified
6. [ ] Living document sizes are inventoried
7. [ ] At least 2 other project repos were sampled for cross-project comparison
8. [ ] Optimization proposals are categorized by effort level
9. [ ] Each finding has a severity (critical/high/medium/low) and estimated context savings
10. [ ] Report is written to `reports/s29-context-intelligence-audit.md`

---

## Post-Flight

1. Write the complete report to `prism-mcp-server/reports/s29-context-intelligence-audit.md`
2. The report should follow this structure:
   - Executive Summary (key findings + top 5 recommendations)
   - Methodology (what was analyzed, how)
   - Findings by Phase (1-8), each with severity ratings
   - Token Budget Table (the full accounting from Phase 5)
   - Optimization Roadmap (prioritized by impact and effort)
   - Appendix: Raw measurements (file sizes, token estimates, response samples)
3. Commit with message: `docs: S29 full-stack context and intelligence audit report`
4. Push to GitHub

---

## Execution Command

```bash
cd ~ && git pull origin main 2>/dev/null; cd ~/prism-mcp-server && git pull origin main && cd ~/prism-framework && git pull origin main && cd ~/prism && git pull origin main && cd ~/prism-mcp-server && cat briefs/s29-full-stack-context-audit.md
```

Then launch Claude Code:

```bash
claude --dangerously-skip-permissions --model claude-opus-4-6 --effort max
```

With instruction: **"Read and execute the brief at `briefs/s29-full-stack-context-audit.md`. Load the entire codebase from all three sibling repos (`../prism-mcp-server`, `../prism-framework`, `../prism`) into your context before beginning analysis. Produce the report exactly as specified."**

<!-- EOF: s29-full-stack-context-audit.md -->