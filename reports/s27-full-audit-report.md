# PRISM Full-Stack Audit Report
> Generated: 2026-04-02
> Scope: prism-framework, prism, prism-mcp-server
> Auditor: Claude Code (Opus 4.6, 1M context)

## Executive Summary

PRISM is an ambitious and largely successful framework for solving Claude's zero cross-session memory problem. The three-repo architecture (framework templates, meta-project living documents, MCP server) is sound in concept, and the MCP server code is well-organized with consistent patterns and a clean dependency tree. The system has evolved through 26 sessions from a bash+cURL workflow to a sophisticated 12-tool MCP server with AI-powered synthesis -- a significant engineering achievement for a single developer.

However, the rapid evolution has created a **documentation debt crisis**. The framework's three docs/ files are frozen at v1.0.0, the full core template trails the MCP template by 8 minor versions, the CHANGELOG has a 16-session gap, and the prism-mcp-server's living documents are frozen at Session 10 despite 16 more sessions of active development. Most critically, the decision index (_INDEX.md) and its domain files have at least 15 ID collisions where the same D-N identifier refers to completely different decisions depending on which file you read -- undermining the entire decision registry system.

On the code quality side, the MCP server has no authentication on its endpoint (anyone with the URL can read/write all GitHub repos via the PAT), doubles its GitHub API calls by fetching content and SHA separately, and has only 1 of 12 tools with comprehensive test coverage. The standing-rule test actively tests a re-implemented function rather than the production code, giving false confidence. These are fixable issues, but they represent real risk in a production system managing 17 projects.

---

## Repo Statistics

| Metric | prism-framework | prism | prism-mcp-server |
|--------|----------------|-------|------------------|
| Files | 22 | 38 | 67 |
| Lines | 4,291 | 4,789 | 12,265 |
| Total size | 241 KB | 286 KB | 457 KB |
| Source code files | 0 | 0 | 24 (.ts) |
| Test files | 0 | 0 | 6 |
| Brief files | 0 | 0 | 12 |
| Living documents | N/A | 10 | 10 (stale) |
| Decisions tracked | N/A | 48 | 5 (stale) |

---

## Architecture & Design

### A.1: Three-Tier Intelligence Model -- Tier Bleeding in MCP Template

- **Finding:** The three-tier model (Tier 1 structural, Tier 2 behavioral, Tier 3 situational) is conceptually clean in the architecture docs, but the MCP template (`core-template-mcp.md`) has significant tier bleeding. Rule 1 contains ~15 lines of procedural banner rendering cascade logic (`banner_html` > `banner_data` > `banner_svg` > null fallback). Rule 11 embeds the entire finalization protocol inline -- audit, draft, compose, commit, banner rendering, confirmation format (~20 lines). The full template correctly defers Rule 11 to the finalization module, maintaining the tier boundary.
- **Severity:** High
- **Evidence:** `_templates/core-template-mcp.md:40-56` (Rule 1 procedural content), `_templates/core-template-mcp.md:119-141` (Rule 11 inline finalization). `_templates/core-template.md:196-225` correctly says "fetch the finalization module and execute it." The `THREE_TIER_ARCHITECTURE.md:245-246` explicitly states rules should be "under 15 rules, each expressible in 1-3 sentences."
- **Recommendation:** Refactor Rules 1 and 11 in the MCP template to defer procedural detail to the banner specs and a finalization reference. Rules should state WHAT, not HOW.

### A.2: Repo Architecture -- Clean Separation with One Coupling Issue

- **Finding:** The three-repo separation is clean in principle. However, the prism-mcp-server repo's living documents are frozen at Session 10, while all subsequent development (S11-S26) was tracked exclusively in the main prism repo. This creates an ambiguity: is prism-mcp-server a standalone PRISM-managed project or a sub-project of the prism meta-project?
- **Severity:** Medium
- **Evidence:** `prism-mcp-server/session-log.md` has 4 entries (through S10). `prism-mcp-server/handoff.md` says "Session Count: 4, Server v2.1.0." Actual server is v2.9.0 with 12 tools. All S11-S26 work on the server is logged in `prism/session-log.md`.
- **Recommendation:** Either maintain prism-mcp-server as a standalone PRISM project (update its living documents) or formally document that it is a sub-project tracked in the prism meta-project (add a note to its handoff.md).

### A.3: Living Documents System -- 8 vs 10 Count Inconsistency

- **Finding:** The living document count is inconsistent across the codebase. D-18 established 8 documents, D-41 (S20) added insights.md as the 9th, D-44 (S22) added intelligence-brief.md as the 10th. But 8+ locations still reference "8 mandatory."
- **Severity:** High
- **Evidence:**
  - **Correct (10):** `config.ts:70`, `prism/handoff.md:4`, `core-template-mcp.md:174`, `prism/architecture.md:33`, `prism/glossary.md:11`, `finalization-banner-spec.md:40`
  - **Stale (8):** `prism-mcp-server/CLAUDE.md:48,124`, `core-template.md:210,221`, `banner-spec.md:43`, `finalization.md:16,169`, `prism-mcp-server/architecture.md:23,28`, onboarding module
- **Recommendation:** Update ALL references to 10. This is the single most pervasive inconsistency in the ecosystem.

### A.4: Decision/Guardrail System -- Critical Index Corruption

