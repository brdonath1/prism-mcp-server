# GitHub MCP Auth Proxy
# Single container: Caddy reverse proxy + GitHub MCP Server
# Caddy injects Authorization header from GITHUB_PERSONAL_ACCESS_TOKEN env var,
# enabling Claude.ai (which only supports OAuth, not custom headers) to connect.

# Stage 1: Grab the statically-compiled MCP server binary
FROM ghcr.io/github/github-mcp-server AS mcp-server

# Stage 2: Caddy alpine (includes /bin/sh for startup script)
FROM caddy:2-alpine

# Copy the Go binary from the official GitHub MCP server image
COPY --from=mcp-server /server/github-mcp-server /usr/local/bin/github-mcp-server

# Copy proxy config and startup script
COPY Caddyfile /etc/caddy/Caddyfile
COPY start.sh /start.sh

RUN chmod +x /start.sh

EXPOSE 8080

CMD ["/start.sh"]
