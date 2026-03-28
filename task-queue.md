# Task Queue — PRISM MCP Server

> Prioritized work items.

## In Progress

(none)

## Up Next

1. **Fix session_patterns analytics** — Date parsing in session-log.md returns 0 sessions. The regex likely doesn't match the date format used in actual session logs.
2. **Fix decision_graph analytics** — Returns fully-connected adjacency (every decision linked to every other). Should parse actual cross-references between decisions.
3. **Railway GitHub integration** — Connect GitHub repo for auto-deploy on push instead of manual `railway up`.
4. **Add automated tests** — At minimum: health endpoint, tool registration, validation rules.
5. **Add request logging middleware** — Structured JSON logs for all MCP requests with timing.

## Blocked

(none)

## Parking Lot

1. **OAuth support** — Multi-user access if PRISM is ever shared. Not needed for personal use. (CC-S3)
2. **Rate limit dashboard** — Monitor GitHub API usage across all tool calls. (CC-S3)
3. **Webhook auto-deploy** — GitHub webhook triggers Railway redeploy on push. (CC-S3)
4. **Performance metrics** — Track response times per tool, GitHub API latency. (CC-S3)

## Recently Completed

- **[CC-S3] Deployed to Railway** — Server live at prism-mcp-server-production.up.railway.app
- **[CC-S3] Battle tested all 7 tools** — Bootstrap, fetch, push, status, finalize, analytics, scale
- **[CC-S3] Framework v2.0.0** — Core template updated with MCP paths
- **[CC-S2] Intelligence layer** — Finalize, analytics, scale_handoff tools
- **[CC-S1] Server scaffold + core tools** — Bootstrap, fetch, push, status + validation

<!-- EOF: task-queue.md -->