- **Finding:** The decision _INDEX.md and domain files have at least 15 ID collisions where the same D-N identifier maps to completely different decisions. The D-40 domain split appears to have introduced independent renumbering that was never reconciled.
- **Severity:** Critical
- **Evidence:** Examples of collisions in `prism/decisions/`:
  - D-11: _INDEX says "Validation-first push pattern"; operations.md says "Automated SBF-to-PRISM mass migration"
  - D-12: _INDEX says "Boot-test write verification"; operations.md says "4-tier context awareness protocol"
  - D-13: _INDEX says "Structured logging"; operations.md says "Finalization hard-stop protocol"
  - D-14: _INDEX says "MCP Architecture A"; operations.md says "Mandatory bootstrap size check"
  - D-15: _INDEX says "Context-aware summarization in fetch"; architecture.md says "Research-first Operating Posture"
  - D-25: _INDEX says "Multi-tool finalization"; architecture.md says "Architecture E -- PRISM MCP Server"
  - D-26: _INDEX says "Architecture.md as living document"; architecture.md says "PRISM v2 build plan"
  - D-27: _INDEX says "Glossary.md as living document"; architecture.md says "Framework v2.0.0 -- MCP integration"
  - Plus domain mismatches for D-6, D-30, D-32, D-33, D-35, D-36
- **Recommendation:** Full reconciliation required. The _INDEX.md should be the authoritative source. All domain files must be regenerated to match. This is the highest-priority fix in the entire audit.

### A.5: Guardrail Count Mismatch

- **Finding:** The handoff claims "10 guardrails" but `eliminated.md` contains only 3 entries (G-1, G-2, and an unnumbered "Architecture D").
- **Severity:** High
- **Evidence:** `prism/handoff.md:53` says "See eliminated.md for full rejection registry (10 guardrails)." `prism/eliminated.md` has G-1, G-2, and one unnumbered entry. The prism-mcp-server eliminated.md has G-1 through G-4 (a different set).
- **Recommendation:** Audit all sessions for rejected approaches. Either add the missing 7 guardrails to eliminated.md or correct the count in the handoff.

### A.6: MCP Server Architecture -- Correctly Stateless

- **Finding:** The stateless design is correctly implemented. Each POST creates a fresh McpServer and transport. `sessionIdGenerator: undefined` enforces stateless mode. Two module-level singletons exist (template cache and Anthropic client) but both are read-only/config-only and safe.
- **Severity:** Info
- **Evidence:** `src/index.ts:69-91` creates fresh instances per request. `src/utils/cache.ts` and `src/ai/client.ts` are intentional performance optimizations.
- **Recommendation:** Document the intentional cache singleton as an exception to the stateless principle.

---

## Code Quality & Technical Debt

### B.1: Double API Call Per File Fetch

- **Finding:** The GitHub client makes TWO HTTP requests per file: one for raw content, one for SHA. This doubles API call count and rate-limit consumption.
- **Severity:** High
- **Evidence:** `src/github/client.ts:73-106` -- `fetchFile` calls the API with `Accept: application/vnd.github.raw+json` for content, then calls `fetchSha` (separate request) for the SHA.
- **Recommendation:** Use a single call with the default JSON accept header, which returns both `content` (base64) and `sha` in one response. Decode base64 content. This halves all API calls.

### B.2: No Authentication on MCP Endpoint

- **Finding:** The `/mcp` endpoint has zero authentication. Anyone who discovers the Railway URL can invoke any tool, including writing to all GitHub repos via the server's PAT.
- **Severity:** Critical
- **Evidence:** `src/index.ts` -- no auth middleware on any route. The server exposes full read/write GitHub access.
- **Recommendation:** Add Bearer token or API key authentication before the MCP handler. The MCP spec supports auth headers.

### B.3: No Request Body Size Limit

- **Finding:** `express.json()` is used with no explicit `limit` option. Express 5 defaults to 100KB, but a malicious client could attempt larger payloads.
- **Severity:** High
- **Evidence:** `src/index.ts:29` -- `app.use(express.json())` with no options.
- **Recommendation:** Set `express.json({ limit: '5mb' })` to allow legitimate large file pushes while capping abuse.

### B.4: No Timeout on Anthropic API Calls

- **Finding:** The Anthropic SDK client has no timeout set. If the API hangs, the MCP request hangs indefinitely. The fire-and-forget synthesis in finalize (`finalize.ts:422`) would leak a pending promise.
- **Severity:** High
- **Evidence:** `src/ai/client.ts:45-49` -- `anthropic.messages.create()` with no timeout.
- **Recommendation:** Set `timeout` in SDK options or wrap with `AbortSignal.timeout(30000)`.

### B.5: Version String Inconsistency

- **Finding:** Three different version strings exist: `config.ts:47` says "2.9.0", `package.json:3` says "2.5.0", `client.ts:28` User-Agent says "2.0.0".
- **Severity:** Medium
- **Evidence:** As cited. Additionally, `prism-mcp-server/handoff.md:19` says "v2.1.0".
- **Recommendation:** Import version from package.json or define in one location. Bump package.json to 2.9.0.

### B.6: Validation Coverage Gaps

- **Finding:** Only `handoff.md` and `decisions/_INDEX.md` have file-specific validators. The other 8 living documents only get non-empty + EOF sentinel checks. The "ACCEPTED" status used in the prism meta-project (D-48) is not in the VALID_STATUSES array.
- **Severity:** Medium
- **Evidence:** `src/validation/index.ts:18-34` shows only two file-specific validators. `src/validation/decisions.ts:9` VALID_STATUSES is `["SETTLED", "PENDING", "SUPERSEDED", "REVISITED"]` -- missing "ACCEPTED" and "OPEN" (suggested in log-decision.ts description).
- **Recommendation:** Add "ACCEPTED" and "OPEN" to VALID_STATUSES. Consider structural validators for session-log.md and task-queue.md.

### B.7: Rate Limit Retry is Single-Attempt Only

- **Finding:** GitHub API 429 responses trigger only a single retry. Paginated endpoints (listRepos) have no rate-limit handling at all.
- **Severity:** Medium
- **Evidence:** `src/github/client.ts:80-94` (fetchFile), `317-341` (listRepos pagination with no 429 handling).
- **Recommendation:** Implement 2-3 retries with exponential backoff. Add rate-limit handling to pagination.

### B.8: Fragile JSON Parsing of AI Output

