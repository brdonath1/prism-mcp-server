# PRISM MCP Server — production container
# Runs as non-root user to satisfy Claude Code CLI security requirements.
# The CLI rejects --dangerously-skip-permissions (permissionMode: bypassPermissions)
# when running as root/sudo. See S146 investigation.

# Pinned by tag and digest to the Node production runs (= .node-version / mise.toml). Bump tag and digest
# together, never the tag alone.
FROM node:22.23.3-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

# Install system dependencies required by cc_dispatch
# git: needed by cloneRepo to clone target repos
# ca-certificates: needed for HTTPS (git clone from GitHub)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

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
