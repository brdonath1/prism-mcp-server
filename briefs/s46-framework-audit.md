# Brief S46 — PRISM Codebase Fresh-Eyes Audit + Live Tool Testing

## Metadata

- **Brief ID:** s46-framework-audit
- **Type:** AUDIT + LIVE-TOOL-TEST (no source code changes; test artifacts must be fully reversed)
- **Primary repo:** `prism-mcp-server` (clone target)
- **Reference repo:** `prism-framework` (clone read-only into `/tmp/prism-framework`)
- **Target branch:** `staging`
- **Model:** Opus 4.7, effort `max`
- **Deliverable:** Single file — `reports/s46-framework-audit.md` in `prism-mcp-server`
- **Deadline:** Hard cap 150 minutes wall-clock. Ship partial report with COVERAGE-GAP markers rather than abandoning.
- **Test target project:** `brdonath1/prism` (live Tier B tests use this project with dedicated test-artifact paths)

## Fresh-eyes posture (READ BEFORE ANYTHING ELSE)

Approach this codebase as an engineer who has never seen it before. You have no prior knowledge of its design decisions, trade-offs, or history. You do not know what "should" be here. You do not know why any particular subsystem exists.

- **No historical authority.** Prior decisions, briefs, reports, insights, and commit messages describe intent. Intent is not correctness. A thing that was intentional can still be wrong, slow, unnecessary, or better solved differently.
- **No subsystem sanctity.** If a subsystem exists but its purpose is not clear from reading its code and tests, that is itself a finding. You are allowed to conclude a subsystem is unnecessary, misaligned, or should be restructured.
- **No evidence-bar asymmetry.** A finding that contradicts a prior decision carries the same evidence bar as a finding that confirms one. Do not soft-pedal disagreements with past choices.
- **No operator premise acceptance.** The request was triggered by a perception that performance has degraded. You have no obligation to confirm or refute that premise. Produce what you find.
- **Documents about the system are not the system.** Architecture docs, READMEs, glossaries, and handoffs describe the project's self-concept. They can be wrong, outdated, or aspirational. Only source code + tests + live behavior constitute ground truth.

## Hard Rules (operational — violations abort the task)

1. **AUDIT ONLY on source.** You MAY create `reports/s46-framework-audit.md`. You MAY NOT modify source code, tests, configs, or documentation. No fixes.
2. **Live test artifacts must be reversed to byte-identical pre-state.** For every Tier B tool, capture pre-state, invoke, then restore. Verify restoration with SHA comparison. A failed restoration aborts further Tier B testing.
3. **Exactly one commit at end in prism-mcp-server.** The commit adds only `reports/s46-framework-audit.md`. Run `git status` before commit; if other files are staged, unstage them.
4. **Test artifacts in `brdonath1/prism`.** Live Tier B tests produce transient commits in the prism repo (this is unavoidable — GitHub cannot un-create a commit). The restoration pushes a second commit with pre-state content. End state: file content byte-identical to pre-test state, commit log shows two extra audit-trail commits. Every audit-trail commit must be prefixed `audit: s46 test-artifact` and include the tool under test in the message.
5. **Evidence requirement.** Every finding needs concrete evidence: `file:line`, `grep -c` with the exact command, test name with pass/fail, or captured command output. No speculation.
6. **Live-verification labeling.** Every runtime-behavior claim is labeled one of: `CONFIRMED-LIVE` (you invoked it and captured output), `CONFIRMED-TEST` (test in repo exercises the behavior and you ran it), or `STATIC-ONLY` (code inspection only).
7. **HTTP routing claims.** Any URL/method/retry claim must come from test inspection (mocked-fetch `tests/*.test.ts`) OR live `curl`, NOT from `grep` over source alone. `grep`-only = `STATIC-ONLY`.
8. **Zero-result discipline.** If a filter/query returns zero results, you MAY NOT conclude the subject is broken unless you independently verify the target class exists in the input. Document the verification.
9. **Severity calibration.** Use the scale strictly. Don't amplify. Don't minimize. If uncertain between two severities, pick the lower and note the uncertainty.
10. **Single push directive.** Push exactly once to `staging` at the end. Do not push interim progress. Do not push to `main`.
11. **PR at end (mandatory).** Open PR `staging → main`. PR body contains the report's Executive Summary verbatim.
12. **No fix code inside findings.** End each finding at a fix *category*, not a code diff.
13. **Brittle-restore honesty.** If any restoration fails, document the unrestored state as a CRITICAL finding and STOP further Tier B tests. Do not attempt to chain fixes.
14. **No destructive production calls.** `cc_dispatch(execute)`, `railway_deploy(redeploy)`, `railway_deploy(restart)` are Tier C — never live-invoked, regardless of apparent safety.

