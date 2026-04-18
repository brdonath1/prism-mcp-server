# Brief S46 — PRISM Codebase Fresh-Eyes Audit

## Metadata

- **Brief ID:** s46-framework-audit
- **Type:** AUDIT-ONLY (no source code changes)
- **Primary repo:** `prism-mcp-server` (clone target)
- **Reference repo:** `prism-framework` (clone read-only into `/tmp/prism-framework`)
- **Target branch:** `staging`
- **Model:** Opus 4.7, effort `max`
- **Deliverable:** Single file — `reports/s46-framework-audit.md` in `prism-mcp-server`
- **Deadline:** Hard cap 120 minutes wall-clock. If you approach the cap, ship a partial report with explicit COVERAGE-GAP markers rather than abandoning.

## Fresh-eyes posture (READ BEFORE ANYTHING ELSE)

Approach this codebase as an engineer who has never seen it before. You have no prior knowledge of its design decisions, trade-offs, or history. You do not know what "should" be here. You do not know why any particular subsystem exists.

- **No historical authority.** Prior decisions, briefs, reports, insights, and commit messages describe intent. Intent is not correctness. A thing that was intentional can still be wrong, slow, unnecessary, or better solved differently.
- **No subsystem sanctity.** If a subsystem exists but its purpose is not clear from reading its code and tests, that is itself a finding. You are allowed to conclude that a subsystem is unnecessary, or that it should be restructured, or that the abstraction is wrong.
- **No evidence-bar asymmetry.** A finding that contradicts a prior decision carries the same evidence bar as a finding that confirms one. Do not soft-pedal disagreements with past choices.
- **No operator premise acceptance.** The request for this audit was triggered by a perception that performance has degraded. You have no obligation to confirm or refute that premise. Produce what you find. If the codebase is in good shape, say so and show why. If it is not, say so and show why. If the evidence is mixed or inconclusive, say that.
- **Documents about the system are not the system.** Architecture docs, READMEs, glossary entries, and handoffs describe the project's self-concept. They can be wrong, outdated, or aspirational. Only source code + tests + live behavior constitute ground truth.

## Hard Rules (operational — violations abort the task)

1. **AUDIT ONLY.** You MAY create `reports/s46-framework-audit.md`. You MAY NOT modify any other file in any repo. No source edits, no test edits, no config edits, no doc edits. If you find a bug, document it as a finding and move on.
2. **Exactly one commit at end.** The commit adds only `reports/s46-framework-audit.md`. Run `git status` before the commit and verify no other files are staged. If any other file is staged, unstage it.
3. **Evidence requirement.** Every finding must include at least one concrete evidence item: `file:line` reference, `grep -c` count with the exact command, test name with pass/fail status, or captured command output. A finding without evidence is not a finding — it is speculation and must be demoted to the `Open Questions` section or removed.
4. **Live-verification labeling.** Any claim about runtime behavior (a tool returns X, a filter matches Y, a handler retries N times) must be labeled one of: `CONFIRMED-LIVE` (you captured tool/curl output), `CONFIRMED-TEST` (a test in the repo exercises the behavior and you ran it green or red), or `STATIC-ONLY` (code inspection only, runtime not verified). If you cannot run it and no test covers it, `STATIC-ONLY` is mandatory.
5. **HTTP routing claims.** Any claim about endpoint URLs, HTTP methods, retry behavior, or status-code handling must come from test inspection (a `tests/*.test.ts` that mocks `fetch` and asserts URL + method) OR a live `curl` you ran, NOT from `grep` over source alone. `grep`-only evidence for an HTTP claim is `STATIC-ONLY` and must be labeled.
6. **Zero-result discipline.** If a filter, query, or test returns zero results, you MAY NOT conclude the subject is broken unless you independently verify the target class exists in the input. Document the positive verification.
7. **Severity calibration.** Use the scale below strictly. Do not amplify. Do not minimize. If you are uncertain between two severities, pick the lower and note the uncertainty in the finding.
8. **Single push directive.** Push exactly once, to `staging`, at the end. If the push fails, investigate and retry — do not abandon the report. Do not push to `main`.
9. **PR at end (mandatory).** Open a PR `staging → main` via GitHub API. PR body must include the report's Executive Summary verbatim.
10. **No fix code inside findings.** Each finding ends at a fix *category* (e.g., "refactor", "test gap", "schema change", "dead code", "doc drift", "timeout tuning"), not at a code diff. Concrete fixes come in separate follow-up briefs after operator review.

## Pre-Flight

### Step 1 — Environment baseline

