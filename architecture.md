# Architecture — PRISM MCP Server

## Stack
- **Runtime:** Node.js >= 18, TypeScript (strict mode)
- **MCP SDK:** @modelcontextprotocol/sdk v1.28.x (Streamable HTTP, stateless mode)
- **HTTP:** Express 5.x
- **Validation:** Zod (peer dependency of MCP SDK)
- **GitHub API:** Plain fetch with thin wrapper (no Octokit)
- **Hosting:** Railway (persistent Node.js service)
- **Package manager:** npm

## System Design

### Request Flow
```
Claude.ai/Desktop/Code → POST /mcp → new McpServer + StreamableHTTPServerTransport
→ tool handler → GitHub API (parallel fetch/push) → structured JSON response
```

Each request is fully independent. No server-side state. Transport created per-request with `sessionIdGenerator: undefined`.

### Tool Architecture (7 tools)
| Tool | Purpose | GitHub Operations |
|------|---------|-------------------|
| prism_bootstrap | Session initialization | Parallel fetch: handoff + decisions + template version |
| prism_fetch | File retrieval | Parallel fetch with optional summary mode |
| prism_push | File push with validation | Validate → parallel (SHA fetch + push + verify) |
| prism_status | Health check | Check all 8 living docs exist + handoff metadata |
| prism_finalize | Session finalization | Audit: fetch all 8 docs. Commit: backup + parallel push |
| prism_analytics | Cross-session metrics | Fetch + parse session-log, decisions, commits |
| prism_scale_handoff | Handoff redistribution | Fetch handoff → identify sections → redistribute to docs |

### Validation Layer
Server-side validation runs before every push:
- EOF sentinel check (`<!-- EOF: {filename} -->`)
- Commit prefix check (prism:, fix:, docs:, chore:)
- Handoff required sections (Meta, Critical Context, Where We Are)
- Decision index format (D-N IDs, valid statuses)
- Size threshold warnings (10KB warning, 15KB critical)

### GitHub API Client
Thin wrapper around fetch with:
- Parallel operations via Promise.allSettled
- Automatic SHA management for push operations
- 404 graceful handling (file doesn't exist ≠ error)
- 429 rate limit retry (wait + retry once)
- 409 conflict retry (fresh SHA + retry once)
- 401 auth error with clear messaging

## Infrastructure
- **Railway project:** prism-mcp-server
- **URL:** https://prism-mcp-server-production.up.railway.app
- **Health:** GET /health → {"status":"ok","version":"2.0.0"}
- **MCP endpoint:** POST/GET/DELETE /mcp
- **Environment variables:** GITHUB_PAT, GITHUB_OWNER, FRAMEWORK_REPO, PORT, LOG_LEVEL

## Project Structure
```
src/
├── index.ts           # Express app + MCP server setup
├── config.ts          # Environment variables, constants
├── github/
│   ├── client.ts      # GitHub API wrapper
│   └── types.ts       # GitHub API response types
├── tools/
│   ├── bootstrap.ts   # prism_bootstrap
│   ├── fetch.ts       # prism_fetch
│   ├── push.ts        # prism_push
│   ├── status.ts      # prism_status
│   ├── finalize.ts    # prism_finalize
│   ├── analytics.ts   # prism_analytics
│   └── scale.ts       # prism_scale_handoff
├── validation/
│   ├── index.ts       # Validation orchestrator
│   ├── handoff.ts     # Handoff-specific rules
│   ├── decisions.ts   # Decision index rules
│   └── common.ts      # EOF sentinel, commit prefix
└── utils/
    ├── summarizer.ts  # Content summarization
    └── logger.ts      # Structured logging
```

<!-- EOF: architecture.md -->
