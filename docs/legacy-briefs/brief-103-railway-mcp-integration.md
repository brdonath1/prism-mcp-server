# Brief 103: Railway API Integration for PRISM MCP Server

> **Priority:** HIGH
> **Target Repo:** `brdonath1/prism-mcp-server` (NOT platformforge-v2)
> **Session:** S143 (PlatformForge-v2)
> **Author:** PRISM Session (Claude.ai)
> **Date:** 2026-04-11

---

## Objective

Extend the PRISM MCP Server with a Railway API integration module. This adds infrastructure operations tools alongside the existing `prism_*` project-state tools, enabling Claude.ai sessions to directly query Railway logs, manage deployments, inspect environment variables, and check service health — eliminating the copy-paste friction that currently costs 2-3 exchanges per debugging cycle.

This is Phase 1 of a broader Operations Gateway architecture. Phase 2 (Claude Code orchestration via Agent SDK) will follow once Railway tools are proven.

---

## Strategic Context

The PRISM MCP Server currently manages project state (handoffs, decisions, documents) via GitHub API. This brief extends it into a **full operations platform** by adding infrastructure operations. The same server, same Railway deployment, same claude.ai connector — just new tool modules.

This is project-agnostic. Every PRISM-managed project that deploys to Railway benefits from this integration automatically.

### Value Demonstrated

During S143, we tested Railway's GraphQL API directly from claude.ai's bash environment and:
- Pulled runtime logs for PlatformForge-v2's latest deployment
- Read all 38 environment variables
- Verified model settings (AI_MODEL, VOICE_AI_MODEL)
- Identified and deleted a stale env var (VOICE_AI_MODEL)
- Diagnosed code-vs-config discrepancies

All without the operator touching the Railway dashboard. This brief formalizes that capability as native MCP tools.

---

## Architecture

### Current Server Structure
```
src/
├── config.ts              # Environment variables, constants
├── index.ts               # Express app + MCP server setup
├── github/
│   ├── client.ts          # GitHub API wrapper (20KB)
│   └── types.ts           # GitHub API response types
├── tools/
│   ├── bootstrap.ts       # prism_bootstrap
│   ├── fetch.ts           # prism_fetch
│   ├── push.ts            # prism_push
│   ├── status.ts          # prism_status
│   ├── finalize.ts        # prism_finalize
│   ├── analytics.ts       # prism_analytics
│   ├── scale.ts           # prism_scale_handoff
│   ├── search.ts          # prism_search
│   ├── synthesize.ts      # prism_synthesize
│   ├── log-decision.ts    # prism_log_decision
│   ├── log-insight.ts     # prism_log_insight
│   └── patch.ts           # prism_patch
├── validation/            # Push validation rules
└── utils/                 # Summarizer, logger, cache, etc.
```

### Target Structure (additions only)
```
src/
├── railway/               # ← NEW MODULE
│   ├── client.ts          # Railway GraphQL API wrapper
│   └── types.ts           # Railway API response types
├── tools/
│   ├── railway-logs.ts    # ← NEW: railway_logs
│   ├── railway-deploy.ts  # ← NEW: railway_deploy
│   ├── railway-env.ts     # ← NEW: railway_env
│   └── railway-status.ts  # ← NEW: railway_status
```

Plus updates to `config.ts` (new env vars) and `index.ts` (register new tools).

---

## Railway GraphQL API Reference

**Endpoint:** `https://backboard.railway.app/graphql/v2`
**Auth:** Bearer token in Authorization header
**Token:** Workspace-scoped token stored in `RAILWAY_API_TOKEN` env var

### Verified Queries (tested in S143)

All of the following were tested against Railway's production API and confirmed working.

#### List Projects
```graphql
{
  projects {
    edges {
      node {
        id
        name
      }
    }
  }
}
```

#### Project Details (services + environments)
```graphql
{
  project(id: "PROJECT_ID") {
    name
    services {
      edges {
        node {
          id
          name
        }
      }
    }
    environments {
      edges {
        node {
          id
          name
        }
      }
    }
  }
}
```

