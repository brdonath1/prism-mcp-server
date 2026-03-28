# Known Issues — PRISM MCP Server

> Active bugs, workarounds, tech debt.

## Active

### KI-4: prism_scale_handoff fails silently on large handoffs
- **Severity:** moderate
- **Discovered:** Session 10 (03-27-26)
- **Description:** `prism_scale_handoff(project_slug: "snapquote-ai", dry_run: false)` returned a generic `{"error": "Error occurred during tool execution"}` with no actionable detail. `prism_fetch` against the same repo also failed with the same generic error. The handoff was 20.4KB with 46 inline decisions — a legitimately large file that is exactly the scenario where scaling is needed most.
- **Root cause hypothesis:** The scale_handoff tool performs multiple parallel GitHub operations (fetch handoff, analyze sections, identify redistribution targets, fetch target living documents, compose new content, push multiple files). A 20KB handoff with 46 decisions likely pushed the total operation time past Railway's or the MCP transport's timeout threshold. The generic error suggests the failure occurred at the transport/infrastructure level (timeout or memory), not in application logic — application-level errors return structured error messages with details.
- **Reproduction steps:**
  1. Have a project with a handoff >15KB containing many inline decisions (e.g., 46)
  2. Call `prism_scale_handoff(project_slug, dry_run: false)`
  3. Observe generic error with no details
  4. Note: `prism_fetch` for the same project also fails, suggesting the issue may be broader than just scale_handoff
- **Impact:** When the tool fails, the operator must fall back to bash+cURL for manual scaling. This defeats the purpose of the MCP server for the exact scenario (large handoffs) where automated scaling is most valuable.
- **Workaround:** Fall back to bash+cURL. Fetch the handoff via GitHub API, manually parse and redistribute sections, push the lean handoff and extracted files individually. This is what was done for SnapQuote in Session 10.
- **Fix path (investigate in CC):**
  1. **Add timeout instrumentation:** Log elapsed time at each stage of scale_handoff (fetch, analyze, redistribute, push) to identify which stage hits the limit.
  2. **Check Railway timeout config:** Default Railway request timeout may be too short for multi-stage operations. Investigate if the timeout is configurable.
  3. **Check MCP transport timeout:** The Streamable HTTP transport or Claude.ai's connector may have its own timeout that's shorter than Railway's.
  4. **Consider chunked execution:** Break scale_handoff into stages — `prism_scale_handoff(action: "analyze")` returns a plan, then `prism_scale_handoff(action: "execute", plan: ...)` executes it. This reduces per-call work and gives the client visibility into progress.
  5. **Improve error propagation:** Even if a timeout kills the operation, the server should catch the error and return a structured message like `{"error": "Operation timed out after Nms during [stage]", "partial_results": {...}}` instead of the generic transport error.
  6. **Test with the fixed SnapQuote:** After fixing, re-test by temporarily restoring the 20KB handoff from `snapquote-ai/handoff-history/handoff_v16_2026-03-27.md` and running scale_handoff against it.

## Resolved

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