# PRISM MCP Server — Claude Code Project Instructions

## Project Overview

This is the **PRISM MCP Server** — a custom remote MCP (Model Context Protocol) server that handles all GitHub operations for the PRISM framework (Persistent Reasoning & Intelligent State Management). It replaces manual bash+cURL GitHub API calls with parallelized, validated, context-efficient MCP tool calls.

**Owner:** Brian (brdonath1 on GitHub)
**Framework:** PRISM — current version pinned by the framework repo's core-template; fetched dynamically at bootstrap.
**Server Version:** 4.0.0
**Status:** Production — deployed on Railway, serving all active PRISM projects.

## What PRISM Is

PRISM is a session continuity framework that gives Claude structured external memory via GitHub-backed living documents. It solves Claude's zero cross-session memory by distributing state across structured files in GitHub repositories. Brian manages all active PRISM projects; current count is visible via `prism_analytics(health_summary)`.

The MCP server is the v2 evolution — separating Claude into a pure reasoning agent while offloading all mechanical GitHub operations to this dedicated server. This reduces finalization from 13-16 tool calls to 2-3, drops bootstrap context consumption from ~15-20% to ~3-5%, and enables capabilities previously impossible (server-side validation, cross-session analytics, AI synthesis, decision graph tracking, multi-project awareness).

## Architecture

```
┌───────────────────────────────────────────────┐
│  Claude.ai Chat Session (Brian + Opus)        │
│  - Brainstorming, planning, decisions         │
│  - Calls PRISM MCP tools as needed            │
└───────────────┬───────────────────────────────┘
                │ MCP Protocol (HTTPS)
┌───────────────▼───────────────────────────────┐
│  PRISM MCP Server (Railway) — v4.0.0          │
│  18 MCP tools — stateless proxy               │
│  ├── 12 PRISM  (bootstrap/fetch/push/...)     │
│  ├──  4 Railway (logs/deploy/env/status)      │
│  └──  2 Claude Code (cc_dispatch/cc_status)   │
│  Parallelized GitHub API operations           │
│  Server-side validation + synthesis + dedup   │
└──┬──────────────────────┬──────────────────┬──┘
   │ GitHub API           │ Railway API      │ Agent SDK
   ▼                      ▼                  ▼
┌──────────────┐ ┌──────────────────┐ ┌───────────────┐
│ GitHub Repos │ │ Railway Platform │ │ Claude Code   │
│ brdonath1/*  │ │ (prod observ.)   │ │ (Agent SDK    │
│ .prism/ docs │ │                  │ │  subprocess)  │
└──────────────┘ └──────────────────┘ └───────────────┘
```

**Note:** The MemoryCache singleton and Anthropic client singleton are intentional performance optimizations — safe in stateless mode since they are read-only/config-only (A.6).

**Claude Code orchestration (brief-104):** `cc_dispatch` clones a target repo into /tmp, runs `@anthropic-ai/claude-agent-sdk` query() against it, and (in execute mode) commits results to a feature branch and opens a PR. Dispatch state is persisted to `brdonath1/prism-dispatch-state/.dispatch/{id}.json` so `cc_status` can read it across stateless requests. The separate state repo avoids Railway auto-deploy loops that would kill in-flight dispatches when state writes commit to this repo. Tools only register when `ANTHROPIC_API_KEY` is set.

## Technology Stack

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.28.x
- **HTTP framework:** Express 5.x
- **Transport:** MCP Streamable HTTP, **stateless mode** (`sessionIdGenerator: undefined`)
- **Validation:** Zod
- **AI Synthesis:** `@anthropic-ai/sdk` (Opus 4.6 for intelligence briefs)
- **Claude Code orchestration:** `@anthropic-ai/claude-agent-sdk` + `@anthropic-ai/claude-code` (subprocess)
- **GitHub API client:** Plain `fetch` (Node.js 18+ built-in) — no Octokit
- **Hosting:** Railway (persistent Node.js service)
- **Package manager:** npm

## GitHub Configuration

- **Owner:** brdonath1
- **PAT:** Set as `GITHUB_PAT` environment variable (never hardcode in source)
- **Auth Token:** Set as `MCP_AUTH_TOKEN` for Bearer authentication
- **Framework repo:** prism-framework
- **Project repos:** brdonath1/[project-slug] (e.g., prism, platformforge, snapquote)

