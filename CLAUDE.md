# PRISM MCP Server — Claude Code Project Instructions

## Project Overview

This is the **PRISM MCP Server** — a custom remote MCP (Model Context Protocol) server that handles all GitHub operations for the PRISM framework (Persistent Reasoning & Intelligent State Management). It replaces manual bash+cURL GitHub API calls with parallelized, validated, context-efficient MCP tool calls.

**Owner:** Brian (brdonath1 on GitHub)
**Framework:** PRISM v2.9.0
**Server Version:** 2.9.0
**Status:** Production — deployed on Railway, serving 17 PRISM projects

## What PRISM Is

PRISM is a session continuity framework that gives Claude structured external memory via GitHub-backed living documents. It solves Claude's zero cross-session memory by distributing state across structured files in GitHub repositories. Brian manages 17 active PRISM projects.

The MCP server is the v2 evolution — separating Claude into a pure reasoning agent while offloading all mechanical GitHub operations to this dedicated server. This reduces finalization from 13-16 tool calls to 2-3, drops bootstrap context consumption from ~15-20% to ~3-5%, and enables capabilities previously impossible (server-side validation, cross-session analytics, AI synthesis, decision graph tracking, multi-project awareness).

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
│  12 MCP tools — stateless proxy         │
│  Parallelized GitHub API operations     │
│  Server-side validation + synthesis     │
│  Returns structured summaries           │
└────────────────┬────────────────────────┘
                 │ GitHub API
┌────────────────▼────────────────────────┐
│  GitHub Repos (brdonath1/*)             │
│  10 living documents per project        │
│  Framework: brdonath1/prism-framework   │
└─────────────────────────────────────────┘
```

**Note:** The MemoryCache singleton and Anthropic client singleton are intentional performance optimizations — safe in stateless mode since they are read-only/config-only (A.6).

## Technology Stack

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.28.x
- **HTTP framework:** Express 5.x
- **Transport:** MCP Streamable HTTP, **stateless mode** (`sessionIdGenerator: undefined`)
- **Validation:** Zod
- **AI Synthesis:** `@anthropic-ai/sdk` (Opus 4.6 for intelligence briefs)
- **GitHub API client:** Plain `fetch` (Node.js 18+ built-in) — no Octokit
- **Hosting:** Railway (persistent Node.js service)
- **Package manager:** npm

## GitHub Configuration

- **Owner:** brdonath1
- **PAT:** Set as `GITHUB_PAT` environment variable (never hardcode in source)
- **Auth Token:** Set as `MCP_AUTH_TOKEN` for Bearer authentication
- **Framework repo:** prism-framework
- **Project repos:** brdonath1/[project-slug] (e.g., prism, platformforge, snapquote)

## Key Technical Constraints

1. **MCP tool call counting:** Each MCP tool invocation counts as 1 tool call against Claude.ai's per-turn limit, regardless of how much work the server does internally.
2. **Response size:** ~25K token limit for MCP responses. Server MUST return structured summaries, not raw file dumps.
3. **Timeout:** ~60 second hard limit. Parallelized GitHub operations should complete in 5-8 seconds. Safe zone is <30 seconds.
4. **Stateless:** No server-side persistence. All state lives in GitHub. Each request is independent.

## Project Structure

```
prism-mcp-server/
├── package.json
├── tsconfig.json
├── CLAUDE.md                     # This file
├── .env.example                  # Template for env vars
├── src/
│   ├── index.ts                  # Express app + MCP server setup + transport
│   ├── config.ts                 # Environment variables, constants
│   ├── github/
│   │   ├── client.ts             # GitHub API wrapper (fetch-based, parallelized)
│   │   └── types.ts              # GitHub API response types
│   ├── ai/
│   │   ├── client.ts             # Anthropic SDK client for synthesis
│   │   ├── prompts.ts            # Synthesis prompt templates
│   │   └── synthesize.ts         # Intelligence brief generation
│   ├── tools/
│   │   ├── bootstrap.ts          # prism_bootstrap
│   │   ├── fetch.ts              # prism_fetch
│   │   ├── push.ts               # prism_push
│   │   ├── status.ts             # prism_status
│   │   ├── finalize.ts           # prism_finalize
│   │   ├── analytics.ts          # prism_analytics
│   │   ├── scale.ts              # prism_scale_handoff
│   │   ├── search.ts             # prism_search
│   │   ├── synthesize.ts         # prism_synthesize
│   │   ├── log-decision.ts       # prism_log_decision
│   │   ├── log-insight.ts        # prism_log_insight
│   │   └── patch.ts              # prism_patch
│   ├── middleware/
│   │   ├── auth.ts               # Bearer token authentication
│   │   └── request-logger.ts     # Request logging middleware
│   ├── validation/
│   │   ├── index.ts              # Validation orchestrator
│   │   ├── handoff.ts            # Handoff-specific validation rules
│   │   ├── decisions.ts          # Decision index validation rules
│   │   ├── common.ts             # EOF sentinel, commit prefix, general rules
│   │   └── slug.ts               # Project slug + file path sanitization
│   └── utils/
│       ├── summarizer.ts         # Content summarization for context efficiency
��       ├── banner.ts             # Server-rendered boot banner HTML (D-35)
│       ├── cache.ts              # In-memory cache with TTL
│       └── logger.ts             # Structured logging
├── tests/
│   ├── intelligence-layer.test.ts
│   ├── scale.test.ts
│   ├── push-validation.test.ts
│   ├── finalize.test.ts
│   ├── bootstrap-parsing.test.ts
│   └── validation-extended.test.ts
└── briefs/                       # Session brief files
```

## PRISM Living Documents (10 Mandatory Per Project)

Every PRISM project repo has these 10 files. The MCP server reads, writes, and validates all of them:

1. `handoff.md` — Lean state pointer (target: <10KB, critical threshold: 15KB)
2. `decisions/_INDEX.md` — Decision registry (NEVER compressed or deleted)
3. `session-log.md` — Session history (append-only)
4. `task-queue.md` — Prioritized work items
5. `eliminated.md` — Rejected approaches with rationale
6. `architecture.md` — Stack, system design, infrastructure
7. `glossary.md` — Project-specific terminology
8. `known-issues.md` — Active bugs, workarounds, tech debt
9. `insights.md` — Institutional knowledge, standing rules (D-41)
10. `intelligence-brief.md` — AI-synthesized project state summary (D-44)

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
- Size warning if content would exceed 15KB
- Must NOT reference "session chat" or "previous conversation" as artifact locations

### decisions/_INDEX.md:
- Must contain a markdown table with columns: ID, Title, Domain, Status, Session
- Each decision must have D-N format ID
- Status must be: SETTLED, PENDING, SUPERSEDED, REVISITED, ACCEPTED, or OPEN
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
- **Parallelize everything** — use `Promise.allSettled` for multi-file operations
- **Test with MCP Inspector** — `npx @modelcontextprotocol/inspector` connecting to `http://localhost:3000/mcp`

<!-- EOF: CLAUDE.md -->
