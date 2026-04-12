#!/bin/sh
set -e

echo "Starting GitHub MCP Server on port 8082..."
/usr/local/bin/github-mcp-server http --port 8082 &
MCP_PID=$!

# Wait for MCP server to be ready
sleep 2

echo "Starting Caddy reverse proxy on port ${PORT}..."
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