- **Finding:** Synthesis output is parsed by stripping markdown code fences with regex then calling JSON.parse. This fails if the model outputs fences with different formatting.
- **Severity:** Medium
- **Evidence:** `src/tools/finalize.ts:272` -- `result.content.replace(/```json\n?|```\n?/g, "").trim()` then `JSON.parse(clean)`.
- **Recommendation:** Extract JSON by finding first `{` and last `}`, or use a more robust extraction pattern.

### B.9: Non-Atomic "Atomic" Decision Logging

- **Finding:** `prism_log_decision` claims to write "atomically" to both _INDEX.md and the domain file, but pushes are sequential `await` calls. If the second push fails, the index is updated but the domain file is not.
- **Severity:** Medium
- **Evidence:** `src/tools/log-decision.ts:14` description says "atomically". Lines 84-96 push sequentially.
- **Recommendation:** Use `Promise.allSettled` for both pushes, or document as best-effort.

### B.10: Dead Code

- **Finding:** Multiple dead code artifacts exist:
  - `src/index.ts:11` -- `isInitializeRequest` imported but never used
  - `src/utils/banner.ts:192` -- `const border = i < data.tools.length - 1 ? "" : ""` always evaluates to `""` and is never referenced
  - `src/tools/finalize.ts:599-619` -- `auditSchema` and `commitSchema` defined but never used (inline schema used instead at line 622)
- **Severity:** Low
- **Evidence:** As cited above.
- **Recommendation:** Remove all three dead code blocks.

### B.11: Input Sanitization Gap

- **Finding:** `project_slug` and file path parameters are passed directly to GitHub API URLs without validation. While GitHub's API prevents path traversal, the server does not validate that slugs match expected patterns.
- **Severity:** Medium
- **Evidence:** All tool input schemas accept arbitrary strings for `project_slug`.
- **Recommendation:** Validate `project_slug` matches `^[a-zA-Z0-9_-]+$` and file paths don't contain `..`.

### B.12: `fileExists` Silently Catches All Errors

- **Finding:** The catch block returns `false` for ANY error, including network failures. A network timeout would incorrectly report a file as non-existent.
- **Severity:** Low
- **Evidence:** `src/github/client.ts:291-299` -- catch returns `false` for all errors.
- **Recommendation:** Check error type and only return `false` for 404s.

### B.13: Response Body Not Consumed in fileExists

- **Finding:** When checking if a file exists, `res.ok` is checked but `res.body` is never consumed, potentially causing socket leaks.
- **Severity:** Low
- **Evidence:** `src/github/client.ts:294` -- `res.ok` checked, body not consumed.
- **Recommendation:** Add `await res.text()` or `await res.body?.cancel()`.

### B.14: Dependencies -- Clean and Minimal

- **Finding:** Only 4 runtime dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `express`, `zod`). No unnecessary dependencies. Express 5 is stable. No known security vulnerabilities in declared versions.
- **Severity:** Info (positive)
- **Evidence:** `package.json:10-15`
- **Recommendation:** None. Excellent dependency hygiene.

### B.15: Test Coverage -- 1 of 12 Tools Tested

