# PRISM MCP Server — production container
# Runs as non-root user to satisfy Claude Code CLI security requirements.
# The CLI rejects --dangerously-skip-permissions (permissionMode: bypassPermissions)
# when running as root/sudo. See S146 investigation.

FROM node:22-slim

# Install system dependencies required by cc_dispatch
# git: needed by cloneRepo to clone target repos
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Create non-root user for running the server
RUN groupadd -r prism && useradd -r -g prism -m -d /home/prism prism

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install all dependencies (dev deps needed for tsc build step)
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --omit=dev

# Ensure non-root user owns the app directory and home
RUN chown -R prism:prism /app /home/prism

# Switch to non-root user
USER prism

# Railway injects PORT via env
EXPOSE 3000

CMD ["npm", "start"]