#### Latest Deployment
```graphql
{
  deployments(first: 1, input: {
    serviceId: "SERVICE_ID",
    environmentId: "ENV_ID"
  }) {
    edges {
      node {
        id
        status
        createdAt
      }
    }
  }
}
```

#### Deployment Logs
```graphql
{
  deploymentLogs(deploymentId: "DEPLOYMENT_ID", limit: 50) {
    ... on Log {
      message
      timestamp
      severity
    }
  }
}
```

#### Environment Variables
```graphql
{
  variables(
    projectId: "PROJECT_ID",
    serviceId: "SERVICE_ID",
    environmentId: "ENV_ID",
    unrendered: false
  )
}
```
Note: Returns a flat JSON object `{ KEY: "value", ... }`, not an array.

#### Delete Variable
```graphql
mutation {
  variableDelete(input: {
    projectId: "PROJECT_ID",
    serviceId: "SERVICE_ID",
    environmentId: "ENV_ID",
    name: "VAR_NAME"
  })
}
```

#### Upsert Variable
```graphql
mutation {
  variableUpsert(input: {
    projectId: "PROJECT_ID",
    serviceId: "SERVICE_ID",
    environmentId: "ENV_ID",
    name: "VAR_NAME",
    value: "VAR_VALUE"
  })
}
```

### Additional Queries to Implement (not yet tested — verify against API)

#### Redeploy
```graphql
mutation {
  deploymentRedeploy(id: "DEPLOYMENT_ID") {
    id
    status
  }
}
```

#### Restart (no rebuild)
```graphql
mutation {
  deploymentRestart(id: "DEPLOYMENT_ID") {
    id
    status
  }
}
```

#### Environment Logs (all services)
```graphql
{
  environmentLogs(
    environmentId: "ENV_ID",
    limit: 50,
    filter: "@level:error"
  ) {
    ... on Log {
      message
      timestamp
      severity
    }
  }
}
```

---

## Tool Specifications

### Tool 1: `railway_logs`

**Purpose:** Fetch deployment or environment logs with optional filtering.

**Input Schema:**
```typescript
{
  project: z.string().describe("Project name or ID"),
  service: z.string().optional().describe("Service name or ID. Omit for environment-wide logs"),
  environment: z.string().optional().default("production").describe("Environment name or ID"),
  limit: z.number().optional().default(50).describe("Number of log lines (max 200)"),
  filter: z.string().optional().describe("Railway filter syntax: @level:error, keyword search, etc."),
  type: z.enum(["deploy", "build", "http"]).optional().default("deploy").describe("Log type")
}
```

**Behavior:**
1. Resolve project name → ID (cache project list)
2. If service provided, resolve service name → ID
3. Resolve environment name → ID
4. If service: get latest deployment → fetch deployment logs
5. If no service: fetch environment logs (all services)
6. Apply filter if provided
7. Return structured response with logs, deployment status, timestamps

**Response:**
```json
{
  "project": "PlatformForge-v2",
  "service": "platformforge-v2",
  "environment": "production",
  "deployment": { "id": "...", "status": "SUCCESS", "createdAt": "..." },
  "log_count": 50,
  "logs": [
    { "timestamp": "...", "severity": "error", "message": "..." }
  ]
}
```

### Tool 2: `railway_deploy`

**Purpose:** Manage deployments — list recent, redeploy, restart, check status.

**Input Schema:**
```typescript
{
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z.string().optional().default("production"),
  action: z.enum(["status", "list", "redeploy", "restart"]).default("status").describe("Action to perform"),
  count: z.number().optional().default(5).describe("Number of deployments to list (for 'list' action)")
}
```

**Behavior:**
- `status`: Fetch current deployment status, uptime, created timestamp
- `list`: Fetch last N deployments with status and timestamps
- `redeploy`: Trigger a full redeploy (build + deploy)
- `restart`: Restart without rebuilding

**Safety:** `redeploy` and `restart` mutations should include a confirmation field in the response ("Redeployed service X in environment Y. Deployment ID: Z").

### Tool 3: `railway_env`

