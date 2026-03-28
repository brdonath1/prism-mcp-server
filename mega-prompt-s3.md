# PRISM MCP Server — Claude Code Build Session 3 of 3

> ## Launch Command — COPY THIS EXACTLY
> ```bash
> claude --dangerously-skip-permissions --model claude-opus-4-6 --effort max
> ```
> Then paste or reference this mega prompt as the task. The flags ensure:
> - `--dangerously-skip-permissions` → zero permission prompts, fully autonomous execution
> - `--model claude-opus-4-6` → highest-quality reasoning
> - `--effort max` → maximum chain-of-thought on every step
>
> **Pre-launch:** `git add -A && git commit -m "checkpoint: pre-CC-session-3"` in the project directory.

---

## Mission

Deploy the PRISM MCP server to Railway, connect it as a Claude.ai custom connector, battle-test it on a real PRISM session, and update the PRISM framework to v2.0.0.

**Prerequisites:** Sessions 1 and 2 are complete. The server has all 7 tools working locally.

**By the end of this session:** PRISM v2 is live, connected, and verified.

**AUTONOMOUS EXECUTION — MANDATORY:** Do NOT ask questions. Do NOT request confirmations. Do NOT pause for permission on any operation — bash commands, file writes, npm installs, curl requests, git operations, or anything else. All decisions are pre-made below. If something is ambiguous, make the simplest choice that works and leave a `// TODO: [description]` comment. Run to completion without human interaction.

---

## Part 1: Deploy to Railway

### Steps

1. **Initialize git repo** in the prism-mcp-server directory (if not already done)
2. **Create GitHub repo** `brdonath1/prism-mcp-server` using the GitHub API
3. **Push all code** to the new repo
4. **Deploy to Railway:**
   - Use Railway CLI if available, or guide through web UI setup
   - Connect the GitHub repo `brdonath1/prism-mcp-server`
   - Railway auto-detects Node.js, runs `npm install && npm run build && npm start`
   - Set environment variables in Railway:
     - `GITHUB_PAT` = the PAT from .env
     - `GITHUB_OWNER` = brdonath1
     - `FRAMEWORK_REPO` = prism-framework
     - `PORT` = (Railway injects this automatically)
     - `LOG_LEVEL` = info
   - Railway provides an HTTPS URL automatically (e.g., `https://prism-mcp-server-production-XXXX.up.railway.app`)
   - The MCP endpoint will be at `{railway_url}/mcp`

5. **Verify deployment:**
   - `curl {railway_url}/health` returns `{ status: "ok", version: "2.0.0" }`
   - MCP Inspector connects to `{railway_url}/mcp` successfully
   - `prism_bootstrap` works through the deployed server

6. **Connect as Claude.ai custom connector:**
   - Claude.ai → Settings → Connectors → Add Custom Connector
   - Paste the MCP endpoint URL: `{railway_url}/mcp`
   - Verify the PRISM tools appear in Claude.ai tool list

### Troubleshooting

- If Railway build fails: check build logs, likely TypeScript compilation issues
- If MCP connection fails: ensure the /mcp endpoint handles POST, GET, DELETE correctly
- If tools fail via Claude.ai but work locally: likely a timeout issue — check Railway response times
- If GitHub operations fail in production: verify GITHUB_PAT environment variable is set correctly in Railway

---

## Part 2: Battle Test

Run a real PRISM session using the MCP server instead of bash+cURL. Suggested test: SnapQuote handoff scaling (already queued as next task — handoff is 19.9KB).

### Test Protocol

1. Call `prism_bootstrap("snapquote")` — verify structured summary returns correctly
2. Call `prism_status("snapquote")` — verify health check identifies the oversized handoff
3. Call `prism_scale_handoff("snapquote", dry_run: true)` — verify proposed redistribution
4. If dry run looks good, call `prism_scale_handoff("snapquote", dry_run: false)` — verify execution
5. Call `prism_status("snapquote")` again — verify handoff is now under 8KB
6. Call `prism_push` with a small update — verify validation and push work through MCP
7. Call `prism_finalize` audit phase — verify all 8 documents are checked
8. Call `prism_finalize` commit phase with a test update — verify backup creation and parallel push
9. Call `prism_analytics("snapquote", "health_summary")` — verify analytics return
10. Call `prism_status()` (no project) — verify multi-project scan works

