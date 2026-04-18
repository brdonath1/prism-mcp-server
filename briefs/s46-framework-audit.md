# Brief S46 — PRISM Framework Comprehensive Audit

## Metadata

- **Brief ID:** s46-framework-audit
- **Type:** AUDIT-ONLY (no source code changes)
- **Primary repo:** `prism-mcp-server` (clone target)
- **Reference repo:** `prism-framework` (clone read-only into `/tmp/prism-framework`)
- **Target branch:** `staging`
- **Session:** S46
- **Model:** Opus 4.7, max effort (per D-77)
- **Effort floor:** `xhigh` minimum; use `max` for any dimension requiring cross-file reasoning
- **Deliverable:** Single file — `reports/s46-framework-audit.md` in `prism-mcp-server`
- **Deadline:** Hard cap 90 minutes total wall-clock; soft cap 60 minutes. If approaching hard cap, checkpoint findings and ship partial report with explicit COVERAGE-GAP markers.

## Hard Rules (READ FIRST — violations abort the task)

1. **AUDIT ONLY.** You MAY create `reports/s46-framework-audit.md`. You MAY NOT modify ANY other file in ANY repo. No source edits, no test edits, no config edits, no README edits, no handoff edits. If you find a bug, document it as a finding — do not fix it.
2. **Exactly one commit at end.** The commit adds only `reports/s46-framework-audit.md`. Run `git status` before commit and verify no other files are staged. If any other file is modified, revert it before committing.
3. **INS-27 compliance.** Every finding must cite explicit evidence: file path + line number, or grep command + match count, or live command + output snippet. "I noticed X looks suspicious" without evidence is a violation. If you can't produce evidence, mark the finding `COVERAGE-GAP` and state what evidence would be needed.
4. **INS-29 compliance.** Any claim that a tool, filter, query, or handler is broken MUST be backed by either (a) a test case in the repo that fails, (b) a live `curl` against the production endpoint with captured response, or (c) explicit `STATIC-ONLY` label indicating you read the code but did not verify runtime behavior. Never assert live behavior from code inspection alone.
5. **INS-31 compliance.** HTTP routing claims (endpoint URLs, method selection, retry behavior) must come from test inspection (`tests/*.test.ts` with mocked fetch) OR live curl, NOT from `grep` over source. If tests don't cover a path, the finding is `UNVERIFIED` not `CONFIRMED`.
6. **INS-33 compliance.** If a tool/filter/query returns zero results, you MAY NOT conclude the tool is broken unless you independently verify the target class exists in the input set. Document the verification.
7. **INS-30 compliance.** Any mirror-pattern finding ("this code should match pattern X from file Y") must cite `grep -c` counts from the reference file, not estimates.
8. **Single push directive (INS-20).** Push once, to `staging`, at the end. Do not push interim progress. Do not push to `main`. If the commit or push fails, investigate and retry — do not abandon the report.
9. **PR at end (mandatory).** Open a PR `staging → main` via GitHub API. The watcher will auto-merge per D101. PR body must include the report's executive summary.
10. **No scope creep.** The 15 audit dimensions below are the ENTIRE scope. If you find something outside the dimensions, note it in the report's `Out-of-Scope Observations` section — do not expand audit dimensions.
11. **No fix proposals inside findings.** Each finding ends at `Recommended Fix Category` (e.g., "test coverage", "schema change", "doc refresh", "performance") — NOT at a concrete code diff. Fix briefs come after operator review.
12. **Template version check.** Before starting, confirm `core-template-mcp.md` in the cloned `prism-framework` is v2.13.0. If it's different, note the version in the report header — do not proceed with a stale template.

## Pre-Flight

### Step 1 — Environment baseline

Run each command and capture the exact output. Put it in the report's `Pre-Flight Evidence` section.

```bash
node --version                                  # must be v20+ per package.json engines
npm --version
git rev-parse HEAD                              # commit SHA you're auditing against
git log -1 --format='%ci %s'                    # commit time + message
git status                                      # must be clean
git branch --show-current                       # must be staging
npm ci 2>&1 | tail -5                           # dependency install
npm run build 2>&1 | tail -10                   # TypeScript compile
npm test 2>&1 | tail -20                        # test suite baseline
find src -name '*.ts' | wc -l                   # source file count
find tests -name '*.test.ts' | wc -l            # test file count
wc -l src/**/*.ts 2>/dev/null | tail -1         # total LoC
cat package.json | grep -A20 '"scripts"'        # available scripts
```

Required baseline state for audit to proceed:
- Build: must succeed. If build fails, STOP and log the failure as CRITICAL-1. Do not continue.
- Tests: capture exact pass/fail/skip counts. If any test fails, document as CRITICAL finding. Continue audit but note tests are red.

### Step 2 — Reference clone

```bash
cd /tmp && git clone https://$GITHUB_PAT@github.com/brdonath1/prism-framework.git
cd prism-framework && git rev-parse HEAD && git log -5 --format='%ci %s'
cd $OLDPWD
```

All subsequent reference paths below under `prism-framework/...` refer to `/tmp/prism-framework/...`.

### Step 3 — Mandatory reading (capture `wc -l` and `wc -c` per file — these are inputs to later findings)