**Purpose:** Read, set, and delete environment variables.

**Input Schema:**
```typescript
{
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z.string().optional().default("production"),
  action: z.enum(["list", "get", "set", "delete"]).default("list"),
  name: z.string().optional().describe("Variable name (required for get/set/delete)"),
  value: z.string().optional().describe("Variable value (required for set)"),
  mask_values: z.boolean().optional().default(true).describe("Mask sensitive values in output")
}
```

**Behavior:**
- `list`: Fetch all variables. Mask values by default (show first 6 chars + `***`). Keys containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `URL` with credentials are always masked.
- `get`: Fetch a single variable's value (unmasked)
- `set`: Upsert a variable
- `delete`: Delete a variable

**Security:** API keys and secrets should be masked in `list` output by default. The `get` action returns unmasked values for specific variables when explicitly requested.

### Tool 4: `railway_status`

**Purpose:** High-level project/service health overview.

**Input Schema:**
```typescript
{
  project: z.string().optional().describe("Project name or ID. Omit to list all projects"),
  include_services: z.boolean().optional().default(true).describe("Include service details")
}
```

**Behavior:**
- No project: List all accessible projects with basic status
- With project: Show project details, all services with latest deployment status, environments
- Include service-level info: current deployment status, last deploy time, service URL if available

---

## Implementation Details

### Railway Client (`src/railway/client.ts`)

Model after `src/github/client.ts` — thin wrapper around fetch with:
- Single `railwayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T>` function
- Bearer token auth from `RAILWAY_API_TOKEN` config
- Error handling: parse GraphQL errors, surface clear messages
- Typed response generics
- No external dependencies (plain fetch, like the GitHub client)

### Railway Types (`src/railway/types.ts`)

Type definitions for:
- `RailwayProject`, `RailwayService`, `RailwayEnvironment`
- `RailwayDeployment` (id, status, createdAt, canRollback)
- `RailwayLog` (message, timestamp, severity)
- `RailwayVariable` (key-value pairs)
- GraphQL response wrappers (edges/node pattern)

### Name-to-ID Resolution

Tools accept human-readable names ("PlatformForge-v2", "production") but the API needs UUIDs. Implement a resolution layer:
1. `resolveProject(nameOrId: string)` — fetch project list, match by name (case-insensitive) or pass through if UUID format
2. `resolveService(projectId: string, nameOrId: string)` — fetch project services, match by name
3. `resolveEnvironment(projectId: string, nameOrId: string)` — fetch project environments, match by name
4. Use in-memory cache (per-request lifetime, since server is stateless) to avoid redundant lookups within a single tool call

### Config Changes (`src/config.ts`)

Add:
```typescript
/** Railway API token (workspace-scoped) */
export const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN ?? "";

/** Railway GraphQL API endpoint */
export const RAILWAY_API_ENDPOINT = "https://backboard.railway.app/graphql/v2";

/** Whether Railway tools are enabled (requires API token) */
export const RAILWAY_ENABLED = !!process.env.RAILWAY_API_TOKEN;
```

### Index Changes (`src/index.ts`)

Add conditional registration:
```typescript
import { RAILWAY_ENABLED } from "./config.js";
import { registerRailwayLogs } from "./tools/railway-logs.js";
import { registerRailwayDeploy } from "./tools/railway-deploy.js";
import { registerRailwayEnv } from "./tools/railway-env.js";
import { registerRailwayStatus } from "./tools/railway-status.js";

// In createServer():
if (RAILWAY_ENABLED) {
  registerRailwayLogs(server);
  registerRailwayDeploy(server);
  registerRailwayEnv(server);
  registerRailwayStatus(server);
}
```

Conditional registration means the server still works without `RAILWAY_API_TOKEN` — existing PRISM tools are unaffected.

### Tool Registration Pattern

Follow the exact same pattern as existing tools. Example skeleton:
```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { railwayQuery } from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  // ... other fields
};

export function registerRailwayLogs(server: McpServer): void {
  server.tool(
    "railway_logs",
    "Fetch deployment or environment logs from Railway with optional filtering.",
    inputSchema,
    async ({ project, ...rest }) => {
      const start = Date.now();
      logger.info("railway_logs", { project, ...rest });
      try {
        // Implementation
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Error handling
      }
    }
  );
}
```

