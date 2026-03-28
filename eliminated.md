# Eliminated Approaches — PRISM MCP Server

> Rejected approaches with rationale. Check before re-proposing.

### G-1: Octokit as GitHub client
- Rejected: CC Session 1
- Reason: 300KB+ dependency for simple REST calls. Node.js 18+ built-in fetch is sufficient. Only need Contents API (GET/PUT) and Repos/Commits API (GET).
- Reconsider if: GitHub API usage grows to require pagination, GraphQL, or complex auth flows.

### G-2: Server-side session persistence
- Rejected: CC Session 1
- Reason: PRISM's state model is GitHub-native. Adding Redis/SQLite creates sync problems, deployment complexity, and contradicts the stateless proxy design. `sessionIdGenerator: undefined` enforces this.
- Reconsider if: A use case emerges requiring cross-request state that can't live in GitHub (e.g., long-running background jobs).

### G-3: Cloudflare Workers as hosting platform
- Rejected: Session 7 (PRISM S7 Architecture E investigation)
- Reason: Workers can't maintain SSE streams needed for MCP Streamable HTTP transport. Request/response model is incompatible with streaming protocol.
- Reconsider if: MCP protocol adds a non-streaming transport option.

### G-4: Vercel as hosting platform
- Rejected: Session 7
- Reason: Serverless function timeout limits (10-60s depending on plan) are too close to MCP's 60s hard limit. Cold starts add latency. Persistent server on Railway is more reliable for streaming.
- Reconsider if: Vercel adds persistent server support or MCP reduces timeout requirements.

<!-- EOF: eliminated.md -->
