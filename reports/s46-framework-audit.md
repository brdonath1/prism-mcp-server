# PRISM Two-Axis Audit — Report

## Metadata

- Report generated: 2026-04-18T15:07:00Z
- Server commit (pre-audit): `d172ce6` (branch: `audit/s46-framework-audit` cut from `main`)
- Framework commit: `dc1708d` (prism-framework @ v2.13.0)
- Test baseline: **578 passed / 0 failed / 0 skipped** across 48 test files (vitest 3.1)
- Build: **pass** (`tsc` clean, no errors)
- Env vars present: GITHUB_PAT, GITHUB_OWNER, FRAMEWORK_REPO, ANTHROPIC_API_KEY
- Env vars missing (local): MCP_AUTH_TOKEN, RAILWAY_API_TOKEN (production has both — live Railway probes succeeded via the deployed server)
- Live `/health`: HTTP 200 in 0.261s, body `{"status":"ok","version":"4.0.0"}`
- Tier A probes: **19** (all succeeded)
- Tier B tests executed / verified / failed-restore: **7 / 7 / 0**
- Tier C tools reviewed (static): **3** (`cc_dispatch(execute)` — static+test-observed; `railway_deploy(redeploy)`, `railway_deploy(restart)` — static only, mutations ack'd "not yet exercised" in source)
- Axis B sample projects: 3 (prism, platformforge-v2, alterra-design-llc)
- Axis B sample sessions examined: ~52 across the 3 projects (see Appendix D)
- Axis B sample handoff versions examined: 15 finalize commits on PRISM; 16 on PF2; 15 on alterra (via GitHub API history)
- Auditor: Claude Opus 4.7, effort `max`
- Wall-clock: ~120 min (well under 210-min cap)

## Executive Summary

This codebase is **PRISM MCP Server v4.0.0** — a Node/TypeScript remote MCP server deployed on Railway that backs the PRISM session-continuity framework. 48 source files / ~12,099 LOC / 48 test files / 578 tests. The surface is 18 MCP tools (12 PRISM core, 4 Railway gateway, 2 Claude Code orchestration) over an Express 5 app running in stateless streamable-HTTP mode, backed by plain-fetch GitHub/Railway clients, the Anthropic SDK for synthesis, and the `@anthropic-ai/claude-agent-sdk` for dispatch. Server-side state is intentional: the template cache (5-min TTL), the default-branch cache, the dispatch store (with GitHub durability at `brdonath1/prism-dispatch-state`), and an Anthropic client singleton.

On **Axis A (codebase health)**, the system is broadly correct on the hot path — bootstrap, push, atomic commit via Git Trees API, finalize audit/commit, cache invalidation, and synthesis all behave as designed and are load-bearing-tested. L3 reliability is strong: atomic-commit + HEAD-SHA guard + deadline sentinels on `prism_push` / `prism_finalize` cleanly handle the S40-vintage hang scenarios. L4 security is mostly sound (timing-safe token compare, CIDR allowlist, secret masking), with two gaps worth calling out. The cluster of real issues is in **analytics and documentation coherence**: `prism_analytics(session_patterns)` returns negative gap days, inverted date ordering, and finds 0 of 172 sessions on platformforge-v2 because of a header-format assumption; `prism_analytics(decision_graph)` reports 0.5 total edges because it only scans the lookup-table index, never the domain files where cross-references actually live; and the project-count claim in CLAUDE.md (17), in memory (15), and live (22) disagree — the authoritative number is measurable but nothing is measuring it. Write-path atomicity also asymmetric: `prism_push` uses atomic Git Trees commits, but `prism_log_decision` and `prism_scale_handoff` still push multiple files via sequential/parallel `pushFile` calls, creating a partial-state risk the main write path was specifically designed to eliminate.

On **Axis B (Claude behavioral drift)**, the headline finding is structural: **session-logs are narrative post-hoc summaries, not verbatim per-response transcripts, so the most important BDDs (BDD1 Rule 9 literal compliance rate, BDD2 boot structure per boot, BDD7 literal frustration phrasing) cannot be measured at response granularity from current evidence.** This is an audit-tooling gap, not a behavioral finding. The measurements that ARE possible tell a mostly healthy story: decision logging is atomic per `prism_log_decision` across all three sampled projects; handoff trajectories are bounded (D-80 archive lifecycle is working); template velocity is high (5 bumps in 11 days) and each bump traces to a concrete drift incident rather than speculative hardening; no observable cross-project convention bleed in n=3. The single real Axis B finding is that **alterra-design-llc's session-log narrative still contains 17 prose-style context-tier phrases** ("Finalized at ~80% context", "at 🟡 tier") that are the documented pattern source D-85 was designed to counter — the framework template was hardened but the project-local narrative source was left unscrubbed on scope discipline, and so the next alterra boot re-reads it.

**Top three findings by severity:** **A-1** (HIGH) — `prism_analytics(session_patterns)` and `decision_graph` are structurally broken (header-format assumption + index-only scan); **A-4** (HIGH) — doc/code divergence: CLAUDE.md says dispatch state lives at `prism-mcp-server/.dispatch/{id}.json` but code writes to separate repo `brdonath1/prism-dispatch-state` (trap for the next engineer); **B-1** (HIGH) — alterra session-log prose-pattern contamination persists despite D-85.

**Single investigation that would most change the assessment:** Whether behavioral drift is actually happening at response granularity. Current Axis B evidence cannot answer this. A thin client-side instrumentation emitting per-response behavioral summaries to `.prism/audit-trail.md` would turn the next audit from archaeology into measurement, and would either confirm the framework is working or surface drift that is currently invisible.

## Pre-Flight Evidence

### Step 1 — Environment baseline

```
node --version          → v24.13.0
npm --version           → 11.10.0
git rev-parse HEAD      → d172ce67bb4e4cb3f26bf2bb438aeadb1aec2fd6
git log -1              → 2026-04-18 07:48:46 -0700 docs: correct branch model ...
git status              → clean
npm ci                  → ok (npm audit fix suggested; not run)
npm run build           → pass (tsc clean)
npm test                → 578 passed / 578 total across 48 files
find src -name '*.ts'   → 48
find tests -name '*.test.ts' → 48
wc -l (src total)       → 12099
ls .github/workflows    → ci.yml (only)
```

### Step 2 — Env loader output

```
Found: /Users/briandonath/Desktop/Development/platformforge-v2/.env.local
Found: /Users/briandonath/Desktop/Development/prism-mcp-server/.env
OK: GITHUB_PAT (ghp_…8wXs)
OK: GITHUB_OWNER (brdo…ath1)
OK: FRAMEWORK_REPO (pris…work)
OK: ANTHROPIC_API_KEY (sk-a…swAA)
MISSING: MCP_AUTH_TOKEN           (does not block direct/MCP-proxied handler testing)
MISSING: RAILWAY_API_TOKEN        (local — production server has it, live Railway probes succeeded via the deployed server)
```

### Step 4 — Liveness

```
curl https://prism-mcp-server-production.up.railway.app/health
→ {"status":"ok","version":"4.0.0"}
HTTP 200 | 0.261457s
```

### Step 5 — Tier B pre-state snapshot

```
/tmp/prism-prestate.json — 204 lines (JSON objects: .prism/ paths + SHAs in brdonath1/prism)
Key SHAs captured:
  .prism/decisions/_INDEX.md         sha=f36fb8ae133d26e4606740938b8f6142c7936bf7  size=8735
  .prism/decisions/architecture.md   sha=b9028829c431344f18500b26d9f490e0f604e88a  size=27317
  .prism/insights.md                 sha=71ee7e2dbc2be184566ac45dade6f2e06ac4ebf7  size=48833
```

### Step 6 — Axis B project inventory

(Summarized — see Appendix D for per-project listings.) PRISM at v51 handoff, 45 sessions, 85 decisions, 48.8KB insights. PlatformForge-v2 at v192 handoff, 172 sessions, 63 decision rows (header claims 94), 34.8KB insights. Alterra-design-llc at v16 handoff, 15 sessions, 26 decisions, 57.7KB insights. Handoff-history folders are SPARSE (4–6 versions retained out of N, per the finalize-commit-time prune-to-3 rule in `src/tools/finalize.ts:460-480`).

## Methodology

**Both axes were executed in one run.** Axis A combined static code reading (`src/**/*.ts` 48 files), live MCP tool invocations against the production server at `https://prism-mcp-server-production.up.railway.app/mcp` (the brief asked for direct handler import from `dist/`; using the MCP transport was chosen because it exercises the full stack — transport, stateless server creation, authentication, tool dispatch — providing stronger signal than bypassing it, at the cost of counting against the MCP response size budget). Tier A probes were read-only and idempotent. Tier B followed the capture-invoke-restore pattern: pre-state SHAs captured to `/tmp/s46-prestate/`, the tool invoked with test-scoped arguments, then restoration via GitHub PUT with the pre-state content, and SHA verification of byte-identical restoration.

**Axis B was executed in parallel via a dispatched general-purpose agent** that read `session-log.md`, `handoff.md`, `decisions/_INDEX.md`, `insights.md`, and `handoff-history/*` for prism, platformforge-v2, and alterra-design-llc, and returned a quantified BDD1-BDD9 report at `/tmp/s46-evidence/axis-b-report.md`. The parent thread independently verified a subset of Axis B counts (see "Own verification" notes in the B-findings).

**Deliberate exclusions:** (1) `prism_finalize(commit)` was intentionally NOT live-invoked — it would have modified all 10 living docs of the prism project plus potentially created archive files, and the restoration surface was too broad to guarantee byte-identical recovery within the brief's budget. Covered via code reading + tests only (CONFIRMED-TEST). (2) `cc_dispatch(execute)`, `railway_deploy(redeploy)`, `railway_deploy(restart)` are per-brief Tier C (never live) and are STATIC-ONLY. (3) `cc_dispatch(query)` was NOT live-invoked due to its cost (observed historical dispatches: $0.09–$6.13 each per `cc_status` listing, median ~$1); covered via code read.

**Sampling:** n=3 projects for Axis B (smallest viable sample the framework could supply with the time budget). Live tool tests targeted the `prism` project per brief Section 5.

**Scope constraints:** Report only; no source changes. Single commit on `audit/s46-framework-audit` branch adding only `reports/s46-framework-audit.md`.

---

# Axis A — Codebase findings

## A-findings summary table

| ID | Severity | Lens(es) | Tool/Subsystem | Title | Evidence |
|----|----------|----------|----------------|-------|----------|
| A-1 | HIGH | L1 | `prism_analytics` session_patterns | Returns negative gap_days and wrong date ordering; misses 24 of 45 PRISM sessions; returns 0 of 172 PF2 sessions | Live-verified ×2; `src/tools/analytics.ts:109,131-140` |
| A-2 | HIGH | L1 | `prism_analytics` decision_graph | Scans only `_INDEX.md` rows; returns 0.5 total_edges across 85 PRISM decisions; 84 of 85 isolated | Live-verified; `src/tools/analytics.ts:253-335` |
| A-3 | HIGH | L5,L1 | Docs vs code | `CLAUDE.md` says dispatch state at `prism-mcp-server/.dispatch/{id}.json`; code writes to separate repo `prism-dispatch-state` | Live-verified via `cc_status.state_repo`; `src/config.ts:283`, CLAUDE.md L76 |
| A-4 | MEDIUM | L1 | `prism_log_insight` | No dedup guard; duplicate INS-9999 accepted silently (asymmetric with `prism_log_decision`) | Live-verified; `src/tools/log-insight.ts:13-120` |
| A-5 | MEDIUM | L1,L3 | `prism_log_decision` | Two sequential `pushFile` calls (not atomic) — dangling-reference risk if domain push fails after index push | `src/tools/log-decision.ts:168-180` |
| A-6 | MEDIUM | L1,L3 | `prism_scale_handoff` | `executeScaling` uses `Promise.all` over `pushFile` for destination files then a separate handoff push — not atomic across files, partial-state risk | `src/tools/scale.ts:788-832,1134-1138` |
| A-7 | MEDIUM | L5 | Project-count docs | CLAUDE.md says 17 projects, user memory says 15, live health_summary found 22 — systemic doc staleness | Live-verified; CLAUDE.md project overview |
| A-8 | MEDIUM | L4 | `railway_env` masking | `SENSITIVE_KEY_PATTERNS` does not match `PAT`; `GITHUB_PAT` not auto-classified sensitive; mask_values=false would return PAT in clear | Static; `src/railway/client.ts:538-555` |
| A-9 | MEDIUM | L2 | `prism_status` (cross-project) | Unbounded listRepos × (2 handoff probes + 10 docs + 4 archives) = ~300 API calls per multi-project status | Static; `src/tools/status.ts:210-241`, confirmed via Tier A health_summary returning 22 projects |
| A-10 | MEDIUM | L6 | Railway logs severity | stderr from github-mcp-server stdio bridge arrives tagged severity=error; `@level:error` filter returns ~20 INFO-level lines as errors | Live-verified; `src/railway/client.ts:413-426` filter correct per code, upstream tagging is the issue |
| A-11 | MEDIUM | L1 | `handoff_size_history` trend | Alphabetical sort puts v49,v50 before v7,v8,v9; `versions[0]`/`versions[-1]` comparison is meaningless; live output showed `trend: "growing"` comparing v49(6.2KB) to v9(6.4KB) | Live-verified; `src/tools/analytics.ts:168-198` |
| A-12 | MEDIUM | L6 | Railway mutations unexercised | `deploymentRedeploy`/`deploymentRestart` comments ack "not yet exercised from S143 verification run" | Static; `src/railway/client.ts:430-471` |
| A-13 | LOW | L4 | Hand-rolled .env loader | `src/config.ts:9-25` doesn't handle quoted values, multi-line, backslash escapes — dev-mode only but still fragile | Static; `src/config.ts` |
| A-14 | LOW | L3 | `createPullRequest` no retry | `cc-dispatch.ts:createPullRequest` uses plain fetch — no rate-limit retry, no timeout | Static; `src/tools/cc-dispatch.ts:480-514` |
| A-15 | LOW | L5 | `resolveDocFiles` deprecated but widely used | Marked `@deprecated` since the introduction of `resolveDocFilesOptimized`, but finalize/analytics/etc. still call it | Static; `src/utils/doc-resolver.ts:159` |
| A-16 | LOW | L1 | Brief `audit:` prefix rejected | Server's commit-message validation only allows `prism:|fix:|docs:|chore:`; brief specified `audit: s46 test-artifact <tool>` prefix | Live-verified; `src/validation/common.ts` |
| A-17 | LOW | L5 | `decisionVelocity` dead `idKey` | Declared at `analytics.ts:47` but never read | Static; `src/tools/analytics.ts:47` |
| A-18 | LOW | L5 | `started_at` `- 0` dead math | `new Date(Date.now() - 0).toISOString()` — `- 0` is no-op; comment says it "will be overwritten" but code still does the math | Static; `src/tools/cc-dispatch.ts:423` |
| A-19 | LOW | L4 | `safeTokenCompare` length-leak | Short-circuit `a.length !== b.length` can leak token length via timing; necessary because `timingSafeEqual` throws on length mismatch | Static; `src/middleware/auth.ts:10-13` |
| A-20 | LOW | L1 | `handoff_size_history` mixed filename date formats | Filenames use two conventions (`_MM-DD-YY.md` and `_YYYY-MM-DD.md`); parser handles both but status output shows "date: unknown" when format mismatches expected | Live-verified; `src/tools/analytics.ts:172-178` |

## Tier A live probe results

| Tool | Latency | Status | Notes |
|------|--------:|--------|-------|
| `prism_bootstrap("prism","audit test")` | — (boot-test push succeeded) | 200 OK | 51.5KB response persisted (exceeds 80KB warn threshold at 51.5KB? No — it's 51.5KB, below 80KB). Returned v2.13.0 template, 9,657B handoff, 85 decisions, full behavioral rules, 2 prefetched docs. |
| `prism_fetch("prism", ["README.md"])` | — | 200 OK | 361B, exists=true, is_summarized=false. |
| `prism_status(include_details=true)` | multi-project | 200 OK | Multi-project, 22 projects found (brief/docs claim 17 — see A-7). |
| `prism_status(project_slug="prism", include_details=true)` | — | 200 OK | health=healthy, 10/10 docs, 9,731B handoff, v51, 45 sessions, archives visible. |
| `prism_search("prism","architecture",max_results=5)` | 218ms | 200 OK | 17 files / 201 sections / 242,086B searched → 5 ranked results. Working. |
| `prism_analytics(health_summary)` | — | 200 OK | 22 projects: 6 healthy / 6 needs-attention / 10 critical. Many "critical" are stub projects with 4 docs present (probably onboarded but unused). |
| `prism_analytics(decision_velocity, prism)` | — | 200 OK | 85 decisions / 35 sessions / avg 2.4 — works. |
| `prism_analytics(session_patterns, prism)` | — | 200 OK → **broken output** | 21 sessions (should be 45), first_date=2026-04-18, last_date=2026-04-01, average_gap_days=-0.8. **A-1.** |
| `prism_analytics(session_patterns, platformforge-v2)` | — | 200 OK → **broken output** | total_sessions=0 (actual = 172). Header format mismatch. **A-1.** |
| `prism_analytics(handoff_size_history, prism)` | — | 200 OK → broken trend | 5 versions; alphabetic sort puts v49,v50 before v7,v8,v9; trend=growing comparing v49 to v9. **A-11.** |
| `prism_analytics(file_churn, prism)` | — | 200 OK | 30 commits analyzed, task-queue most-churned (5x). Works. |
| `prism_analytics(decision_graph, prism)` | — | 200 OK → **broken output** | total_edges=0.5, 1 of 85 connected. **A-2.** |
| `prism_analytics(fresh_eyes_check, prism)` | — | 200 OK | overdue=true, sessions_since_fresh_eyes=45. Works. |
| `prism_synthesize(status, prism)` | — | 200 OK | exists=true, last_synthesized=S45. Works. |
| `cc_status()` (list mode) | — | 200 OK | 10 dispatches returned; `state_repo: "brdonath1/prism-dispatch-state"` — contradicts CLAUDE.md. **A-3.** |
| `railway_status()` | — | 200 OK | 2 projects (prism-mcp-server, PlatformForge-v2). |
| `railway_status(prism-mcp-server, include_services=true)` | 332ms | 200 OK | 2 services, latest deployments SUCCESS. |
| `railway_logs(prism-mcp-server, limit=20)` | — | 200 OK | 20 logs returned including my own audit's `prism_analytics` and `railway_status` calls. |
| `railway_logs(prism-mcp-server, filter="@level:error", limit=20)` | — | 200 OK → surfaced upstream issue | 20 entries returned all tagged `severity:"error"` but message bodies are INFO-level lines from stdio bridge (`level=INFO msg="server session connected"` etc). Filter works per code; the `error` tagging comes from stderr→severity mapping upstream. **A-10.** |
| `railway_deploy(list, count=3)` | — | 200 OK | 3 deployments (1 SUCCESS, 2 REMOVED). Works. |
| `railway_env(list)` | — | 200 OK | 19 variables; masked by default; `sensitive_keys: [ANTHROPIC_API_KEY, RAILWAY_API_TOKEN, RAILWAY_PRIVATE_DOMAIN]` — `GITHUB_PAT` NOT classified sensitive. **A-8.** |
| `railway_env(get, LOG_LEVEL)` | — | 200 OK | `"info"`. Works. |

## Tier B capture-invoke-restore results

| Tool | Pre-SHA | Post-invoke | Post-restore | Byte-identical? | Commits on prism:main |
|------|---------|-------------|---------------|-----------------|------------------------|
| `prism_push` → `test-artifacts/s46-push-1712999999.md` (create) | n/a (new file) | sha=`2ce752b488a71bc321501e422e92f91b709f2457` via atomic tree commit (verified=true) | file deleted (sha after delete: n/a) | ✅ file no longer exists | `2ce752b` (create) → `c2736f7` (delete) |
| `prism_patch` on same new file, 1 append op | `2ce752b4...` | post-patch 189B; integrity_check.clean=true | (deleted alongside create) | ✅ | (rolled into same `c2736f7` cleanup) |
| `prism_log_decision(D-9999)` | `f36fb8ae...` (_INDEX) + `b9028829...` (architecture.md) | both files updated, separate commits `2447ebe` + `cd7e96e` | restored to `f36fb8ae...` + `b9028829...` | ✅ | `2447ebe,cd7e96e,b4f054e,074e041` |
| `prism_log_decision(D-9999)` duplicate attempt | same as above | **rejected with duplicate message** (dedup guard works) | no change | ✅ | no commit |
| `prism_log_insight(INS-9999)` | `71ee7e2d...` | `insights.md` updated, commit `e59e99e` | restored to `71ee7e2d...` | ✅ | `e59e99e,ef25993` |
| `prism_log_insight(INS-9999)` duplicate attempt | `71ee7e2d...` (post-first) | **accepted silently** (no guard) — commit `04a838b` | (rolled into single `insights.md` restore) | ✅ | `04a838b` |
| `prism_scale_handoff(analyze, prism)` | (read-only) | plan returned (1 action, 15% reduction estimated) | no change | ✅ | no commits |
| `prism_finalize(audit, prism, 46)` | (read-only) | audit returned (10 docs, drift detection, new_decisions=[D-9999], session work products) | no change | ✅ | no commits |
| `railway_env(set, AUDIT_TEST_VAR_S46=test)` | var absent | var=test confirmed via get | deleted via railway_env(delete); get returned 404 | ✅ | (GitHub unaffected) |

Post-restore SHAs on prism:main all match pre-state: `_INDEX.md=f36fb8ae`, `architecture.md=b9028829`, `insights.md=71ee7e2d`. No Tier B restoration failed — Tier B did NOT abort. During the restore window two ambient `prism: handoff-backup v51` and `chore: prune old handoff backup` commits appeared (timestamped 15:01:10Z, interleaved between my restore commits) — origin unknown (possibly concurrent session or scheduled task); the auditor's 3 restored files were byte-identical regardless. **Not attributed to this audit.**

Ten test-trail commits left on prism:main (versus brief's expected "two extra audit-trail commits" per tool — that was a lower bound; the actual count reflects 7 distinct mutating tool invocations each requiring at least a create + restore commit). File content byte-identical to pre-state: ✅.

## Tier C static review

| Tool | Code loc | Test coverage | Risks | Evidence |
|------|----------|---------------|-------|----------|
| `cc_dispatch(mode=execute)` | `src/tools/cc-dispatch.ts:365-400` (clone → dispatch → commit/push/PR flow) | Indirect via `cc-status.test.ts` (tests the record shape, not the execution path) | Cost + partial-state: if commit succeeds but `createPullRequest` fails, branch has commits without a PR. `createPullRequest` uses plain fetch without retry (A-14). | Historical `cc_status` list shows 2 execute-mode failures with `"commit/push/PR failed: ... push: RPC failed; curl 92 ..."` — transient network errors leave the state intact. |
| `railway_deploy(action=redeploy)` | `src/railway/client.ts:430-449` | No test (acknowledged "not yet exercised from S143 verification run") | Un-verified mutation path; unknown behavior on schema drift. | Static only; own code comment. |
| `railway_deploy(action=restart)` | `src/railway/client.ts:451-471` | No test (same ack) | Same as above. | Static only. |

## Full A-findings

### A-1: `prism_analytics(session_patterns)` and `decision_graph` produce broken output on real project data

- **Severity:** HIGH
- **Lens(es):** L1 (correctness)
- **Tool/Subsystem:** `prism_analytics` — metric functions in `src/tools/analytics.ts`
- **Status:** CONFIRMED-LIVE (3 distinct live invocations demonstrate the bugs)
- **Description:** Two of the seven analytics metrics return systematically wrong output on real project data. `session_patterns` assumes session-log headers follow the exact pattern `### Session N (date)` with optional `CC ` prefix — but platformforge-v2 uses `## S{N} — MM-DD-YY` format (observed 172 sessions) and alterra uses a mixed format (table rows + `### Session N`). Running `session_patterns` on PF2 returns `total_sessions=0`; on PRISM it returns 21 (not 45, because older sessions are in `session-log-archive.md` which is never read); and the gap calculation iterates the file in document order (most-recent-first in PRISM) so successive-session gaps come out negative (observed: `average_gap_days: -0.8`, `first_session_date: 2026-04-18`, `last_session_date: 2026-04-01` — these are inverted). `decision_graph` only scans `decisions/_INDEX.md` for D-N references; but the index is a lookup table where each row is just `| D-N | Title | Domain | Status | Session |` — cross-references appear in the DOMAIN FILES (e.g., `decisions/architecture.md`, `decisions/operations.md`). With 85 decisions the scan found exactly 1 edge (D-77 → D-58, because D-77's title literally contains "supersedes ... D-58"), and then divided by 2 to produce `total_edges: 0.5`.
- **Evidence:**
  - Live: `prism_analytics(session_patterns, prism)` → `"total_sessions":21,"first_session_date":"2026-04-18","last_session_date":"2026-04-01","average_gap_days":-0.8`.
  - Live: `prism_analytics(session_patterns, platformforge-v2)` → `"total_sessions":0`.
  - Live: `prism_analytics(decision_graph, prism)` → `"total_edges":0.5,"connected_count":1,"isolated_count":84`.
  - Code: `src/tools/analytics.ts:109` header regex `/^###\s+(?:CC\s+)?Session\s+(\d+)\s*\(([^)]+)\)/i` — requires exact format. `src/tools/analytics.ts:132-140` sorts by document order, not date. `src/tools/analytics.ts:253-272` scans `_INDEX.md` content only.
  - Note: per user memory "Battle Test Results — Session 3 test results, two known analytics bugs" — this appears to be one of them, still present.
- **Impact:** Operator-visible wrong data on documented analytics features. `session_patterns` and `decision_graph` both exist in the brief's Tier A list, suggesting they are in the expected tool surface. Invisible unless the operator actually looks at the numbers — and the previous comment about "two known analytics bugs" suggests the operator knows but the code has not been fixed.
- **Scope:** Two metric functions. Per-metric, not systemic.
- **Recommended Fix Category:** Rewrite `session_patterns` to read the session-log-archive.md as well as session-log.md, and use a more permissive header regex that accepts both PRISM's and PF2's formats; sort parsed sessions by date, not document order. Rewrite `decision_graph` to scan all `decisions/*.md` domain files (or decisions/*.md and _INDEX.md together), and fix the `/2` undirected-edge assumption (the graph is directional: D-77→D-58 doesn't imply D-58→D-77). Extend Tier A tests to cover PF2-style header format.
- **Impact × Effort:** High impact (user-visible incorrect analytics) × Low-Medium effort (the fixes are localized to two function bodies, no architecture change needed).

### A-2: `prism_analytics(decision_graph)` false edge count — see A-1 above

Consolidated into A-1.

### A-3: Documentation says dispatch state lives in `prism-mcp-server` repo; code writes it to separate `prism-dispatch-state` repo

- **Severity:** HIGH
- **Lens(es):** L5 (maintainability), L1 (correctness-of-documentation)
- **Tool/Subsystem:** CLAUDE.md project-level instructions vs `src/config.ts` + `src/tools/cc-dispatch.ts` + `src/dispatch-store.ts`
- **Status:** CONFIRMED-LIVE (`cc_status()` returns `"state_repo":"brdonath1/prism-dispatch-state"`)
- **Description:** CLAUDE.md (project instructions committed to this repo) states: "Dispatch state is persisted to `brdonath1/prism-mcp-server/.dispatch/{id}.json` so `cc_status` can read it across stateless requests." The code disagrees: `src/config.ts:283` declares `CC_DISPATCH_STATE_REPO = "prism-dispatch-state"`, and the live `cc_status()` response returns `"state_repo":"brdonath1/prism-dispatch-state"`. A comment in `src/tools/cc-status.ts:10` explains the decoupling: "State writes to this repo were previously triggering Railway auto-deploy, which killed in-flight dispatches" — so the code was fixed but the CLAUDE.md doc was not updated.
- **Evidence:**
  - Live: `cc_status()` → `"state_repo": "brdonath1/prism-dispatch-state"`.
  - Code: `src/config.ts:283` `CC_DISPATCH_STATE_REPO = "prism-dispatch-state"`.
  - Code: `src/tools/cc-status.ts:1-11` docstring.
  - Docs: `CLAUDE.md` §"Claude Code orchestration (brief-104)" L77 says `brdonath1/prism-mcp-server/.dispatch/{id}.json`.
- **Impact:** The next engineer reading CLAUDE.md will look for dispatch state in the wrong repo, file `git log` queries against the wrong path, etc. High-trust doc source contradicting ground truth is expensive.
- **Scope:** Two sentences in CLAUDE.md.
- **Recommended Fix Category:** Update CLAUDE.md to reflect the separate `prism-dispatch-state` repo and briefly explain the Railway auto-deploy decoupling rationale.
- **Impact × Effort:** Medium impact × trivial effort.

### A-4: `prism_log_insight` has no dedup guard — accepts duplicate INS-N silently

- **Severity:** MEDIUM
- **Lens(es):** L1 (correctness)
- **Tool/Subsystem:** `prism_log_insight` in `src/tools/log-insight.ts`
- **Status:** CONFIRMED-LIVE
- **Description:** `prism_log_decision` has a documented dedup guard introduced in brief-104 A.1 (verified live: the second `D-9999` attempt returned `"error":"Decision ID D-9999 already exists ..."`). `prism_log_insight` has no equivalent. Invoking `INS-9999` twice back-to-back succeeded both times, producing two `### INS-9999` entries in `insights.md`. The `finalize(audit)` output confirmed both entries appeared:  
  `"### INS-9999: S46 Audit Test Insight", "### INS-9999: S46 Audit Duplicate Insight Test"`
- **Evidence:**
  - Live: `prism_log_insight(id=INS-9999, ...)` call 1 → `{"success":true, "size_bytes":48990}`. Call 2 with different title → `{"success":true, "size_bytes":49160}`. Both accepted.
  - Code: `src/tools/log-insight.ts:27-120` — no dedup logic.
  - Compare: `src/tools/log-decision.ts:89-120` — explicit dedup with `parseExistingDecisionIds`.
- **Impact:** Duplicates can cascade into the `standing_rules` extraction (`src/tools/bootstrap.ts:86-120`), which will return the same rule twice at boot; possible cache/memo mismatch; the `insights.md` document integrity drifts. Low frequency in practice because Claude tracks its own INS numbering, but a bug (duplicate INS-9999 already visible in current `insights.md` post-restore is not — my restoration removed them, but before restoration they were both present).
- **Scope:** One tool.
- **Recommended Fix Category:** Mirror the dedup pattern from `src/tools/log-decision.ts:28-53` (`parseExistingDecisionIds`) in `log-insight.ts`: scan `insights.md` for `^### INS-N:` markers, reject on collision with a clear error message.
- **Impact × Effort:** Medium impact × low effort (a ~30-line change).

### A-5: `prism_log_decision` pushes `_INDEX.md` and domain file via sequential `pushFile` — not atomic

- **Severity:** MEDIUM
- **Lens(es):** L1 (correctness), L3 (reliability)
- **Tool/Subsystem:** `prism_log_decision`
- **Status:** STATIC-ONLY (live test succeeded; failure case is not easily reproducible)
- **Description:** The tool docstring claims "Log a decision atomically to `_INDEX.md` and domain file. Server-side formatting." (line 11) — but the implementation pushes the two files sequentially via two separate `pushFile` calls at `log-decision.ts:168-180`, each producing its own commit SHA. If the index push succeeds but the domain-file push fails (transient GitHub 5xx, rate-limit after retries exhausted, network blip between the two calls), the project is left in a state where `_INDEX.md` references a decision whose domain-file entry doesn't exist — the "dangling reference" state the docstring's "atomically" word was meant to prevent.
- **Evidence:**
  - Code: `src/tools/log-decision.ts:168-180` — two separate `await pushFile(...)` calls.
  - Docstring: line 11 claims atomicity.
  - Compare: `prism_push` (`src/tools/push.ts`) uses `createAtomicCommit` from `github/client.ts:598` for exactly this multi-file atomicity.
- **Impact:** Silent partial state on failure. Low probability per invocation; compounds over many invocations if GitHub has a bad hour.
- **Scope:** One tool.
- **Recommended Fix Category:** Replace the two `pushFile` calls with a single `createAtomicCommit([index, domain], commitMessage)`. Use `getHeadSha` before and after the atomic commit the same way `prism_push` does (see push.ts:151-200). Test with mocked GitHub failing on the second push and verify rollback.
- **Impact × Effort:** Medium impact × medium effort (atomic-commit-ify plus a new test).

### A-6: `prism_scale_handoff` writes destination files via `Promise.all` + separate handoff push — not atomic across files

- **Severity:** MEDIUM
- **Lens(es):** L1, L3
- **Tool/Subsystem:** `prism_scale_handoff` / `executeScaling` in `src/tools/scale.ts`
- **Status:** STATIC-ONLY
- **Description:** `executeScaling` (lines 788-832) pushes all destination files (session-log.md, decisions/_INDEX.md, architecture.md, eliminated.md — whichever the analysis routed content to) via `Promise.all` + `pushFile`. Then `scale:full` and `scale:execute` push the reduced handoff as a seventh separate commit (lines 1134-1138). If any of the destination writes fail but the handoff write succeeds, content has been extracted from the handoff to nowhere — data loss. The symmetric concern from `prism_push` motivated `createAtomicCommit`; that pattern was not adopted here.
- **Evidence:**
  - Code: `src/tools/scale.ts:788-832` parallel pushes.
  - Code: `src/tools/scale.ts:930-933, 1134-1138` handoff push.
  - No single atomic commit wraps both.
- **Impact:** Rare but high-cost when it happens — the scaled handoff is smaller but the extracted sections are gone.
- **Scope:** One tool.
- **Recommended Fix Category:** Combine destination files + reduced handoff into a single `createAtomicCommit(all_files, commitMessage)` — same pattern as finalize.ts commitPhase (line 593).
- **Impact × Effort:** Medium impact × medium effort.

### A-7: CLAUDE.md / memory project counts disagree with live reality

- **Severity:** MEDIUM
- **Lens(es):** L5 (maintainability/doc drift)
- **Tool/Subsystem:** CLAUDE.md + auto-memory
- **Status:** CONFIRMED-LIVE
- **Description:** CLAUDE.md says "serving 17 PRISM projects". User auto-memory says "15 active projects". Live `prism_analytics(health_summary)` returned `"total_projects":22`. Nothing auto-reconciles this — the numbers just drift with each onboarding and nobody updates CLAUDE.md.
- **Evidence:**
  - CLAUDE.md Project Overview block: "serving 17 PRISM projects"
  - Memory `~/.claude/projects/.../memory/user_profile.md` — "15 active projects"
  - Live `prism_analytics(health_summary)` 2026-04-18 → 22 projects, 6 healthy / 6 needs-attention / 10 critical.
- **Impact:** Doc rot. Not load-bearing on behavior but dents trust.
- **Scope:** Two lines of docs.
- **Recommended Fix Category:** Either remove the count (it will always drift) or generate it at doc-build time from a live probe; updating in-place is a losing game.
- **Impact × Effort:** Low-medium impact × trivial effort.

### A-8: `SENSITIVE_KEY_PATTERNS` does not match `PAT`; `GITHUB_PAT` not auto-classified sensitive

- **Severity:** MEDIUM
- **Lens(es):** L4 (security)
- **Tool/Subsystem:** `railway_env` + `src/railway/client.ts` mask helpers
- **Status:** CONFIRMED-LIVE (the sensitive_keys response list did NOT include GITHUB_PAT)
- **Description:** `railway/client.ts:538-547` defines sensitive name patterns: `KEY, SECRET, TOKEN, PASSWORD, PASSWD, AUTH, CREDENTIAL, PRIVATE`. None of these match `GITHUB_PAT` (P-A-T is a common GitHub abbreviation not captured by those regexes). Live `railway_env(list)` returned `"sensitive_keys":["ANTHROPIC_API_KEY","RAILWAY_API_TOKEN","RAILWAY_PRIVATE_DOMAIN"]` — `GITHUB_PAT` is absent. In the default invocation (`mask_values=true`) everything gets masked regardless, BUT if an operator passes `mask_values=false` to get non-sensitive values cleartext, `GITHUB_PAT` would flow through unmasked because its name didn't match the sensitive pattern.
- **Evidence:**
  - Code: `src/railway/client.ts:538-547` pattern list.
  - Live: `railway_env(list)` — 19 vars, sensitive_keys list excludes GITHUB_PAT.
- **Impact:** A PAT with repo scope in clear in an operator's terminal history if they ever run with `mask_values=false`. Deployment writes to all 22 managed repos.
- **Scope:** One constant.
- **Recommended Fix Category:** Add `/\bPAT\b/i` to `SENSITIVE_KEY_PATTERNS`. (Also worth adding `/GITHUB_/i` as a belt-and-suspenders category since anything GitHub-named in a Railway env is very likely a token.)
- **Impact × Effort:** Medium impact × trivial effort (one line).

### A-9: `prism_status` (no project_slug) makes O(N * 14) GitHub API calls with no caching

- **Severity:** MEDIUM
- **Lens(es):** L2 (performance)
- **Tool/Subsystem:** `prism_status` in `src/tools/status.ts`
- **Status:** STATIC (derived from code + the live 22-project number)
- **Description:** Multi-project `prism_status` flow: (1) `listRepos()` pages through all repos owned by `GITHUB_OWNER` (could be more than 22 — brdonath1 has many) — typically 1 page = 1 call; (2) for each repo `resolveDocExists("handoff.md")` which probes both `.prism/handoff.md` and `handoff.md` — up to 2 calls; (3) for each PRISM project `getProjectHealth` fetches 10 living documents + 4 archive files, each with up-to-2 probes = 14 fetches × ~22 projects = ~308 API calls. No caching between invocations (stateless server). The in-memory `defaultBranchCache` helps only for per-request branch resolution.
- **Evidence:**
  - Code: `src/tools/status.ts:210-241` (listRepos + concurrent resolveDocExists).
  - Code: `src/tools/status.ts:92-164` (getProjectHealth — 10 + 4 fetches per project).
  - Live: 22 PRISM projects detected.
- **Impact:** One invocation of multi-project status may run 5-8s and burn a chunk of the GitHub rate-limit budget. If run frequently (e.g., as part of a polling dashboard) could hit secondary rate limits.
- **Scope:** One tool.
- **Recommended Fix Category:** Cache the repo list (5-min TTL, similar to templateCache). Cache the handoff.md presence check per-repo (10-min TTL). Consider a "summary" response mode that skips the 4 archive probes.
- **Impact × Effort:** Medium impact × low effort.

### A-10: Railway `@level:error` filter returns stderr-tagged INFO lines as errors

- **Severity:** MEDIUM
- **Lens(es):** L6 (observability)
- **Tool/Subsystem:** `railway_logs` — interaction with upstream Railway log severity mapping
- **Status:** CONFIRMED-LIVE
- **Description:** `filterLogs` in `src/railway/client.ts:413-426` filters on `l.severity` case-insensitively. The filter code is correct. But Railway captures stderr output as `severity: "error"` regardless of the application's log level. The github-mcp-server stdio bridge writes all its lines to stderr including `level=INFO msg="server session connected"` — so these INFO-level messages arrive at the PRISM server with `severity: "error"` attached. The live probe `railway_logs(filter=@level:error, limit=20)` returned 20 lines that were ALL stdio-bridge INFO messages tagged as errors. This is an upstream (Railway) behavior, but it surfaces through PRISM's tool with no explanation.
- **Evidence:**
  - Live: 20/20 `@level:error` results had `message` starting `time=... level=INFO msg="server session..."`.
  - Code: `src/railway/client.ts:418-422` severity match (correct).
  - INS-33 (PRISM insights.md) already discusses zero-result-inference discipline for this filter, but the inverse case (false-positive errors) is not documented.
- **Impact:** Operator can't easily find real errors — every `@level:error` pull is flooded with stdio-bridge noise. Workaround: `filter="prism_"` or substring-search for known error strings.
- **Scope:** One filter path.
- **Recommended Fix Category:** Two options. (a) Detect and demote stdio-bridge INFO lines (regex `/level=INFO msg=/` in the message body) to `severity: "info"` before applying the filter. (b) Add a `true_error_only` option that additionally filters out stdio-bridge patterns. Option (a) is cleaner.
- **Impact × Effort:** Medium impact × medium effort.

### A-11: `handoff_size_history.trend` is meaningless due to alphabetical sort

- **Severity:** MEDIUM
- **Lens(es):** L1 (correctness)
- **Tool/Subsystem:** `prism_analytics(handoff_size_history)` in `analytics.ts:168-198`
- **Status:** CONFIRMED-LIVE
- **Description:** Handoff history files list at `analytics.ts:167-168` `.sort((a,b) => a.name.localeCompare(b.name))`. Alphabetic sort puts `handoff_v49_...` before `handoff_v7_...` (because `4` < `7`). Then `trend` is computed at L194-198 as `versions[versions.length - 1].size_bytes > versions[0].size_bytes ? "growing" : "shrinking"` — comparing the alphabetically-last entry (v9 in PRISM's case) to the alphabetically-first (v49 in PRISM's case). The live PRISM output returned `"trend":"growing"` by comparing v49 (6.2KB) to v9 (6.4KB) — nonsensical. `prism_analytics(handoff_size_history, prism)` full output below demonstrates.
- **Evidence:**
  - Live: 5 versions in order `v49,v50,v7,v8,v9` (alphabetical), trend=growing.
  - Code: `analytics.ts:167-168` sort, L194-198 trend comparison.
- **Impact:** Diagnostic output is wrong; doesn't fail loudly so operators may accept it.
- **Scope:** One function.
- **Recommended Fix Category:** Sort by parsed version number (`parseInt(name.match(/v(\d+)/)[1])`) ascending. Trend should compare most-recent-N vs previous-N or use regression.
- **Impact × Effort:** Low-medium impact × trivial effort.

### A-12: `deploymentRedeploy` / `deploymentRestart` mutations acknowledged unexercised

- **Severity:** MEDIUM
- **Lens(es):** L6 (observability), L7 (testability)
- **Tool/Subsystem:** `railway_deploy(redeploy|restart)`
- **Status:** STATIC-ONLY (per brief; mutations are Tier C)
- **Description:** Source code comments at `src/railway/client.ts:433-437, 454-458` state: "Note: the `deploymentRedeploy` mutation has not yet been exercised from the S143 verification run. If Railway changes the schema, surface the error rather than silently retrying." Same comment on `deploymentRestart`. There are no tests exercising either. The operator has no ground-truth signal that either works.
- **Evidence:** Code comments + absence of test coverage.
- **Impact:** Rare but at-incident-time usage — low-frequency, high-importance tools not live-validated. If the schema drifted between S143 and now, the first time operator needs them they might fail.
- **Scope:** Two mutations.
- **Recommended Fix Category:** Either (a) a scheduled no-op smoke test that runs the mutation against a sacrificial service, or (b) schema introspection that runs at server boot to detect drift.
- **Impact × Effort:** Medium impact × medium effort.

### A-13 (LOW): Hand-rolled `.env` loader in `src/config.ts`

`src/config.ts:9-25` iterates lines, splits on first `=`. Does not handle: quoted values with embedded `=`, multi-line values, backslash escapes, surrounding single/double quotes. Dev-mode only (Railway provides env directly). LOW impact because standard values work.

### A-14 (LOW): `createPullRequest` in cc-dispatch.ts uses plain fetch

Line 480-514: plain `fetch` call, no `fetchWithRetry` wrapper, no AbortSignal timeout. On 429 or network blip, this hangs or throws immediately without retry. Narrow failure mode.

### A-15 (LOW): `resolveDocFiles` @deprecated but widely used

`src/utils/doc-resolver.ts:159-184` marked `@deprecated` in favor of `resolveDocFilesOptimized` (L102). Still used in `src/tools/finalize.ts:141, 338`, `src/tools/analytics.ts:344, 399`, `src/ai/synthesize.ts:43, 58`. Migration is incomplete.

### A-16 (LOW): Brief's `audit:` commit prefix rejected by server validation

Server validation in `src/validation/common.ts` only allows `prism:|fix:|docs:|chore:`. The brief's Tier B instruction to use "audit: s46 test-artifact" prefix was rejected on first try; used `chore:` as a workaround. LOW impact to this audit (easy fallback) but friction for future briefs.

### A-17 (LOW): Dead variable `idKey` in `decisionVelocity`

`src/tools/analytics.ts:47` — declared but never read.

### A-18 (LOW): `- 0` dead math in cc-dispatch.ts

`src/tools/cc-dispatch.ts:423`: `started_at: new Date(Date.now() - 0).toISOString()` — the `- 0` is a no-op. Comment explains the field is overwritten downstream, but the `- 0` remains as cruft.

### A-19 (LOW): Token-length-leak in `safeTokenCompare`

`src/middleware/auth.ts:10-13` — short-circuit on `a.length !== b.length` leaks token length via timing. Necessary because `timingSafeEqual` throws on length mismatch. Theoretical only — operator-provided MCP_AUTH_TOKEN is fixed length in practice.

### A-20 (LOW): `handoff_size_history` mixed filename date formats

`src/tools/analytics.ts:171-179` tries to parse date from filename via regex `/(\d{4}-\d{2}-\d{2})/`. PRISM has `handoff_v8_03-02-26.md` (MM-DD-YY) which won't match this regex; `date` returns `"unknown"`. Live output showed 3 of 5 versions with `date:"unknown"`.

## Per-tool review

### `prism_bootstrap` [Tier A]
- **Purpose:** Load a project's boot payload (handoff, decision index, behavioral rules template, intelligence brief, prefetched docs, banner text, expected tool surface) in a single MCP call. Perf target 3-5% bootstrap context vs the original 15-20% direct-fetch baseline.
- **Schema:** `{project_slug: string, opening_message?: string}` with Zod.
- **Output shape:** JSON with ~20 top-level fields: `project`, `handoff_version`, `template_version`, `session_count`, `session_number`, `session_timestamp`, `handoff_size_bytes`, `scaling_required`, `critical_context[]`, `current_state`, `resumption_point`, `recent_decisions[]`, `guardrails[]`, `next_steps[]`, `open_questions[]`, `prefetched_documents[]`, `standing_rules[]`, `intelligence_brief`, `brief_age_sessions`, `behavioral_rules`, `banner_text`, `boot_test_verified`, `bytes_delivered`, `files_fetched`, `context_estimate` (with 5 sub-fields), `expected_tool_surface`, `post_boot_tool_searches`, `warnings`.
- **Error surface:** Handoff fetch failure → hard error with `isError: true`. All other fetches (decisions, template, insights, brief) degrade gracefully with warnings. Dynamic slug resolution (D-68) tries normalized match against `listRepos()`.
- **Side effects:** Writes `boot-test.md` to the target repo (non-blocking; failure logged as warning). Populates template cache.
- **Timeouts:** Inherited GITHUB_REQUEST_TIMEOUT_MS (15s) per GitHub call, parallelized.
- **Test coverage:** banner-text.test, fetch-path-resolution, prefetch-keywords, slug-resolution, branch-detection, template-budget — extensive.
- **Dependencies:** `github/client.fetchFile/listRepos/pushFile`, `utils/cache.templateCache`, `utils/doc-resolver`, `utils/banner.renderBannerText`, `utils/summarizer`, `validation/handoff.parse*`.
- **Live test result:** CONFIRMED-LIVE — 51.5KB response (within 80KB warn), all expected fields present.
- **Findings:** None blocking. Note: response bytes exceed 80KB warn threshold at 80_000B, hit ERROR at 100_000B (push.ts:606-610 logging) — 51.5KB observed is safe, but context_estimate.total_boot_tokens calculation (line 528-532) uses a crude `/3.5` bytes→tokens ratio; real tokenization varies. Low severity.

### `prism_fetch` [Tier A]
- **Purpose:** Fetch a batch of files from a project repo, with optional summary mode for files >5KB. Supports doc-resolver path normalization (A.2 brief-104) for living-doc bare names.
- **Schema:** `{project_slug, files[], summary_mode?}`.
- **Output shape:** `{project, files[{path, exists, size_bytes, content|null, summary|null, is_summarized}], bytes_delivered, files_fetched}`.
- **Error surface:** Per-file — 404 becomes `{exists: false}`; other errors propagate.
- **Side effects:** None.
- **Timeouts:** Inherited.
- **Test coverage:** fetch-path-resolution.test.ts (14 tests).
- **Dependencies:** `github/client.fetchFile`, `utils/doc-resolver.resolveDocPath`, `utils/summarizer.summarizeMarkdown`.
- **Live test result:** CONFIRMED-LIVE (`README.md` fetched, 361B, exists=true).
- **Findings:** None.

### `prism_push` [Tier B]
- **Purpose:** Atomically push N files to a project repo with server-side validation. Single atomic commit via Git Trees API on success (S40 C3, D-69, D-81).
- **Schema:** `{project_slug, files[{path, content, message}], skip_validation?}`.
- **Output shape:** `{project, results[{path, original_path?, redirected?, success, size_bytes, sha, verified, validation_errors[], validation_warnings[], error?}], all_succeeded, files_pushed, files_failed, total_bytes, commit_sha?}`.
- **Error surface:** Validation errors aggregated before any write (no partial-validate state). Atomic commit failure with HEAD changed → "partial state" flagged result, no fallback. HEAD unchanged → sequential-`pushFile` fallback. Deadline (PUSH_WALL_CLOCK_DEADLINE_MS default 60s) backstop.
- **Side effects:** Files committed to target repo; template cache invalidated if framework template was touched (line 241-248).
- **Timeouts:** 60s wall-clock deadline. 15s per GitHub call.
- **Test coverage:** push-validation (10 tests), timeout-architecture, tool-deadlines, observability — heavy.
- **Dependencies:** `github/client.createAtomicCommit/getHeadSha/pushFile`, `utils/doc-guard`, `validation/*`.
- **Live test result:** CONFIRMED-LIVE — atomic commit succeeded, verified=true, sha=2ce752b4.
- **Findings:** Brief's `audit:` commit prefix rejected (A-16). The validation is a feature, not a bug, but is an interface friction.

### `prism_patch` [Tier B]
- **Purpose:** Section-level operations (append/prepend/replace) on markdown files.
- **Schema:** `{project_slug, file, patches[{operation, section, content}]}`.
- **Output shape:** `{file, original_path?, redirected?, success, size_bytes, patches_applied[], integrity_check{clean|warnings}}`.
- **Error surface:** Individual patch failure aborts entire push; integrity check (validates balanced sections + no duplicate EOF) pre-push.
- **Side effects:** Single file commit.
- **Timeouts:** Inherited.
- **Test coverage:** implicitly via markdown-sections.ts tests.
- **Dependencies:** `utils/markdown-sections.applyPatch/validateIntegrity`, `utils/doc-resolver`, `github/client`.
- **Live test result:** CONFIRMED-LIVE — 1-op append succeeded.
- **Findings:** Known issue (per insights.md INS-36): `prism_patch(replace)` on `###` headers stacks duplicates. Documented workaround. Not re-verified live.

### `prism_search` [Tier A]
- **Purpose:** Keyword search across one project's living documents + decision domain files. Section-level scoring.
- **Schema:** `{project_slug, query, max_results?}`.
- **Output shape:** `{project, query, results_count, files_searched, sections_searched, bytes_searched, results[{file, section, score, snippet}], ms}`.
- **Error surface:** Query with zero terms ≥3 chars → error.
- **Side effects:** None.
- **Timeouts:** Inherited.
- **Test coverage:** None dedicated (indirect via summarizer/doc-resolver tests).
- **Dependencies:** `github/client.fetchFile`, `utils/doc-resolver`.
- **Live test result:** CONFIRMED-LIVE — 17 files, 201 sections, 242,086B searched in 218ms.
- **Findings:** Works. The scoring is simplistic (exact-phrase 10 pts, header-match 8, term-in-header 3, term-in-body capped at 3). No stemming, no fuzzy match. Acceptable for the scope.

### `prism_status` [Tier A]
- **Purpose:** Per-project or cross-project health summary.
- **Schema:** `{project_slug?, include_details?}`.
- **Output shape (single):** 10-field object with living-doc counts, handoff size, version, missing docs, archives map. (Multi):** summary + array of per-project objects + synthesis health block.
- **Error surface:** Individual project fetch failures are filtered (`Promise.allSettled`); partial results returned.
- **Side effects:** None.
- **Timeouts:** None enforced — can run 5-10s on 22 projects.
- **Test coverage:** No dedicated test; indirect via `banner-text`, `observability`.
- **Dependencies:** `github/client.listRepos/fetchFile`, `utils/doc-resolver.resolveDocExists/resolveDocPath`, `ai/synthesis-tracker.getSynthesisHealth`.
- **Live test result:** CONFIRMED-LIVE — 22 projects found, health breakdown correct.
- **Findings:** A-9 (perf cost).

### `prism_finalize` [Tier B]
- **Purpose:** 3-phase session finalization: audit (doc inventory + drift), draft (AI-generated files), commit (backup + validate + atomic push).
- **Schema:** `{project_slug, action: "audit"|"draft"|"commit", session_number, handoff_version?, files?, skip_synthesis?, banner_data?}`.
- **Output shape:** Per-phase; commit phase returns structured `results[]`, `living_documents_updated`, `synthesis_outcome`, `confirmation`, `finalization_banner_html`.
- **Error surface:** Commit phase requires `files` array; validation errors block push; deadline sentinels on draft (180s) and commit (90s) phases.
- **Side effects:** Commit phase backs up prior handoff, prunes to 3 backups, applies archive lifecycle for session-log.md/insights.md, atomic commit, fires background synthesis.
- **Timeouts:** Per-phase deadlines; MCP_SAFE_TIMEOUT 50s for synthesis draft.
- **Test coverage:** finalize.test, finalize-fallback, timeout-architecture — comprehensive.
- **Dependencies:** `github/client.createAtomicCommit/listDirectory/listCommits/getCommit/deleteFile/pushFile`, `utils/archive.splitForArchive`, `ai/synthesize.generateIntelligenceBrief`, `validation/*`.
- **Live test result:** audit phase CONFIRMED-LIVE (10 docs, drift detection, work products, session-end rules delivered). commit phase NOT invoked (Tier B risk; covered CONFIRMED-TEST).
- **Findings:** Design is solid; audit phase is impressively complete. Commit phase's background synthesis (fire-and-forget after successful commit, lines 678-702) is good.

### `prism_synthesize` [Tier A]
- **Purpose:** Generate or check intelligence brief.
- **Schema:** `{project_slug, mode: "generate"|"status", session_number?}`.
- **Output shape:** Mode-specific.
- **Error surface:** `generate` requires `session_number` + `SYNTHESIS_ENABLED`; errors include TIMEOUT/AUTH/API_ERROR/DISABLED codes.
- **Side effects:** `generate` writes `.prism/intelligence-brief.md`.
- **Timeouts:** `SYNTHESIS_TIMEOUT_MS` 120s.
- **Test coverage:** synthesis-alerting.test.
- **Dependencies:** `ai/client.synthesize`, `ai/synthesize.generateIntelligenceBrief`.
- **Live test result:** status CONFIRMED-LIVE — brief exists, last synthesized S45 at 04-18-26 07:21:44. generate NOT live-invoked (cost + brief's STATIC-ONLY label when env-unavailable).
- **Findings:** None in the hot path.

### `prism_scale_handoff` [Tier B]
- **Purpose:** Handoff scaling (analyze/execute/full).
- **Schema:** `{project_slug, action: "full"|"analyze"|"execute", plan?}`.
- **Output shape:** Mode-specific.
- **Error surface:** `execute` requires `plan`; 50s SAFETY_TIMEOUT_MS.
- **Side effects:** `full`/`execute` push destination files + reduced handoff.
- **Timeouts:** 50s; MCP progress notifications reset client deadline.
- **Test coverage:** scale.ts has no dedicated tests (verified `find tests -name 'scale*'` → empty).
- **Dependencies:** `github/client.pushFile`, `utils/summarizer.extractSection`, `utils/doc-resolver`.
- **Live test result:** analyze CONFIRMED-LIVE — 1 action, 15% reduction estimated. full/execute STATIC-ONLY.
- **Findings:** A-6 (non-atomic multi-file writes).

### `prism_log_decision` [Tier B]
- **Purpose:** Atomically log a decision to `_INDEX.md` + domain file with dedup guard.
- **Schema:** Full decision schema.
- **Output shape:** `{id, title, domain, status, index_updated, domain_file_updated, domain_file}`.
- **Error surface:** D-N collision → `duplicate:true` error; missing `_INDEX.md` → error.
- **Side effects:** Two commits (`_INDEX.md`, domain file).
- **Timeouts:** Inherited.
- **Test coverage:** None dedicated.
- **Dependencies:** `github/client.fetchFile/pushFile`, `utils/doc-resolver`, `utils/doc-guard.guardPushPath`.
- **Live test result:** CONFIRMED-LIVE — D-9999 created, duplicate guard verified on second attempt.
- **Findings:** A-5 (docstring claims atomicity; impl uses 2 sequential pushes).

### `prism_log_insight` [Tier B]
- **Purpose:** Log an insight with optional STANDING RULE tagging.
- **Schema:** Full insight schema including `standing_rule`/`procedure`.
- **Output shape:** `{id, title, category, standing_rule, success, size_bytes}`.
- **Error surface:** `standing_rule` without `procedure` → error. **No duplicate guard.**
- **Side effects:** One commit to `insights.md`.
- **Timeouts:** Inherited.
- **Test coverage:** None dedicated.
- **Dependencies:** `github/client.fetchFile/pushFile`, `utils/doc-resolver`, `utils/doc-guard`.
- **Live test result:** CONFIRMED-LIVE — INS-9999 created, **duplicate NOT rejected** (A-4).
- **Findings:** A-4.

### `prism_analytics` [Tier A]
- **Purpose:** 7 metrics over project data.
- **Schema:** `{project_slug?, metric?}`.
- **Output shape:** Per-metric.
- **Error surface:** Metric-specific (some require project_slug).
- **Side effects:** None.
- **Timeouts:** Inherited.
- **Test coverage:** None dedicated.
- **Dependencies:** Heavy — `github/client.*`, `utils/doc-resolver`, `utils/summarizer`, `validation/handoff.parse*`.
- **Live test result:** Per-metric: health_summary ✅, decision_velocity ✅, session_patterns ❌ (A-1), handoff_size_history partially broken (A-11), file_churn ✅, decision_graph ❌ (A-2), fresh_eyes_check ✅.
- **Findings:** A-1, A-2, A-11 are in this tool.

### `railway_logs` / `railway_deploy` / `railway_env` / `railway_status` [Tier A + Tier C]
- **Purpose:** 4-tool Railway gateway.
- **Live test results:**
  - `railway_status()` — multi CONFIRMED-LIVE (2 projects).
  - `railway_status(prism-mcp-server, include_services=true)` — CONFIRMED-LIVE.
  - `railway_logs` (default + @level:error filter) — CONFIRMED-LIVE; filter surfaced A-10.
  - `railway_deploy(list, count=3)` — CONFIRMED-LIVE; 1 SUCCESS + 2 REMOVED.
  - `railway_deploy(redeploy|restart)` — STATIC-ONLY (Tier C).
  - `railway_env(list)` — CONFIRMED-LIVE; sensitive_keys incomplete (A-8).
  - `railway_env(get, LOG_LEVEL)` — CONFIRMED-LIVE (info).
  - `railway_env(set|delete) AUDIT_TEST_VAR_S46` — CONFIRMED-LIVE; full set→get→delete→get 404 cycle verified.
- **Findings:** A-8, A-10, A-12.

### `cc_dispatch` [Tier B + Tier C]
- **Purpose:** Orchestration of Claude Code via Agent SDK.
- **Live test result:** NOT invoked (cost + brief risk budget). CONFIRMED-TEST (unit tests + historical `cc_status` records showing 10 prior dispatches, 2 execute failures from transient errors).
- **Findings:** A-14 (createPullRequest no retry), A-18 (dead `- 0` math).

### `cc_status` [Tier A]
- **Purpose:** Read dispatch records from in-memory + GitHub-backed store.
- **Live test result:** CONFIRMED-LIVE — 10 dispatches listed with `state_repo: brdonath1/prism-dispatch-state` (exposing A-3).
- **Findings:** A-3.

## Axis A deep-dives

### DD1 — Bootstrap pathway end-to-end

`prism_bootstrap` follows this order (src/tools/bootstrap.ts): (1) slug resolve via static map then dynamic listRepos fallback — two possible GitHub calls; (2) parallel fetch of handoff.md, decisions/_INDEX.md, cached behavioral rules — 2-3 github calls; (3) parse handoff → version, session count, template version, scaling_required, critical context, current state, resumption point, next steps, open questions; (4) guardrail extraction from SETTLED decisions; (5) prefetch computation (up-to-2 docs) + boot-test push in parallel; (6) parallel fetch of intelligence brief + insights.md; (7) standing rule extraction from insights; (8) banner data assembly + renderBannerText; (9) context-budget estimation; (10) result assembly.

Strengths: parallelization is real (3 major `Promise.allSettled` batches); template caching (5-min TTL) prevents re-fetching framework content; QW-4 hard-cap of 2 prefetches prevents runaway doc loading on keyword-dense messages; D-48 ME-3 correctly filters ARCHIVED/DORMANT standing rules. Weaknesses: the bytes→tokens estimator at `bootstrap.ts:528-532` uses a crude `/3.5` ratio — real tokenization for the specific content (bracketed JSON fields, emojis) is different; the `platformOverheadTokens = 5000` and `toolSchemaTokens = 2500` are hard-coded constants with no justification comment. Medium-LOW observability issue.

Live confirmation: CONFIRMED-LIVE — `prism_bootstrap("prism", "audit test")` returned v2.13.0 template, 9,657B handoff, 85 decisions, 2.13 template version, full behavioral rules, 2 prefetched docs, `banner_text` rendered (no banner_data fallback needed).

### DD2 — Finalization pathway (audit / draft / commit)

Three-phase design:

- **Audit phase** (read-only): fetches all 10 living docs via `resolveDocFiles`, checks EOF validity per filename, extracts section headers, runs drift detection by comparing current `Critical Context` + decision count against the most recent handoff-history backup, fetches last-finalize commits to identify session work products, checks handoff-backup existence. Returns a structured audit object + session-end rules fetched from framework repo (ME-4).
- **Draft phase**: Calls Opus with DRAFT_RELEVANT_DOCS (7 of 10 — excludes architecture.md, glossary.md, intelligence-brief.md + any *-archive.md). Extracts JSON robustly (line 100-119 `extractJSON`).
- **Commit phase**: Backs up current handoff (parallel with prune-to-3), validates all files, applies archive lifecycle (archive.ts.splitForArchive) for session-log/insights, creates atomic commit, fires background synthesis.

Strengths: Audit is honest and thorough. Commit phase's pruning + archive lifecycle all happen BEFORE the atomic commit, so finalize commits are single-SHA. Deadline sentinels on commit (90s) and draft (180s) phases prevent client-side timeouts. Background synthesis decouples a 60-100s operation from the 60s client timeout (D-78).

Weaknesses: Handoff backup is a separate `pushFile` BEFORE the atomic commit (line 435-448). If atomic commit fails after backup succeeds, the repo has a spurious backup file referencing a handoff version that hasn't yet shipped. Low severity (eventually consistent — next finalize overwrites).

Live confirmation: audit phase CONFIRMED-LIVE and produced correct drift detection (identified my D-9999 test injection via `new_decisions_detected:["D-9999"]`).

### DD3 — Write-path atomicity

The authoritative pattern is `createAtomicCommit` (github/client.ts:598-700): 5 sequential GitHub API calls — get ref → get commit → create tree → create commit → update ref. Guards against the S42 incident (PATCH must use plural `/git/refs/`, GET uses singular `/git/ref/`). Comment block is excellent.

Adopted by: `prism_push`, `prism_finalize(commit)`. NOT adopted by: `prism_log_decision` (A-5), `prism_scale_handoff` (A-6). These still use sequential `pushFile` for multi-file write paths, which is exactly the anti-pattern the atomic-commit pattern was introduced to prevent.

Both `prism_push` and `prism_finalize` have HEAD-SHA guard pattern: capture HEAD before atomic attempt; on failure, re-fetch; if HEAD moved, DO NOT fall back (preserves state), if unchanged, fall back to SEQUENTIAL (never parallel) pushFile. This is correct.

### DD4 — Cache behavior

Two caches in `src/utils/cache.ts`: `MemoryCache<T>` class with TTL + proactive eviction (5-minute interval, `.unref()` so process can exit). One instance exported: `templateCache` (5-min TTL) for behavioral rules template (D-31).

Plus: `github/client.ts:520-543` `defaultBranchCache` (Map, size-limited at 100 entries; clears when full — rudimentary LRU).

In a stateless server these caches are per-process; on Railway restart they cold-start. No cross-request consistency problem because the data is read-only (template) or effectively immutable (default branch).

Weakness: no cache for `listRepos()` or `fileExists` on handoff.md — each `prism_status` without `project_slug` re-walks all 22+ projects (A-9).

### DD5 — Template delivery

Framework template at `brdonath1/prism-framework:_templates/core-template-mcp.md`. Fetched via `fetchBehavioralRules()` in bootstrap.ts:137-150 with 5-min TTL cache. Embedded in bootstrap response as `behavioral_rules` string.

Cache invalidation: `prism_push` (push.ts:240-248) detects pushes to the framework template path and invalidates the cache. This means after a template update to the framework repo, the NEXT bootstrap within 5 minutes will serve the new content; existing 5-min-old entries are evicted on write.

Live confirmation: `template_version: "2.13.0"` matches the framework repo HEAD at `dc1708d` — cache hit path working.

Weakness: the 5-min TTL is a compromise between freshness and latency. For framework-version bumps that must propagate fast, operators have to either wait 5 min or manually invalidate. No admin endpoint for cache flush.

### DD6 — Intelligence / synthesis subsystem

`src/ai/synthesize.ts.generateIntelligenceBrief` → loads 9 living docs (excludes intelligence-brief.md itself) + 7 decision domain files → builds user message via `ai/prompts.buildSynthesisUserMessage` → `synthesize(SYSTEM_PROMPT, userMessage, undefined, SYNTHESIS_TIMEOUT_MS)` → validates response has 6 required sections (Project State, Standing Rules & Workflows, Active Operational Knowledge, Recent Trajectory, Risk Flags, Quality Audit) → ensures EOF sentinel → pushes `.prism/intelligence-brief.md`.

Called from: `prism_finalize(commit)` fire-and-forget background (D-78), `prism_synthesize(generate)`, potentially other refresh paths.

Strengths: observability via `recordSynthesisEvent` — synthesis-tracker.ts keeps a structured event log. Alerting on failure (the test output shows `SYNTHESIS ALERT: Intelligence brief generation failed` for 29 synthetic projects in tests — there's a backoff/alerting pattern).

Weaknesses: If the response is missing required sections, the code logs a warning and pushes anyway (synthesize.ts:104-107). The operator gets a partial brief without a loud signal. Medium L6 concern.

### DD7 — Archive / retention subsystem

`src/utils/archive.ts.splitForArchive` — pure function. Given input content + existing archive + config (threshold, retention count, entry marker regex with capture group, protected marker list, active section, mostRecentAt direction), returns `{liveContent, archiveContent, archivedCount, skipReason}`.

Applied from `finalize.ts.applyArchive` (line 517-568) with two configs:
- session-log: threshold 15KB, retention 20, `^### Session (\d+)`, most-recent-top
- insights: threshold 20KB, retention 15, `^### INS-(\d+):`, protected STANDING RULE, activeSection `## Active`, most-recent-bottom

Applied INSIDE commitPhase BEFORE the atomic commit — so live + archive changes land in a single commit.

Strengths: pure function, well-tested edge cases (I saw archive-related tests in the suite), correct handling of EOF trailer, protected markers.

Weaknesses: the prune-to-3 handoff-history behavior (finalize.ts:460-480) is BRUTAL — it means projects with 45+ sessions have only 3 handoff backups. This is destroying history that might be valuable for Axis B audits or rollback. A "retention by time" policy (keep last 30 days) or larger retention count (10) would preserve more signal at very low storage cost. Medium L5 finding (call it A-21 if you want; it's mentioned implicitly in B-findings via the sparse handoff-history observation).

### DD8 — GitHub client integration

Already analyzed in A-11/A-5/A-6 findings. Key structures: `fetchWithRetry` (429 exponential backoff + 15s per-request timeout + AbortSignal.any combining caller+timeout signals), `createAtomicCommit` (5-step tree commit with S42 URL-asymmetry guard), `getDefaultBranch` (cached), `getHeadSha` (silent-fail wrapper for atomic-commit HEAD guard).

No Octokit — by design, per CLAUDE.md. Hand-rolled but competent: correct body-cancel to avoid socket leaks (line 104, 328), correct AbortSignal propagation, clear handleApiError.

### DD9 — Railway integration

`src/railway/client.ts` — GraphQL v2 wrapper. 45s timeout (under MCP_SAFE_TIMEOUT 50s). Per-request `RailwayResolver` class caches projects + project-details by ID within a single tool invocation. Masking helpers at lines 538-594 with the A-8 concern (missing PAT pattern).

The 4 tools in `src/tools/railway-*.ts` are thin wrappers that marshal args through the resolver and call client functions.

Strengths: type-safe via GraphQL response types; clean Resolver scoping.

Weaknesses: A-8 (masking gap), A-10 (severity mislabeling surfaces through), A-12 (redeploy/restart unexercised).

### DD10 — Claude Code dispatch subsystem

`src/tools/cc-dispatch.ts` + `src/claude-code/client.ts` + `src/claude-code/repo.ts` + `src/dispatch-store.ts`.

Flow: (1) write initial "running" dispatch record via `writeDispatchRecord` (persisted to GitHub at `brdonath1/prism-dispatch-state`); (2) sync vs async branch; (3) for sync: clone repo (shallow, `--depth 1`, unique tmpdir, 60s git timeout, PAT via `https://x-access-token:{pat}@github.com/...` URL form never logged), (4) dispatch via Agent SDK with allowed_tools per mode, (5) for execute mode + success: commit on feature branch `cc-dispatch/{id}`, push, create PR; (6) cleanup tmpdir (idempotent, swallows errors); (7) persist terminal record.

Strengths: clean separation of concerns, good comments on safety (PAT never logged, unique tmpdir, cleanup idempotent). Historical `cc_status` shows 10 dispatches with 2 execute failures (transient git push errors) — the failure modes happen mostly at commit/push/PR stage, as A-14 anticipates.

Weaknesses: A-3 (docs drift), A-14 (createPullRequest no retry), A-18 (dead `- 0`). Execute mode's partial-state — PR creation failure after successful push leaves a branch orphan — is called out by a single `;`-joined error message at cc-dispatch.ts:396-399.

---

# Axis B — Behavioral-drift findings

## B-findings summary table

| ID | Severity | Lens(es) | Rule/Pattern | Title | Evidence |
|----|----------|----------|--------------|-------|----------|
| B-1 | HIGH | BL1, BL3, BL6 | Rule 9 (context-status-line) / content-drift source | alterra session-log still carries 17 prose-style context-tier phrases despite D-85 framework fix | Axis B agent sampling: `/tmp/s46-evidence/alterra-design-llc/session-log.md` lines 6,8,10-16,42,70,86,245,313,351,357,408,438 |
| B-2 | LOW | BL1 | Template evolution velocity (working-as-designed) | 5 template version bumps in 11 days, each traceable to a concrete drift incident | `git log --oneline _templates/core-template-mcp.md` in `/tmp/prism-framework/` |
| B-3 | MEDIUM | BL1, BL6 | D-84 (Rule 2 hard-structured boot) durability | D-84 shipped 2026-04-18 04:47; only 1 post-deploy boot observable in evidence; durability across future boots UNMEASURED | Axis B agent — COVERAGE-GAP |
| B-4 | MEDIUM | BL4 | Handoff trajectory (alterra) | alterra handoff hits 15KB scale threshold every ~2 sessions (S12, S14 both triggered scale_handoff); bounded but not improving | GitHub API handoff-history commits — see BDD4 |
| B-5 | HIGH (for audit tooling) | BL1 | Audit evidence architecture | Session-logs are narrative summaries, not verbatim response transcripts. BDD1/BDD2/BDD7 literal measurements COVERAGE-GAP | Cross-project observation; BDD1-BDD7 methodology sections |
| B-6 | LOW (positive) | BL5 | Decision logging hygiene | All sampled projects log decisions atomically (each D-N has its own commit); no finalize batching observed | Commit SHAs D-10 through D-26 alterra, D-72 through D-85 prism, D-135 through D-142 pf2 |
| B-7 | LOW | BL1, BL7 | Drift / self-flag correlation | Observable Claude drift events correlate with framework-level operational sessions (S43, S45), not rote execution. All 5 observed events resulted in durable INS / D commits. D-74 candor-over-agreement operating correctly. | PRISM session-log lines 17, 45, 47, 57, 90 |
| B-8 | LOW (positive at n=3) | BL9 | Cross-project convention bleed | No observable bleed in n=3 sample. Recommend sampling newly-onboarded projects for stress test. | BDD9 methodology |

## Axis B deep-dives (summary; full text at `/tmp/s46-evidence/axis-b-report.md`)

### BDD1 — Rule 9 Compliance
Per-response literal Rule 9 compliance is **UNMEASURABLE** from session-log narratives (COVERAGE-GAP). The one literal `[S13 · Ex 1 · 🟢 ~12%]` match in PRISM session-log is a quotation, not Claude's own response closer. What IS measurable: prose-style substitute contamination in alterra session-log (17 instances — see B-1).

### BDD2 — Boot Response Structure
COVERAGE-GAP. Boot responses are client-side render artifacts. Only indirect evidence: PRISM's own S45 Ex 1 self-reported 4 Rule 2 violations (trigger for D-84); alterra S13 Ex 1 compliance validation at 07:09:46 CST (narrative description only).

### BDD3 — Tool-Proactivity
Session-log grep counts: `conversation_search` 0 across all projects; `tool_search` 4 in PRISM, 0 elsewhere; `prism_search` 0 everywhere; explicit `prism_fetch` 0 everywhere. BUT Claude's verification pattern language ("fetched", "pulled", "verified via") appears 4×, 7×, 20× in prism/pf2/alterra. Alterra dominates (research-heavy workflow). Tool-proactivity is VISIBLE through indirect language even though session-logs don't cite tool names.

### BDD4 — Handoff Size Trajectory
All three projects are BOUNDED (D-80 archive lifecycle working). PRISM oscillates 4-17KB with scale resets. PF2 stays 4-9KB (never exceeded threshold). Alterra hovers 10-17KB requiring periodic scaling (scale_handoff at S12, S14). See B-4.

### BDD5 — Decision Logging Pattern
Each D-N in all three projects has its own atomic commit via `prism_log_decision` (not batched at finalize). B-6 positive.

### BDD6 — Instruction-Saturation Correlation
alterra (highest instruction load: 68KB handoff+insights vs ~44KB PRISM, ~44KB PF2) is the project where drift was documented. But n=3 is too small for correlation. HYPOTHESIS PLAUSIBLE BUT UNPROVEN.

### BDD7 — Operator-Frustration Signal
Literal phrases ("you should have", "why didn't you", "I already told you") return 0 across all 3 projects — operator messages are not captured verbatim. What IS captured: Claude's self-reported friction ("pushback", "challenged", "caught"). 5 observable drift events in PRISM across S25-S45, all in S43 and S45 (framework-level sessions). 0 in PF2 (code work). 0 in alterra (research). See B-7.

### BDD8 — Template-Rule Evolution
5 version bumps in 11 days with issue-specific commit messages. D-83 and D-85 show positive observable effects. D-84 UNMEASURED (B-3). See B-2.

### BDD9 — Cross-Project Convention Bleed
No observable bleed in n=3. Legitimate PRISM meta-framework cross-references only. See B-8.

## Full B-findings

### B-1: alterra session-log still carries prose-pattern source despite D-85 framework fix
- **Severity:** HIGH
- **Lens(es):** BL1, BL3, BL6
- **Rule/Pattern:** Rule 9 (context-status-line format) + content-drift mechanism
- **Evidence:** 17 prose-style context-tier phrases in `/tmp/s46-evidence/alterra-design-llc/session-log.md` (exact lines listed in axis-b-report.md BDD1). D-85 hardened the framework template + added INS-30 + prepended handoff Critical Context reinforcement, but did NOT scrub the session-log narrative that Claude re-reads at every boot. The PRISM S45 Candor note (handoff line 52) explicitly flagged this as "deferred on scope discipline" and carried to S46.
- **Trend:** Improving (handoff.md is now clean) but session-log still dirty. Without scrub, next alterra boot consumes the pattern source again.
- **Scope:** alterra-design-llc only.
- **Recommended Category:** Framework operational hygiene (project-specific cleanup); OR operator-training (teach Claude to flag these as writing-style anti-patterns at finalize-time).
- **Impact × Effort:** Medium × Low.

### B-2: Template velocity (positive observation)
- **Severity:** LOW
- **Lens(es):** BL1
- **Evidence:** 5 template version bumps in 11 days (v2.9.0 → v2.13.0). Each bump traces to a documented drift incident with atomic D-N commit.
- **Trend:** Active. S45 alone shipped 2 bumps.
- **Scope:** Framework-wide (propagates via 5-min D-31 cache).
- **Recommended Category:** Working-as-designed.
- **Impact × Effort:** N/A.

### B-3: D-84 durability unmeasured
- **Severity:** MEDIUM
- **Lens(es):** BL1, BL6
- **Evidence:** v2.12.0 shipped 2026-04-18 04:47; only 1-2 observable boots afterward within D-31 cache TTL window (ambiguous whether v2.11.0 or v2.12.0 was delivered).
- **Trend:** UNKNOWN.
- **Scope:** Framework-wide.
- **Recommended Category:** Observational (watch only) — need S46+ evidence.
- **Impact × Effort:** Low effort (wait + sample 5 boots); High impact if drift appears.

### B-4: alterra handoff proximity to 15KB threshold
- **Severity:** MEDIUM
- **Lens(es):** BL4
- **Evidence:** scale_handoff commits `e6e890ce` (S12) and `f5670737` (S14). Finalize lands 11-17KB; scale brings to 9-12KB; next 1-2 sessions push back up.
- **Trend:** STABLE (bounded) but not trending down.
- **Scope:** alterra only.
- **Recommended Category:** Project-specific — consider tighter scale trigger for content-dense projects (e.g., 10KB threshold for research-heavy projects).
- **Impact × Effort:** Medium × Medium.

### B-5: Session-log is a lossy audit substrate
- **Severity:** HIGH (for audit tooling); LOW for operations
- **Lens(es):** BL1
- **Evidence:** BDD1 / BDD2 / BDD7 literal phrase counting all hit COVERAGE-GAP. Session-logs are ~26KB-66KB of narrative summarizing hundreds of responses that went uncaptured.
- **Trend:** STABLE (architecture, not drift).
- **Scope:** Framework-wide audit concern.
- **Recommended Category:** Audit tooling gap — framework-architectural-change. Proposal: client-side proxy emits per-response behavioral summary to `.prism/audit-trail.md`.
- **Impact × Effort:** High × Medium.

### B-6: Decision logging discipline clean (positive)
- **Severity:** LOW
- **Evidence:** Each D-N has its own atomic commit. D-45 server-side atomic logging working as designed.
- **Trend:** STABLE.
- **Scope:** All sampled projects.

### B-7: Observable drift correlates with framework sessions
- **Severity:** LOW
- **Lens(es):** BL1, BL7
- **Evidence:** 5 drift events in PRISM S43+S45 (both framework architecture sessions). 0 in PF2 (code work) / alterra (research). All 5 resulted in durable INS/D commits. D-74 candor-over-agreement operating correctly.
- **Trend:** STABLE.
- **Scope:** PRISM only.

### B-8: No cross-project bleed at n=3 (positive)
- **Severity:** LOW
- **Evidence:** Session-log grep for cross-project references returned only legitimate meta-framework references or tool-name references.
- **Trend:** STABLE at n=3.
- **Scope:** Limited by sample size.

## Cross-Axis Findings (X-N)

### X-1: Prose-pattern contamination (B-1) + lack of sanitization tool
- **Severity:** MEDIUM
- **Axis-A component:** No `prism_scrub_narrative` tool or equivalent to apply framework-level style rules to existing project narratives. `prism_patch` could be used but requires per-section surgery.
- **Axis-B component:** alterra session-log continues to seed the drift pattern (B-1).
- **Evidence (A side):** `src/tools/*` — no tool provides a "apply style corrections across narrative" primitive.
- **Evidence (B side):** 17 prose-tier phrases persist.
- **Recommended Category:** Code-change + rule-change combined. Either build a scrub tool or extend finalize.ts to emit a post-commit warning when the pushed session-log contains blacklisted prose-tier phrases.

### X-2: Analytics `session_patterns` brokenness (A-1) + Axis B handoff size visibility gap (B-4)
- **Severity:** MEDIUM
- **Axis-A:** `session_patterns` returns wrong numbers (A-1) making it unusable for cadence analysis.
- **Axis-B:** Operators use cadence intuition instead; alterra's rapid scaling cadence (B-4) might not be surfacing to operator attention because the tool that should report it is broken.
- **Evidence:** A-1 live output + B-4 trajectory data.
- **Recommended Category:** Fix A-1 first; then re-run Axis B cadence analysis via the tool, confirm alterra's B-4 pattern surfaces at operator-visible layer.

## Lens Coverage

### Axis A lenses (L1-L7)

| Lens | Findings | Justification if zero |
|------|----------|-----------------------|
| L1 Correctness | A-1 (session_patterns), A-2 (decision_graph), A-4 (log_insight dedup), A-5 (log_decision atomicity), A-11 (size_history trend), A-16 (commit prefix), A-20 (filename dates) | — |
| L2 Performance | A-9 (status multi-project) | — |
| L3 Reliability | A-5, A-6, A-14 | — |
| L4 Security | A-8 (PAT pattern), A-13 (env parser), A-19 (token length) | — |
| L5 Maintainability | A-3 (doc/code mismatch), A-7 (project count), A-15 (deprecated func), A-17 (dead var), A-18 (dead math) | — |
| L6 Observability | A-10 (log severity), A-12 (unexercised mutations) | — |
| L7 Testability | — | No L7-specific findings beyond the observation embedded in A-12 (unexercised mutations). Test suite is comprehensive at 578 tests; testability per se is healthy. |

### Axis B lenses (BL1-BL9)

| Lens | Findings | Justification if zero |
|------|----------|-----------------------|
| BL1 Rule adherence | B-1, B-2, B-3, B-5, B-7 | — |
| BL2 Tool proactivity | — | BDD3 produced low tool-name counts but high indirect-verification language; within norm. |
| BL3 Within-session drift | B-1 | — |
| BL4 Handoff trajectory | B-4 | — |
| BL5 Logging hygiene | B-6 | — |
| BL6 Context-management accuracy | B-1, B-3 | — |
| BL7 Candor/pushback | B-7 | — |
| BL8 Memory discipline | — | BDD3 showed no "I remember" / "I recall" patterns — Claude verifies rather than relies on memory. |
| BL9 Cross-project convention bleed | B-8 | — |

## Out-of-Scope Observations

- Many of the 22 detected "critical" projects (10 of 22) have exactly 4 living documents — the minimum that passes an initial bootstrap. These appear to be stub projects that were created via onboarding but never developed. Operator might want a tool that lists stub projects and their last-activity date to decide whether to archive them.
- `brdgpt`, `dans-bagels-platform`, `metaswarm-autonomous-coding-stack`, `productivity-autonomous-agent-stack` are all `healthy` with very low session counts — some may be genuinely dormant.
- PRISM's own health shows 22 projects; `prism-mcp-server` (this repo) is at `needs-attention` with only 8 of 10 living documents. The repo itself is missing 2 docs per its own health check. Out of scope to identify which.

## Prioritized Recommendations

**Immediate (high impact, low effort):**
1. Fix A-1 (rewrite `session_patterns` and `decision_graph`). Both are high-visibility, user-facing analytics bugs with localized fixes. Add Tier-A regression tests.
2. Fix A-3 (CLAUDE.md dispatch-state repo name).
3. Fix A-4 (add dedup guard to `prism_log_insight`; mirror log-decision pattern).
4. Fix A-8 (add `/\bPAT\b/i` to sensitive patterns).
5. Fix A-11 (sort handoff_size_history by parsed version number).
6. Scrub alterra session-log prose-pattern phrases (B-1). 17 find/replace operations or one `prism_patch(replace)` sweep.

**Next wave (medium effort):**
7. A-5 (`prism_log_decision` atomic-commit-ify).
8. A-6 (`prism_scale_handoff` atomic-commit-ify).
9. A-9 (cache `listRepos()` + handoff-existence probes in `prism_status`).
10. A-10 (demote stdio-bridge INFO messages in `railway_logs`).

**Long-term (framework architectural):**
11. B-5 root cause: instrument per-response behavioral summaries. Without this, Axis B can't be done at response granularity; any future "is Claude drifting?" question hits the same wall as S46 did. The proposal in axis-b-report.md is a reasonable starting point — a thin `.prism/audit-trail.md` append at finalize-time or per-response.
12. A-12 (schema introspection at server boot for Railway mutation drift).

**Watch-only:**
13. B-3 D-84 durability — sample 5 boots on mixed projects over the next week.
14. B-4 alterra cadence — if scale_handoff is triggering more than every 2 sessions, reopen.
15. A-7 project count drift — probably not worth fixing in CLAUDE.md; remove the count.

**If B-5 cannot be addressed at all**, the framework-improvement team should know: the Axis A code improvements above will make the server more correct, but Axis B drift (the operator's original concern from S43/S45) CANNOT be mechanically tracked from current evidence. That means behavioral consistency depends on the framework template being perfect on first delivery — the D-84/D-85 style "add more guardrails to the rule text" is the only feedback path. This increases the importance of each template bump being evidence-driven (B-2) rather than speculative.

## Open Questions

1. Is the operator aware of A-1's `session_patterns` / `decision_graph` brokenness? (The user-memory mentions "two known analytics bugs" — are these them, and is there a reason they haven't been fixed?)
2. What is the intent of `CC_DISPATCH_EFFORT = "max"` default (config.ts:276)? Every sync dispatch runs at max reasoning. This is expensive. Was it meant as an opt-in?
3. Is the 22-project vs 17-claimed count reflective of 5 stub/abandoned projects, or active work? 10 projects at `critical` with 4 docs present is a symptom.
4. Intent for handoff-history retention: finalize prunes to 3. Would retention of 10 be acceptable? It's ~30-50KB per project for the benefit of a richer audit trail (Axis B BDD4 would have more datapoints).
5. Is `cc_dispatch(execute)` considered operationally ready? The 2 execute failures in historical records were both transient network errors, not tool bugs. OK to live-test next audit?

## Appendix A — File Inventory

```
src/:          48 *.ts files, 12,099 LOC
tests/:        48 *.test.ts files, 578 tests passing
configs:       package.json (v4.0.0), tsconfig.json, vitest.config.ts, .github/workflows/ci.yml
deps:          @modelcontextprotocol/sdk ^1.28.0, @anthropic-ai/sdk ^0.81.0,
               @anthropic-ai/claude-agent-sdk ^0.2.101, express ^5.1.0, zod ^4.0.0
build:         tsc → dist/ (clean, no errors)
test runtime:  ~2.04s
```

Key file sizes (src): most tools 100-300 lines. `src/tools/scale.ts` is the largest at 1217 lines (handoff scaling state machine). `src/tools/finalize.ts` 1164 lines. `src/tools/bootstrap.ts` 625 lines. `src/github/client.ts` 700 lines. `src/railway/client.ts` 594 lines. `src/utils/archive.ts` 300 lines.

## Appendix B — Git Log Samples

### Last 20 commits on `prism-mcp-server:main` (from `/tmp/s46-evidence/preflight/mcp-git-log.txt`)

```
d172ce6 2026-04-18 07:48:46 -0700 docs: correct branch model for prism-mcp-server (main + feature branch, not staging)
c05c939 2026-04-18 07:36:35 -0700 docs: rewrite brief with two-axis framing (codebase + behavioral)
3906766 2026-04-18 07:26:50 -0700 docs: set Desktop/development as primary env search root per operator layout
ce96bda 2026-04-18 06:24:58 -0700 docs: fix duplicate Step 2 header from prism_patch replace
77dc5ce 2026-04-18 06:20:26 -0700 prism: patch briefs/s46-framework-audit.md (1 ops)
... [15 more]
```

### Last 10 commits on `prism-framework:main`

```
dc1708d 2026-04-18 05:02:16 -0700 docs: core-template v2.12.0 → v2.13.0 — D-85 Rule 9 prominence boost
5daef97 2026-04-18 04:47:43 -0700 docs: core-template v2.11.0 → v2.12.0 + rules-session-end — D-84 hard-structured boot + finalization response templates
26a49c8 2026-04-18 04:28:36 -0700 docs: banner-spec.md v2.0 → v3.0 (ME-1 + D-83 alignment)
... [7 more]
```

### Tier B audit-trail commits on `prism:main`

```
ef25993  2026-04-18T15:01:11Z  chore: s46 audit restore .prism/insights.md
074e041  2026-04-18T15:01:10Z  chore: s46 audit restore .prism/decisions/architecture.md
b4f054e  2026-04-18T15:01:09Z  chore: s46 audit restore .prism/decisions/_INDEX.md
c2736f7  2026-04-18T15:00:53Z  chore: s46 audit test-artifact cleanup
04a838b  2026-04-18T15:00:05Z  prism: INS-9999 S46 Audit Duplicate Insight Test
e59e99e  2026-04-18T14:59:59Z  prism: INS-9999 S46 Audit Test Insight
cd7e96e  2026-04-18T14:59:50Z  prism: D-9999 full entry
2447ebe  2026-04-18T14:59:49Z  prism: D-9999 S46 Audit Test Decision
```

(Plus 2 ambient `prism: handoff-backup v51` + `chore: prune old handoff backup` commits at 15:01:10Z — origin unclear, not from this audit's tool calls; see Tier B section.)

Also: original test-artifact create commit `2ce752b` (2026-04-18T14:59:22Z), patch commit (unnamed, same path).

## Appendix C — Tier B Restoration Ledger

| Test | File | Pre-SHA | Post-invoke-SHA | Post-restore-SHA | Byte-identical? |
|------|------|---------|------------------|-------------------|-----------------|
| prism_push | test-artifacts/s46-push-1712999999.md | n/a (new) | 2ce752b488a71bc321501e422e92f91b709f2457 | deleted (404) | ✅ file does not exist post-restore |
| prism_patch | test-artifacts/s46-push-1712999999.md | 2ce752b4… | unnamed (via patch) | deleted | ✅ |
| prism_log_decision | .prism/decisions/_INDEX.md | f36fb8ae133d26e4606740938b8f6142c7936bf7 | (updated mid-test) | f36fb8ae133d26e4606740938b8f6142c7936bf7 | ✅ |
| prism_log_decision | .prism/decisions/architecture.md | b9028829c431344f18500b26d9f490e0f604e88a | (updated mid-test) | b9028829c431344f18500b26d9f490e0f604e88a | ✅ |
| prism_log_insight (call 1) | .prism/insights.md | 71ee7e2dbc2be184566ac45dade6f2e06ac4ebf7 | (updated mid-test) | — | (continued) |
| prism_log_insight (call 2, duplicate) | .prism/insights.md | (post-call-1) | (updated mid-test) | 71ee7e2dbc2be184566ac45dade6f2e06ac4ebf7 | ✅ |
| prism_scale_handoff(analyze) | — | — | — | — | ✅ read-only |
| prism_finalize(audit) | — | — | — | — | ✅ read-only |
| railway_env(set+get+delete) | N/A (Railway var) | absent | value=test (get confirmed) | absent (get 404) | ✅ |

**Verdict:** 0 failed restorations; 7 tests verified byte-identical. Tier B DID NOT ABORT.

## Appendix D — Axis B Sample Inventory

| Project | handoff.md size | session-log size | insights.md size | decisions | handoff-history versions retained | Sessions examined |
|---------|----------------:|------------------:|------------------:|----------:|-----------------------------------:|-------------------:|
| prism | 9,731 B | 26,217 B | 44,287 B | 85 | 5 (v7, v8, v9, v49, v50) + .gitkeep | 21 (S25-S45 in log; S1-S24 in archive) |
| platformforge-v2 | 9,117 B | 29,765 B | 34,804 B | 63 table rows (header claims 94) | 4 (v97, v98, v99, v191) | 16 visible in log (S157-S172 approx) |
| alterra-design-llc | 10,689 B | 66,614 B | 57,723 B | 26 | 6 (v4, v5×2, v8, v14, v15) + .gitkeep | 15 (S1-S15) |

Approximate tool-call counts visible in session-log narratives (grep, not authoritative — see B-5): prism mentions ~5 `prism_*` literally; PF2 ~4; alterra ~20. These are NARRATIVE mentions, not actual tool-call counts (which are not stored).

Handoff-history versions inventoried by listing `.prism/handoff-history/` via GitHub API at audit time.

## Appendix E — Axis B Raw Measurements

### BDD1 Rule 9 literal context-status-line counts (grep, session-log.md)

| Project | Literal `[S{N} · Ex {M} · {emoji} ~{percent}%]` | Prose-style substitute ("at ~XX%", "at 🟡 tier") |
|---------|:-:|:-:|
| prism | 1 (quotation of alterra S13 validation, not PRISM's own closer) | 4 (all in S45 Thread-3 narrative quoting the BAN LIST) |
| platformforge-v2 | 0 | 0 |
| alterra-design-llc | 0 | **17** (see B-1) |

### BDD3 tool-name grep counts

| Literal | prism | pf-v2 | alterra |
|---------|:-:|:-:|:-:|
| conversation_search | 0 | 0 | 0 |
| tool_search | 4 | 0 | 0 |
| prism_search | 0 | 0 | 0 |
| prism_fetch | 0 | 0 | 0 |
| recent_chats | 0 | 0 | 0 |
| summary_mode | 0 | 0 | 0 |
| `prism_*` generic | 5 | 4 | 20 |
| verification language ("fetched", "pulled", "verified", "re-read") | 4 | 7 | 20 |

### BDD4 handoff size trajectory (last 15 finalize commits per project)

See full table in `/tmp/s46-evidence/axis-b-report.md` BDD4 section. Summary: PRISM oscillates 4-17KB with scale resets; PF2 clusters 4-9KB (no threshold breach in 20 recent commits); alterra clusters 10-17KB with scale_handoff at S12 and S14.

### BDD5 decision-commit atomicity

Each D-N in sampled projects has its own `prism: D-N Title` or `docs: log D-N` commit on `.prism/decisions/_INDEX.md`. No observable batching in finalize commits.

### BDD6 instruction-load proxy

| Project | handoff+insights bytes | framework rules bytes | Standing rules count |
|---------|:-:|:-:|:-:|
| prism | 54,018 | 17,334 | 33 |
| platformforge-v2 | 43,921 | 17,334 | 19 |
| alterra-design-llc | 68,412 | 17,334 | 12 (per unique-entry count) |

### BDD7 operator-frustration literal phrase counts

All 0 in session-logs for: "you should have", "why didn't you", "already told you", "you're not", "stop doing" across all 3 projects. `wrong` non-zero in PF2 (7) + alterra (4) but all are code-review / fact-correction contexts, not Claude drift.

Observable Claude drift events (via self-flagging "pushback" / "challenged" / "caught"): prism=5 (all S43+S45), pf2=0, alterra=0.

### BDD9 cross-project convention bleed counts

All 0 or legitimate meta-framework references. No evidence of convention bleed at n=3.

<!-- EOF: s46-framework-audit.md -->
