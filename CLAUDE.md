# PRISM MCP Server — Claude Code Project Instructions

## Project Overview

This is the **PRISM MCP Server** — a custom remote MCP (Model Context Protocol) server that handles all GitHub operations for the PRISM framework (Persistent Reasoning & Intelligent State Management). It replaces manual bash+cURL GitHub API calls with parallelized, validated, context-efficient MCP tool calls.

**Owner:** Brian (brdonath1 on GitHub)
**Framework:** PRISM v2.0.0
**Status:** Active build — 3 sessions planned

## What PRISM Is

PRISM is a session continuity framework that gives Claude structured external memory via GitHub-backed living documents. It solves Claude's zero cross-session memory by distributing state across structured files in GitHub repositories. Brian manages 12 active PRISM projects across 15 repos.

The MCP server is the v2 evolution — separating Claude into a pure reasoning agent while offloading all mechanical GitHub operations to this dedicated server. This reduces finalization from 13-16 tool calls to 2-3, drops bootstrap context consumption from ~15-20% to ~3-5%, and enables capabilities previously impossible (server-side validation, cross-session analytics, decision graph tracking, multi-project awareness).

## Architecture

```
┌─────────────────────────────────────────┐
│  Claude.ai Chat Session (Brian + Opus)  │
│  - Brainstorming, planning, decisions   │
│  - Full conversational experience       │
│  - Calls PRISM MCP tools as needed      │
└────────────────┬────────────────────────┘
                 │ MCP Protocol (HTTPS)
┌────────────────▼────────────────────────┐
│  PRISM MCP Server (Railway)             │
│                                         │
│  Tools:                                 │
│  ─ prism_bootstrap(project_slug)        │
│  ─ prism_fetch(project, files[])        │
│  ─ prism_push(project, files[])         │
│  ─ prism_status(project?)               │
│  ─ prism_finalize(project, action)      │
│  ─ prism_analytics(project?, metric)    │
│  ─ prism_scale_handoff(project)         │
│                                         │
│  Stateless — reads/writes GitHub only   │
│  Parallelized GitHub operations         │
│  Returns structured summaries           │
└────────────────┬────────────────────────┘
                 │ GitHub API
┌────────────────▼────────────────────────┐
│  GitHub Repos (unchanged)               │
│  brdonath1/prism-framework              │
│  brdonath1/[project-slug]               │
│  8 living documents per project         │
└─────────────────────────────────────────┘
```

## Technology Stack (Locked)

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.28.x (v1.x branch — NOT v2 pre-alpha)
- **Express middleware:** `@modelcontextprotocol/express` (if available on npm; fall back to raw StreamableHTTPServerTransport if not)
- **HTTP framework:** Express 5.x
- **Transport:** MCP Streamable HTTP, **stateless mode** (`sessionIdGenerator: undefined`)
- **Validation:** Zod (peer dependency of MCP SDK)
- **GitHub API client:** Plain `fetch` (Node.js 18+ built-in) — no Octokit
- **Hosting:** Railway (persistent Node.js service)
- **Package manager:** npm

## GitHub Configuration

- **Owner:** brdonath1
- **PAT:** Set as `GITHUB_PAT` environment variable (never hardcode in source)
- **Framework repo:** prism-framework
- **Project repos:** brdonath1/[project-slug] (e.g., prism, platformforge, snapquote)

## Key Technical Constraints (Verified)

1. **MCP tool call counting:** Each MCP tool invocation counts as 1 tool call against Claude.ai's per-turn limit, regardless of how much work the server does internally. This is the core thesis — finalization drops from 13-16 to 2-3 calls.
2. **Response size:** ~25K token limit for MCP responses. Server MUST return structured summaries, not raw file dumps.
3. **Timeout:** ~60 second hard limit. Parallelized GitHub operations should complete in 5-8 seconds. Safe zone is <30 seconds.
4. **Stateless:** No server-side persistence. All state lives in GitHub. Each request is independent.

## Project Structure