#### prism-mcp-server (the primary audit subject)
- `src/index.ts` — tool registration entry point
- `src/tool-registry.ts` — D-83 single source of truth
- All files under `src/tools/` — per-tool handlers
- All files under `src/github/` — GitHub client (retry, atomic commits, timeouts)
- All files under `src/railway/` — Railway GraphQL wrapper
- All files under `src/utils/` — archive, banner, doc-resolver, doc-guard, markdown sections, validation
- `src/cc/` (if exists) — Claude Code dispatch/status
- `src/synthesis/` or equivalent — intelligence brief generation
- `package.json`, `tsconfig.json`, `.github/workflows/*.yml`, `railway.json`
- `.prism/handoff.md`, `.prism/architecture.md`, `.prism/known-issues.md`, `.prism/decisions/_INDEX.md`, `.prism/insights.md`, `.prism/task-queue.md` — server's own living documents (known-issues is the single most important file here — read in full)
- `reports/s39-observability-perf-audit.md` — reference exemplar for report format
- All files under `briefs/` — exemplar briefs that shaped current server behavior (s40*, s41*, s42*, s44*)

#### prism-framework (reference — read-only)
- `_templates/core-template-mcp.md` — v2.13.0 behavioral rules (template Claude uses at every session)
- `_templates/core-template.md` — verbose fallback template
- `_templates/modules/*.md` — onboarding, task-checkpoints, fresh-eyes, error-recovery, finalization, handoff-scaling
- `_templates/reference/*.md` + `ci-whitelist.yml` — framework reference docs
- `CHANGELOG.md` if present
- `README.md`

#### Sample project repos (cross-section — DO NOT clone unless strictly needed; use GitHub API via `curl` to inspect)
- `brdonath1/prism` — the framework's own PRISM project (most instrumented)
- `brdonath1/platformforge-v2` — largest active project, ~S158
- `brdonath1/alterra-design-llc` — recently mentioned in S45 context, smaller

For each sample: fetch `.prism/handoff.md`, `.prism/insights.md` size, `.prism/decisions/_INDEX.md` size, handoff version. DO NOT read full insights.md across all three — file sizes are sufficient for cross-project comparison.

### Step 4 — Liveness probe (no-auth endpoint only)

```bash
curl -s -w '\nHTTP %{http_code} | %{time_total}s\n' https://prism-mcp-server-production.up.railway.app/health
```

Expected: `{"status":"ok","version":"4.0.0"}` with HTTP 200 in under 1.5s. Document actual response time. This is the ONLY live endpoint call authorized — do NOT attempt authenticated `/mcp` calls from CC (the bearer token is not in-scope for this dispatch).

## Scope

### In scope (audit these)
1. `prism-mcp-server` repo — all source, all tests, all configs, all living documents in `.prism/`, all briefs, all reports
2. `prism-framework` repo — all templates, modules, references, `CHANGELOG.md`, `README.md`
3. `expected_tool_surface` in bootstrap response — the 18-tool inventory (12 PRISM + 4 Railway + 2 Claude Code)
4. Three sample project repos, SURFACE-LEVEL ONLY (handoff size, insights size, decisions index size) — to spot cross-project anomalies
5. The 21 STANDING RULE insights listed in handoff.md (behavioral rules auto-loaded at every boot)

