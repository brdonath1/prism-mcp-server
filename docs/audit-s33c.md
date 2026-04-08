# PRISM MCP Server — Full-Stack Audit Report (S33)

## Executive Summary

This audit examined all 35 TypeScript source files (7,883 LOC) and 28 test files (4,545 LOC / 316 test cases) in the prism-mcp-server codebase. The server is production-grade infrastructure serving 17 active PRISM projects on Railway, so any instability cascades to every project.

**Overall assessment: Solid but with targeted gaps.** The codebase has clean architecture, good separation of concerns, consistent structured logging, and comprehensive validation. However, the audit surfaced 3 critical findings (path traversal bypass, timing-unsafe auth, MCP/synthesis timeout mismatch), 11 high-priority issues (missing retry logic, partial failure masking, N+1 API call patterns), and 13 medium/low items. The critical findings are security-related and should be addressed before the next Railway deploy. The high-priority performance findings account for an estimated 8-10 seconds of unnecessary latency per finalization.

Sessions S32-S33b fixed immediate finalization instability, but this audit reveals deeper structural issues — particularly around GitHub API resilience (6 functions use plain `fetch` without retry), synthesis error visibility (failures return null with no diagnostic info), and input validation (URL-encoded path traversal bypasses slug validation).

## Critical Findings (must fix)

- **Finding C-1: Path Traversal via URL-Encoded Input**
  - Severity: CRITICAL
  - File(s): `src/validation/slug.ts:21-32`
  - Description: `validateFilePath()` checks for `".."` and leading `/`, but does NOT decode URL-encoded input first. `%2e%2e/` (percent-encoded `..`) and null bytes (`\x00`) bypass validation entirely.
  - Impact: A crafted `file_path` parameter could escape the intended repo boundary, potentially reading or writing files outside the project.
  - Recommended fix: Decode input with `decodeURIComponent()` before validation. Add null byte check. Reject any path where decoded form differs from raw form and contains traversal sequences.

- **Finding C-2: Bearer Token Comparison Not Timing-Safe**
  - Severity: CRITICAL
  - File(s): `src/middleware/auth.ts:34`
  - Description: Token comparison uses `===` (strict equality), which is vulnerable to timing attacks. An attacker can distinguish correct token prefixes by measuring response time differences.
  - Impact: Auth token can be brute-forced character-by-character via timing side channel.
  - Recommended fix: Use `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(MCP_AUTH_TOKEN))` with try/catch for length mismatch.

- **Finding C-3: MCP Client Timeout (60s) vs Synthesis Timeout (120s) Mismatch**
  - Severity: CRITICAL
  - File(s): `src/tools/finalize.ts:303-306, 525-530`
  - Description: Draft phase sets `draftTimeoutMs` up to 120,000ms. Post-commit synthesis uses a 120s Promise.race timeout. But the MCP client enforces a ~60s hard timeout. If synthesis takes >60s, the MCP connection drops, leaving orphaned API calls and a dangling Anthropic request.
  - Impact: Incomplete finalization. User gets timeout error but doesn't know if commit succeeded. Orphaned Anthropic API calls waste tokens.
  - Recommended fix: Cap all synthesis/draft timeouts to 50s (leaving 10s buffer for MCP transport overhead). For large projects, split synthesis into a separate non-blocking call.

## High-Priority Findings (should fix soon)

- **Finding H-1: 6 GitHub API Functions Missing Retry Logic**
  - Severity: HIGH
  - File(s): `src/github/client.ts` — `getFileSize` (line 305), `listDirectory` (line 347), `listCommits` (line 382), `getCommit` (line 417), `fileExists` (line 282), `deleteFile` (line 440)
  - Description: These functions use plain `fetch()` without `fetchWithRetry()`. A single transient GitHub 502/503 causes permanent failure with no recovery.
  - Impact: A GitHub API blip during finalize cascades — drift detection, session audit, and handoff pruning all silently degrade.
  - Recommended fix: Wrap all API calls with `fetchWithRetry()`. This is a mechanical change — the function already exists and handles 429 + exponential backoff.

