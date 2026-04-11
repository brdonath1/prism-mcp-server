# Brief 104: Operations Gateway Full Stack — PRISM MCP Server v4.0

> **Priority:** HIGH — Strategic infrastructure for all PRISM projects
> **Target Repo:** `brdonath1/prism-mcp-server`
> **Session:** S143 (PlatformForge-v2)
> **Author:** PRISM Session (Claude.ai)
> **Date:** 2026-04-11
> **Execution:** Metaswarm agent team — 3 parallel workstreams

---

## Executive Summary

Transform the PRISM MCP Server from a project-state + Railway-ops tool into a full **Operations Gateway** with three capabilities:

1. **Framework fixes** — Server-side dedup for `prism_log_decision`, path resolution fix for `prism_fetch`
2. **Claude Code orchestration** — New `cc_dispatch` and `cc_status` tools using the Anthropic Agent SDK to programmatically dispatch tasks to Claude Code from claude.ai sessions
3. **Coordination protocol** — Brief status tracking and concurrent-write safety between claude.ai sessions and Claude Code

**Version bump:** 3.0.0 → 4.0.0 (new capability surface + breaking behavior change in dedup)

---

## ⚠️ CRITICAL: Coordination Rules (INS-69)

**Do NOT log any decisions (prism_log_decision) from this brief.** The claude.ai PRISM session will handle all D-N logging to prevent ID collisions — the exact problem this brief partially solves.

**Do NOT update PlatformForge-v2 living documents.** This brief targets `brdonath1/prism-mcp-server` only. The PRISM session will update PF-v2 docs post-merge.