Run each command and capture the exact output in the report's `Pre-Flight Evidence` section.

```bash
node --version
npm --version
git rev-parse HEAD
git log -1 --format='%ci %s'
git status
git branch --show-current
npm ci 2>&1 | tail -5
npm run build 2>&1 | tail -20
npm test 2>&1 | tail -30
find src -type f -name '*.ts' | wc -l
find tests -type f -name '*.test.ts' | wc -l
find src -type f -name '*.ts' -exec wc -l {} + | tail -1
cat package.json
ls -la .github/workflows/ 2>/dev/null
```

Required state for audit to proceed:
- Build: if it fails, STOP, log the failure as a top-severity finding, and do not continue. You cannot audit code that does not compile.
- Tests: capture exact counts (pass / fail / skip). Any failing test is itself a finding. Continue the audit regardless of test status.

### Step 2 — Reference clone (for runtime-input evaluation only)

```bash
cd /tmp && git clone https://$GITHUB_PAT@github.com/brdonath1/prism-framework.git
cd prism-framework && git rev-parse HEAD && git log -5 --format='%ci %s'
cd -
```

The framework repo contains files that the server loads at runtime (behavioral templates, reference documents, module files). Evaluate them as system components, not as authority.

### Step 3 — Liveness probe (unauthenticated only)

```bash
curl -s -w '\nHTTP %{http_code} | %{time_total}s\n' https://prism-mcp-server-production.up.railway.app/health
```

This is the only live endpoint call authorized. Authenticated `/mcp` calls are NOT authorized (credentials are not in your dispatch context). Record the response and the round-trip time.

## What to read (and how to read it)

### In scope, read as code (ground truth)
- `src/**/*.ts` — all source files. Start with `src/index.ts` as the entry point and trace outward.
- `tests/**/*.test.ts` — all tests. Run them once (`npm test`) and read them once.
- `package.json`, `tsconfig.json`, `vitest.config.ts` / `jest.config.ts`, `.github/workflows/*.yml`, `railway.json`, `Dockerfile` (if any), `.env.example` (if any).

### In scope, read as runtime inputs (evaluate as part of the system)
- `prism-framework/_templates/**/*.md` — templates the server serves at bootstrap and finalization. Evaluate whether the content is coherent, whether the server correctly serves it, and whether the instruction density is appropriate for the consumer (a Claude model).
- `prism-framework/_templates/reference/**/*.md` — reference documents.
- `prism-framework/_templates/modules/**/*.md` — on-demand modules.

### In scope, read as self-descriptions (verify against code)
- `prism-mcp-server/.prism/architecture.md` — what the project says it is. Check each claim against source.
- `prism-mcp-server/.prism/known-issues.md` — read in full. Known issues are findings the project has already acknowledged; cross-check that the issues listed are actually fixed or actually still present.
- `prism-mcp-server/.prism/handoff.md` — most recent operational state claimed by the project.
- `prism-mcp-server/README.md` — public-facing description.

### NOT in mandatory reading (may skim only if a specific finding requires disambiguation)
- `prism-mcp-server/briefs/*` — historical work orders. Reading these will prime you with past rationale.
- `prism-mcp-server/reports/*` — historical audit outputs. Same priming risk.
- `prism-mcp-server/.prism/decisions/**` — decision logs. These are rationale, not code.
- `prism-mcp-server/.prism/insights.md` — accumulated patterns and gotchas. Priming risk.
- `prism-mcp-server/.prism/eliminated.md` — rejected approaches. Priming risk.
- `prism-mcp-server/.prism/session-log.md` — session history. Priming risk.

If during your audit you find yourself about to conclude "this is wrong" and you are uncertain whether the project has already considered and rejected the alternative, you MAY fetch a specific decision or insight entry to disambiguate. When you do, note it in the finding's evidence list and state why the historical rationale does or does not change your conclusion.

### Cross-project surface check (surface-level only)
For three sample project repos — `brdonath1/prism`, `brdonath1/platformforge-v2`, `brdonath1/alterra-design-llc` — fetch directory listing of `.prism/` via GitHub API and capture file sizes + last-commit date. Do NOT download and read the contents. The purpose is anomaly detection (one project wildly different from the others), not content review.

## Severity scale (strict)

- **CRITICAL** — Breaks core functionality in normal operation, risks data loss or corruption, or creates a security exposure. Requires immediate attention regardless of other findings.
- **HIGH** — User-observable degradation: latency materially worse than design intent, incorrect results on a common code path, significant reliability gap, or major resource waste. Worth addressing before the next feature cycle.
- **MEDIUM** — Latent bug or inefficiency not currently triggered on hot paths, meaningful tech debt, or missing safety net that would matter on failure. Worth addressing but not urgent.
- **LOW** — Cosmetic, documentation drift, minor optimization, or style concern that does not affect behavior today.