```
prism-mcp-server/
├── package.json
├── tsconfig.json
├── CLAUDE.md                     # This file
├── .env                          # Local env vars (gitignored)
├── .env.example                  # Template for env vars
├── .gitignore
├── README.md
├── src/
│   ├── index.ts                  # Express app + MCP server setup + transport
│   ├── config.ts                 # Environment variables, constants
│   ├── github/
│   │   ├── client.ts             # GitHub API wrapper (fetch-based, parallelized)
│   │   └── types.ts              # GitHub API response types
│   ├── tools/
│   │   ├── bootstrap.ts          # prism_bootstrap tool
│   │   ├── fetch.ts              # prism_fetch tool
│   │   ├── push.ts               # prism_push tool
│   │   ├── status.ts             # prism_status tool
│   │   ├── finalize.ts           # prism_finalize tool (Session 2)
│   │   ├── analytics.ts          # prism_analytics tool (Session 2)
│   │   └── scale.ts              # prism_scale_handoff tool (Session 2)
│   ├── validation/
│   │   ├── index.ts              # Validation orchestrator
│   │   ├── handoff.ts            # Handoff-specific validation rules
│   │   ├── decisions.ts          # Decision index validation rules
│   │   └── common.ts             # EOF sentinel, commit prefix, general rules
│   └── utils/
│       ├── summarizer.ts         # Content summarization for context efficiency
│       └── logger.ts             # Structured logging
```

## Build Sessions

### Session 1: Foundation (Current)
Server scaffold + 4 core tools (prism_bootstrap, prism_fetch, prism_push, prism_status) + server-side validation layer.

### Session 2: Intelligence Layer
3 remaining tools (prism_finalize, prism_analytics, prism_scale_handoff) — finalization with drift detection, cross-session analytics with decision graph, server-side handoff scaling.

### Session 3: Deploy + Battle Test
Deploy to Railway, connect to Claude.ai as custom connector, battle-test on real PRISM project, update framework to v2.0.0.

## PRISM Living Documents (8 Mandatory Per Project)

Every PRISM project repo has these 8 files. The MCP server reads, writes, and validates all of them:

1. `handoff.md` — Lean state pointer (target: <10KB, critical threshold: 15KB)
2. `decisions/_INDEX.md` — Decision registry (NEVER compressed or deleted)
3. `session-log.md` — Session history (append-only)
4. `task-queue.md` — Prioritized work items
5. `eliminated.md` — Rejected approaches with rationale
6. `architecture.md` — Stack, system design, infrastructure
7. `glossary.md` — Project-specific terminology
8. `known-issues.md` — Active bugs, workarounds, tech debt

All .md files MUST end with `<!-- EOF: {filename} -->`.

## Validation Rules (Server-Side Enforcement)

### All .md files:
- Must end with `<!-- EOF: {filename} -->` where filename matches actual filename
- Must not be empty
- Must be valid UTF-8

### handoff.md:
- Must contain `## Meta` section with: Handoff Version, Session Count, Template Version, Status
- Must contain `## Critical Context` section with at least 1 numbered item
- Must contain `## Where We Are` section (non-empty)
- Handoff Version must be >= current version
- Size warning if content would exceed 15KB
- Must NOT reference "session chat" or "previous conversation" as artifact locations

### decisions/_INDEX.md:
- Must contain a markdown table with columns: ID, Title, Domain, Status, Session
- Each decision must have D-N format ID
- Status must be: SETTLED, PENDING, SUPERSEDED, or REVISITED
- No duplicate decision IDs

### Commit messages:
- Must start with: `prism:`, `fix:`, `docs:`, or `chore:`

## Commit Prefixes

| Action | Prefix |
|--------|--------|
| Session finalization | `prism: finalize session N [date]` |
| Mid-session checkpoint | `prism: checkpoint [date]` |
| Artifact creation/update | `prism: artifact [filename]` |
| Version rotation | `prism: supersede [filename]` |
| Handoff backup | `prism: handoff-backup vN` |
| Project scaffold | `prism: scaffold [project-name]` |
| Decision domain split | `prism: split decisions` |
| Reference extraction | `prism: extract [filename]` |

## Working Preferences

