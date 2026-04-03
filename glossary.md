> **ARCHIVAL NOTICE:** This document is frozen at Session 10 (CC-S4). Active development of the PRISM MCP Server is tracked in the [prism meta-project](https://github.com/brdonath1/prism) living documents. This file is retained for historical context only.

# Glossary — PRISM MCP Server

> Project-specific terminology.

| Term | Definition | First Used |
|------|-----------|------------|
| MCP | Model Context Protocol — open standard by Anthropic for connecting AI to external tools | CC-S1 |
| Streamable HTTP | Current MCP transport protocol (spec 2025-03-26). Single /mcp endpoint for POST/GET/DELETE | CC-S1 |
| Stateless mode | Server config where each request creates a new transport. `sessionIdGenerator: undefined` | CC-S1 |
| Living document | One of 8 mandatory PRISM files per project (handoff, decisions, session-log, etc.) | CC-S1 |
| EOF sentinel | `<!-- EOF: {filename} -->` marker required at end of every .md file | CC-S1 |
| Validation-first | Push pattern: validate ALL files, reject ALL if any fail, push NONE until all pass | CC-S1 |
| Promise.allSettled | JavaScript API for parallel async operations that doesn't short-circuit on failure | CC-S1 |
| Drift detection | Finalize audit feature: compares current handoff critical context against fetched state | CC-S2 |
| Decision graph | Analytics feature: maps cross-references between decisions (currently bugged — KI-2) | CC-S2 |
| Fresh-eyes check | Analytics feature: identifies projects overdue for a fresh-eyes review | CC-S2 |
| Scale handoff | Process of redistributing oversized handoff content to living documents | CC-S2 |
| Dry run | Scale handoff preview mode: shows what would be moved without executing | CC-S2 |
| Railway | Cloud hosting platform. Usage-based pricing, git deploys, auto-SSL | CC-S3 |
| Battle test | Systematic verification of all tools against live data | CC-S3 |
| Custom connector | Claude.ai feature for connecting to remote MCP servers via URL | CC-S3 |

<!-- EOF: glossary.md -->