If uncertain between two severities, pick the lower and explain the uncertainty in the finding body.

## Audit lenses

Organize your review around seven neutral engineering concerns. Every finding maps to at least one lens. Lenses are not subsystems; a single module may produce findings in multiple lenses.

### L1 — Correctness
Does the code do what it claims to do? Are there edge cases that produce incorrect output? Are there ambiguities in the spec (schema, behavior, error contract) that would cause divergent implementations? Are there type-level mismatches between producer and consumer? Are there race conditions, off-by-one errors, incorrect assumptions about input shape?

Evidence types: failing or passing tests that demonstrate the behavior, `file:line` references to conditional logic, contract examples.

### L2 — Performance & efficiency
What is the work done per request for the hot paths? Are there serial awaits that could be parallel? Are there caches, and if so are they invalidated correctly and is the cache-miss path acceptable? Are there quadratic or worse algorithms over inputs that grow? Are there network calls that could be batched? Are there payload sizes that grow unboundedly? Are there operations that run on every call when they could run once per process or once per session?

Evidence types: `await` placements, loop structures with N dependence, cache TTL values, payload size measurements, curl timings, test timings.

### L3 — Reliability & resilience
What happens when a dependency fails? Are timeouts set on every outbound call? Are retries classified (retryable vs fatal) with appropriate backoff? Are error paths as well-covered as success paths? Are partial failures handled (N of M operations succeed)? Is state consistent after a mid-operation crash? Are there operations that must be atomic but aren't?

Evidence types: try/catch structures, timeout configuration, test coverage of error paths, documented guarantees vs implemented guarantees.

### L4 — Security
Where are secrets handled? Can any error path expose a secret? Is input from external sources validated before use in paths, queries, commands, or API calls? Is authentication enforced where it should be and bypassed where it claims to be bypassable? Are there injection surfaces (path traversal, command injection, SQL-like)? Are there TOCTOU windows? Is logging careful about PII and credentials?

Evidence types: secret-loading code paths, input validation at trust boundaries, logging statements with variable interpolation, auth middleware, mask function test coverage.

### L5 — Maintainability
Can a new contributor understand and change this code without breaking it? Are functions overlong? Are modules overcoupled? Is there duplication that should be shared? Is naming clear and consistent? Are public APIs versioned? Is dead code present? Are there multiple implementations of the same concept? Are there abstractions that add cost without paying for themselves?

Evidence types: LoC per function, import graph shape, duplicate logic across files (grep counts), callsite counts for exported symbols.

### L6 — Observability
Can an operator diagnose a failure in production from the available signals? Are logs structured? Are error messages actionable? Is there a correlation ID threading through a request? Are slow operations timed? Is there metrics emission? Does `/health` reflect actual health or just process liveness? Are secrets masked consistently across log paths?

Evidence types: logger call structure, error message quality, /health response, presence or absence of instrumentation.

### L7 — Testability & test quality
Is the code testable without production dependencies? Are tests independent, fast, deterministic? Are HTTP calls mocked at the transport layer and asserted on URL + method, not on source-code text? Is there end-to-end coverage of at least the critical paths? Are fixtures realistic? Are there flaky patterns (sleep-based timing, shared mutable state)? What is the coverage of error paths relative to happy paths?

Evidence types: test structure, mock patterns, fixture origins, test runtime totals, `vitest` / `jest` config flags, flakiness indicators.

## Tool-by-tool review (mandatory — every tool gets a section)

The server exposes a set of tools to MCP consumers. For each tool in the exposed surface, produce a compact review covering the items below. Do not defer to tool descriptions — derive behavior from the handler code.

Required per-tool coverage:
1. **Purpose in your own words** — what does this tool actually do, derived from the handler?
2. **Input schema** — params, types, optionality. Are any validations missing? Are any params declared but unused in the handler?
3. **Output shape** — what does the tool return on success, and is the shape consistent across success cases?
4. **Error surface** — what errors can the tool emit? Are error messages actionable? Do any error paths leak secrets or raw stack traces?
5. **Side effects** — what state does the tool mutate (disk, network, cache, remote services)? Are side effects reversible? Idempotent?
6. **Timeouts** — deadline set? What happens if it expires?
7. **Test coverage** — which test files exercise this tool? Is the mock transport consistent with production transport? Are error paths tested?
8. **Dependencies** — what does this tool depend on (GitHub API, Anthropic API, Railway API, disk, env vars)? Is each dependency timeouted, retried, and failure-handled?
9. **Findings** — any issues you identified in lenses L1–L7 specific to this tool.

