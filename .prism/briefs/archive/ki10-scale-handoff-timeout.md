# PRISM MCP Server — KI-10 Fix: scale_handoff Timeout

> ## Launch Command — COPY THIS EXACTLY
> ```bash
> claude --dangerously-skip-permissions --model claude-opus-4-6 --effort max
> ```
> Then paste or reference this mega prompt as the task. The flags ensure:
> - `--dangerously-skip-permissions` → zero permission prompts, fully autonomous execution
> - `--model claude-opus-4-6` → highest-quality reasoning
> - `--effort max` → maximum chain-of-thought on every step
>
> **Pre-launch:** `cd ~/Desktop/Development/prism-mcp-server && git add -A && git commit -m "checkpoint: pre-ki10-fix"`

---

## Mission

Fix KI-10: `prism_scale_handoff` fails silently on large handoffs (>20KB). The tool returns a generic `{"error": "Error occurred during tool execution"}` with no actionable detail when called against projects with large handoffs.

**Root cause (verified by research):** The MCP client (Claude.ai) enforces a ~60-second timeout on tool calls via the MCP TypeScript SDK default `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`. The `scale_handoff` operation performs multiple sequential stages of parallel GitHub API calls that exceed this window on large handoffs. Railway's platform timeout is 15 minutes -- Railway is NOT the bottleneck. Node.js's default `server.requestTimeout` of 300s is also not the bottleneck. The 60s MCP client timeout is.

**The fix:** MCP progress notifications reset the client's 60-second timer (via `resetTimeoutOnProgress: true`, default since SDK PR #849). The server must send progress notifications during each stage of the scaling operation. Additionally, improve error propagation so timeouts return structured errors instead of generic ones.

**By the end of this session:** `prism_scale_handoff` successfully scales a 20KB+ handoff without timeout, with progress notifications visible to the client, and structured error messages on any failure. All existing tests pass plus new tests added.

Do NOT ask questions. All architectural decisions are pre-made below. If ambiguous, make the simplest choice and leave a `// TODO` comment.

---

## Pre-Existing Context

- **Stack:** Node.js, TypeScript (strict), Express 5.x, MCP SDK v1.28.x, Zod, Railway hosting
- **Repo:** `~/Desktop/Development/prism-mcp-server`
- **MCP SDK version in use:** Check `package.json` -- if below v1.28.x, update to latest stable
- **Key file:** `src/tools/scale.ts` -- the scale_handoff tool implementation
- **Related files:** `src/index.ts` (Express/MCP server setup), `src/github/client.ts` (GitHub API wrapper)
- **Test framework:** vitest, existing 32 tests in 3 suites

---

## Research Findings -- Timeout Landscape (March 27, 2026)

These findings drive the fix strategy:

1. **Railway platform max timeout: 15 minutes.** Source: docs.railway.com/networking/public-networking/specs-and-limits (updated Mar 19, 2026). Railway is NOT the bottleneck.

2. **Node.js `server.requestTimeout`: 300,000ms (5 min) default.** Inherited by Express 5.x. NOT the bottleneck for our use case.

3. **MCP TypeScript SDK `DEFAULT_REQUEST_TIMEOUT_MSEC`: 60,000ms (60s).** This is the CLIENT-side timeout. Source: `@modelcontextprotocol/sdk/shared/protocol.ts`. Claude.ai's custom connector uses this default. THIS IS THE BOTTLENECK.