---

## Testing

### Unit Tests (vitest)
Add test files alongside existing tests:
- `tests/railway-client.test.ts` — Mock GraphQL responses, verify query construction
- `tests/railway-tools.test.ts` — Test name resolution, response formatting, error handling

### Integration Verification
After deployment, verify each tool from claude.ai:
1. `railway_status` — List all projects
2. `railway_status` with project — Show PlatformForge-v2 services
3. `railway_logs` — Fetch latest deployment logs
4. `railway_logs` with filter — Fetch error-only logs
5. `railway_env` list — List all env vars (masked)
6. `railway_env` get — Get specific variable value
7. `railway_deploy` status — Check current deployment

---

## Environment Setup

### Railway Dashboard
Add `RAILWAY_API_TOKEN` to the prism-mcp-server service in Railway:
- **Key:** `RAILWAY_API_TOKEN`
- **Value:** `308b0c3b-bbbd-4d3a-a205-9cb3e487d427`
- **Environment:** production

### Version Bump
Bump `SERVER_VERSION` in `config.ts` from `2.14.0` → `3.0.0` (major version — new capability surface).

---

## Known Railway API IDs (for testing)

| Entity | Name | ID |
|--------|------|----|
| Project | PlatformForge-v2 | `60692ab9-d35f-4115-a57e-750c8a99c948` |
| Project | prism-mcp-server | `582f7768-0ec6-4801-8f6b-f031750fe3be` |
| Service | platformforge-v2 | `af6e1e2a-8dc5-4fcc-b5ce-a8b26561a79b` |
| Service | pipeline-worker | `573f2df3-9b69-4715-b319-82a3ddd8dd0d` |
| Service | Redis | `61da7c85-b99b-4216-80b3-3dd0d17c5524` |
| Service | cpkb-monitor | `3b6a469e-c012-40d9-928e-d78b6baeb4e7` |
| Environment | production | `f34d918a-03ab-422f-a33a-98b9bd331b8a` |
| Environment | preview | `0076ec01-742e-4c85-a884-d9d9f1ae330a` |

---

## Constraints

1. **No new dependencies.** Use plain `fetch` for the Railway client, matching the GitHub client pattern. No graphql-request, no Apollo, no Octokit.
2. **Stateless.** No server-side caching across requests. Each tool call is independent.
3. **50-second timeout.** All operations must complete within `MCP_SAFE_TIMEOUT` (50s). Log queries with large limits may need pagination.
4. **Graceful degradation.** If `RAILWAY_API_TOKEN` is not set, Railway tools simply don't register. Existing PRISM tools are unaffected.
5. **Security.** Never log or return full API key values. Mask by default in `railway_env` list output. The Railway token itself should never appear in tool responses.
6. **TypeScript strict mode.** Match existing codebase conventions — no `any`, explicit types.

---

## Success Criteria

1. All 4 Railway tools register and respond correctly when `RAILWAY_API_TOKEN` is set
2. Existing 12 PRISM tools continue working unchanged
3. Name-to-ID resolution works for projects, services, and environments
4. Log retrieval returns structured, filterable output
5. Environment variable operations (list, get, set, delete) work correctly with value masking
6. Deployment management (status, list, redeploy, restart) works correctly
7. Tests pass (vitest)
8. Server deploys cleanly to Railway

---

## Post-Deployment

After successful deployment:
1. **No connector changes needed** — claude.ai already connects to the PRISM MCP server. New tools appear automatically.
2. **Test from a live PRISM session** — Verify `railway_logs`, `railway_env`, `railway_status` work from claude.ai.
3. **Update prism-mcp-server PRISM docs** — Architecture, handoff, task-queue.
4. **Log decision** — D-116 in PlatformForge-v2 decisions (or next available ID).

<!-- EOF: brief-103-railway-mcp-integration.md -->