- **Finding H-2: N+1 fileExists Pattern in guardPushPath**
  - Severity: HIGH
  - File(s): `src/utils/doc-guard.ts:77-89`, `src/tools/finalize.ts:443-445`
  - Description: `guardPushPath()` calls `fileExists()` for each file to determine if `.prism/` version exists. With 10 files in finalize, this is 10 sequential GitHub API calls (~300ms each).
  - Impact: ~3-6 seconds added latency per multi-file finalization.
  - Recommended fix: Pre-check all paths in a single `listDirectory(".prism/")` call, then compare locally. Eliminates 9 of 10 API calls.

- **Finding H-3: Partial Failure Masking in Promise.allSettled**
  - Severity: HIGH
  - File(s): `src/github/client.ts:136-157` (fetchFiles), `src/github/client.ts:249-277` (pushFiles), `src/tools/finalize.ts:209-220`
  - Description: `Promise.allSettled()` catches failed promises with only a warning log. If 3/5 files fail in bootstrap, the response shows partial data without flagging incompleteness.
  - Impact: User receives incomplete bootstrap data (missing decisions, handoff) without any indication. Silent data loss.
  - Recommended fix: Track partial failure rate. If >0 failures, add `incomplete: true` flag to response. If >50% fail, escalate to error.

- **Finding H-4: Silent Synthesis Failure Path**
  - Severity: HIGH
  - File(s): `src/ai/client.ts:75-79`, `src/tools/finalize.ts:520-554`
  - Description: `synthesize()` catches all errors and returns `null` with only a log — no distinction between auth errors, API failures, and timeouts. Post-commit synthesis wraps the result in a try/catch that provides minimal diagnostics.
  - Impact: Intelligence brief silently goes stale. Next bootstrap loads outdated brief without explicit warning.
  - Recommended fix: Return structured error: `{ success: false, error: "...", error_code: "TIMEOUT" | "AUTH" | "API_ERROR" }`. Surface in finalize response.

- **Finding H-5: X-Forwarded-For Header Spoofing**
  - Severity: HIGH
  - File(s): `src/middleware/auth.ts:11-20`
  - Description: Code trusts the leftmost IP from `X-Forwarded-For` without verifying the request came through a trusted proxy. An attacker can spoof this header to bypass IP allowlist.
  - Impact: IP-based access control (CIDR allowlist) can be bypassed entirely.
  - Recommended fix: Verify Railway proxy configuration strips untrusted `X-Forwarded-For`. Consider using `req.ip` with Express trust proxy setting configured correctly.

- **Finding H-6: Atomic Commit Fallback Risks Partial State**
  - Severity: HIGH
  - File(s): `src/tools/finalize.ts:459-501`
  - Description: When atomic commit fails, finalize falls back to `pushFiles()` (parallel individual pushes). But if atomic failed due to ref staleness, parallel pushes risk 409 conflicts. Some files may commit while others fail.
  - Impact: Partial finalization — handoff version may be out of sync with other living documents.
  - Recommended fix: On atomic failure, check if partial writes occurred before falling back. Add 409 retry to individual push fallback.

- **Finding H-7: fileExists Has No Timeout**
  - Severity: HIGH
  - File(s): `src/github/client.ts:282-300`, called in `src/utils/doc-resolver.ts:51-56`
  - Description: `fileExists()` uses plain `fetch` with no timeout or retry. If GitHub hangs, the entire path resolution hangs indefinitely.
  - Impact: Any tool (bootstrap, push, finalize) can hang indefinitely on a single `fileExists()` call.
  - Recommended fix: Add `AbortSignal.timeout(10000)` to the fetch call, or use `fetchWithRetry()`.

- **Finding H-8: deleteFile Swallows All Errors**
  - Severity: HIGH
  - File(s): `src/github/client.ts:440-465`
  - Description: `deleteFile()` catches all errors and returns `false`. Caller cannot distinguish "file not found" from "auth failed" or "rate limited."
  - Impact: Handoff history pruning silently fails on auth issues. No diagnostic info surfaces.
  - Recommended fix: Return `{ success: boolean; error?: string }` instead of bare boolean.