## Environment Variables (Railway)

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITHUB_PAT` | ✅ | GitHub API auth for all read/write operations |
| `MCP_AUTH_TOKEN` | ✅ | Bearer token for MCP client auth |
| `ANTHROPIC_API_KEY` | optional | Enables intelligence-brief synthesis AND `cc_dispatch`/`cc_status` |
| `RAILWAY_API_TOKEN` | optional | Enables `railway_*` tools (brief-103) |
| `SYNTHESIS_MODEL` | optional | Override Opus model for intelligence briefs |
| `CC_DISPATCH_MODEL` | optional | Override model for Claude Code dispatches (default: `opus`) |
| `CC_DISPATCH_MAX_TURNS` | optional | Default agent turn cap (default: 50) |

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
│   ├── github/                   # GitHub API wrapper (fetch-based, parallelized)
│   ├── ai/                       # Anthropic SDK client for synthesis
│   ├── railway/                  # Railway GraphQL client (brief-103)
│   ├── claude-code/              # Agent SDK wrapper + repo clone helpers (brief-104)
│   │   ├── client.ts             # dispatchTask() — Agent SDK query() wrapper
│   │   └── repo.ts               # cloneRepo(), commitAndPushBranch()
│   ├── tools/
│   │   ├── bootstrap.ts          # prism_bootstrap
│   │   ├── fetch.ts              # prism_fetch (bare-path resolution — brief-104 A.2)
│   │   ├── push.ts               # prism_push
│   │   ├── status.ts             # prism_status
│   │   ├── finalize.ts           # prism_finalize
│   │   ├── analytics.ts          # prism_analytics
│   │   ├── scale.ts              # prism_scale_handoff
│   │   ├── search.ts             # prism_search
│   │   ├── synthesize.ts         # prism_synthesize
│   │   ├── log-decision.ts       # prism_log_decision (dedup — brief-104 A.1)
│   │   ├── log-insight.ts        # prism_log_insight
│   │   ├── patch.ts              # prism_patch
│   │   ├── railway-*.ts          # 4 Railway tools (brief-103)
│   │   ├── cc-dispatch.ts        # cc_dispatch (brief-104)
│   │   └── cc-status.ts          # cc_status (brief-104)
│   ├── middleware/               # auth + request logging
│   ├── validation/               # Server-side push validation
│   └── utils/                    # doc-resolver, doc-guard, logger, etc.
├── tests/                        # vitest unit + integration tests
└── docs/briefs/                  # Session brief files
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
- No duplicate decision IDs — `prism_log_decision` rejects with a clear error when a D-N ID already exists (brief-104 A.1)

### Commit messages:
- Must start with: `prism:`, `fix:`, `docs:`, `chore:`, `audit:`, or `test:`

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
| Audit report / audit-trail | `audit: [description]` |
| Test artifact / fixture | `test: [description]` |

## Working Preferences

- **Quality over speed** — write clean, well-structured TypeScript with JSDoc comments
- **Handle all error cases explicitly** — no silent failures
- **Log everything useful** — structured JSON to stdout, Railway captures it
- **Parallelize everything** — use `Promise.allSettled` for multi-file operations
- **Test with MCP Inspector** — `npx @modelcontextprotocol/inspector` connecting to `http://localhost:3000/mcp`

## Concurrent-write Protocol (INS-69)

Two Claudes may be operating on the same project at the same time — the
claude.ai PRISM session AND a Claude Code instance dispatched via
`cc_dispatch`. To prevent ID collisions and duplicated living-document
updates, follow these rules:

1. **Decision IDs are owned by the claude.ai session.** Only the PRISM
   session logs new D-N entries via `prism_log_decision`. Claude Code dispatches
   MUST NOT log decisions — the server-side dedup guard (brief-104 A.1) will
   reject duplicate IDs, but the contract is "don't log from two places."
2. **Living documents are updated by exactly one actor at a time.** If a
   brief targets `repo X`, the dispatched Claude Code only touches files
   under that repo. The claude.ai session updates *its* own project's
   living documents (handoff, session-log, etc.) — never the dispatched
   repo's.
3. **Briefs carry explicit scope.** Every brief lists the document scopes
   it MAY update. Claude Code treats files outside that scope as read-only.
4. **GitHub optimistic concurrency is the last line of defense.** If two
   writes race, the second one gets a 409 and the retry path re-reads the
   SHA. This works for any single file but does not solve semantic
   conflicts — the rules above do.

## Brief Status Tracking

When Claude Code starts executing a brief, it writes a status file alongside
the brief at `docs/briefs/{brief-name}.status.json`:

```json
{
  "brief": "brief-104-operations-gateway-full-stack",
  "status": "executing",
  "started_at": "2026-04-11T12:00:00Z",
  "agent": "claude-code",
  "dispatch_id": "cc-1712834400-abcdef12"
}
```

On completion, the file is updated with `"status": "completed"`, the
terminal `completed_at`, any `pr_url`, and the list of commits. The
`cc_status` tool exposes the same information for async dispatches via its
records in `brdonath1/prism-dispatch-state`.

## Trigger Workflow

This repo is enrolled in the Trigger daemon (`brdonath1/trigger`) via the marker file at `.prism/trigger.yaml`. The daemon discovers this repo, dispatches Claude Code to execute briefs autonomously, and runs post-merge actions on PR merge.

### Brief execution
- Briefs live at `docs/briefs/brief-NNN-description.md`.
- Branch strategy: feature branch from `main`, PR back to `main`. No staging branch.
- Commit prefix: `prism(SN):` where N is the session number specified in the brief.
- Every completed brief MUST end with a PR. Trigger detects PR creation via polling.

### Quality gates before PR
- `npm test` must pass
- `npx tsc --noEmit` must compile cleanly
- `npm run lint` must pass with zero warnings
- Verify changes from disk after push: re-read each modified file and confirm content matches intent

### Done criteria
- PR exists on `brdonath1/prism-mcp-server` targeting `main`
- All CI checks green
- Operator merges; Trigger fires `notify` ntfy event on merge
- State recorded in trigger repo at `state/prism-mcp-server.json` (not in this repo)

<!-- EOF: CLAUDE.md -->
