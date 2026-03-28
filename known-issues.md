# Known Issues — PRISM MCP Server

> Active bugs, workarounds, tech debt.

## Active

### KI-1: session_patterns analytics returns 0 sessions
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Description:** `prism_analytics(metric: "session_patterns")` returns `total_sessions: 0` with all fields empty. The date parsing regex in the analytics tool doesn't match the actual date format used in session-log.md entries (e.g., "### Session 7 (03-23-26 CST)").
- **Workaround:** Other analytics metrics (decision_velocity, health_summary, fresh_eyes_check) work correctly.
- **Fix path:** Update the session date regex in `src/tools/analytics.ts` to match the `MM-DD-YY CST` format.

### KI-2: decision_graph returns fully-connected adjacency
- **Severity:** minor
- **Discovered:** CC Session 3 (battle test)
- **Description:** `prism_analytics(metric: "decision_graph")` returns every decision connected to every other decision (338 edges for 26 decisions — a complete graph). Should parse actual cross-references (e.g., "D-24" mentioned in D-25's reasoning).
- **Workaround:** Decision velocity and status breakdown are accurate. Graph connectivity is the only broken metric.
- **Fix path:** Rewrite the adjacency builder in `src/tools/analytics.ts` to scan each decision's full text for `D-{N}` references instead of generating all pairs.

### KI-3: No automated tests
- **Severity:** moderate
- **Discovered:** CC Session 3
- **Description:** Server has zero automated tests. All verification was manual during battle test. Risk of regressions when fixing bugs or adding features.
- **Workaround:** Manual testing via curl or MCP Inspector.
- **Fix path:** Add test suite with at minimum: health endpoint, tool registration, validation rules, mock GitHub responses.

## Resolved

(none yet)

<!-- EOF: known-issues.md -->
