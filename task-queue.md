# Task Queue — PRISM MCP Server

> Prioritized work items.

## In Progress

(none)

## Up Next

1. **Run test suite in CI** — vitest is added but no CI pipeline exists yet. Consider GitHub Actions.
2. **Expand test coverage** — Add integration tests with mocked GitHub API responses for tool-level testing.

## Blocked

(none)

## Parking Lot

1. **OAuth support** — Multi-user access if PRISM is ever shared. Not needed for personal use. (CC-S3)
2. **Rate limit dashboard** — Monitor GitHub API usage across all tool calls. (CC-S3)
3. **Webhook auto-deploy** — GitHub webhook triggers Railway redeploy on push. (CC-S3)
4. **Performance metrics** — Track response times per tool, GitHub API latency. (CC-S3)

## Recently Completed

- **[S10] Fixed session_patterns analytics** — KI-1 resolved. Regex now matches actual session-log header formats.
- **[S10] Fixed decision_graph analytics** — KI-2 resolved. Removed contentBlocks complete-graph loop.
- **[S10] Added request logging middleware** — Structured JSON logs for all HTTP requests with method, path, status, timing.
- **[S10] Added automated test suite** — vitest with 3 test files covering summarizer utils, handoff validation, and analytics parsing.
- **[S10] Version bumped to 2.1.0** — Reflects bug fixes and new features.
- **[CC-S3] Deployed to Railway** — Server live at prism-mcp-server-production.up.railway.app
- **[CC-S3] Battle tested all 7 tools** — Bootstrap, fetch, push, status, finalize, analytics, scale
- **[CC-S3] Framework v2.0.0** — Core template updated with MCP paths
- **[CC-S2] Intelligence layer** — Finalize, analytics, scale_handoff tools
- **[CC-S1] Server scaffold + core tools** — Bootstrap, fetch, push, status + validation

<!-- EOF: task-queue.md -->