**Document scopes this brief MAY update:**
- `brdonath1/prism-mcp-server/` — all source code, tests, CLAUDE.md, package.json
- `brdonath1/prism-mcp-server/.prism/` — architecture.md, session-log.md, task-queue.md (prism-mcp-server's own PRISM docs)

---

## Workstream A: Framework Fixes (Can parallelize with B and C)

### A.1: Server-Side Dedup for `prism_log_decision`

**Problem:** When two actors (claude.ai session + Claude Code) log the same D-N ID concurrently, both writes succeed and create duplicate entries in `_INDEX.md` and the domain file. In S143, two D-116 entries were created 13 minutes apart.

**Fix:** In `src/tools/log-decision.ts`, before writing:
1. Fetch current `_INDEX.md` for the target project
2. Parse existing decision IDs
3. If the requested D-N ID already exists, **reject the write** with a clear error message:
   ```
   Decision ID D-116 already exists in _INDEX.md (title: "..."). Use a different ID or update the existing entry via prism_patch.
   ```
4. Only proceed with the atomic write if the ID is unique

**Edge case:** Two concurrent requests with the same ID could both pass the check. This is acceptable — the GitHub API's SHA-based optimistic concurrency will cause the second push to fail with a 409 conflict, which the existing retry logic handles. The retry should re-check for duplicates before retrying.

**Test:** Add vitest test: attempt to log a decision with an ID that already exists → expect rejection error.

### A.2: Path Resolution Fix for `prism_fetch`

**Problem:** `prism_fetch` passes file paths literally to `fetchFile()` instead of using `resolveDocPath()`. When a caller requests `decisions/_INDEX.md`, the tool looks for it at the repo root instead of `.prism/decisions/_INDEX.md`. Workaround exists (use explicit `.prism/` prefix) but this violates the framework's doc-resolution contract.

**Fix:** In `src/tools/fetch.ts`:
1. Import `resolveDocPath` from `../utils/doc-resolver.js`
2. For each requested file path, check if it matches a known living document name pattern
3. If it does, resolve it through `resolveDocPath` which handles the `.prism/` vs root detection
4. If it doesn't match (arbitrary file path), pass through as-is

**Important:** Do NOT break existing callers that already use `.prism/` prefix. The resolution should be additive — if `.prism/decisions/_INDEX.md` is requested, use it directly. If `decisions/_INDEX.md` is requested, resolve to `.prism/decisions/_INDEX.md`.

**Test:** Add vitest test: fetch `decisions/_INDEX.md` without prefix → expect resolution to `.prism/decisions/_INDEX.md`.

---

## Workstream B: Claude Code Orchestration (Can parallelize with A and C)

### B.1: Install Agent SDK

Add `@anthropic-ai/claude-agent-sdk` as a dependency:
```bash
npm install @anthropic-ai/claude-agent-sdk
```

Also ensure `@anthropic-ai/claude-code` CLI is available in the Railway container. The Agent SDK spawns it as a subprocess. Add to package.json:
```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.2.98",
  "@anthropic-ai/claude-code": "latest"
}
```

**Environment variable required:** `ANTHROPIC_API_KEY` (already set on the prism-mcp-server Railway service for synthesis).

### B.2: Claude Code Client (`src/claude-code/client.ts`)

Create a thin wrapper around the Agent SDK:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

interface DispatchOptions {
  prompt: string;
  workingDirectory: string;
  allowedTools?: string[];
  maxTurns?: number;
  model?: string;
  permissionMode?: string;
}

interface DispatchResult {
  success: boolean;
  result: string;
  turns: number;
  usage: { input_tokens: number; output_tokens: number };
  error?: string;
}

export async function dispatchTask(options: DispatchOptions): Promise<DispatchResult> {
  // Implementation using query() from Agent SDK
  // Use bare mode + ANTHROPIC_API_KEY auth
  // Stream results, collect final output
  // Return structured result
}
```

**Key design decisions:**
- Use `permissionMode: "bypassPermissions"` since this runs in a controlled server environment
- Use `model: "opus"` by default (configurable via env var)
- Set `maxTurns: 100` default with override capability
- Working directory: clone the target repo to a temp directory, execute there, push results
- Timeout: respect `MCP_SAFE_TIMEOUT` (50s) for quick queries, but support async mode for longer tasks

### B.3: Repo Clone + Cleanup Utility (`src/claude-code/repo.ts`)

The Agent SDK needs a local working directory. Create a utility that:
1. Clones a GitHub repo to a temp directory (`/tmp/cc-dispatch-{uuid}`)
2. Checks out the target branch
3. Returns the path
4. Provides cleanup function to remove the temp directory

```typescript
export async function cloneRepo(repoSlug: string, branch?: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}>;
```

**Important:** The Railway container has git installed. Use `child_process.execSync` for git operations.

### B.4: Tool — `cc_dispatch`

**Purpose:** Dispatch a task to Claude Code from a claude.ai session. The MCP server clones the repo, runs the Agent SDK, and returns results.

**Input Schema:**
```typescript
{
  repo: z.string().describe("GitHub repo slug (e.g., 'platformforge-v2', 'prism-mcp-server')"),
  prompt: z.string().describe("Task description for Claude Code"),
  branch: z.string().optional().default("main").describe("Branch to work on"),
  allowed_tools: z.array(z.string()).optional().default(["Read", "Glob", "Grep"]).describe("Tools Claude Code can use"),
  mode: z.enum(["query", "execute"]).default("query").describe("query = read-only analysis, execute = can write/edit/bash"),
  max_turns: z.number().optional().default(50).describe("Maximum agent turns"),
}
```

**Behavior:**
- `query` mode: Read-only. Allowed tools: Read, Glob, Grep. For analysis, investigation, code review.
- `execute` mode: Full write access. Allowed tools: Read, Write, Edit, Bash, Glob, Grep. For implementation tasks.
- Clone repo → run Agent SDK → collect results → cleanup → return response
- For `execute` mode: after completion, commit changes and push to a feature branch (`cc-dispatch/{timestamp}`), then create a PR.

**Response:**
```json
{
  "repo": "platformforge-v2",
  "mode": "query",
  "branch": "main",
  "success": true,
  "result": "Analysis: The generatePersona function fails because...",
  "turns": 12,
  "usage": { "input_tokens": 45000, "output_tokens": 3200 },
  "pr_url": null,
  "duration_ms": 35000
}
```

**Safety:**
- `execute` mode NEVER pushes to main directly. Always creates a feature branch + PR.
- `query` mode has no write tools — physically cannot modify files.
- Both modes run in an isolated temp directory that's cleaned up after completion.

**Timeout considerations:**
- The MCP client timeout is ~60s. For tasks that take longer, the tool should return immediately with a dispatch ID and status "running".
- A follow-up `cc_status` call retrieves results when complete.
- For quick queries (<50s), return results inline.

### B.5: Tool — `cc_status`

**Purpose:** Check status and retrieve results of dispatched Claude Code tasks.

**Input Schema:**
```typescript
{
  dispatch_id: z.string().optional().describe("Specific dispatch ID to check. Omit for all recent dispatches."),
}
```

**Implementation:**
- Store dispatch records in a lightweight in-memory map (acceptable for stateless server since dispatches complete within minutes)
- Alternative: store dispatch records as JSON files in a known location in the prism-mcp-server repo itself (persistent across restarts)
- Return status: queued, running, completed, failed

**Note on statefulness:** The PRISM MCP server is stateless (new server instance per request). For dispatch tracking to work across requests, dispatch state must be persisted externally. Options in order of preference:
1. **GitHub-based:** Write dispatch status to `brdonath1/prism-mcp-server/.dispatch/{id}.json`. Simple, persistent, uses existing GitHub client.
2. **Redis:** If available (PlatformForge-v2 has Redis). Fast, ephemeral, but adds cross-project coupling.
3. **File system:** Write to `/tmp/` on Railway. Persists across requests within the same container instance but lost on redeploy.

Recommend option 1 (GitHub-based) for reliability and visibility.

---

## Workstream C: Coordination & Documentation (Can parallelize with A and B)

### C.1: Brief Status Tracking

**Problem:** After a claude.ai session pushes a brief, there's no visibility into whether Claude Code picked it up, is executing, succeeded, or failed.

**Implementation:** Add a standardized status file convention:

When Claude Code starts executing a brief, it writes:
```
docs/briefs/{brief-name}.status.json
```
With content:
```json
{
  "brief": "brief-103-railway-mcp-integration",
  "status": "executing",
  "started_at": "2026-04-11T19:00:00Z",
  "agent": "claude-code",
  "session_id": "cc-session-xyz"
}
```

On completion:
```json
{
  "brief": "brief-103-railway-mcp-integration",
  "status": "completed",
  "started_at": "2026-04-11T19:00:00Z",
  "completed_at": "2026-04-11T19:21:00Z",
  "agent": "claude-code",
  "pr_url": "https://github.com/brdonath1/platformforge-v2/pull/41",
  "commits": ["40e0600", "0151674"],
  "defects_found": 4,
  "tests_added": 2
}
```

**This is a CLAUDE.md instruction** — add to the prism-mcp-server CLAUDE.md AND create a reusable `.claude/commands/brief-status.md` slash command that Claude Code can use.

### C.2: Update CLAUDE.md

Update `brdonath1/prism-mcp-server/CLAUDE.md` with:
1. Server version → 4.0.0
2. Architecture diagram → add Claude Code orchestration layer
3. Tool count → 16 tools (12 PRISM + 4 Railway) + new CC tools
4. Concurrent write protocol (INS-69 rules)
5. Brief status tracking convention
6. New environment variables: `RAILWAY_API_TOKEN`, `CC_DISPATCH_ENABLED`
7. New dependencies: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-code`

### C.3: Config Updates (`src/config.ts`)

Add:
```typescript
/** Whether Claude Code dispatch tools are enabled */
export const CC_DISPATCH_ENABLED = !!process.env.ANTHROPIC_API_KEY;

/** Default model for Claude Code dispatch */
export const CC_DISPATCH_MODEL = process.env.CC_DISPATCH_MODEL ?? "opus";

/** Max turns for Claude Code dispatch (default) */
export const CC_DISPATCH_MAX_TURNS = parseInt(process.env.CC_DISPATCH_MAX_TURNS ?? "50", 10);

/** GitHub owner for repo cloning */
// GITHUB_OWNER already exists
```

### C.4: Index Updates (`src/index.ts`)

Register new tools conditionally:
```typescript
import { CC_DISPATCH_ENABLED } from "./config.js";
import { registerCCDispatch } from "./tools/cc-dispatch.js";
import { registerCCStatus } from "./tools/cc-status.js";

// In createServer():
if (CC_DISPATCH_ENABLED) {
  registerCCDispatch(server);
  registerCCStatus(server);
}
```

---

## Testing Strategy

### Unit Tests (vitest)
- `tests/log-decision-dedup.test.ts` — Dedup rejection, concurrent write handling
- `tests/fetch-path-resolution.test.ts` — Path resolution with and without `.prism/` prefix
- `tests/cc-dispatch.test.ts` — Mock Agent SDK, verify clone/execute/cleanup cycle
- `tests/cc-status.test.ts` — Status tracking CRUD

### Integration Verification (post-deploy)
1. From claude.ai: `prism_log_decision` with existing ID → expect rejection
2. From claude.ai: `prism_fetch` with bare `decisions/_INDEX.md` → expect resolution
3. From claude.ai: `cc_dispatch` query mode → analyze a file in prism-mcp-server repo
4. From claude.ai: `cc_dispatch` execute mode → make a trivial change, verify PR created
5. From claude.ai: `cc_status` → verify dispatch record

---

## Environment Setup

### Railway Dashboard — prism-mcp-server service
Verify these are set (some already exist):
- `GITHUB_PAT` — ✅ already set
- `ANTHROPIC_API_KEY` — ✅ already set (used for synthesis)
- `RAILWAY_API_TOKEN` — ✅ already set (Brief 103)
- `CC_DISPATCH_MODEL` — optional (defaults to "opus")
- `CC_DISPATCH_MAX_TURNS` — optional (defaults to 50)

### Railway Container Requirements
The Agent SDK spawns Claude Code as a subprocess, which requires:
- Node.js 18+ — ✅ already available
- git CLI — ✅ already available (Railway Ubuntu containers)
- Sufficient memory — Monitor after deployment. Agent SDK + Claude Code subprocess may need 500MB+.

---

## Risk Assessment

### Known Risks
1. **Agent SDK on Railway is unverified.** The SDK spawns a Claude Code subprocess. Railway's container may have restrictions (no TTY, limited /tmp space, process isolation). Mitigation: Workstream B should start with a minimal proof-of-concept (`cc_dispatch` in query mode only) before implementing execute mode.

2. **MCP timeout (60s) vs Agent SDK execution time.** Most useful tasks take >60s. The async dispatch pattern (return immediately, check status later) is the mitigation, but adds complexity. Start with synchronous mode for quick queries.

3. **Cost.** Each `cc_dispatch` call consumes Anthropic API tokens for the Agent SDK session. A 50-turn analysis at Opus pricing could cost $5-15. This is acceptable for targeted investigations but should not be used for trivial queries.

4. **Container disk space for repo clones.** Large repos cloned to /tmp may exhaust disk. Implement aggressive cleanup and consider shallow clones (`git clone --depth 1`).

### Fallback Plan
If the Agent SDK doesn't work on Railway (Risk #1), the `cc_dispatch` and `cc_status` tools should be implemented as **enhanced brief dispatchers** instead:
- `cc_dispatch` writes a brief file to the target repo and returns a brief ID
- `cc_status` checks for the `.status.json` file
- Execution still happens via the existing Metaswarm watcher on the user's machine
- This is less elegant but still eliminates most manual coordination

---

## Success Criteria

1. ✅ `prism_log_decision` rejects duplicate D-N IDs with clear error message
2. ✅ `prism_fetch` resolves bare living document paths to `.prism/` subdirectory
3. ✅ `cc_dispatch` in query mode works — analyze a repo and return results
4. ✅ `cc_dispatch` in execute mode works — make changes, create PR
5. ✅ `cc_status` tracks dispatch lifecycle
6. ✅ All existing 16 tools (12 PRISM + 4 Railway) continue working unchanged
7. ✅ Tests pass (vitest)
8. ✅ Server deploys cleanly to Railway as v4.0.0
9. ✅ CLAUDE.md updated with coordination protocol

---

## Post-Deployment (handled by PRISM session, NOT this brief)

1. Log D-117 in PlatformForge-v2 for Operations Gateway Phase 2
2. Update PlatformForge-v2 architecture.md with Operations Gateway diagram
3. Smoke test all new tools from claude.ai
4. Connector refresh in claude.ai settings (if new tools don't auto-appear)

<!-- EOF: brief-104-operations-gateway-full-stack.md -->