## Pre-Flight

### Step 1 — Environment baseline

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
- Build: if it fails, STOP, log the failure as CRITICAL and do not continue.
- Tests: capture exact counts (pass / fail / skip). Any failing test is itself a finding. Continue regardless.

### Step 2 — Env loader (multi-source fallback)
### Step 2 — Env loader (multi-repo discovery)

The API keys the audit needs are distributed across the operator's local clones of `prism-mcp-server`, `prism-framework`, and `platformforge-v2`. These env files are NOT committed to GitHub — they live only on the operator's local filesystem. Search common locations, source every file found. Later sources overlay earlier, so the order matters: `platformforge-v2` first (Anthropic/GitHub keys), then `prism-mcp-server` (server-specific like `RAILWAY_API_TOKEN` and `MCP_AUTH_TOKEN`), then `prism-framework` (unlikely to have env but check anyway).

```bash
# Candidate search roots (common layouts)
SEARCH_ROOTS=(
  "$(dirname "$(pwd)")"              # parent of current dir (sibling-repo layout)
  "$(dirname "$(dirname "$(pwd)")")"  # grandparent (nested layout)
  "$HOME"
  "$HOME/projects"
  "$HOME/code"
  "$HOME/dev"
  "$HOME/work"
  "$HOME/repos"
  "$HOME/src"
  "$HOME/Documents"
  "$HOME/Desktop"
)

# Order: later sources overlay earlier. platformforge-v2 first (full AI keys),
# then prism-mcp-server (server-specific), then prism-framework.
REPOS=("platformforge-v2" "prism-mcp-server" "prism-framework")
ENV_NAMES=(".env.local" ".env")

echo "=== Env file discovery ==="
LOADED=()
SEEN=()
for root in "${SEARCH_ROOTS[@]}"; do
  for repo in "${REPOS[@]}"; do
    for env in "${ENV_NAMES[@]}"; do
      candidate="$root/$repo/$env"
      # Resolve to canonical path so we don't double-source via symlinks / relative roots
      if [ -f "$candidate" ]; then
        canonical=$(readlink -f "$candidate" 2>/dev/null || echo "$candidate")
        # Dedupe
        already=false
        for s in "${SEEN[@]}"; do [ "$s" = "$canonical" ] && already=true; done
        if [ "$already" = false ]; then
          SEEN+=("$canonical")
          echo "Found: $canonical"
          set -a
          if source "$canonical" 2>/dev/null; then
            LOADED+=("$canonical")
          else
            echo "  WARN: failed to parse $canonical"
          fi
          set +a
        fi
      fi
    done
  done
done

echo ""
echo "=== Loaded env files (${#LOADED[@]}) ==="
printf '%s\n' "${LOADED[@]}"

# Verify required vars. Print first/last 4 chars only to avoid leaking to CI/logs.
echo ""
echo "=== ENV CHECK ==="
for var in GITHUB_PAT GITHUB_OWNER FRAMEWORK_REPO ANTHROPIC_API_KEY MCP_AUTH_TOKEN RAILWAY_API_TOKEN; do
  if [ -z "${!var}" ]; then
    echo "MISSING: $var"
  else
    val="${!var}"
    if [ ${#val} -ge 8 ]; then
      echo "OK: $var (${val:0:4}…${val: -4})"
    else
      echo "OK: $var (short-value)"
    fi
  fi
done
```

Record the full output in the report's `Pre-Flight Evidence` section, including the list of discovered files and the ENV CHECK result (key presence only, never actual values).

**Tier dependency table — consult after ENV CHECK to determine which tiers can run:**

