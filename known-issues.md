# Known Issues — PRISM MCP Server

> Active bugs, workarounds, tech debt.

## Active

(no active issues)

## Resolved

### KI-4: prism_scale_handoff fails silently on large handoffs
- **Severity:** moderate
- **Discovered:** Session 10 (03-27-26)
- **Resolved:** Session 11 (03-27-26)
- **Root cause:** MCP client (Claude.ai) enforces a 60-second timeout on tool calls. The scale_handoff operation performs multiple sequential stages of parallel GitHub API calls that exceeded this window on 20KB+ handoffs.
- **Fix:** Added three execution modes (full/analyze/execute) with MCP progress notifications that reset the 60s client timeout, a 50s safety valve, parallelized all GitHub operations, and structured error propagation with stage/timing info. Added 10 new vitest tests (42 total).

### KI-1: session_patterns analytics returns 0 sessions
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Resolved:** Session 10 (03-27-26)
- **Fix:** Rewrote `sessionPatterns` in `src/tools/analytics.ts` to match actual session-log header formats. MCP server v2.1.0.

### KI-2: decision_graph returns fully-connected adjacency
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Resolved:** Session 10 (03-27-26)
- **Fix:** Removed `contentBlocks` complete-graph loop. Per-row scanning handles cross-references correctly. MCP server v2.1.0.

### KI-3: No automated tests
- **Severity:** moderate
- **Discovered:** CC Session 3
- **Resolved:** Session 10 (03-27-26)
- **Fix:** Added vitest with 3 test suites (32 tests): summarizer utils, handoff validation, analytics parsing.

<!-- EOF: known-issues.md -->