### Out of scope (do not audit)
- Application code in project repos (e.g., platformforge-v2's `src/`, `personas/`, `prisma/`)
- Any repo not listed above
- Fix implementation (this is audit-only; see Rule 11)
- Live authenticated MCP tool calls (credentials not available)
- Railway billing / quota analysis (not a framework concern)

### Known measurement gap (must be acknowledged in report)
This brief was authored WITHOUT an operator-side Phase 1 measurement pass (per INS-22 two-track pattern). That means live MCP tool latency, production log error rates, cross-project analytics, and handoff-size trend data are NOT available as Pre-Flight inputs. The report's `Methodology` section must state this limitation explicitly. Any finding that would require live MCP tool invocation or production analytics to confirm MUST be labeled `UNVERIFIED — LIVE-MEASUREMENT-REQUIRED` with a specific suggestion of what measurement would confirm or refute it.

## Methodology principles

1. **Static-first, live-when-possible.** Default to reading code + tests. Use `curl /health` for liveness. Don't fabricate live behavior.
2. **Evidence density.** Each finding gets at least one concrete evidence item. Prefer `file:line` references. Prefer `grep -c` counts over estimates.
3. **Severity discipline.** Use the scale strictly (see Output Format). `CRITICAL` = system-breaking or data-losing. `HIGH` = observable user-facing degradation. `MEDIUM` = inefficiency or latent bug. `LOW` = cosmetic, doc drift, style. Don't inflate.
4. **False-positive immunity.** If a "finding" would survive `git blame` scrutiny by the operator ("this was intentional, see D-N"), verify against `decisions/` first. Re-check against `eliminated.md` — rejected approaches may look like omissions but are guardrailed (see G-N entries).
5. **Pattern over point.** If you find the same issue in 3+ places, it's a systemic pattern, not N separate findings. Group under one `PATTERN-` finding with all instances enumerated.
6. **Churn awareness.** `git log --since='90 days ago' --pretty=format:'%ci %s' -- <file>` before claiming a file is "stale" or "abandoned."
7. **Decision-compliant.** 85 decisions shape current behavior. If a finding contradicts a SETTLED decision, either (a) cite the decision and revise the finding, or (b) argue explicitly that the decision should be revisited — the latter raises the bar for evidence.

## 15 Audit Dimensions

For each dimension: read the listed files, answer the listed questions, produce findings. Each dimension section in the final report must exist (use `NO-FINDINGS` if nothing material).

### D1 — Bootstrap performance & correctness
**Files:** `src/bootstrap/*.ts` (or equivalent), `src/index.ts` (registerBootstrap call path), `tests/bootstrap*.test.ts`, `.prism/decisions/architecture.md` (D-44, D-45, D-47, D-72, D-83), `src/tool-registry.ts`

**Questions:**
1. What is the theoretical critical path (serial dependencies) of a `prism_bootstrap` call? Enumerate each step and its upstream dependency.
2. Which steps could run in parallel but currently run serially? Cite `await` placements and promise composition patterns.
3. Template cache: what's the TTL, how is invalidation triggered, and is there a cache-stampede protection path (multiple concurrent boots under a cold cache)?
4. Prefetch keyword matching: read the prefetch logic. What patterns does it search for in `opening_message` and `next_steps`? Are there obvious common keywords that AREN'T matched (e.g., domain terms like "railway", "finalize" — do they actually trigger relevant doc fetch)?
5. Tool surface delivery: does the response include `post_boot_tool_searches` + `expected_tool_surface` on every path (feature-flagged paths, legacy callers)? Any path that skips?
6. Intelligence brief inclusion: size of typical brief in payload. Is there a size guard (G-1 proximity watch per S26)? Current proximity to 25KB bootstrap payload threshold?
7. Handoff size check: at what threshold does bootstrap warn vs. fail? Is the 15KB soft limit + hard scaling threshold consistent with architecture.md?
8. Boot test push: the "push verified" in the banner comes from a boot-test commit. What file is pushed, is it idempotent, and what failure modes exist?
9. Standing rule filtering: are ARCHIVED/DORMANT tags honored (D-48)? Or is the code still loading all tagged rules? Verify against tests.

### D2 — Finalization performance & correctness
**Files:** `src/finalize/*.ts` (audit, draft, commit phases), `src/synthesis/*.ts`, `src/utils/archive.ts`, `tests/finalize*.test.ts`, `tests/archive*.test.ts`, `.prism/decisions/architecture.md` (D-72, D-80, S40-C* entries), `briefs/s40-archive-lifecycle.md`, `briefs/s41-finalize-draft-timeout.md`

**Questions:**
1. Audit phase: what does it check, and is it fail-fast or fail-soft? Are there validation rules that would benefit from being fail-fast (malformed handoff) vs fail-soft (stale doc)?
2. Draft phase: `FINALIZE_DRAFT_TIMEOUT_MS` (150s) + `FINALIZE_DRAFT_DEADLINE_MS` (180s) — verify env var names and defaults match S41-C1 spec.
3. Retry logic: S41-C1 set `maxRetries=0` on the synthesize call. Verify in code and in tests. Any other synthesize call sites that DIDN'T get the fix?
4. Commit phase: the 5-step path (backup → archive → patch/push → verify → PR). Is each step wrapped in try/catch? What happens if step N succeeds but N+1 fails — is state consistent?
5. Archive integration: archive runs in commitPhase before atomic commit (per architecture.md). Does it run inside or outside the atomic-commit transaction? If outside, archive + commit is NOT atomic — is there a documented acceptance of that?
6. Banner rendering: `renderBannerText` output is deterministic (per banner-spec.md v3.0). Verify the finalization banner path uses the same renderer or has a separate renderer — if separate, flag as duplicate logic.
7. Auto-synthesis (D-72): `skip_synthesis: true` opt-out. Is there a size or age gate that auto-skips synthesis even without the flag (e.g., handoff already synthesized this session)?
8. Deadline handling: Promise.race deadline at 90s for commit phase (S40 C4). Verify wrapping and test coverage.
9. Post-finalize verification: does commit phase verify the pushed state matches local intent (the `verified` block in the banner)? What exactly is verified?

### D3 — Push / patch / fetch behavior
**Files:** `src/github/client.ts`, `src/github/*.ts` (atomic-commit, applyPatch), `src/utils/doc-guard.ts`, `src/utils/doc-resolver.ts`, `src/utils/markdown-sections*.ts`, `tests/atomic-commit*.test.ts`, `tests/github-client-timeouts.test.ts`, `tests/markdown-sections*.test.ts`, `tests/doc-guard*.test.ts`, `.prism/decisions/operations.md` (D-67, D-79, D-81, D-82)

**Questions:**
1. Atomic commits (D-81): verify `createAtomicCommit` uses plural `/git/refs/` endpoint in PATCH step. Cite file:line. Verify regression test exists (`tests/atomic-commit-url.test.ts`).
2. Does EVERY write path go through createAtomicCommit, or are there sequential-commit fallback paths still in use? Enumerate write paths: prism_push, prism_patch, prism_finalize commit, prism_log_decision, prism_log_insight, boot-test push.
3. prism_patch semantics: replace/append/prepend — are the test fixtures covering multi-line section content (D-82 KI-16 territory)? Any obvious edge case still uncovered (bold headers in section names per INS-8, trailing whitespace, nested lists)?
4. Anti-duplication guard (D-67): which handlers invoke `doc-guard.ts`? Any handler that writes files but bypasses the guard? Grep `doc-guard` imports and cross-reference with handler list.
5. prism_fetch summary mode: >5KB threshold. Verify the threshold isn't per-file but per-sum (or vice versa). Verify summarization logic doesn't drop EOF sentinels.
6. EOF sentinel validation: which files are required to have EOF sentinels? What's the behavior on missing sentinel (reject, warn, auto-add)?
7. Commit message prefix validation: `prism:`, `fix:`, `docs:`, `chore:` per schema. Verify validator honors this. Does it accept `prism(SN):` format used historically?
8. Size limits: per-file cap, per-push cap. What happens on violation?

### D4 — Archive lifecycle (D-80)
**Files:** `src/utils/archive.ts`, `tests/archive*.test.ts`, `briefs/s40-archive-lifecycle.md`, `.prism/decisions/architecture.md` (D-80)

**Questions:**
1. Retention policy: session-log.md keeps 20 sessions; insights.md keeps 15 non-protected entries. Verify by reading code constants.
2. STANDING RULE protection: verify that `STANDING RULE`-tagged entries never count against the 15-retention limit. Verify the regex/parser correctly identifies the tag (INS-8 applies — markdown bold can break simple regexes).
3. Semantics Y vs Z (protected-exclude vs protected-include): the handoff and brief reference both. Which is implemented? Is it documented? Is there a test that would fail if implementation flipped?
4. Archive location: where do archived entries go? Filename convention? Is there a retrieval path (e.g., when operator asks "what was INS-3 originally")?
5. Failure mode: archive is fail-open per architecture.md. Verify — which exceptions are caught, which are re-thrown? Any exception that would abort finalization vs. be swallowed?
6. Run ordering: archive runs in commitPhase BEFORE the atomic commit per architecture.md. Verify. If archive modifies files and then atomic commit fails, what's the rollback path?

### D5 — Intelligence layer (D-44 + D-72)
**Files:** `src/synthesis/*.ts`, `src/insights/*.ts` (or equivalent), `tests/synthesis*.test.ts`, `.prism/decisions/architecture.md` (D-44, D-72), framework `_templates/core-template-mcp.md` (standing rule loader reference)

**Questions:**
1. Track 1 loader: which file reads insights.md at bootstrap? How does it filter to `STANDING RULE`-tagged entries? Is the filter case-sensitive, whitespace-tolerant, bold-tolerant (INS-8)?
2. Track 1 output: 21 standing rules currently loaded for `prism` project. Size of this block in bootstrap response? Any dedup against entries already in `critical_context` or `intelligence_brief`?
3. Track 2 synthesis prompt: find the prompt template. Length? Variables interpolated? Any prompt fields derived from living docs that could be stale (e.g., cached file content vs fresh fetch)?
4. Synthesis model: `claude-sonnet-4-6` per D-77 (NOT opus, opus is for interactive). Verify in code. Verify max-retries handling per S41-C1.
5. Intel brief age: `brief_age_sessions` warning threshold. Auto-synthesis on finalize resolves it. What if a session finalizes with `skip_synthesis: true` — does the age warning compound?
6. Risk flags: generated by synthesis or by static code? If by synthesis, the model output shape needs validation. If static, enumerate the code that produces them.
7. Opus 4.7 model-string anywhere it shouldn't be: D-77 split opus (interactive) from sonnet (synthesis). Grep for `claude-opus` in `src/` — every match should be interactive-path, not synthesis.

### D6 — Tool surface correctness (D-83)
**Files:** `src/tool-registry.ts`, `src/index.ts`, `tests/tool-surface.test.ts`, all `src/tools/*.ts` files, `.prism/decisions/architecture.md` (D-83)

**Questions:**
1. Registry shape: verify `TOOL_REGISTRY` in `src/tool-registry.ts` lists all 18 tools with category + flag gating. Cross-check every tool in `src/index.ts` `register*()` calls appears in the registry.
2. Drift guard: the test `tests/tool-surface.test.ts` uses readFileSync against `src/index.ts`. Does the `it.each` cover all 18 tools, or is coverage lower? `grep -c` count needed.
3. ZodDefault absence (INS-6): grep all tool schemas for `.default(`. Every match is a violation. Zero matches = clean.
4. Optional parameter handling: for every `.optional()` param, verify the handler has a `?? fallback` pattern. Missing fallbacks = latent NaN/undefined bugs.
5. Tool descriptions: each tool has a description string delivered in tool_search. Read the descriptions — are any misleading, outdated, or insufficient for relevance ranking (which is why D-83 existed)?
6. Category keyword overlap: `post_boot_tool_searches` uses two queries. Verify each tool matches at least one query's keywords (the keyword-overlap guard test). Cite the test and its it.each length.
7. Response shape: for every tool, the response should be JSON-serializable and under the MCP size cap. Check for any response that could include arbitrary user content (e.g., prism_fetch file content) without size guarding.
8. Timeout budgets: each tool wall-clock ceiling. `MCP_SAFE_TIMEOUT` 50s. Railway tools 45s. Finalize commit 90s. Push 60s. Are there tools without explicit deadlines that could hang?
9. Error surface: error messages exposed to Claude. Look for any error message leaking bearer tokens, PAT, or URLs-with-credentials. Mask should apply to error paths too.

### D7 — GitHub integration
**Files:** `src/github/client.ts`, `src/github/atomic-commit.ts` (or equivalent), `tests/github-client-timeouts.test.ts`, `tests/atomic-commit*.test.ts`, `.prism/decisions/operations.md` (D-79, D-81)

**Questions:**
1. Fetch wrapper: verify 15s `AbortSignal.timeout` on every fetch call (D-79). Enumerate fetch call sites and flag any without timeout.
2. Retry logic: classification of retryable vs non-retryable errors. 429 rate-limit handling — does it respect `Retry-After`? 5xx retry? 422 (conflict) retry?
3. /rate_limit endpoint: per INS-23, live rate-limit checks before theorizing. Is there a programmatic rate-limit awareness (back off pre-emptively when bucket is low), or is it only reactive?
4. Atomic commit: 5-step sequence. Each step has URL + method assertions per INS-31. Verify the test mocks fetch and asserts URL path for every step.
5. 404 handling: file-not-found on GET is expected for new files; verify the wrapper differentiates between "file doesn't exist yet" (expected) and "path mistyped" (error). Currently, is the distinction made or conflated?
6. 409 conflict on push: race conditions. Verify there's retry-with-rebase-against-remote logic, or that atomic commits sidestep this entirely.
7. PAT error masking: if the PAT is invalid/expired, the error response. Does any error message leak the PAT value?
8. Parallel operations: backup + prune + fetch are parallelized (S33b). Verify concurrency limits (`Promise.all` vs `Promise.allSettled` — which is used, and does any failure abort sibling operations?).
9. GitHub Actions integration: the server seems to have `actions_*` tool access via the separate GitHub MCP Server, not directly. Confirm no redundant GitHub-Actions logic in prism-mcp-server itself.

### D8 — Railway integration (D-75)
**Files:** `src/railway/client.ts`, `src/railway/types.ts`, `src/tools/railway-*.ts`, `tests/railway-*.test.ts`, `.prism/decisions/operations.md` (D-75), architecture.md "Known Railway schema notes" section

**Questions:**
1. Feature flag: `RAILWAY_ENABLED`. Verify tools register only when `RAILWAY_API_TOKEN` is set. Verify graceful degradation (server still serves 12 core + 2 CC tools).
2. GraphQL endpoint hardcoded: `https://backboard.railway.com/graphql/v2`. Verify. If overridable via env, document; if not, flag as minor config gap.
3. Log filter semantics (INS-29 territory): `@level:X` filter. Verify the implementation actually sends the filter server-side vs client-side filtering. If client-side, there's a correctness concern around truncation.
4. Name resolution cache: per-request cache via `RailwayResolver`. Verify. Any cross-request caching that could stale?
5. Masking: force-mask regex for `KEY/SECRET/TOKEN/PASSWORD/AUTH/CREDENTIAL/PRIVATE`. Verify. Test with a variable named `GITHUB_PAT` — should mask. Test with value matching `scheme://user:pass@host` — should mask. Cite tests.
6. Destructive mutations: `deploymentRedeploy` / `deploymentRestart` are implemented but not exercised live per architecture.md. Any guardrail preventing accidental invocation? Rate limit?
7. Timeouts: 45s `AbortSignal.timeout`. Any call site without?
8. Error surface: Railway GraphQL errors — are they surfaced cleanly or swallowed? Any error path that could include the token in a log?
9. Response shape: logs return newest-first or oldest-first? Document. `limit` semantics for `environmentLogs` (client-side slice) vs `deploymentLogs` (server-side) per architecture.md — verify and flag if semantics leak to tool consumers.

### D9 — Claude Code orchestration (D-117)
**Files:** `src/cc/dispatch.ts` + `src/cc/status.ts` (or equivalent), `src/tools/cc-*.ts`, `tests/cc-dispatch*.test.ts`, `tests/dispatch-store.test.ts`, `tests/cc-status.test.ts`, `.prism/decisions/operations.md` (D-117, D-123), `.prism/known-issues.md`

**Questions:**
1. Query vs execute mode: boundaries enforced how? Tool allowlist per mode. Grep the default allowlists.
2. Async mode: dispatch_id generation, persistence location, retention. If CC process dies mid-run, is the dispatch_id marked failed or left zombie?
3. Tool allowlist override: `allowed_tools` param — does it REPLACE or EXTEND the default? Verify and flag if ambiguous.
4. PR creation at end: for execute mode, PR body default. Does the default include dispatch metadata (dispatch_id, branch)?
5. Max turns: default from `CC_DISPATCH_MAX_TURNS` env var. What's the default-default if env not set? Any hard cap in code?
6. dispatch-store race: S40's D-123 fix re-exported `readDispatchRecord`. Verify tests pass (`tests/dispatch-store.test.ts`). Any other symbol export gaps?
7. Model routing: `--model claude-opus-4-7` default. Configurable? Where?
8. Effort parameter: `xhigh` recommended per CLAUDE.md, default used here. Verify.
9. Output parsing: when CC completes, how is the agent's output captured (stdout, stderr, structured)? Any truncation, any failure to surface agent errors?
10. Failure modes: network failure mid-dispatch, SDK retry handling, timeout.

### D10 — Test coverage
**Files:** all `tests/*.test.ts`, `package.json` test scripts, `.github/workflows/*.yml` (CI config)

**Questions:**
1. Baseline count: exact pass/fail/skip from `npm test`. Compare to `578` asserted in handoff.
2. Coverage gaps by dimension: for each of D1–D9 above, does coverage exist? Use `grep -l` in `tests/` for the relevant module name and list test files.
3. Mocked-fetch coverage (INS-31): which tools have HTTP-level tests? Enumerate `tests/*` that mock `global.fetch` (or `undici.fetch`) and assert URLs.
4. E2E coverage: are there full bootstrap → patch → finalize flows exercised end-to-end, or only unit tests?
5. Fixture quality: grep for fixture directories. Are fixtures regenerated from real data, or hand-crafted?
6. Flaky indicators: grep tests for `setTimeout`, `await new Promise(r => setTimeout(...))`, or `jest.useFakeTimers` missing. Sleep-based tests are flaky candidates.
7. Parallel test execution: verify test runner config (vitest.config.ts? jest.config.ts?). Any tests with shared state that could race under parallel runs?
8. CI vs local divergence: do any tests skip under CI (`test.skipIf(...)`)? Any tests that only fail in CI? Grep for `CI` env checks in tests.
9. Coverage tool: is there a coverage tool configured (c8, v8, nyc)? Thresholds?

### D11 — Behavioral rule template
**Files:** `prism-framework/_templates/core-template-mcp.md`, `prism-framework/_templates/core-template.md`, `prism-framework/_templates/modules/*.md`

**Questions:**
1. Version sanity: v2.13.0 confirmed. CHANGELOG consistent?
2. Rule interactions: do any two rules conflict or create ambiguity? Specifically: Rule 2 (Boot Response Template) vs Rule 3 (Critical Context) vs Rule 9 (Context awareness). Does Rule 2 Block 4 "opening statement" have room for the Block 5 context status line, or is there ordering ambiguity?
3. Rule 2 FORBIDDEN list: does it contradict anything elsewhere in the template? "Markdown headings anywhere in the opening response" — but Block 4 prose could arguably include structure. Precise enough?
4. D-84 hard-structured response: are there other rules that would benefit from similar HARD STRUCTURE treatment (e.g., finalization response Step 6 already has it; what about checkpoint push responses)?
5. D-85 Rule 9 prominence: three-layer fix (⛔ marker, No-substitutes paragraph, Mandatory Response Closer). Is it working? Any place the prose-style mention is still tolerated?
6. Instruction density: count rules (`^\*\*Rule \d+`), count forbidden/required lists, count code blocks. Is the template approaching the instruction-following saturation point (per INS-1, INS-2, INS-3)?
7. Module triggers: listed in core-template-mcp.md. Are all module files present in `_templates/modules/`? Any trigger for a module that doesn't exist?
8. Operating Posture: 4 bullets. Effective framing? Any redundancy with the 14 rules?
9. Interaction Rules: 5 bullets. Any contradiction with Rule 2's boot response structure?

### D12 — Documentation & references
**Files:** `prism-framework/_templates/reference/*.md`, `prism-mcp-server/.prism/architecture.md`, `prism-mcp-server/.prism/glossary.md`, `prism-mcp-server/.prism/known-issues.md`, all `CHANGELOG.md` / `README.md`

**Questions:**
1. Reference doc freshness: for each `_templates/reference/*.md`, find the most recent `git log` date and compare with the file's documented scope. Any doc whose subject matter has changed but doc hasn't been touched?
2. `mcp-tool-surface.md` (11.5KB): largest reference doc. Does it enumerate all 18 tools? Does it list `expected_tool_surface` format? Compare against `tool-registry.ts` — any drift?
3. `batch-operations.md` (7KB): is the batch pattern still recommended, or largely superseded by Architecture E server-side parallelism per architecture.md?
4. `ci-best-practices.md` + `ci-whitelist.yml`: verify against prism-mcp-server's actual `.github/workflows/` — does the server follow its own CI whitelist?
5. `claude-code-config.md`: audit accuracy against cc_dispatch implementation.
6. `commit-prefixes.md` (685 bytes): verify enumerated prefixes match validator regex in server code.
7. `github-api.md`: is this the server's API contract doc, or GitHub API reference? Scope appropriate?
8. `global-claude-md.md`: describes what? Redundant with per-project CLAUDE.md?
9. `repo-structure.md`: reflects current `.prism/` D-67 structure?
10. CHANGELOG.md: does it track template version bumps (v2.11.0 → v2.12.0 → v2.13.0)? Session numbers referenced?
11. README.md (framework + server): accurate? Does it tell a new operator how to onboard a project?

### D13 — Cross-project consistency
**Files:** Use GitHub API to `GET /repos/brdonath1/{prism|platformforge-v2|alterra-design-llc}/contents/.prism/handoff.md` — metadata only.

**Questions:**
1. Handoff version ages: for each of 3 sample projects, what's the current handoff version and when was it last committed (`git log -1` equivalent)?
2. Handoff size compliance: under 15KB each?
3. Meta section format (INS-17): all use list format? Fetch first 30 lines of each handoff.
4. Living document completeness: all 10 files present in each sample's `.prism/`? Use GitHub API dir listing.
5. Size anomalies: for each project, `.prism/insights.md` size, `.prism/session-log.md` size, `.prism/decisions/_INDEX.md` size. Any project outlier (>2x the median)?
6. Standing rule count: approximate count of `STANDING RULE` tag occurrences in each project's insights.md. Is any project loading dramatically more rules than others at every boot?

### D14 — Dead code & unused surface
**Files:** all of `src/`, `tests/`

**Questions:**
1. Exported-but-uncalled functions: use `grep -r` or tsc's dead-code detection if configured. Enumerate.
2. Unused tool parameters: for each tool schema, are all declared params actually consumed in the handler? Grep handler for param name.
3. Modules not triggered: the 6 modules listed in core-template-mcp.md. Evidence of ANY module being triggered in the last 20 sessions across any project? (Check session-log of sample projects.)
4. `prism_search` usage: any evidence of operator use? (Search session-log, insights, task-queue for `prism_search` invocations.) If low-use, is it worth the maintenance?
5. `prism_analytics` usage: 7 metrics. Which ones are invoked in session logs? Which are never called?
6. `prism_scale_handoff` usage: invoked how often? Bootstrap forces scaling only >15KB — could this be auto-triggered rather than a separate tool?
7. Legacy symbols: the S41-C2 rename was LEGACY_LIVING_DOCUMENTS → LIVING_DOCUMENT_NAMES. Are there other LEGACY_*, `// TODO: remove`, `// DEPRECATED` markers still in source?

### D15 — Error handling, resilience, observability
**Files:** `src/utils/logger.ts` (or equivalent), all `src/**/*.ts` (grep patterns), `.prism/decisions/operations.md` (D-79 observability bullets)

**Questions:**
1. Structured logging: FINDING-1/3 from S39 shipped S40 (architecture.md "Railway log structured payloads"). Verify every logger call has structured `attributes` payload, not string interpolation.
2. Error classification: is there a taxonomy (RETRYABLE, FATAL, USER_ERROR, SYSTEM_ERROR)? Used consistently?
3. User-facing error messages: differ from server logs? Should they? Is a stack trace ever sent to Claude as a tool response (prompt-injection + info-leak risk)?
4. Timeout messaging: when a deadline fires, what does Claude see? Is the message actionable?
5. Failure recovery: which operations have rollback paths? Which fail-open, which fail-closed?
6. Health endpoint: `/health` returns what? Dependency checks (GitHub reachable, Anthropic reachable) or just process liveness? Tradeoff: deep checks mean slower response + amplified failure domain.
7. Correlation IDs: is there a request ID threaded through logs? If not, debugging a multi-step failure is manual log grep.
8. Metrics: any Prometheus/StatsD emitter? If not, Railway logs are the only signal — is that sufficient?

## Output Format — EXACT TEMPLATE

The report MUST follow this structure. Use the headings verbatim. Do not re-order.

```
# PRISM Framework Audit — S46

## Metadata

- Report generated: <ISO timestamp from `date -Iseconds`>
- Server commit: <git rev-parse HEAD>
- Framework commit: <git rev-parse HEAD from /tmp/prism-framework>
- Test baseline: <pass>/<fail>/<skip> from `npm test`
- Build status: <pass|fail>
- Template version confirmed: v2.13.0 <yes|no — if no, actual version>
- Live /health: <HTTP code> in <time_total>s
- Auditor model: Opus 4.7, effort max
- Total wall-clock: <minutes>

## Executive Summary (≤ 1 page)

<3–5 paragraphs. Answer: is the framework degraded (per operator perception) or is performance consistent with design? Top 3 highest-severity findings by ID. Single-sentence recommendation for next step.>

## Pre-Flight Evidence

<command output snippets from Pre-Flight Step 1 + Step 4>

## Methodology & Limitations

<explicit mention of the INS-22 measurement gap: this audit was authored without operator-side Phase 1 live measurement. Enumerate findings labeled UNVERIFIED — LIVE-MEASUREMENT-REQUIRED — state what live measurement would confirm each.>

## Findings

### Summary Table

| ID | Severity | Dimension | Title | Evidence Type |
|----|----------|-----------|-------|---------------|
| F-1 | CRITICAL | D2 | ... | test-fail / live-curl / static |
| F-2 | HIGH     | D3 | ... | ... |

### Full Findings

For each finding:

```
### F-N: <Title>

- **Severity:** CRITICAL | HIGH | MEDIUM | LOW
- **Dimension:** D1–D15
- **Status:** CONFIRMED | UNVERIFIED — LIVE-MEASUREMENT-REQUIRED | STATIC-ONLY | COVERAGE-GAP
- **Description:** <2–6 sentences describing the issue>
- **Evidence:**
  - <file:line reference or grep output or curl output>
  - <second evidence item if pattern>
- **Impact:** <what breaks or degrades, who feels it>
- **Scope:** <isolated | affects-N-call-sites | systemic>
- **Related decisions:** <D-N list, or G-N for guardrail conflict>
- **Recommended Fix Category:** <one of: test-coverage | schema-change | retry-logic | timeout-tuning | doc-refresh | dead-code-removal | new-feature | architectural-change | no-action-documentation-only>
- **Estimated Impact × Effort:** <impact: low/med/high × effort: low/med/high; e.g., HIGH × LOW = quick win>
```

Severity scale (STRICT):
- **CRITICAL:** Breaks core functionality or risks data loss in normal operation.
- **HIGH:** User-observable degradation (latency >2× expected, incorrect results on common path, security exposure).
- **MEDIUM:** Latent bug or inefficiency not currently triggered on hot path; or significant tech debt.
- **LOW:** Doc drift, cosmetic, minor optimization.

## Dimension Coverage

<table confirming each of D1–D15 was audited, with count of findings per dimension. Dimensions with 0 findings must include a 1–2 sentence justification that the dimension was actually examined.>

## Out-of-Scope Observations

<Anything noticed outside the 15 dimensions — flagged for operator visibility without expanding audit scope.>

## Prioritized Recommendations

<Ranked list by Impact × Effort ratio. Group into: Immediate (HIGH × LOW), Next-wave (HIGH × MED), Long-term (MED or LOW), Watch-only (no recommended action yet — needs more data).>

## Open Questions

<Specific questions the operator should answer before fix briefs are drafted. Concrete, answerable questions — not "is this worth fixing?">

## Appendix A — File Inventory

<output of the Step 3 reading list with file sizes>

## Appendix B — Git Log Samples

<last 10 commits for prism-mcp-server main, last 10 for prism-framework main, 10 most recent touches to `src/` in server>

<!-- EOF: s46-framework-audit.md -->
```

## Completion Criteria (verifiable)

1. File exists at `reports/s46-framework-audit.md` in `prism-mcp-server` repo on `staging` branch.
2. Report contains all 15 dimension sections (D1–D15 in Dimension Coverage table).
3. At least 10 findings total. If fewer, the Executive Summary explains why.
4. Every finding has at least one concrete evidence item (file:line OR grep output OR command output).
5. Every CRITICAL or HIGH finding has a `Related decisions` line (even if empty = "none"). This forces the auditor to check decisions/ before escalating severity.
6. Dimension Coverage table is present and complete.
7. `git status` shows no modified files beyond the new report (no incidental edits). Verify before commit.
8. `git log -1 --stat` shows exactly one file added.
9. PR exists on GitHub with base `main`, head `staging`, title `Brief S46: PRISM Framework Audit Report`, body containing the Executive Summary.
10. Total report size between 15KB and 60KB. Under 15KB = too shallow. Over 60KB = verbose; condense.

## Finishing Up (single chained command)

After the report is written and verified, run ONE command:

```bash
git add reports/s46-framework-audit.md && \
git status && \
git diff --cached --stat && \
git commit -m "docs: s46 framework audit report" && \
git push origin staging && \
PR_RESPONSE=$(curl -s -X POST \
  -H "Authorization: token $GITHUB_PAT" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/brdonath1/prism-mcp-server/pulls" \
  -d "{\"title\":\"Brief S46: PRISM Framework Audit Report\",\"head\":\"staging\",\"base\":\"main\",\"body\":\"$(head -c 2000 reports/s46-framework-audit.md | sed 's/\"/\\\\\"/g' | tr '\n' ' ')\"}") && \
echo "$PR_RESPONSE" | grep -oE '"number":[0-9]+' && \
git log -1 --stat
```

If any step fails, STOP and report the failure verbatim in your final output. Do not attempt a second push. Do not retry the PR creation. Exit with the failure message so the operator can intervene.

## What success looks like

The operator reads the Executive Summary and, within 2 minutes, knows:
1. Whether their degraded-performance perception is grounded in code evidence, or not.
2. Which 3 issues (if any) to address first.
3. Which findings require the operator to run Phase 1 live measurement before any fix can be drafted.

The operator should NOT need to re-read source code to understand any finding. Evidence must be self-contained.

## What failure looks like (avoid)

- Findings without evidence ("this might be", "could be optimized", "seems like").
- Findings that propose fixes (Rule 11 violation).
- 50+ LOW-severity findings clogging the report (noise > signal).
- Dimension sections marked `NO-FINDINGS` with no justification.
- Empty Methodology & Limitations section (INS-22 acknowledgment is mandatory).
- Commit message not matching the `docs:` prefix requirement.
- Modified files other than the report staged in the final commit.
- PR not opened.

<!-- EOF: s46-framework-audit.md -->