| Required env var | Tools that need it | Where it likely lives |
|---|---|---|
| `GITHUB_PAT`, `GITHUB_OWNER`, `FRAMEWORK_REPO` | ALL tools — no work possible without these | `prism-mcp-server/.env` (primary), `platformforge-v2/.env.local` (may have `GITHUB_PAT` if populated) |
| `ANTHROPIC_API_KEY` | `prism_synthesize(generate)`, `prism_finalize(draft)` + `(commit)` auto-synthesis | `platformforge-v2/.env.local` (likely populated per AI SDK usage), also `prism-mcp-server/.env` |
| `RAILWAY_API_TOKEN` | All 4 `railway_*` tools | `prism-mcp-server/.env` only — not part of PF-v2 stack |
| `MCP_AUTH_TOKEN` | Not required for direct handler invocation (which is how the audit tests tools). Only needed if separately testing the MCP HTTP transport layer end-to-end. | `prism-mcp-server/.env` only |

Handling missing vars:

- If `GITHUB_PAT` or `GITHUB_OWNER` is still missing after full discovery: STOP the audit. No testing possible. Document the miss as a top-severity Pre-Flight finding.
- If `ANTHROPIC_API_KEY` is missing: skip `prism_synthesize(generate)` live test and the synthesis path of `prism_finalize(commit)`. Label those sections `STATIC-ONLY (env-unavailable)`.
- If `RAILWAY_API_TOKEN` is missing: skip all 4 Railway tool live invocations (both Tier A status/list/logs/get and Tier B set+delete). Label each Railway tool's Tier A/B result `STATIC-ONLY (env-unavailable)` and note in the report.
- If `MCP_AUTH_TOKEN` is missing: this does not block direct-handler tool testing. The audit proceeds. Only flag as a finding if DD8 (transport-layer review) is blocked.

### Step 3 — Reference clone

```bash
cd /tmp && git clone https://$GITHUB_PAT@github.com/brdonath1/prism-framework.git
cd prism-framework && git rev-parse HEAD && git log -5 --format='%ci %s'
cd -
```

### Step 4 — Liveness probe (unauthenticated)

```bash
curl -s -w '\nHTTP %{http_code} | %{time_total}s\n' https://prism-mcp-server-production.up.railway.app/health
```

Only unauthenticated endpoint authorized for curl-based probing.

### Step 5 — Test target pre-flight

Before any Tier B test, capture SHAs of all files under `.prism/` in the test target (`brdonath1/prism`) to serve as restoration reference:

```bash
# Use gh API or curl to list .prism contents and capture each file's blob SHA
curl -s -H "Authorization: token $GITHUB_PAT" \
  "https://api.github.com/repos/brdonath1/prism/git/trees/main?recursive=1" \
  | jq '.tree[] | select(.path | startswith(".prism/")) | {path, sha}' \
  > /tmp/prism-prestate.json
wc -l /tmp/prism-prestate.json
```

This snapshot becomes the restoration reference.

## What to read (and how to read it)