- **Quality over speed** — write clean, well-structured TypeScript with JSDoc comments
- **Handle all error cases explicitly** — no silent failures
- **Log everything useful** — structured JSON to stdout, Railway captures it
- **Make it extendable** — Session 2 adds more tools to the same server
- **Parallelize everything** — use `Promise.allSettled` for multi-file operations
- **Test with MCP Inspector** — `npx @modelcontextprotocol/inspector` connecting to `http://localhost:3000/mcp`

---

# SESSION 1 BUILD SPECIFICATION

Everything below is the detailed specification for Session 1. Build all of this.

## Server Setup (src/index.ts)

Use the official MCP SDK pattern for Streamable HTTP with Express:

```typescript
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
```

**Critical: Stateless mode.** Set `sessionIdGenerator: undefined` on the transport. PRISM's state lives entirely in GitHub — the MCP server is a stateless proxy. Every request creates a new transport and server instance.

The server should:
1. Create a new `McpServer` and `StreamableHTTPServerTransport` per request (stateless pattern)
2. Register all tools on the server
3. Handle POST /mcp, GET /mcp, DELETE /mcp as per the MCP Streamable HTTP spec
4. Include a GET /health endpoint that returns `{ status: "ok", version: "2.0.0" }`
5. Listen on `process.env.PORT || 3000`

## Environment Variables

```env
GITHUB_PAT=<set in .env locally, Railway env var in production>
GITHUB_OWNER=brdonath1
FRAMEWORK_REPO=prism-framework
PORT=3000
LOG_LEVEL=info
```

## GitHub API Client (src/github/client.ts)

Build a thin wrapper around Node.js `fetch` for GitHub API operations.

### Core Methods

```typescript
interface GitHubClient {
  fetchFile(repo: string, path: string): Promise<{ content: string; sha: string; size: number }>;
  fetchFiles(repo: string, paths: string[]): Promise<Map<string, { content: string; sha: string; size: number }>>;
  pushFile(repo: string, path: string, content: string, message: string): Promise<{ success: boolean; size: number; sha: string; error?: string }>;
  pushFiles(repo: string, files: Array<{ path: string; content: string; message: string }>): Promise<Array<{ path: string; success: boolean; size: number; sha: string; error?: string }>>;
  fileExists(repo: string, path: string): Promise<boolean>;
  getFileSize(repo: string, path: string): Promise<number>;
  listRepos(): Promise<string[]>;
}
```

