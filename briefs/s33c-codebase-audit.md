# Brief S33c: Full-Stack Codebase Audit — PRISM MCP Server

## Context

This is the **PRISM MCP Server** — a production MCP server on Railway that handles all GitHub operations for 17 active PRISM projects. It's the backbone of an AI session continuity framework used daily across multiple platforms and products. Any instability, performance issue, or security gap here cascades to every project.

**Recent history:** Sessions S32-S33 exposed critical finalization instability (cascading failures, 5-10 minute finalizations, no fallback paths). S33/S33b fixed the immediate issues (atomic commit fallback, dynamic branch detection, draft timeout scaling, audit phase optimization). But those were targeted fixes for known symptoms — this audit is about finding what we DON'T know yet.

**Tech stack:** Node.js 18+, TypeScript, Express 5.x, MCP SDK v1.28.x, Zod, Anthropic SDK (Opus 4.6 for synthesis), plain `fetch` for GitHub API. Hosted on Railway (auto-deploy on push to main). Stateless — all persistence via GitHub API.

**Repo:** `prism-mcp-server` (already cloned locally)

## Mission

Conduct an exhaustive, multi-angle audit of the entire `prism-mcp-server` codebase. Every `.ts` file in `src/` and `tests/` must be examined. The goal is to surface every performance bottleneck, resilience gap, error handling weakness, security concern, architectural anti-pattern, and test coverage hole — especially issues that would only manifest under production load or edge conditions.

**This is NOT a brief that produces code changes.** This audit produces a structured report. Code changes come later as targeted briefs derived from the findings.

## Audit Dimensions

Each dimension below should be examined across the ENTIRE codebase, not just one file.

### 1. Performance & Latency

- **API call inventory:** Count every GitHub API call in each tool. Map the critical path for each MCP tool (bootstrap, finalize, push, fetch, etc.) — how many sequential API calls? How many could be parallelized?
- **Timeout analysis:** Every `setTimeout`, `Promise.race`, or SDK timeout. Are they appropriate for their context? What happens when they fire?
- **Caching opportunities:** What data is fetched repeatedly across tool calls that could be cached? Consider: the server is stateless per-request, so only within-request caching applies.
- **Payload sizes:** What are the largest responses returned to Claude? Are there cases where the ~25K token MCP response limit could be hit? What gets truncated?
- **Cold start:** What happens on first request after Railway deploy? Any initialization that could be pre-warmed?
- **Memory:** Any patterns that could leak memory in a long-running Node.js process? (Even though requests are stateless, the process persists.)

### 2. Resilience & Error Handling

- **Every try/catch:** Audit every catch block. Is the error logged? Is it swallowed silently? Is it re-thrown when it should be? Does the error message help diagnose the issue?
- **Fallback paths:** For every operation that can fail, is there a degraded-but-functional alternative? Or does it just return an error?
- **Partial failure handling:** When `Promise.allSettled` is used, how are partial failures reported? Could a single file failure mask a systemic issue?
- **Retry logic:** Where is retry implemented? Where is it missing but should exist? Are retry counts and backoff appropriate?
- **Timeout handling:** What happens when the 60-second MCP client timeout fires? Does the server leave orphaned operations? Are there cleanup mechanisms?
- **Race conditions:** Any shared mutable state across concurrent requests? (The `defaultBranchCache` Map, the Anthropic client singleton, the MemoryCache — are these safe?)
- **GitHub API edge cases:** What happens on 422 (validation failed)? On 502/503 (GitHub down)? On truncated responses for large files?

### 3. Security

- **PAT exposure:** Is the GitHub PAT ever logged, included in error messages, or returned in MCP responses?
- **Input sanitization:** `slug.ts` handles path sanitization — is it sufficient? Could a crafted `project_slug` or `file_path` escape the intended repo boundary?
- **Auth middleware:** How robust is the Bearer token check? Timing-safe comparison? What happens on missing/malformed auth headers?
- **CIDR validation:** The IP allowlist uses `ANTHROPIC_CIDRS` — is the CIDR matching implementation correct? Edge cases with IPv6?
- **Dependency audit:** Any known vulnerabilities in dependencies? (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `express`, `zod`)
- **Error message information leakage:** Do error responses reveal internal paths, configuration, or stack traces?

### 4. API Design & Contract Stability