- **Finding H-9: Synthesis Tracker Cross-Project State Leak**
  - Severity: HIGH
  - File(s): `src/ai/synthesis-tracker.ts:21-40`
  - Description: Module maintains a 50-event ring buffer across all requests in the process. Events persist across projects and sessions — no isolation.
  - Impact: `getSynthesisHealth()` reports leak state from other projects. Memory grows unbounded over weeks.
  - Recommended fix: Scope events by project slug. Add TTL-based eviction (drop events older than 24h).

- **Finding H-10: Sequential resolveDocPath Calls — Double API Fetches**
  - Severity: HIGH
  - File(s): `src/utils/doc-resolver.ts:19-39`
  - Description: `resolveDocPath()` calls `fetchFile()` for `.prism/` path, then on failure calls `fetchFile()` for legacy path. With 10 documents, worst case is 20 GitHub API calls.
  - Impact: ~2 seconds added latency per finalize on legacy repos.
  - Recommended fix: Use `listDirectory(".prism/")` once to determine which paths exist, then fetch only the correct paths.

- **Finding H-11: Response Body Leak in fetchWithRetry on 429**
  - Severity: HIGH
  - File(s): `src/github/client.ts:67-83`
  - Description: When a 429 response is received and retry continues, the response body is never consumed or cancelled. This leaks sockets.
  - Impact: Gradual socket exhaustion under sustained rate limiting.
  - Recommended fix: Add `await res.body?.cancel()` before continuing the retry loop.

## Medium-Priority Findings (fix when convenient)

- **Finding M-1: IPv6 Not Supported in CIDR Validation**
  - Severity: MEDIUM
  - File(s): `src/utils/cidr.ts:6-17`
  - Description: `ipToLong()` only handles IPv4 (splits on `.`). IPv6 addresses silently return `false` from `isIpInCidr()`.
  - Impact: If Anthropic adds IPv6 ranges, CIDR check would block legitimate requests.
  - Recommended fix: Add explicit IPv6 handling or log a warning when IPv6 address encountered.

- **Finding M-2: Null Byte Not Checked in validateProjectSlug**
  - Severity: MEDIUM
  - File(s): `src/validation/slug.ts:8-19`
  - Description: `validateProjectSlug()` does not check for null bytes which could truncate the slug in some contexts.
  - Recommended fix: Add `if (slug.includes("\x00")) return { valid: false, error: "..." }`.

- **Finding M-3: Zod Schema Permissiveness on Decision/Insight IDs**
  - Severity: MEDIUM
  - File(s): `src/tools/log-decision.ts:18-26`, `src/tools/log-insight.ts`
  - Description: Decision IDs and domains are plain strings with no format validation. Could accept `"D-999999999"` or HTML injection in logs.
  - Recommended fix: Add regex constraints: `z.string().regex(/^D-\d{1,5}$/)`.

- **Finding M-4: Configuration Drift — LEGACY_LIVING_DOCUMENTS Not Deprecated**
  - Severity: MEDIUM
  - File(s): `src/config.ts:87-101`
  - Description: Comment says "REMOVE after all repos confirmed migrated" but still heavily used in 4+ tools. No migration tracking exists.
  - Recommended fix: Create a tracking decision (D-NN) for when to remove legacy path support. Track per-project migration status.

- **Finding M-5: No Request Tracing / Correlation ID**
  - Severity: MEDIUM
  - File(s): `src/middleware/request-logger.ts`, all tools
  - Description: No correlation ID propagated through the tool chain. Cannot trace a failing finalize across its 12+ internal operations in Railway logs.
  - Recommended fix: Generate UUID per request in middleware, attach to logger context, propagate to all tool calls.

- **Finding M-6: Error Information Leakage in Synthesis Logs**
  - Severity: MEDIUM
  - File(s): `src/ai/client.ts:76-77`
  - Description: Anthropic API errors are logged with full message content. Could include API key format hints or internal error details.
  - Recommended fix: Sanitize error messages before logging: strip API key patterns (`sk-...`).