Tools to review (you must produce a section for each; if you find additional registered tools not listed here, review them too and note the surface drift):

```
prism_bootstrap
prism_fetch
prism_push
prism_patch
prism_search
prism_status
prism_finalize
prism_synthesize
prism_scale_handoff
prism_log_decision
prism_log_insight
prism_analytics
railway_logs
railway_deploy
railway_env
railway_status
cc_dispatch
cc_status
```

If the tool registry contains more or fewer than this list, that discrepancy is itself a finding.

## Cross-cutting deep-dives

Beyond per-tool review, examine these cross-cutting subsystems as wholes. Do not assume their current shape is correct; evaluate whether the shape itself is sound.

### DD1 — Bootstrap pathway
Trace the full code path from an incoming `prism_bootstrap` request to the response return. Note every file read, every network call, every cache touch, every synchronous transformation. Then ask: is this the minimum work needed to answer the request? Is the response shape coherent and stable? Is the payload size bounded? What is the critical path, and what could be parallelized?

### DD2 — Finalization pathway
Same for `prism_finalize` (all three phases: audit, draft, commit). This is the most complex tool; trace it end-to-end. Does any phase have steps that could fail without being detected? Are there implicit assumptions about phase ordering? If the process crashes between phases, what is the recovery story?

### DD3 — Write-path atomicity
For every operation that writes to a repo (push, patch, finalize commit, decision logging, insight logging, boot-test), determine whether the write is atomic and whether the code's claimed atomicity matches the transport's actual behavior. Identify any path where a partial write is possible.

### DD4 — Cache behavior
Locate every cache in the system (template cache, name-resolution cache, any in-memory memoization). For each: scope (per-request, per-process, per-cluster), TTL, invalidation trigger, miss cost. Identify any cache whose correctness depends on an assumption about immutability that may not hold.

### DD5 — Template delivery
The server delivers behavioral rules to consumers at bootstrap. Examine the template files in the framework repo, the server code that loads them, the caching layer, and the delivery code path. Evaluate both: (a) is the delivery mechanism correct and efficient? and (b) is the content being delivered coherent and appropriately sized for the consumer?

### DD6 — Intelligence / synthesis subsystem
The server invokes a model to produce a project-state summary (an "intelligence brief") at certain moments. Trace the call: prompt construction, model selection, timeout handling, retry policy, failure mode, output validation, storage, delivery. Ask: does the cost/latency of this subsystem justify its output? What are the failure modes, and does the system degrade gracefully when it fails?

### DD7 — Archive / retention subsystem
Some files in the project state are archived or pruned according to policy. Locate the code. Evaluate: is the policy consistent with documented intent? Is the archive atomic with the write that triggers it? Is there a retrieval path? What happens on policy violation (oversize file, corrupt archive)?

### DD8 — GitHub integration
All repo writes go through a GitHub client. Evaluate the client: timeout configuration, retry classification, rate-limit awareness, error surfacing, URL construction, method selection per operation. Identify any inconsistency between claimed behavior and implemented behavior.

### DD9 — Railway integration
A subset of tools query Railway's GraphQL API. Evaluate the client: feature-flag gating, credential handling, schema assumptions, log-filter semantics, masking behavior. Live-verify at least one log-filter operation via the exposed tool (you cannot run the tool directly, but you CAN inspect a test that does and verify it runs green).

### DD10 — Claude Code dispatch subsystem
Some tools orchestrate a separate Claude Code agent. Evaluate the dispatch mechanism: how are tasks handed off, how are results retrieved, how is state tracked across async runs, what are the failure modes of a mid-run crash or network break?

## What to output

The report lives at `reports/s46-framework-audit.md` and MUST contain the sections below in this order. Use headings verbatim.

