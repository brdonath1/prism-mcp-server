# GitHub MCP Auth Proxy

A single Docker container that runs a **Caddy reverse proxy** in front of the official **GitHub MCP Server**, injecting a GitHub Personal Access Token as the `Authorization` header on every upstream request.

This solves a specific integration gap: the GitHub MCP server (`ghcr.io/github/github-mcp-server`) requires a Bearer token in the `Authorization` header for HTTP mode, but Claude.ai's custom MCP connector only supports OAuth Client ID/Secret — not custom headers.

## Architecture

```
┌──────────────────┐         ┌──────────────────────────────────────┐
│   Claude.ai      │  HTTPS  │  Docker Container (Railway)          │
│   MCP Connector  │────────▶│                                      │
│   (no auth hdr)  │         │  ┌──────────────────────────────┐   │
└──────────────────┘         │  │  Caddy (PORT)                │   │
                             │  │  + Injects Authorization hdr │   │
                             │  │  + Injects X-MCP-Toolsets    │   │
                             │  └──────────────┬───────────────┘   │
                             │                 │ localhost:8082     │
                             │  ┌──────────────▼───────────────┐   │
                             │  │  github-mcp-server (HTTP)    │   │
                             │  │  (official GitHub binary)    │   │
                             │  └──────────────┬───────────────┘   │
                             └─────────────────┼───────────────────┘
                                               │ GitHub API
                                               ▼
                             ┌──────────────────────────────────────┐
                             │  api.github.com                      │
                             └──────────────────────────────────────┘
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Yes | GitHub PAT — injected by Caddy as `Authorization: Bearer <token>` on every request to the MCP server |
| `GITHUB_TOOLSETS` | Yes | Comma-separated MCP toolsets to enable (e.g. `repos,issues,pull_requests,code_security`) — passed via `X-MCP-Toolsets` header |
| `PORT` | Auto | Set automatically by Railway — Caddy listens on this port |

## Deployment (Railway)

1. Create a new Railway project
2. Connect this GitHub repo as the source
3. Railway auto-detects the `Dockerfile` and builds the image
4. Set environment variables:
   - `GITHUB_PERSONAL_ACCESS_TOKEN` — your GitHub PAT with appropriate scopes
   - `GITHUB_TOOLSETS` — e.g. `repos,issues,pull_requests,code_security`
5. Deploy — Railway assigns a public URL and sets `PORT` automatically

## How It Works

1. **`start.sh`** launches the GitHub MCP server binary on `localhost:8082`, then starts Caddy
2. **Caddy** listens on the Railway-assigned `PORT` and reverse-proxies all traffic to `localhost:8082`
3. On every upstream request, Caddy injects:
   - `Authorization: Bearer <GITHUB_PERSONAL_ACCESS_TOKEN>`
   - `X-MCP-Toolsets: <GITHUB_TOOLSETS>`
4. The MCP server receives the token via the `Authorization` header on each request — it does not need the env var directly
5. Claude.ai connects to the public Railway URL as a standard MCP endpoint — no custom headers needed on the client side

## Key Details

- The `github-mcp-server` binary from the official image is **statically compiled Go** — runs on Alpine without additional dependencies
- Caddy's Alpine image includes `/bin/sh`, enabling the startup script
- Caddy's `header_up` directive in `reverse_proxy` injects headers on upstream (outgoing) requests only
- The `{$ENV_VAR}` syntax is Caddy v2's environment variable expansion in Caddyfile config