- **Finding M-7: Response Size Not Monitored**
  - Severity: MEDIUM
  - File(s): `src/tools/bootstrap.ts:516-596`
  - Description: MCP responses are JSON.stringify'd with no size check. Large projects with many standing rules could exceed ~25K token limit, causing silent truncation.
  - Recommended fix: Add runtime size check after JSON.stringify. Log warning if >80KB.

- **Finding M-8: No GitHub 422 Validation Error Handling**
  - Severity: MEDIUM
  - File(s): `src/github/client.ts:40-54`
  - Description: `handleApiError()` handles 401, 403, 404, 429 explicitly but not 422 (validation errors). Returns generic message for these.
  - Recommended fix: Add 422 case with extracted validation message from response body.

## Low-Priority / Informational

- **Finding L-1: defaultBranchCache Has No Size Limit or TTL**
  - Severity: LOW
  - File(s): `src/github/client.ts:471-503`
  - Description: Module-level `Map<string, string>` grows unbounded. With 17 projects this is negligible, but violates best practice for long-running processes.
  - Recommended fix: Cap at 100 entries or add 24h TTL.

- **Finding L-2: MemoryCache Does Not Evict Expired Entries Proactively**
  - Severity: LOW
  - File(s): `src/utils/cache.ts:27-37`
  - Description: Expired entries stay in the Map until re-accessed. Memory grows if keys are never re-read.
  - Recommended fix: Add periodic cleanup with `setInterval`.

- **Finding L-3: fileExists() Doesn't Consume Body on Success**
  - Severity: LOW
  - File(s): `src/github/client.ts:288-289`
  - Description: Body cancelled on 404 (line 287) but not explicitly consumed on success. Minor socket leak edge case.
  - Recommended fix: Add `await res.body?.cancel()` after the `res.ok` check.

- **Finding L-4: Rate Limit Retry Caps Retry-After at 10s**
  - Severity: LOW
  - File(s): `src/github/client.ts:75`
  - Description: `Math.min(retryAfter * 1000, 10000)` caps the wait at 10s even if GitHub says `Retry-After: 60`. May cause immediate re-rate-limiting.
  - Recommended fix: Respect the full `Retry-After` value (remove the 10s cap).

- **Finding L-5: Response Inconsistency Across Tools**
  - Severity: LOW
  - File(s): All `src/tools/*.ts`
  - Description: Error response shapes vary: some use `{ error: "..." }`, others `{ success: false, results: [...] }`. No consistent contract.
  - Recommended fix: Standardize error response shape across all tools.

- **Finding L-6: extractJSON Tested but Not All Strategies Exercised Behaviorally**
  - Severity: LOW
  - File(s): `src/tools/finalize.ts:35-54`, `tests/finalize.test.ts`, `tests/finalize-edge-cases.test.ts`
  - Description: `extractJSON` is tested structurally and with edge cases, but the array extraction path (first `[` to last `]`) has minimal behavioral coverage.
  - Recommended fix: Add test case for array extraction with surrounding prose.

## Metrics Summary

- Total source files analyzed: 35
- Total source lines of code: 7,883
- Test files: 28 with 316 test cases (4,545 LOC)
- GitHub API calls per tool (critical path):

| Tool | Sequential API Calls | Parallelizable | Total |
|------|---------------------|----------------|-------|
| bootstrap | 3-5 | 2-3 prefetch | 5-8 |
| finalize (audit) | 5-7 | 5 commit details | 10-12 |
| finalize (draft) | 10-20 | 10 doc resolve | 10-20 |
| finalize (commit) | 3-4 + 5 atomic | 10 guard checks | 8-19 |
| push | 1-2 per file | N guard checks | 2-3N |
| scale | 4-6 | 3-5 doc pushes | 7-11 |
| search | 1-3 | 0 | 1-3 |
| status | 2-4 | 0 | 2-4 |

- try/catch blocks audited: 47
- Type safety issues found: 30+ `as` assertions, 3 unsafe `(err as Error).message` patterns
- Silent catch blocks: 8 (4 intentional empty catches, 4 with only warnings)

## Files Analyzed