- **Finding:** Only `prism_scale_handoff` has comprehensive tool-level tests. The other 11 tools (including critical ones like `prism_push`, `prism_finalize`, `prism_bootstrap`) have zero direct test coverage. The standing-rule test in `intelligence-layer.test.ts` re-implements the function rather than importing the production code, testing different behavior.
- **Severity:** Critical
- **Evidence:**
  - `tests/scale.test.ts` -- 14 test cases, thorough (positive example)
  - `tests/intelligence-layer.test.ts:18-38` -- `extractStandingRules` re-implemented with different interface (`content` vs production's `procedure` field)
  - No test files for: bootstrap, finalize, push, fetch, search, status, patch, log-decision, log-insight, synthesize
- **Recommendation:** Priority test additions: (1) `prism_push` validate-all-or-push-none invariant, (2) `prism_finalize` commit phase, (3) `prism_bootstrap` handoff parsing, (4) `validateDecisionIndex`, (5) `validateEofSentinel` and `validateCommitMessage`.

### B.16: CI Pipeline -- Minimal

- **Finding:** CI has only build + test. No linting, no security scanning, no coverage reporting, no type-check-only step, single Node version (20) despite engine spec of >=18.
- **Severity:** High
- **Evidence:** `.github/workflows/ci.yml` -- 5 steps: checkout, setup-node, install, build, test.
- **Recommendation:** Add: ESLint/Biome, `npm audit`, coverage threshold, Node 18 in test matrix.

---

## Behavioral Rules & Template Quality

### C.1: MCP Template Rules -- Generally Clear with Size Issues

- **Finding:** The 14 rules are individually clear and mostly enforceable. However, Rules 1 and 11 are far too long for Tier 2 behavioral rules, containing procedural detail that belongs in modules or specs. Three HARD RULES (1, 9, 11) are appropriately designated.
- **Severity:** High (tier bleeding, discussed in A.1)
- **Evidence:** `core-template-mcp.md` Rules 1 (~15 lines), 9 (~25 lines), 11 (~20 lines). `THREE_TIER_ARCHITECTURE.md:245-246` prescribes "1-3 sentences" per rule.
- **Recommendation:** Refactor to move procedural content to specs/references.

### C.2: Rule 5 Behavioral Contradiction Between Templates

- **Finding:** The full template says "Track silently" while the MCP template says "capture knowledge proactively" -- opposite interaction styles for the same rule number.
- **Severity:** High
- **Evidence:** `core-template.md:122-125` (Rule 5): "Track silently." `core-template-mcp.md:66-71` (Rule 5): "capture institutional knowledge proactively."
- **Recommendation:** Reconcile. If proactive capture is the desired behavior (per D-45), update the full template.

### C.3: Template Version Divergence

- **Finding:** The MCP template is at v2.9.0, the full template at v2.1.1. The CHANGELOG stops at v2.1.1 (Session 13). All changes from v2.2.0 through v2.9.0 are unrecorded.
- **Severity:** High
- **Evidence:** `core-template-mcp.md:1` v2.9.0. `core-template.md:1` v2.1.1. `_templates/CHANGELOG.md` last entry is v2.1.1.
- **Recommendation:** Either bring the full template to parity or formally deprecate it. Backfill the CHANGELOG.

### C.4: Module Trigger Table Incomplete in MCP Template

- **Finding:** The MCP template lists 4 modules (onboarding, task-checkpoints, fresh-eyes, error-recovery) but omits finalization and handoff-scaling even as fallback entries.
- **Severity:** Medium
- **Evidence:** `core-template-mcp.md:158-167` lists 4; `core-template.md:242-252` lists 6.
- **Recommendation:** Add finalization and handoff-scaling as fallback entries.

### C.5: Banner Spec docs.total Mismatch

- **Finding:** Boot banner spec says `docs.total` is "always 8"; finalization banner spec says "10".
- **Severity:** Medium
- **Evidence:** `banner-spec.md:43` says 8. `finalization-banner-spec.md:40` says 10.
- **Recommendation:** Update both to 10.

### C.6: MCP Template References Wrong Filename

- **Finding:** `core-template-mcp.md:6` says "Full template: `_templates/core-template-full.md`" but the actual file is `_templates/core-template.md`.
- **Severity:** Low
- **Evidence:** As cited. File `core-template-full.md` does not exist.
- **Recommendation:** Fix to `core-template.md`.

### C.7: Rule 9 Context Tracking -- Inherently Imprecise

- **Finding:** Rule 9 demands exact format on every response with no exceptions, but the estimation formula uses qualitative terms ("~1% per small fetch"). The rule is simultaneously mechanical (mandatory format) and fuzzy (estimation-based).
- **Severity:** Medium
- **Evidence:** `core-template-mcp.md:86-113`
- **Recommendation:** Acknowledge as best-effort or simplify the formula.

### C.8: Interaction Rule Scope Ambiguity

- **Finding:** "Sequential instructions only... wait for the user's response before moving on" conflicts with automated PRISM workflows (bootstrap, finalization) that are multi-step autonomous operations.
- **Severity:** Low
- **Evidence:** `core-template-mcp.md:26`
- **Recommendation:** Add qualifier: "Applies to user-facing instructions, not automated PRISM protocol execution."

---

## Session Lifecycle & Methodology

### D.1: Bootstrap Flow -- Sequential Where Parallel Would Work

- **Finding:** Intelligence brief and insights fetches in bootstrap are sequential `await` calls that could be parallelized, adding ~400-800ms latency.
- **Severity:** Medium
- **Evidence:** `src/tools/bootstrap.ts:307-341` (intelligence brief), `:345` (insights) -- sequential awaits.
- **Recommendation:** `Promise.allSettled([fetchFile(..., "intelligence-brief.md"), fetchFile(..., "insights.md")])`.

### D.2: Bootstrap Payload Size

- **Finding:** The bootstrap response includes behavioral_rules (~3-8KB), banner_html (~4KB), banner_data, intelligence_brief, standing_rules, component_sizes, and prefetched documents. Total can exceed 20KB.
- **Severity:** Medium
- **Evidence:** `src/tools/bootstrap.ts:444-471`
- **Recommendation:** Consider whether behavioral_rules (cached and rarely changing) needs to be in every bootstrap response.

### D.3: Finalization Flow -- Fire-and-Forget Synthesis Risk

- **Finding:** Intelligence brief synthesis is fire-and-forget during finalization commit. If the Anthropic API hangs or the process restarts, the brief is silently lost.
- **Severity:** Medium
- **Evidence:** `src/tools/finalize.ts:422-436` -- `.then().catch()` pattern.
- **Recommendation:** Document as known limitation. Consider making synthesis synchronous for critical projects.

### D.4: Context Window Management

- **Finding:** Rule 9's formula is imprecise but the context status line concept is sound. The main context waste is the prism-mcp-server's CLAUDE.md, which still contains the full Session 1 build specification (~400 lines of historical content) that Claude Code reads every session.
- **Severity:** Medium
- **Evidence:** `prism-mcp-server/CLAUDE.md` is 413 lines, ~18KB. The Session 1 build spec (lines 200-413) is pure historical content consuming context on every CC session.
- **Recommendation:** Remove the Session 1 build spec from CLAUDE.md. It served its purpose and is now dead weight.

### D.5: Brief Workflow -- Well-Designed

- **Finding:** The 12 briefs in the briefs/ directory demonstrate a mature workflow pattern. Each brief has clear pre-flight, implementation steps, verification criteria, and post-flight. The briefs effectively serve as executable specifications.
- **Severity:** Info (positive)
- **Evidence:** `briefs/` directory, particularly `ki10-scale-handoff-timeout.md` (200 lines, research-backed) and `s23-efficiency-tools.md` (700 lines, comprehensive).
- **Recommendation:** None. The brief system is one of PRISM's strongest innovations.

---

## Data Integrity & Consistency

### E.1: Decision Index Corruption (see A.4)

- **Severity:** Critical
- **Evidence:** 15+ ID collisions between `prism/decisions/_INDEX.md` and domain files.
- **Recommendation:** Full reconciliation with _INDEX.md as source of truth.

### E.2: Domain Count Math Error

- **Finding:** The _INDEX.md header claims domain counts that sum to 43, but the table has 48 entries. "production-stack" is listed as a domain but no file exists and no decision claims it.
- **Severity:** Medium
- **Evidence:** `prism/decisions/_INDEX.md:4` domain counts sum to 43, not 48.
- **Recommendation:** Recount after reconciliation. Remove phantom "production-stack" domain.

### E.3: Stale Known Issues

- **Finding:** KI-2 in the prism meta-project ("PlatformForge decision index 44.7KB") has been "reduced" by v2.0.0 and should be resolved after PlatformForge sessions confirmed the fix. KI-3 ("11 projects have only 4/8 living documents") references "8" (should be 10) and is from S4 -- 22 sessions ago.
- **Severity:** Medium
- **Evidence:** `prism/known-issues.md:16-30`
- **Recommendation:** Resolve KI-2. Audit and update or resolve KI-3.

### E.4: prism-mcp-server Living Documents Frozen at S10

- **Finding:** All 10 living documents in the prism-mcp-server repo are frozen at the Session 10 state. The session-log has 4 entries, handoff says "Session Count: 4, Server v2.1.0", decisions/_INDEX has 5 entries, known-issues is missing KI-10/11/15, glossary says KI-2 is "currently bugged" (resolved), task-queue lists CI as "Up Next" (completed), architecture lists 7 tools (actual: 12).
- **Severity:** High
- **Evidence:** Every living document in `/tmp/prism-mcp-server/` as detailed above.
- **Recommendation:** Either perform a comprehensive update of all prism-mcp-server living documents or formally designate them as archival.

### E.5: Handoff Version vs Session Count

- **Finding:** In the prism meta-project, handoff version (31) exceeds session count (26) by 5, reflecting mid-session checkpoints. This is healthy and expected.
- **Severity:** Info
- **Evidence:** `prism/handoff.md:4-5`
- **Recommendation:** None.

### E.6: Standing Rules Properly Maintained

- **Finding:** All 6 standing rules in insights.md are properly tagged with "STANDING RULE" and have "Standing procedure:" sections. The count matches the handoff claim.
- **Severity:** Info (positive)
- **Evidence:** `prism/insights.md` -- INS-6, 7, 8, 10, 11, 13. `prism/handoff.md:89` confirms 6 standing rules.
- **Recommendation:** None.

### E.7: EOF Sentinel Issues in Briefs

- **Finding:** 2 brief files have mismatched EOF sentinels (filename in sentinel doesn't match actual filename). 1 brief file and CLAUDE.md are missing EOF sentinels entirely.
- **Severity:** Low
- **Evidence:**
  - `briefs/d35-html-banner.md` EOF says `html-banner-brief.md` (mismatch)
  - `briefs/ki15-slug-resolution.md` EOF says `slug-resolution-brief.md` (mismatch)
  - `briefs/s22-intelligence-layer.md` has no EOF sentinel
  - `CLAUDE.md` has no EOF sentinel
- **Recommendation:** Fix mismatched sentinels. Add missing sentinels.

### E.8: Artifacts in "current/" Are Historical

- **Finding:** Both files in `prism/artifacts/current/` are historical snapshots: `claude-md-prism-mcp-server.md` (S9 build spec) and `living-documents-design.md` (S4 design proposal, v1.3.0). The "current" directory name is misleading.
- **Severity:** Medium
- **Evidence:** `claude-md-prism-mcp-server.md` lists 7 tools, 8 docs, 12 projects (actual: 12 tools, 10 docs, 17 projects). `living-documents-design.md` says "8 Mandatory" at v1.3.0.
- **Recommendation:** Rename directory to `artifacts/archive/` or add "HISTORICAL SNAPSHOT" headers.

---

## Performance & Optimization

### F.1: Double API Call Per File (see B.1)

- **Severity:** High
- **Impact:** Every file fetch costs 2 API calls instead of 1. For a bootstrap with 5 files, that's 10 calls instead of 5.
- **Recommendation:** Single call with base64 decode.

### F.2: Search Fetches Domain Files Twice

- **Finding:** `prism_search` fetches each decision domain file completely via `fetchFile` in `discoverDecisionDomainFiles`, then fetches all files AGAIN for content search.
- **Severity:** Medium
- **Evidence:** `src/tools/search.ts:145-170` (discovery fetch), `192-208` (content fetch). Same files fetched twice.
- **Recommendation:** Use `fileExists` for discovery, then fetch once for content.

### F.3: Status Multi-Project is O(N*M) API Calls

- **Finding:** For each repo (N), status checks all 10 living documents (M). With 20 repos and 10 PRISM projects, that's ~120 API calls.
- **Severity:** Medium
- **Evidence:** `src/tools/status.ts:139-178`
- **Recommendation:** Parallelization mitigates wall-clock time, but GitHub rate limit (5000/hr) could be consumed with frequent status checks. Consider short-lived caching.

### F.4: No Caching for Read-Only Operations

- **Finding:** Template cache (5-minute TTL) is well-implemented, but search and status operations fetch all living documents from GitHub with no caching.
- **Severity:** Medium
- **Evidence:** `src/tools/search.ts` and `src/tools/status.ts` -- no cache usage.
- **Recommendation:** Add 30-60 second cache for file content in read-only operations.

### F.5: Bootstrap Payload Could Be Smaller

- **Finding:** Behavioral rules (~3-8KB) are included in every bootstrap response despite being cached and rarely changing. The `banner_html` (~4KB) is also included alongside `banner_data`.
- **Severity:** Medium
- **Evidence:** `src/tools/bootstrap.ts:444-471`
- **Recommendation:** Consider making behavioral rules a separate cached fetch, not bundled in every bootstrap.

### F.6: Cache Implementation is Sound

- **Finding:** The `MemoryCache` class is well-implemented with proper TTL management. Cache invalidation on push is correctly wired for the core template.
- **Severity:** Info (positive)
- **Evidence:** `src/utils/cache.ts`, `src/tools/push.ts:134-139`
- **Recommendation:** Change cache hit/miss logging from `info` to `debug` level (`src/utils/cache.ts:33,37,44`).

---

## Security & Operational Risks

### G.1: No Authentication on MCP Endpoint (see B.2)

- **Severity:** Critical
- **Recommendation:** Implement Bearer token authentication.

### G.2: GitHub PAT in Template File

- **Finding:** A real GitHub PAT is stored in plaintext in the framework template file.
- **Severity:** Critical
- **Evidence:** `_templates/project-instructions.md:9` contains a real, active-format GitHub Personal Access Token in plaintext (value redacted from this report).
- **Recommendation:** Immediately rotate this PAT. Replace with a placeholder like `github_pat_YOUR_TOKEN_HERE`.

### G.3: No Input Sanitization on Project Slug (see B.11)

- **Severity:** Medium
- **Recommendation:** Validate `project_slug` matches `^[a-zA-Z0-9_-]+$`.

### G.4: XSS Risk in Banner HTML

- **Finding:** `escapeHtml` in banner.ts escapes `&`, `<`, `>`, `"` but not single quotes. Theoretical risk in single-quoted HTML attributes.
- **Severity:** Low
- **Evidence:** `src/utils/banner.ts:37-43`
- **Recommendation:** Add `'` to `&#39;` escaping for defense in depth.

### G.5: Error Recovery -- Adequate

- **Finding:** GitHub 401/404/409/429 errors are handled with appropriate messages. Rate limit retry exists (single attempt). 409 conflict retries with fresh SHA. Express error handler catches unhandled rejections.
- **Severity:** Info
- **Evidence:** `src/github/client.ts` error handling throughout. `src/index.ts` catch-all error handler.
- **Recommendation:** Increase 429 retry count to 2-3 with backoff.

### G.6: Railway Deployment -- Properly Configured

- **Finding:** `railway.json` specifies healthcheck path. `Procfile` runs `npm start`. Environment variables are properly externalized.
- **Severity:** Info
- **Evidence:** `railway.json`, `Procfile`, `.env.example`
- **Recommendation:** None.

---

## Documentation Quality

### H.1: METHODOLOGY_DEEP_DIVE.md -- Frozen at v1.0.0

- **Finding:** This 42KB document describes a v1.0.0 system that no longer exists. It references `active/[project-slug]/` directory structure (actual: separate repos), a three-phase finalization (actual: five-step), and context monitoring "every 5 exchanges" (actual: every response). No mention of MCP, banners, insights, intelligence briefs, or any feature added after v1.0.0.
- **Severity:** High
- **Evidence:** `docs/METHODOLOGY_DEEP_DIVE.md:3` says v1.0.0. `docs/METHODOLOGY_DEEP_DIVE.md:109` shows `active/[project-slug]/` path. `:77` shows three-phase finalization. `:280` shows "every 5 exchanges."
- **Recommendation:** Rewrite or add prominent deprecation notice.

### H.2: THREE_TIER_ARCHITECTURE.md -- Frozen at v1.0.0

- **Finding:** Same staleness as H.1. Additionally, this document explicitly explains why context zones and health calculations are NOT in Tier 2 -- but the actual v2.9.0 MCP template puts the context zone formula into Tier 2 as Rule 9, directly contradicting the documented design rationale.
- **Severity:** High
- **Evidence:** `docs/THREE_TIER_ARCHITECTURE.md:6` v1.0.0. `:301-313` design notes against context zones in Tier 2. Actual `core-template-mcp.md:86-113` has context zone formula in Tier 2.
- **Recommendation:** Rewrite or deprecate.

### H.3: SETUP_GUIDE.md -- Dangerously Stale

- **Finding:** A new user following this guide would create a v1.0.0 implementation that conflicts with the actual v2.9.0 framework in every operational detail. The embedded templates, modules, and project instructions are all pre-MCP, pre-banner, pre-10-document versions. The onboarding approach shown (lengthy questionnaire) is explicitly rejected by the current onboarding module.
- **Severity:** Critical
- **Evidence:** `docs/SETUP_GUIDE.md:69-218` embeds v1.0.0 core template. `:298-472` embeds old onboarding (current module at `:33-34` says "Ask exactly two questions"). `:780-805` has no MCP discovery.
- **Recommendation:** Rewrite completely or remove with a redirect to `project-instructions.md`.

### H.4: Glossary -- Mostly Complete with Format Inconsistency

- **Finding:** The prism glossary has ~30 terms covering major concepts but uses two formatting conventions (table rows vs bullet entries). Missing terms: "D-48 lifecycle states", "banner_data mode", "compact intelligence brief".
- **Severity:** Low
- **Evidence:** `prism/glossary.md:6-22` uses table format; `:24-58` switches to bullet format.
- **Recommendation:** Standardize on table format. Add missing S22-S26 vocabulary.

### H.5: CLAUDE.md in Server Repo -- Frozen at Session 1

- **Finding:** The CLAUDE.md still contains the full Session 1 build specification and describes the project as "3 sessions planned." It lists 7 tools, 8 documents, and the Session 1 spec consumes ~200 lines of context that Claude Code reads on every session.
- **Severity:** High
- **Evidence:** `prism-mcp-server/CLAUDE.md:124` says "8 Mandatory Per Project." Tool list shows 7. Session 1 spec starts at ~line 200.
- **Recommendation:** Remove Session 1 build spec. Update to reflect 12 tools and 10 documents. This directly impacts CC session context efficiency.

---

## Scalability & Future-Readiness

### I.1: Multi-Project Scaling

- **Finding:** With 17 projects and the current O(N*M) status check pattern, a `prism_status()` call without a project slug would hit ~170 API calls. The system works but rate limits could become constraining.
- **Severity:** Medium
- **Evidence:** `src/tools/status.ts` multi-project mode. `prism/architecture.md` reports 17 projects.
- **Recommendation:** Consider caching project list and health status with 5-minute TTL for the global status view.

### I.2: Session Count Scaling

- **Finding:** At session 100, session-log.md will grow to ~50-60KB (current 26 sessions = ~14KB). The 15KB archive threshold would trigger repeatedly. The decision index at 48 decisions (26 sessions) extrapolates to ~185 decisions at session 100 -- manageable but the index table will be large.
- **Severity:** Low
- **Evidence:** `prism/session-log.md` is 14KB at 26 sessions. Linear projection to 100 sessions.
- **Recommendation:** The archive mechanism exists. Monitor decision index growth; consider domain file pruning if individual domains exceed 15KB.

### I.3: Server Tool Count

- **Finding:** 12 tools is within MCP SDK limits. The McpServer class supports arbitrary tool counts. The per-request server+transport creation pattern scales linearly with tool count.
- **Severity:** Info
- **Evidence:** `src/index.ts` creates server per request. Tool registration is a simple loop.
- **Recommendation:** No concerns up to 30-50 tools. Beyond that, consider tool grouping/namespacing.

### I.4: User Experience Friction Points

- **Finding:** The main friction points are: (1) stale CLAUDE.md consuming context without providing value, (2) bootstrap response size (~20KB) consuming significant context budget, (3) the context tracking formula being imprecise and potentially anxiety-inducing, (4) Claude Code brief generation requiring manual "initial GitHub sync" and "final GitHub sync" commands.
- **Severity:** Medium
- **Evidence:** Various findings above.
- **Recommendation:** Address CLAUDE.md staleness (highest UX impact for CC users), consider lazy-loading behavioral rules, and simplify Rule 9's tracking.

---

## Priority Recommendations

Ranked by impact-to-effort ratio. Items marked with severity in parentheses.

| # | Recommendation | Impact | Effort | Severity |
|---|---------------|--------|--------|----------|
| 1 | **Rotate the exposed PAT** in `_templates/project-instructions.md:9` and replace with placeholder | Eliminates credential exposure risk | 5 min | Critical |
| 2 | **Add authentication to the MCP endpoint** (`src/index.ts`) -- Bearer token or API key middleware | Prevents unauthorized access to all GitHub repos | 1-2 hours | Critical |
| 3 | **Reconcile decision _INDEX.md with domain files** -- fix 15+ ID collisions | Restores decision registry integrity | 2-3 hours | Critical |
| 4 | **Fix the double API call in GitHub client** (`src/github/client.ts`) -- single call for content+SHA | Halves all API usage, improves performance | 30 min | High |
| 5 | **Update the "8" to "10" everywhere** -- living doc count across all repos/templates | Eliminates the most pervasive inconsistency | 1 hour | High |
| 6 | **Add tests for prism_push, prism_finalize, prism_bootstrap** -- focus on invariants | Protects against data loss in the three most critical tools | 3-4 hours | Critical |
| 7 | **Update prism-mcp-server CLAUDE.md** -- remove S1 build spec, add 12 tools, 10 docs | Immediately improves CC session context efficiency | 1 hour | High |
| 8 | **Add Anthropic API timeout** (`src/ai/client.ts`) | Prevents hung requests | 10 min | High |
| 9 | **Bump package.json version to 2.9.0** and unify all version strings | Eliminates version confusion | 15 min | Medium |
| 10 | **Deprecate or rewrite docs/ files** -- add prominent v1.0.0 warning to METHODOLOGY_DEEP_DIVE, THREE_TIER_ARCHITECTURE, SETUP_GUIDE | Prevents new users from following dangerously stale instructions | 30 min (warnings) or 4-6 hours (rewrites) | High |
| 11 | **Backfill CHANGELOG** from v2.2.0 through v2.9.0 | Restores traceability for 16 sessions of changes | 1-2 hours | High |
| 12 | **Add `express.json({ limit: '5mb' })` and input sanitization** | Defense against payload abuse and path injection | 30 min | High |
| 13 | **Fix the standing-rule test** (`tests/intelligence-layer.test.ts`) to import production code | Eliminates false test confidence | 30 min | High |
| 14 | **Add "ACCEPTED" to VALID_STATUSES** in `src/validation/decisions.ts` | Fixes validation rejection of valid decision status | 5 min | Medium |
| 15 | **Resolve stale known issues** (KI-2, KI-3 in prism; glossary KI-2 "bugged" annotation in prism-mcp-server) | Improves data accuracy | 20 min | Medium |

---

## Appendix: Full File Inventory

### prism-framework (22 files, 241 KB)

| File | Size (bytes) |
|------|-------------|
| `README.md` | 2,194 |
| `_insights/cross-project-patterns.md` | 498 |
| `_templates/CHANGELOG.md` | 5,019 |
| `_templates/banner-spec.md` | 15,075 |
| `_templates/core-template-mcp.md` | 15,092 |
| `_templates/core-template.md` | 21,833 |
| `_templates/finalization-banner-spec.md` | 13,077 |
| `_templates/modules/error-recovery.md` | 3,373 |
| `_templates/modules/finalization.md` | 13,115 |
| `_templates/modules/fresh-eyes.md` | 2,230 |
| `_templates/modules/handoff-scaling.md` | 6,802 |
| `_templates/modules/onboarding.md` | 7,093 |
| `_templates/modules/task-checkpoints.md` | 1,594 |
| `_templates/project-instructions.md` | 1,274 |
| `_templates/reference/batch-operations.md` | 7,066 |
| `_templates/reference/claude-code-config.md` | 4,998 |
| `_templates/reference/commit-prefixes.md` | 685 |
| `_templates/reference/github-api.md` | 1,855 |
| `_templates/reference/repo-structure.md` | 1,697 |
| `docs/METHODOLOGY_DEEP_DIVE.md` | 42,591 |
| `docs/SETUP_GUIDE.md` | 37,968 |
| `docs/THREE_TIER_ARCHITECTURE.md` | 35,810 |

### prism (38 files, 286 KB)

| File | Size (bytes) |
|------|-------------|
| `README.md` | 361 |
| `_scratch/mcp-battle-test.md` | 126 |
| `_scratch/mcp-server-test.md` | 156 |
| `architecture.md` | 10,650 |
| `artifacts/context-savings-analysis-s16.md` | 3,807 |
| `artifacts/current/architecture-e-investigation.md` | 12,628 |
| `artifacts/current/claude-md-prism-mcp-server.md` | 18,637 |
| `artifacts/current/living-documents-design.md` | 13,891 |
| `artifacts/current/mega-prompt-ki10-fix.md` | 11,411 |
| `artifacts/current/mega-prompt-session-1.md` | 23,539 |
| `artifacts/current/mega-prompt-session-2.md` | 9,377 |
| `artifacts/current/mega-prompt-session-3.md` | 8,151 |
| `artifacts/current/migrate-sbf-to-prism.py` | 20,184 |
| `artifacts/current/migration-dead-projects-report.md` | 2,096 |
| `artifacts/current/project-instructions-prismv2.md` | 2,056 |
| `boot-test.md` | 126 |
| `decisions/_INDEX.md` | 4,627 |
| `decisions/architecture.md` | 10,713 |
| `decisions/efficiency.md` | 1,861 |
| `decisions/integrity.md` | 365 |
| `decisions/onboarding.md` | 419 |
| `decisions/operations.md` | 16,098 |
| `decisions/optimization.md` | 9,039 |
| `decisions/resilience.md` | 2,031 |
| `eliminated.md` | 1,965 |
| `glossary.md` | 9,057 |
| `handoff-history/handoff_v25_2026-04-01.md` | 5,952 |
| `handoff-history/handoff_v26_2026-04-01.md` | 4,800 |
| `handoff-history/handoff_v28_2026-04-01.md` | 5,730 |
| `handoff-history/handoff_v7_03-01-26.md` | 5,462 |
| `handoff-history/handoff_v8_03-02-26.md` | 5,864 |
| `handoff-history/handoff_v9_03-23-26.md` | 6,527 |
| `handoff.md` | 6,824 |
| `insights.md` | 13,227 |
| `intelligence-brief.md` | 9,769 |
| `known-issues.md` | 11,022 |
| `session-log.md` | 14,026 |
| `task-queue.md` | 3,516 |

### prism-mcp-server (67 files, 457 KB)

| File | Size (bytes) |
|------|-------------|
| `.env.example` | 126 |
| `.github/workflows/ci.yml` | 581 |
| `.gitignore` | 48 |
| `CLAUDE.md` | 17,974 |
| `Procfile` | 15 |
| `architecture.md` | 3,539 |
| `boot-test.md` | 135 |
| `briefs/ci-pipeline.md` | 2,623 |
| `briefs/d35-html-banner.md` | 6,708 |
| `briefs/ki10-scale-handoff-timeout.md` | 11,417 |
| `briefs/ki11-scale-logic-fix.md` | 8,016 |
| `briefs/ki15-slug-resolution.md` | 4,275 |
| `briefs/s22-intelligence-layer.md` | 20,211 |
| `briefs/s23-efficiency-tools.md` | 25,172 |
| `briefs/s24-finalization-banner.md` | 6,133 |
| `briefs/s25-bootstrap-optimization.md` | 11,287 |
| `briefs/s25-standing-rules-fix.md` | 2,182 |
| `briefs/s27-boot-banner-html.md` | 5,813 |
| `briefs/s27-full-audit-brief.md` | 12,777 |
| `cc-brief-s21.md` | 3,095 |
| `decisions/_INDEX.md` | 2,185 |
| `docs/intelligence-layer-design.md` | 12,548 |
| `eliminated.md` | 1,531 |
| `glossary.md` | 1,742 |
| `handoff.md` | 2,490 |
| `known-issues.md` | 1,639 |
| `mega-prompt-s3.md` | 8,151 |
| `package.json` | 827 |
| `railway.json` | 343 |
| `session-log.md` | 3,053 |
| `src/ai/client.ts` | 2,102 |
| `src/ai/prompts.ts` | 6,798 |
| `src/ai/synthesize.ts` | 4,274 |
| `src/config.ts` | 6,179 |
| `src/github/client.ts` | 13,468 |
| `src/github/types.ts` | 1,790 |
| `src/index.ts` | 4,071 |
| `src/middleware/request-logger.ts` | 725 |
| `src/tools/analytics.ts` | 22,864 |
| `src/tools/bootstrap.ts` | 21,411 |
| `src/tools/fetch.ts` | 4,344 |
| `src/tools/finalize.ts` | 30,317 |
| `src/tools/log-decision.ts` | 4,917 |
| `src/tools/log-insight.ts` | 4,499 |
| `src/tools/patch.ts` | 5,156 |
| `src/tools/push.ts` | 6,217 |
| `src/tools/scale.ts` | 43,037 |
| `src/tools/search.ts` | 9,222 |
| `src/tools/status.ts` | 7,265 |
| `src/tools/synthesize.ts` | 3,602 |
| `src/utils/banner.ts` | 12,207 |
| `src/utils/cache.ts` | 1,530 |
| `src/utils/logger.ts` | 1,262 |
| `src/utils/summarizer.ts` | 3,279 |
| `src/validation/common.ts` | 2,569 |
| `src/validation/decisions.ts` | 2,209 |
| `src/validation/handoff.ts` | 4,047 |
| `src/validation/index.ts` | 1,551 |
| `task-queue.md` | 1,778 |
| `tests/analytics-parsing.test.ts` | 4,523 |
| `tests/intelligence-layer.test.ts` | 5,798 |
| `tests/scale.test.ts` | 27,369 |
| `tests/slug-resolution.test.ts` | 2,326 |
| `tests/summarizer.test.ts` | 3,599 |
| `tests/validation.test.ts` | 3,494 |
| `tsconfig.json` | 450 |
| `vitest.config.ts` | 177 |

<!-- EOF: prism-full-audit-report.md -->