```
# PRISM Codebase Fresh-Eyes Audit — Report

## Metadata
- Report generated: <ISO timestamp>
- Server commit SHA: <>
- Framework commit SHA: <>
- Test baseline: <pass>/<fail>/<skip>
- Build status: <pass|fail>
- Live /health: <HTTP code> in <time_total>s
- Auditor model and effort: Opus 4.7, max
- Total wall-clock: <minutes>

## Executive Summary (≤ 1 page, prose only, no lists)
Answer four questions in order:
1. What is this codebase, in one paragraph, from your reading?
2. What is the overall state: which lenses are strong, which are weak?
3. What are the top three findings by severity (by ID)?
4. What single investigation would most change your assessment if performed next?

Do not editorialize about operator perception. Do not promise fixes. Do not recommend next steps here — they go in a later section.

## Pre-Flight Evidence
<verbatim command outputs from Pre-Flight Step 1 and Step 3>

## Methodology
State: how you read the code (order, tools used, time spent per area), what you ran, what you could not verify, and any reading you deliberately excluded per the fresh-eyes posture. Note anything the scope prevented you from examining.

## Findings

### Summary Table
| ID | Severity | Lens(es) | Tool / Subsystem | Title | Evidence Type |

### Full Findings
<one section per finding>

Per finding (use this template):

### F-N: <short declarative title>
- Severity: CRITICAL | HIGH | MEDIUM | LOW
- Lens(es): L1–L7 (one or more)
- Tool / Subsystem: <scope>
- Status: CONFIRMED-LIVE | CONFIRMED-TEST | STATIC-ONLY
- Description: 2–6 sentences. What is wrong, in concrete terms.
- Evidence:
  - <file:line, grep output, test name, curl output>
- Impact: what behavior this produces, who observes it
- Scope: isolated | N call sites | systemic pattern
- Recommended Fix Category: refactor | test-gap | schema-change | dead-code | doc-drift | timeout-tuning | cache-invalidation | atomicity | security | observability | retry-logic | new-feature | no-action
- Impact × Effort: low/med/high × low/med/high

## Tool-by-Tool Review
<one subsection per tool, per the required coverage above>

## Cross-Cutting Deep Dives
<one subsection per DD1–DD10>

## Lens Coverage
Table showing which lenses each finding hit. If a lens has zero findings, note whether that means the lens was weak in evidence opportunities, strong in the codebase, or not covered due to time.

## Out-of-Scope Observations
Things you noticed that fell outside the seven lenses or ten deep-dives. No severity labels required.

## Prioritized Recommendations
Ranked by Impact × Effort ratio. Grouped: Immediate (high-impact, low-effort), Next wave, Long-term, Watch-only (needs more data).

## Open Questions
Specific questions the operator should answer before fix briefs can be drafted.

## Appendix A — File Inventory
Sizes of source files, test files, config files.

## Appendix B — Git Log Sample
Last 20 commits on main for the server; last 10 for the framework repo. Timestamps + messages only.

<!-- EOF: s46-framework-audit.md -->
```

## Completion criteria (verifiable)

1. File exists at `reports/s46-framework-audit.md` on `staging`.
2. Executive Summary answers all four numbered questions.
3. Every tool in the exposed surface has a `Tool-by-Tool Review` subsection.
4. Every deep-dive (DD1–DD10) has a subsection. If any is `NOT APPLICABLE`, justify in one sentence.
5. Every finding has at least one concrete evidence item in the Evidence field.
6. Every runtime-behavior claim is labeled CONFIRMED-LIVE, CONFIRMED-TEST, or STATIC-ONLY.
7. Severity distribution is reported in Lens Coverage.
8. `git status` shows no modified files beyond the new report; `git diff --cached --stat` shows exactly one added file.
9. PR exists on GitHub, base `main`, head `staging`, title `Brief S46: PRISM Codebase Fresh-Eyes Audit`.

## Finishing up (single chained command)

After the report is written and you have verified it locally:

```bash
git add reports/s46-framework-audit.md && \
git status && \
git diff --cached --stat && \
git commit -m "docs: s46 fresh-eyes audit report" && \
git push origin staging && \
EXEC_SUMMARY=$(awk '/^## Executive Summary/,/^## Pre-Flight Evidence/' reports/s46-framework-audit.md | sed '$d' | head -c 3000) && \
PR_BODY=$(jq -Rs '.' <<< "$EXEC_SUMMARY") && \
curl -s -X POST \
  -H "Authorization: token $GITHUB_PAT" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/brdonath1/prism-mcp-server/pulls" \
  -d "{\"title\":\"Brief S46: PRISM Codebase Fresh-Eyes Audit\",\"head\":\"staging\",\"base\":\"main\",\"body\":$PR_BODY}" | tee /tmp/pr-response.json && \
grep -oE '"number":[0-9]+' /tmp/pr-response.json && \
git log -1 --stat
```

If any step fails, STOP and report the failure verbatim in your final output. Do not retry the push. Do not retry the PR. Exit so the operator can intervene.

<!-- EOF: s46-framework-audit.md -->
