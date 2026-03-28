# Known Issues — PRISM MCP Server

> Active bugs, workarounds, tech debt.

## Active

(none)

## Resolved

### KI-1: session_patterns analytics returns 0 sessions
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Resolved:** Session 10 (03-27-26)
- **Description:** `prism_analytics(metric: "session_patterns")` returned `total_sessions: 0` with all fields empty. The date parsing regex didn't match the actual date format used in session-log.md entries (e.g., "### Session 7 (03-23-26 CST)").
- **Fix:** Rewrote `sessionPatterns` in `src/tools/analytics.ts` to match `### Session N (MM-DD-YY CST)`, `### Session N (MM-DD-YY HH:MM:SS CST)`, `### CC Session N (...)`, and legacy `### Session N (YYYY-MM-DD)` header formats. Date is now extracted directly from the header line.

### KI-2: decision_graph returns fully-connected adjacency
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Resolved:** Session 10 (03-27-26)
- **Description:** `prism_analytics(metric: "decision_graph")` returned every decision connected to every other decision (338 edges for 26 decisions). The "scan full content" loop split the _INDEX.md by `## ` headers, putting all table rows in one block and linking every D-N to every other D-N.
- **Fix:** Removed the `contentBlocks` complete-graph loop. Per-row scanning correctly extracts actual D-N cross-references from each row's Title/Reasoning content.

### KI-3: No automated tests
- **Severity:** moderate
- **Discovered:** CC Session 3
- **Resolved:** Session 10 (03-27-26)
- **Description:** Server had zero automated tests.
- **Fix:** Added vitest with 3 test suites: `tests/summarizer.test.ts` (utility functions), `tests/validation.test.ts` (handoff validation rules), `tests/analytics-parsing.test.ts` (KI-1/KI-2 fix verification with session header and adjacency parsing tests).

<!-- EOF: known-issues.md -->