### In scope, read as code (ground truth)
- `src/**/*.ts` — all source files. Start with `src/index.ts` and trace outward.
- `tests/**/*.test.ts` — all tests. Run once (`npm test`) and read once.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/*.yml`, `railway.json`, `Dockerfile`, `Procfile`, `.env.example`.

### In scope, read as runtime inputs (evaluate as part of the system)
- `prism-framework/_templates/**/*.md`
- `prism-framework/_templates/reference/**/*.md`
- `prism-framework/_templates/modules/**/*.md`

### In scope, read as self-descriptions (verify against code)
- `prism-mcp-server/.prism/architecture.md`
- `prism-mcp-server/.prism/known-issues.md` (read in full)
- `prism-mcp-server/.prism/handoff.md`
- `prism-mcp-server/README.md`

### NOT in mandatory reading (priming risk)
- `prism-mcp-server/briefs/*` — historical work orders
- `prism-mcp-server/reports/*` — historical audit outputs
- `prism-mcp-server/.prism/decisions/**` — decision logs (rationale, not code)
- `prism-mcp-server/.prism/insights.md` — patterns and gotchas (priming risk)
- `prism-mcp-server/.prism/eliminated.md`
- `prism-mcp-server/.prism/session-log.md`

May skim a specific entry ONLY if a finding needs disambiguation. When you do, note it in the finding's evidence list.

## Severity scale (strict)

- **CRITICAL** — Breaks core functionality in normal operation, risks data loss or corruption, or creates a security exposure.
- **HIGH** — User-observable degradation: latency materially worse than design intent, incorrect results on a common code path, significant reliability gap, major resource waste.
- **MEDIUM** — Latent bug or inefficiency not currently triggered on hot paths; meaningful tech debt; missing safety net that would matter on failure.
- **LOW** — Cosmetic, documentation drift, minor optimization, style.

When uncertain between two severities, pick the lower and explain the uncertainty.

## Audit lenses (every finding maps to ≥ 1 lens)

### L1 — Correctness
Does the code do what it claims? Edge cases producing incorrect output? Ambiguities in spec? Type-level mismatches? Race conditions, off-by-one, incorrect input-shape assumptions?

### L2 — Performance & efficiency
Work done per request on hot paths? Serial awaits that could be parallel? Cache correctness? Quadratic-or-worse over growing inputs? Unbatched network calls? Unbounded payloads? Per-call work that could be per-process or per-session?

### L3 — Reliability & resilience
Dependency-failure behavior? Timeouts on every outbound call? Retry classification + backoff? Error-path coverage vs success-path? Partial-failure handling? Post-crash state consistency? Atomic operations that claim atomicity?

### L4 — Security
Secret handling paths? Error paths exposing secrets? Input validation at trust boundaries? Auth enforcement gaps? Injection surfaces (path traversal, command injection)? TOCTOU windows? Logging carefulness re: PII + credentials?

### L5 — Maintainability
Legibility to a new contributor? Overlong functions? Overcoupled modules? Duplication that should be shared? Naming clarity? Public API versioning? Dead code? Abstractions that don't pay for themselves?

### L6 — Observability
Production-failure diagnosability? Structured logs? Actionable errors? Correlation IDs? Timed slow operations? Metrics? `/health` depth? Consistent secret masking?

### L7 — Testability & test quality
Testable without production deps? Independent, fast, deterministic? HTTP mocked at transport with URL+method assertions? E2E coverage of critical paths? Realistic fixtures? Flakiness patterns (sleep-based, shared mutable state)? Error-path test coverage vs happy-path?

## Cross-cutting deep-dives (each MUST have a section in the report)

- **DD1** — Bootstrap pathway: trace full path from incoming request to response. Critical path? Parallelizable steps? Payload boundedness?
- **DD2** — Finalization pathway: all three phases end-to-end. Undetected failure modes? Implicit ordering assumptions? Mid-phase-crash recovery?
- **DD3** — Write-path atomicity: every repo-write operation — atomic in code vs atomic at transport? Partial-write possibility?
- **DD4** — Cache behavior: every cache (template cache, name-resolution cache, memoization). Scope, TTL, invalidation, miss cost, correctness assumptions.
- **DD5** — Template delivery: framework template files → server load → cache → delivery. Mechanism correct + efficient? Content coherent + appropriately sized for consumer?
- **DD6** — Intelligence / synthesis subsystem: prompt construction → model selection → timeout → retry → failure mode → output validation → storage → delivery. Cost/latency justified? Graceful degradation on failure?
- **DD7** — Archive / retention subsystem: code location, policy correctness, atomicity with triggering write, retrieval path, oversize/corrupt behavior.
- **DD8** — GitHub integration: client timeout + retry + rate-limit + error surface + URL construction + method selection. Claimed vs implemented behavior.
- **DD9** — Railway integration: feature flag + credentials + schema assumptions + log-filter semantics + masking. Verify at least one log-filter operation via a green test.
- **DD10** — Claude Code dispatch subsystem: task handoff + result retrieval + async state + mid-run crash handling.

## Live tool testing — three tiers

Invocation mechanics: CC imports tool handlers directly from `dist/` (after `npm run build`) and invokes them as functions. This bypasses the MCP transport layer, which is separately covered in DD5/DD8 via code + test review.

### Tier A — Safe live probes (read-only or idempotent)

For each tool, invoke with minimal valid arguments, capture:
- Exact request arguments
- Full response body (or error if failed)
- Wall-clock latency
- Any error surface observed

Tier A tools (invoke each at least once):

```
prism_bootstrap("prism", "audit test")
  - note: writes boot-test.md as side effect (idempotent; same content pushed per boot). Not restored — boot-test is expected transient state.
prism_fetch(["README.md"], "prism")
prism_status(include_details=true)
prism_status(include_details=true, project_slug="prism")
prism_search("prism", "architecture")
prism_analytics(metric="health_summary")
prism_analytics(metric="decision_velocity", project_slug="prism")
prism_analytics(metric="session_patterns")
prism_analytics(metric="handoff_size_history")
prism_analytics(metric="file_churn", project_slug="prism")
prism_analytics(metric="decision_graph", project_slug="prism")
prism_analytics(metric="fresh_eyes_check", project_slug="prism")
prism_synthesize(mode="status", project_slug="prism")
cc_status()   // no dispatch_id; list mode
railway_status()
railway_status(project="prism-mcp-server", include_services=true)
railway_logs(project="prism-mcp-server", limit=20)
railway_logs(project="prism-mcp-server", filter="@level:error", limit=50)
railway_deploy(project="prism-mcp-server", service="prism-mcp-server", action="status")
railway_deploy(project="prism-mcp-server", service="prism-mcp-server", action="list", count=5)
railway_env(project="prism-mcp-server", service="prism-mcp-server", action="list")
railway_env(project="prism-mcp-server", service="prism-mcp-server", action="get", name="LOG_LEVEL")
```

### Tier B — Live mutating tests (capture-invoke-restore)

Hard protocol for each Tier B test:

1. **Pre-snapshot**: fetch current SHA + content of every file the tool could mutate. Save to `/tmp/s46-prestate-<tool>/<file>`.
2. **Invoke**: call the tool with test-scoped arguments.
3. **Capture**: record request / response / latency / error to the Tool-by-Tool Review section.
4. **Restore**: push pre-state content back via `prism_push` (with `skip_validation: false` so validators run; if a validator fails on legitimate restored content, that itself is a finding). For any files CREATED by the tool that did not exist pre-state, delete them via GitHub API.
5. **Verify**: re-fetch all mutated files. Compute new blob SHAs. Compare to pre-snapshot SHAs. **MUST be byte-identical**. If any SHA differs, flag as CRITICAL and STOP further Tier B tests.
6. **Record**: the verification SHA comparison goes into the report as evidence.

Tier B tools and their test-scoped arguments:

| Tool | Test-scoped invocation | Files potentially mutated |
|---|---|---|
| `prism_push` | push one file to `test-artifacts/s46-push-<timestamp>.md` with content `# Audit test artifact` | just the new file (delete on restore) |
| `prism_patch` | patch `test-artifacts/s46-patch-<timestamp>.md` (create first, then patch, then delete) | just the test file |
| `prism_log_decision` | `D-9999` with domain=`test`, title="S46 audit test", reasoning="audit artifact" | `.prism/decisions/_INDEX.md` + `.prism/decisions/test.md` (new file) |
| `prism_log_insight` | `INS-9999`, category=`test`, title="S46 audit test", standing_rule=false | `.prism/insights.md` |
| `prism_scale_handoff` | `action="analyze"` first (non-mutating, captures plan). Then `action="full"` (mutating — redistributes). Capture all `.prism/*.md` before; restore all after. | potentially 5–10 `.prism/*.md` files + handoff.md |
| `prism_synthesize(generate)` | capture `intelligence-brief.md` pre-state; invoke with `mode=generate, session_number=46`; capture response; restore pre-state. | `.prism/intelligence-brief.md` |
| `prism_finalize(audit)` | read-only phase. Capture response; no restoration needed. | none |
| `prism_finalize(draft)` | generates drafts; capture drafts; no persistence unless phase=commit. Verify no files mutated by comparing git log before/after. | none expected |
| `prism_finalize(commit)` | **HIGHEST-RISK RESTORE**. Capture pre-state of ALL 10 living docs + `handoff-history/`. Invoke with minimal `files` array (1 no-op file to test the path). Verify what was mutated. Push restoration of every affected file. Delete any new `handoff-history/handoff_vN.md` backup and any new archive files created. Verify via git log that pre-state and post-restore SHAs match for all files. | all 10 living docs + `handoff-history/handoff_v<N>.md` backup + possible archive files |
| `cc_dispatch(query)` | dispatch a minimal read-only task: `prompt="list the files in src/", repo="prism-mcp-server", mode="query", async_mode=false, max_turns=3`. No file mutation expected in query mode. | none expected (query mode is read-only per schema) |
| `railway_env(set + delete)` | use variable name `AUDIT_TEST_VAR_S46` that does not exist. Set value to `test`. Verify via `get`. Delete. Verify via `list` that it's gone. | none persistent (set + delete round-trip) |

Notes:
- The `prism_finalize(commit)` test is the most fragile. If pre-snapshot is incomplete, restoration will leave residue. Err on the side of over-capturing: snapshot the entire `.prism/` tree and `handoff-history/` before the test.
- The `cc_dispatch(query)` test may run for 30–60s depending on SDK behavior. Use `max_turns=3` and `async_mode=false` to bound it.
- After EVERY Tier B test, run `git log --oneline -5 origin/main` against `brdonath1/prism` via GitHub API. Verify the expected number of audit-trail commits appear (typically 2 per Tier B test: tool-invocation commit + restoration commit).

### Tier C — Static / test-only review (never live-invoked)

These tools are evaluated by reading the handler source code and running their existing tests (`npm test -- <filename>`). Any runtime-behavior claim is labeled `CONFIRMED-TEST` (if a test exercises it) or `STATIC-ONLY` (code inspection only).

Tier C tools:
- `cc_dispatch(mode=execute)` — autonomous agent; cannot guarantee "leave as found"
- `railway_deploy(action=redeploy)` — production deploy; observable interruption
- `railway_deploy(action=restart)` — production restart; observable interruption

For each Tier C tool: produce a Tool-by-Tool Review section with purpose, schema, output shape, error surface, side effects, timeouts, test coverage, dependencies, findings — same per-tool checklist as Tier A/B, but all evidence is code/test based.

## Tool-by-tool review (mandatory — every tool gets a section)

Required per-tool coverage (all tiers):

1. **Purpose in your own words** — derived from handler code, not from tool description.
2. **Input schema** — params, types, optionality. Any validation gap. Any unused param.
3. **Output shape** — success + error cases. Consistency.
4. **Error surface** — enumerable errors, actionability, secret-leak risk.
5. **Side effects** — state mutations (disk, network, cache, remote). Reversible? Idempotent?
6. **Timeouts** — deadline setting, expiry behavior.
7. **Test coverage** — exercising tests, mock patterns, error-path coverage.
8. **Dependencies** — external systems, each timeouted/retried/handled.
9. **Live test result** (Tier A / B only) — latency, raw response sample, restoration verification (Tier B).
10. **Findings** — L1–L7 issues specific to this tool.

Mandatory tool list (one section per item; note additional tools found in the registry as surface drift):

```
prism_bootstrap                        [Tier A]
prism_fetch                            [Tier A]
prism_push                             [Tier B]
prism_patch                            [Tier B]
prism_search                           [Tier A]
prism_status                           [Tier A]
prism_finalize (audit/draft/commit)    [Tier B]
prism_synthesize (status/generate)     [Tier A (status) + Tier B (generate)]
prism_scale_handoff                    [Tier B]
prism_log_decision                     [Tier B]
prism_log_insight                      [Tier B]
prism_analytics                        [Tier A]
railway_logs                           [Tier A]
railway_deploy (status/list/redeploy/restart) [Tier A (status/list) + Tier C (redeploy/restart)]
railway_env (list/get/set/delete)      [Tier A (list/get) + Tier B (set+delete)]
railway_status                         [Tier A]
cc_dispatch (query/execute)            [Tier B (query) + Tier C (execute)]
cc_status                              [Tier A]
```

## Execution order

1. Pre-Flight Steps 1–5
2. Static code reading (all of `src/`, `tests/`, configs, framework templates, self-description files)
3. Tier A live probes (safe, fast, broad baseline)
4. Tier B live tests with capture-invoke-restore (one tool at a time; verify restoration after each)
5. Tier C static/test-only review
6. Cross-cutting deep-dives synthesis
7. Findings consolidation + severity calibration
8. Report assembly
9. Final verification + single commit + PR

## What to output

Path: `reports/s46-framework-audit.md` in `prism-mcp-server`. Follow this structure exactly:

```
# PRISM Codebase Fresh-Eyes Audit — Report

## Metadata
- Report generated: <ISO timestamp>
- Server commit SHA: <>
- Framework commit SHA: <>
- Test baseline: <pass>/<fail>/<skip>
- Build status: <pass|fail>
- Env vars present: <list>
- Env vars missing: <list>
- Live /health: <HTTP code> in <time_total>s
- Tier A probes executed: <N>
- Tier B tests executed with verified restoration: <N>
- Tier B tests with FAILED restoration: <N (must be 0)>
- Tier C tools reviewed: <N>
- Auditor model and effort: Opus 4.7, max
- Total wall-clock: <minutes>

## Executive Summary (≤ 1 page, prose only, no lists)
Answer in order:
1. What is this codebase, in one paragraph?
2. Overall state: which lenses are strong, which are weak?
3. Top three findings by severity (by ID).
4. What single investigation would most change your assessment if performed next?

No editorializing on operator perception. No fix promises. No next-step recommendations (those go lower).

## Pre-Flight Evidence
<verbatim command outputs from Pre-Flight Steps 1, 2, 4, 5>

## Methodology
Reading order, tools used, time spent per area, deliberate exclusions per fresh-eyes posture, scope constraints, tests run live vs code-read.

## Tier A Live Probe Results
Table: tool | latency | HTTP/response-status | response-size | error-surface | notes

## Tier B Capture-Invoke-Restore Results
Per-tool: pre-state SHAs captured | invocation result | restoration commit SHA | post-restore SHAs | byte-identical (YES/NO) | notes

## Tier C Static Review Summary
Per-tool: code location | test coverage | key risks identified | evidence refs

## Findings

### Summary Table
| ID | Severity | Lens(es) | Tool / Subsystem | Title | Evidence Type |

### Full Findings
(one section per finding using the template below)

### F-N: <short declarative title>
- Severity: CRITICAL | HIGH | MEDIUM | LOW
- Lens(es): L1–L7
- Tool / Subsystem: <scope>
- Status: CONFIRMED-LIVE | CONFIRMED-TEST | STATIC-ONLY
- Description: 2–6 sentences.
- Evidence:
  - <file:line, grep output, test name, curl output, tier A/B probe capture>
- Impact: what behavior, who observes it.
- Scope: isolated | N call sites | systemic pattern.
- Recommended Fix Category: refactor | test-gap | schema-change | dead-code | doc-drift | timeout-tuning | cache-invalidation | atomicity | security | observability | retry-logic | new-feature | no-action
- Impact × Effort: low/med/high × low/med/high

## Tool-by-Tool Review
(one subsection per tool; 9-point checklist; ≥ 1 mandatory live-test result for Tier A/B)

## Cross-Cutting Deep Dives
(one subsection per DD1–DD10; if NOT-APPLICABLE justify in one sentence)

## Lens Coverage
Table of finding counts per lens. Zero-finding lenses require one-sentence justification ("audited but no issues" vs "insufficient time" vs "not reachable from observable surface").

## Out-of-Scope Observations
Notes outside the seven lenses or ten deep-dives. No severity required.

## Prioritized Recommendations
Ranked by Impact × Effort. Groups: Immediate (high-impact, low-effort), Next wave, Long-term, Watch-only (needs more data).

## Open Questions
Concrete, answerable questions for the operator before fix briefs are drafted.

## Appendix A — File Inventory
Source, test, and config file sizes.

## Appendix B — Git Log Sample
Last 20 commits on `prism-mcp-server:main`; last 10 on `prism-framework:main`; Tier B audit-trail commits on `prism:main` (expected count = 2 × Tier B tests executed).

## Appendix C — Tier B Restoration Ledger
Per Tier B test: file path | pre-state SHA | post-invoke SHA | post-restore SHA | byte-identical verdict.

<!-- EOF: s46-framework-audit.md -->
```

## Completion criteria (verifiable)

1. File exists at `reports/s46-framework-audit.md` on `staging`.
2. Executive Summary answers all four numbered questions in prose.
3. Every tool in the registry has a Tool-by-Tool Review subsection with the 9-point checklist complete.
4. Every Tier A tool has a live-probe result. Every Tier B tool has a capture-invoke-restore result with byte-identical verification (YES/NO).
5. If ANY Tier B restoration is NO, the report documents the unrestored state as a CRITICAL finding AND the Tier B section header states `ABORTED AFTER: <tool>` and no further Tier B tests were attempted.
6. Every DD1–DD10 section exists; any `NOT-APPLICABLE` is justified.
7. Every finding has at least one concrete evidence item.
8. Every runtime-behavior claim is labeled CONFIRMED-LIVE / CONFIRMED-TEST / STATIC-ONLY.
9. `git status` in `prism-mcp-server` shows only `reports/s46-framework-audit.md` staged. `git diff --cached --stat` shows one added file.
10. PR exists on GitHub, base `main`, head `staging`, title `Brief S46: PRISM Codebase Fresh-Eyes Audit`.
11. Test-target (`prism`) ends in byte-identical state per Tier B protocol; Appendix C proves this.

## Finishing up (single chained command)

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

If any step fails, STOP and report the failure verbatim. Do not retry. Exit so the operator can intervene.

<!-- EOF: s46-framework-audit.md -->