- **Tool schemas:** Are Zod schemas complete and correct? Are there parameters that accept broader types than they should?
- **Response contracts:** Is every tool's response shape consistent and documented? Could a consumer rely on the shape not changing?
- **Backward compatibility:** If a tool's response shape changes, what breaks? Are there versioning mechanisms?
- **Validation completeness:** Are there inputs that pass validation but cause downstream failures? (e.g., a valid-looking file path that doesn't match any living document)
- **Error response format:** Are error responses structured consistently across all tools? Can the consumer always distinguish "your input was wrong" from "something broke on our end"?

### 5. Test Coverage & Quality

- **Coverage gaps:** Which functions have zero test coverage? Which critical paths are tested only structurally (source code grep) vs. behaviorally (actual execution)?
- **Mock quality:** Are mocks realistic? Do they cover error paths or just happy paths?
- **Integration test opportunities:** Which tool flows would benefit from end-to-end tests with mocked GitHub API?
- **Test reliability:** Are any tests fragile (dependent on timing, file ordering, external state)?
- **Missing edge case tests:** Based on the code review, what edge cases should be tested but aren't?

### 6. Architecture & Code Health

- **Dead code:** Functions, imports, or config values that are defined but never used.
- **Code duplication:** Repeated patterns that should be extracted into shared utilities.
- **Coupling:** Which modules have tight dependencies that make them hard to modify independently?
- **Configuration drift:** Are there config values in `config.ts` that don't match the actual behavior? Constants that should be configurable but aren't (or vice versa)?
- **Technical debt:** Patterns marked with TODO, HACK, FIXME, or "REMOVE after" comments — what's the actual status?
- **Type safety:** Are there `any` types, unsafe casts, or `as` assertions that could mask bugs?
- **Consistency:** Naming conventions, error handling patterns, logging format — are they consistent across all files?

### 7. Observability & Debugging

- **Log coverage:** Are all significant operations logged? Are log levels appropriate (debug vs info vs warn vs error)?
- **Structured logging:** Are all log entries structured (JSON key-value) or are some free-text?
- **Request tracing:** Can a single MCP request be traced through the logs from entry to exit?
- **Metric opportunities:** What operational metrics would help monitor server health? (Request latency, error rates, GitHub API call counts, cache hit rates)
- **Debug mode:** Is there a way to get verbose output for troubleshooting without redeploying?

## Deliverables

Produce a single markdown report at `docs/audit-s33c.md` with these sections:

```markdown
# PRISM MCP Server — Full-Stack Audit Report (S33)

## Executive Summary
[2-3 paragraph overview of findings, severity distribution, overall health assessment]

## Critical Findings (must fix)
[Issues that could cause data loss, security breach, or systemic failure]
- Finding C-1: [title]
  - Severity: CRITICAL
  - File(s): [paths]
  - Description: [what's wrong]
  - Impact: [what happens if not fixed]
  - Recommended fix: [specific guidance]

## High-Priority Findings (should fix soon)
[Issues that degrade performance, reliability, or maintainability]
- Finding H-1: [title]
  ...

## Medium-Priority Findings (fix when convenient)
[Issues that are suboptimal but not actively harmful]
- Finding M-1: [title]
  ...

## Low-Priority / Informational
[Observations, suggestions, nice-to-haves]
- Finding L-1: [title]
  ...

## Metrics Summary
- Total files analyzed: [N]
- Total lines of code: [N]
- Test files: [N] with [N] test cases
- GitHub API calls per tool (critical path): [table]
- try/catch blocks audited: [N]
- Type safety issues found: [N]

## Prioritized Action Backlog
[Ordered list of recommended fixes, grouped into briefs that could be executed]
1. Brief proposal: [title] — addresses findings C-1, H-3, H-7
2. Brief proposal: [title] — addresses findings H-2, M-1, M-4
...
```

## Constraints

1. **Read-only audit.** Do NOT modify any source files. The deliverable is the report only.
2. **Evidence-based.** Every finding must cite the specific file and line number(s). No vague warnings.
3. **Actionable.** Every finding must include a recommended fix specific enough to implement.
4. **Honest severity.** Don't inflate — CRITICAL means "could cause data loss or security breach in production." HIGH means "actively degrading performance or reliability." Be calibrated.
5. **Complete coverage.** Every `.ts` file in `src/` must be examined. The report should list files analyzed to prove completeness.

## Verification

After the report is generated:
```bash
# Report exists and is non-trivial
wc -l docs/audit-s33c.md
# Expected: 200+ lines

# Report covers all source files
grep -c "src/" docs/audit-s33c.md
# Expected: references to most/all src/ files

# Report has the required sections
grep -c "## " docs/audit-s33c.md
# Expected: 7+ section headers
```

## Post-Flight

```bash
git add docs/audit-s33c.md && git commit -m 'docs: full-stack codebase audit report (S33c)' && git push origin main
```

The audit report becomes a permanent artifact in the repo. Findings will be triaged in the next PRISM session and converted into prioritized briefs for execution.

<!-- EOF: s33c-codebase-audit.md -->