4. **`resetTimeoutOnProgress` now defaults to `true`** (merged in typescript-sdk PR #849). The client resets its 60s countdown each time it receives a progress notification from the server. THIS IS THE FIX MECHANISM.

5. **Claude Desktop uses same 60s timeout.** Users report "No result received from client-side tool execution" after ~60s. Pattern: <30s always works, 30-60s unreliable, >60s fails.

---

## Task Checklist

### Task 1: Verify MCP SDK version and progress notification support
- [ ] Check `package.json` for `@modelcontextprotocol/sdk` version
- [ ] If below 1.28.0, run `npm install @modelcontextprotocol/sdk@latest`
- [ ] Verify the SDK version supports `server.sendNotification` with `notifications/progress` method
- [ ] Check the MCP SDK docs/types for the progress notification schema: `{ method: "notifications/progress", params: { progressToken, progress, total?, message? } }`

### Task 2: Add timeout instrumentation to scale.ts
- [ ] Add `Date.now()` timestamps at the start and end of each stage in scale_handoff:
  - Stage 1: Fetch handoff
  - Stage 2: Analyze sections and identify redistribution targets
  - Stage 3: Fetch target living documents
  - Stage 4: Compose redistributed content
  - Stage 5: Push all modified files
  - Stage 6: Verify pushed files
- [ ] Log elapsed time at each stage boundary using the existing logger
- [ ] Add a total elapsed time log at completion

### Task 3: Implement progress notifications in scale_handoff
This is the core fix. The scale_handoff tool handler must send progress notifications during execution.

**Implementation approach:**

The MCP SDK's tool handler callback receives a second argument -- the `CallToolRequestSchema` extras. However, to send progress notifications, the tool handler needs access to the `McpServer` instance (or the underlying `Server` from `@modelcontextprotocol/sdk/server`).

Check how the server is set up in `src/index.ts`. The tool handlers are registered via `server.tool()` or `server.setRequestHandler()`. The progress notification pattern is:

```typescript
// Inside a tool handler, if you have access to the server instance:
await server.notification({
  method: "notifications/progress",
  params: {
    progressToken: meta?.progressToken,  // from the request's _meta
    progress: currentStep,
    total: totalSteps,
    message: "Fetching target living documents..."
  }
});
```

**Critical:** Progress notifications only work if the CLIENT sends a `progressToken` in the request's `_meta`. Claude.ai may or may not send this. If it doesn't, progress notifications are silently ignored. The fix must work EITHER WAY:
- If `progressToken` is present: send progress notifications (resets the 60s timer)
- If `progressToken` is absent: the operation must still complete within 60s OR use a chunked approach

**Chunked approach (fallback):** If progress notifications can't be sent (no progressToken), OR if the operation would exceed 60s even with them, break scale_handoff into a 2-call pattern:
- `prism_scale_handoff(project_slug, action: "analyze")`: returns a scaling plan (what to move where) without executing anything. This is fast (<10s).
- `prism_scale_handoff(project_slug, action: "execute", plan: {...})`: executes the plan from analyze. Each push is a separate stage with progress.

**Implementation steps:**
- [ ] Modify the `scale_handoff` tool handler signature to accept an `action` parameter: `"full"` (default, current behavior), `"analyze"`, or `"execute"`
- [ ] For `action: "analyze"`: fetch handoff, identify sections to redistribute, return the plan as structured JSON without pushing anything
- [ ] For `action: "execute"`: accept a plan object, execute the redistribution, send progress at each stage
- [ ] For `action: "full"`: attempt the full operation with progress notifications. If `progressToken` is available, send progress and proceed. If not, run the full operation but with aggressive parallelization to stay under 60s.
- [ ] Update the Zod schema for the tool to include the new `action` parameter
- [ ] Default `action` to `"full"` for backward compatibility

### Task 4: Improve error propagation
- [ ] Wrap the entire scale_handoff execution in a try-catch that returns structured errors:
  ```typescript
  {
    error: "Scale operation failed",
    stage: "fetch_living_documents",
    elapsed_ms: 45000,
    detail: "GitHub API rate limit hit",
    partial_results: { ... }
  }
  ```
- [ ] Add timeouts to individual GitHub API calls (10s per call) so one slow call doesn't silently block
- [ ] If total elapsed time exceeds 50s (leaving 10s buffer before the 60s client timeout), return a partial result with a message explaining the operation was too large for single-call and suggesting the analyze+execute pattern

### Task 5: Optimize GitHub operations for speed
- [ ] Audit `src/tools/scale.ts` for sequential operations that could be parallelized
- [ ] Ensure ALL GitHub fetches in a stage use `Promise.allSettled` (not sequential awaits)
- [ ] Ensure ALL GitHub pushes in a stage use `Promise.allSettled` (not sequential awaits)
- [ ] Consider: can we skip the verification fetch after push? The push response already confirms success. If verification is kept, batch all verifications into one parallel group.

### Task 6: Add tests
- [ ] Add vitest tests for the chunked analyze/execute pattern:
  - Test that `action: "analyze"` returns a valid plan without pushing anything
  - Test that `action: "execute"` with a valid plan produces expected results
  - Test that `action: "full"` works for small handoffs (<10KB)
- [ ] Add a test for the structured error output format
- [ ] Add a test for the 50s timeout safety valve
- [ ] Run full test suite: `npm test` -- all tests must pass (existing 32 + new ones)

### Task 7: Update Zod schema and tool description
- [ ] Update the tool's Zod input schema to include:
  ```
  action: z.enum(["full", "analyze", "execute"]).default("full")
    .describe("'full' runs complete scaling (default). 'analyze' returns a plan without executing. 'execute' runs a plan from a previous analyze call.")
  plan: z.object({...}).optional()
    .describe("Required for action='execute'. The plan object returned by a previous 'analyze' call.")
  ```
- [ ] Update the tool description to mention the chunked approach for large handoffs

### Task 8: Build, test, and verify
- [ ] Run `npm run build` -- must compile with zero errors
- [ ] Run `npm test` -- all tests must pass
- [ ] Start server locally: `node dist/index.js &`
- [ ] Test health endpoint: `curl http://localhost:3000/health`
- [ ] Test scale_handoff analyze mode with a curl command:
  ```bash
  curl -s -X POST http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d '{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "tools/call",
      "params": {
        "name": "prism_scale_handoff",
        "arguments": {"project_slug": "snapquote-ai", "action": "analyze"}
      }
    }'
  ```
- [ ] Verify the response contains a valid scaling plan
- [ ] Kill the local server: `kill %1`
- [ ] Git commit: `git add -A && git commit -m "fix: KI-10 scale_handoff timeout -- progress notifications, chunked execution, error propagation"`

---

## Completion Criteria

You are done when:
1. `npm run build` compiles with zero errors
2. `npm test` passes all tests (existing + new)
3. The `prism_scale_handoff` tool supports three modes: `full`, `analyze`, `execute`
4. Progress notifications are sent during full/execute modes
5. Structured error messages replace generic errors on failure
6. Timeout instrumentation logs elapsed time at each stage
7. A single git commit captures all changes

---

## What NOT to Do

- Do NOT modify any tool other than `prism_scale_handoff`
- Do NOT change the Express server configuration or port
- Do NOT add new npm dependencies (the MCP SDK already has everything needed)
- Do NOT push to GitHub -- the Railway auto-deploy will handle that after Brian reviews
- Do NOT restructure the project directory layout
- Do NOT modify existing tests -- only add new ones

<!-- EOF: ki10-scale-handoff-timeout.md -->