### Expected Issues and Fixes

Document everything that breaks or doesn't work as expected. Fix in this session if possible. If a fix requires architectural changes, document it as a known issue for a future session.

---

## Part 3: PRISM Framework Update to v2.0.0

### Core Template Changes (prism-framework/_templates/core-template.md)

Update to v2.0.0. Key changes:

1. **Connection Setup section:** Add MCP as primary, bash+cURL as fallback:
   ```
   On session start, detect available tools:
   - If PRISM MCP tools are available (prism_bootstrap, prism_push, etc.) → use MCP (recommended)
   - If GitHub MCP tools are available → use generic GitHub MCP
   - If bash/shell is available → use cURL with PAT (fallback)
   ```

2. **Rule 1 — Bootstrap:** If MCP available, call `prism_bootstrap(project_slug, opening_message)`. This replaces the manual cURL fetch + size check + batch-operations loading. The MCP server handles all of that server-side.

3. **Rule 7 — Push:** If MCP available, call `prism_push()`. Server-side validation replaces behavioral compliance.

4. **Rule 9 — Context tracking:** Note that `bytes_delivered` from MCP responses provides measured fetch_total instead of estimated.

5. **Rule 11 — Finalization:** If MCP available, call `prism_finalize("audit")` then `prism_finalize("commit")`. 2 tool calls instead of 13-16.

6. **On-Demand References:** Note that `batch-operations.md` is only needed for bash+cURL fallback mode. MCP mode doesn't need it at bootstrap.

7. **Version header:** `v2.0.0`

### CHANGELOG.md Update

Add v2.0.0 entry with all changes.

### New Decision: D-25 (Formalize)

Settle D-25 with full reasoning. Push to `brdonath1/prism/decisions/_INDEX.md`.

### New Decision: D-26

Record v2.0.0 framework update decision.

### Project Instructions Template Update

Add note about MCP connector setup:
```
### MCP Connector (Recommended)
If PRISM MCP tools are available as a connected MCP server, use them instead of bash+cURL.
The MCP server handles GitHub operations with parallelization, validation, and context-efficient summaries.
```

### Memory Update

Update Claude's memory with:
- PRISM framework is now v2.0.0
- MCP server is deployed at {railway_url}
- All 7 MCP tools are available
- bash+cURL is now fallback mode, not primary

---

## Part 4: Set Up prism-mcp-server as a PRISM Project

The MCP server repo itself should be a PRISM project:

1. Create all 8 living documents in `brdonath1/prism-mcp-server`:
   - handoff.md (v1, Session 1 — referencing the 3 build sessions)
   - decisions/_INDEX.md (decisions made during build)
   - session-log.md (3 build sessions)
   - task-queue.md (future improvements)
   - eliminated.md (rejected approaches from Architecture E investigation)
   - architecture.md (server architecture, tool schemas, hosting details)
   - glossary.md (MCP terms, PRISM-specific server terms)
   - known-issues.md (anything discovered during battle test)

2. This means the MCP server manages its own project state — eating its own dog food.

---

## Definition of Done for Session 3

1. ✅ Server deployed to Railway and accessible via HTTPS
2. ✅ Health endpoint returns 200
3. ✅ Connected as Claude.ai custom connector
4. ✅ All 7 tools work through Claude.ai (not just locally)
5. ✅ SnapQuote (or another project) successfully bootstrapped, scaled, and finalized via MCP
6. ✅ Core template updated to v2.0.0
7. ✅ D-25 and D-26 formalized
8. ✅ prism-mcp-server has all 8 living documents
9. ✅ Memory updated with v2 state
10. ✅ Known issues documented for any problems found during battle test

---

## After Session 3

PRISM v2 is live. Future improvements (v2.1+):
- Enhanced decision graph with visualization
- Predictive context curation (ML-based document relevance)
- Webhook-based auto-deployment on framework changes
- Multi-user support (OAuth) if PRISM is ever shared
- Performance dashboard in Railway metrics