**Patterns:**
- All repo parameters are just the repo name (e.g., "prism"). Full path `brdonath1/{repo}` is constructed internally.
- Use `Accept: application/vnd.github.raw+json` for raw content fetches.
- For push: fetch SHA first, then PUT with base64-encoded content. Atomic per file.
- For parallel operations: use `Promise.allSettled` so one failure doesn't abort others.
- Handle 404s gracefully (file doesn't exist — not always an error).
- Handle rate limiting (429): wait and retry once.
- Handle auth errors (401): clear error message about PAT.
- Handle conflicts (409): retry once with fresh SHA.
- Log all API calls at debug level with timing.

## Tool 1: prism_bootstrap

**Purpose:** Initialize a PRISM session. Fetches handoff, decision index, and optionally relevant living documents. Returns structured summary, NOT raw content.

### Input Schema
```typescript
{
  project_slug: z.string().describe("Project repo name (e.g., 'platformforge', 'prism', 'snapquote')"),
  opening_message: z.string().optional().describe("User's opening message. Enables intelligent pre-fetching of relevant living documents.")
}
```

### Behavior
1. Fetch in parallel: `{project_slug}/handoff.md` (required), `{project_slug}/decisions/_INDEX.md` (optional), `prism-framework/_templates/core-template.md` first 10 lines (version check)
2. Mandatory size check: if handoff > 15,360 bytes, set `scaling_required: true`
3. Intelligent pre-fetching if `opening_message` provided — map keywords to living documents:
   - "architecture", "stack", "infrastructure", "deploy", "integration" → architecture.md
   - "bug", "issue", "error", "workaround", "debt" → known-issues.md
   - "term", "definition", "glossary" → glossary.md
   - "task", "priority", "next", "queue", "backlog", "plan" → task-queue.md
   - "reject", "eliminate", "guardrail", "why not", "tried" → eliminated.md
   - "session", "history", "last time", "previous" → session-log.md
4. Parse handoff into structured sections (Meta, Critical Context, Where We Are, Recent Decisions, etc.)
5. Return structured summary with `bytes_delivered` for context tracking

### Output Format
```typescript
{
  project: string,
  handoff_version: number,
  template_version: string,
  session_count: number,
  handoff_size_bytes: number,
  scaling_required: boolean,
  critical_context: string[],
  current_state: string,
  resumption_point: string,
  recent_decisions: Array<{ id: string, title: string, status: string }>,
  guardrails: Array<{ id: string, summary: string }>,
  next_steps: string[],
  open_questions: string[],
  prefetched_documents: Array<{ file: string, size_bytes: number, summary: string }>,
  bytes_delivered: number,
  files_fetched: number,
  warnings: string[]
}
```

## Tool 2: prism_fetch

**Purpose:** Fetch files from a PRISM project repo with optional summary mode.

### Input Schema
```typescript
{
  project_slug: z.string(),
  files: z.array(z.string()).describe("File paths relative to repo root"),
  summary_mode: z.boolean().optional().default(false).describe("Return summaries for files >5KB")
}
```

### Behavior
1. Fetch all files in parallel
2. If summary_mode and file > 5KB: return first 500 chars + section headers + size
3. Otherwise: return full content
4. Track bytes_delivered

### Output Format
```typescript
{
  project: string,
  files: Array<{
    path: string, exists: boolean, size_bytes: number,
    content: string | null, summary: string | null, is_summarized: boolean
  }>,
  bytes_delivered: number,
  files_fetched: number
}
```

## Tool 3: prism_push

**Purpose:** Push files with server-side validation.

### Input Schema
```typescript
{
  project_slug: z.string(),
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    message: z.string()
  })),
  skip_validation: z.boolean().optional().default(false)
}
```

### Behavior
1. Validate ALL files first. If any fail, push NONE. Return all errors.
2. Push all validated files in parallel (SHA-fetch + push + verify per file)
3. Return per-file results with validation errors/warnings

### Output Format
```typescript
{
  project: string,
  results: Array<{
    path: string, success: boolean, size_bytes: number, sha: string,
    verified: boolean, validation_errors: string[], validation_warnings: string[]
  }>,
  all_succeeded: boolean,
  files_pushed: number,
  files_failed: number,
  total_bytes: number
}
```

## Tool 4: prism_status

**Purpose:** Health status for one project or all projects.

### Input Schema
```typescript
{
  project_slug: z.string().optional().describe("Specific project or omit for all"),
  include_details: z.boolean().optional().default(false)
}
```

### Behavior
- Single project: fetch handoff metadata, check all 8 living documents exist, return health report
- Multi-project: list all repos with handoff.md, fetch metadata for each, return cross-project summary
- Health scoring: healthy (all 8 docs, <15KB handoff), needs-attention (1-2 missing docs or 10-15KB), critical (3+ missing or >15KB)

## Error Handling

- GitHub 401 → "GitHub PAT is invalid or expired."
- GitHub 404 → Distinguish repo vs file missing
- GitHub 409 → Retry once with fresh SHA
- GitHub 429 → Wait for retry-after, retry once
- All errors → Return structured MCP content: `{ content: [{ type: "text", text: JSON.stringify(errorObject) }] }`
- Timeout → All operations must complete within 30 seconds

## Definition of Done

1. `npm run build` compiles with zero errors
2. `npm start` launches on port 3000
3. GET /health returns `{ status: "ok", version: "2.0.0" }`
4. MCP Inspector connects to http://localhost:3000/mcp
5. prism_bootstrap returns structured summary for a real project
6. prism_fetch returns file contents
7. prism_push validates and rejects bad content
8. prism_push successfully pushes valid content (test with scratch file)
9. prism_status returns health for single and multi-project
10. All GitHub operations parallelized
11. Stateless mode (no session persistence)

## Do NOT in Session 1:
- Deploy to Railway
- Implement finalize, analytics, or scale_handoff tools
- Set up OAuth
- Add automated tests
- Build a frontend