**Source (35 files):**
`src/ai/client.ts`, `src/ai/prompts.ts`, `src/ai/synthesis-tracker.ts`, `src/ai/synthesize.ts`, `src/config.ts`, `src/github/client.ts`, `src/github/types.ts`, `src/index.ts`, `src/middleware/auth.ts`, `src/middleware/request-logger.ts`, `src/tools/analytics.ts`, `src/tools/bootstrap.ts`, `src/tools/fetch.ts`, `src/tools/finalize.ts`, `src/tools/log-decision.ts`, `src/tools/log-insight.ts`, `src/tools/patch.ts`, `src/tools/push.ts`, `src/tools/scale.ts`, `src/tools/search.ts`, `src/tools/status.ts`, `src/tools/synthesize.ts`, `src/utils/banner.ts`, `src/utils/cache.ts`, `src/utils/cidr.ts`, `src/utils/doc-guard.ts`, `src/utils/doc-resolver.ts`, `src/utils/logger.ts`, `src/utils/markdown-sections.ts`, `src/utils/summarizer.ts`, `src/validation/common.ts`, `src/validation/decisions.ts`, `src/validation/handoff.ts`, `src/validation/index.ts`, `src/validation/slug.ts`

**Tests (28 files):**
`tests/analytics-parsing.test.ts`, `tests/atomic-fallback.test.ts`, `tests/banner-text.test.ts`, `tests/bootstrap-budget.test.ts`, `tests/bootstrap-parsing.test.ts`, `tests/branch-detection.test.ts`, `tests/cidr.test.ts`, `tests/doc-guard.test.ts`, `tests/doc-resolver.test.ts`, `tests/finalize-edge-cases.test.ts`, `tests/finalize-fallback.test.ts`, `tests/finalize-integration.test.ts`, `tests/finalize-performance.test.ts`, `tests/finalize.test.ts`, `tests/github-client-resilience.test.ts`, `tests/intelligence-layer.test.ts`, `tests/markdown-sections.test.ts`, `tests/prefetch-keywords.test.ts`, `tests/push-integration.test.ts`, `tests/push-validation.test.ts`, `tests/scale.test.ts`, `tests/setup.ts`, `tests/slug-resolution.test.ts`, `tests/summarizer.test.ts`, `tests/synthesis-alerting.test.ts`, `tests/template-budget.test.ts`, `tests/validation-extended.test.ts`, `tests/validation.test.ts`

## Prioritized Action Backlog

1. **Brief proposal: Security Hardening (S34a)** — addresses C-1, C-2, H-5, M-1, M-2, M-3
   - Timing-safe token comparison, URL-decode path validation, null byte checks, X-Forwarded-For trust, Zod schema tightening
   - Estimated scope: 4 files modified

2. **Brief proposal: Timeout Architecture Fix (S34b)** — addresses C-3, H-4, H-7
   - Cap all synthesis/draft timeouts to 50s, add AbortSignal to fileExists, structured synthesis error returns
   - Estimated scope: 3 files modified

3. **Brief proposal: GitHub API Resilience (S34c)** — addresses H-1, H-8, H-11, M-8, L-4
   - Wrap all 6 functions with fetchWithRetry, structured deleteFile returns, 422 handling, response body cleanup
   - Estimated scope: 1 file modified (client.ts)

4. **Brief proposal: Performance — Eliminate N+1 Patterns (S34d)** — addresses H-2, H-10
   - Replace fileExists calls in guardPushPath with batch listDirectory, cache resolved paths across phases
   - Estimated scope: 3 files modified

5. **Brief proposal: Observability & Diagnostics (S34e)** — addresses H-3, H-9, M-5, M-6, M-7
   - Add request correlation ID, partial failure flagging, synthesis tracker scoping, response size monitoring
   - Estimated scope: 5 files modified

6. **Brief proposal: Error Path Test Suite (S34f)** — addresses L-5, L-6, missing edge case tests
   - Network failure tests, rate limiting tests, partial failure tests, extractJSON array path
   - Estimated scope: 2-3 new test files

<!-- EOF: audit-s33c.md -->
