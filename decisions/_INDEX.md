# Decision Index — PRISM MCP Server

> Complete decision registry for the MCP server project.

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-1 | Stateless server design | architecture | SETTLED | CC-1 |
| D-2 | Plain fetch over Octokit | architecture | SETTLED | CC-1 |
| D-3 | Validation-first push pattern | architecture | SETTLED | CC-1 |
| D-4 | Promise.allSettled for parallel ops | architecture | SETTLED | CC-1 |
| D-5 | Structured summaries over raw content | architecture | SETTLED | CC-1 |

### D-1: Stateless server design
- Domain: architecture
- Reasoning: PRISM state lives entirely in GitHub. Server-side persistence adds complexity, failure modes, and cost with no benefit. Each request creates fresh McpServer + transport. Set `sessionIdGenerator: undefined`.
- Decided: CC Session 1

### D-2: Plain fetch over Octokit
- Domain: architecture
- Reasoning: Octokit adds 300KB+ dependency for simple REST calls. Node.js 18+ has built-in fetch. We only need GET/PUT on Contents API + GET on Repos/Commits API. Plain fetch with thin wrapper is cleaner and lighter.
- Decided: CC Session 1

### D-3: Validation-first push pattern
- Domain: architecture
- Reasoning: Validate ALL files before pushing ANY. If one file fails validation, none are pushed. This prevents partial state corruption in GitHub. Server-side validation converts rule compliance from behavioral (Claude follows instructions) to structural (system rejects violations).
- Decided: CC Session 1

### D-4: Promise.allSettled for parallel ops
- Domain: architecture
- Reasoning: MCP has ~60s timeout. Sequential GitHub API calls for 8 files could take 16-32s. Promise.allSettled enables parallel execution (~2-4s) and handles per-file failures gracefully without aborting the entire batch.
- Decided: CC Session 1

### D-5: Structured summaries over raw content
- Domain: architecture
- Reasoning: ~25K token limit on MCP responses. Raw file dumps waste Claude's context window. Server parses handoff into sections, extracts metadata, and returns structured JSON. Context consumption drops from ~15-20% to ~3-5%.
- Decided: CC Session 1

<!-- EOF: _INDEX.md -->
