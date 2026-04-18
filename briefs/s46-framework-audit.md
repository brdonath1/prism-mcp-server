# Brief S46 — PRISM Two-Axis Audit: Codebase Health + Claude Behavioral Drift

## Metadata

- **Brief ID:** s46-framework-audit
- **Type:** DUAL-AXIS AUDIT + LIVE-TOOL-TEST (no source changes; test artifacts reversed)
- **Primary repo:** `prism-mcp-server` (uses `main` directly — no staging branch)
- **Reference repo:** `prism-framework` (clone read-only into `/tmp/prism-framework`)
- **Work branch:** `audit/s46-framework-audit` (created from `main`, PR back to `main` at end)
- **Model:** Opus 4.7, effort `max`
- **Deliverable:** Single file — `reports/s46-framework-audit.md` in `prism-mcp-server`
- **Deadline:** Hard cap 210 minutes wall-clock. Ship partial report with explicit COVERAGE-GAP markers rather than abandoning.
- **Test target project:** `brdonath1/prism` (live Tier B tests use this with dedicated test-artifact paths)
- **Known local layout:** operator keeps all three repos under `~/Desktop/development/` (prism-mcp-server, prism-framework, platformforge-v2)

## Two-axis framing (READ FIRST — governs every downstream choice)

This audit answers two distinct questions that require different evidence and different reading postures. Keep them separate at every stage of the investigation. Findings are tagged by axis.

### Axis A — Codebase health (fresh-eyes code review)
*Question:* Is the code, tests, schemas, and template content correct, efficient, reliable, secure, maintainable, observable, and testable? If a new engineer joined today, what would they find?

*Evidence:* source code, tests, configs, framework template content, self-description docs (verified against code), live tool invocations against production.

*Posture:* **fresh-eyes.** No historical authority. Do not read `decisions/`, `insights.md`, `session-log.md`, `briefs/`, or `reports/` as primary evidence for Axis A findings.

*Finding prefix:* `A-N`

### Axis B — Claude behavioral drift (session archaeology)
*Question:* Is Claude — the AI consumer of this framework — using the framework as designed? Are behavioral rules being followed? Are tools being used proactively when available? Has instruction-following degraded over time? Has the framework's design intent been eroded by Claude-side drift rather than code-side drift?

*Evidence:* `session-log.md` across projects, `handoff.md` version history in `handoff-history/`, `decisions/_INDEX.md` temporal pattern, `insights.md` growth, banner samples from recent sessions, tool-call frequencies derived from session logs.

*Posture:* **session-aware.** History IS the primary evidence. The files that are priming-risk for Axis A are primary sources for Axis B. There is no tension — the two axes read the same project's files with different questions.

*Finding prefix:* `B-N`

### Cross-axis synthesis
Some findings span both axes: a template rule that doesn't work because Claude ignores it (axis A says template is fine, axis B says adherence is poor), a code feature that exists but is never invoked by Claude (axis A says code is correct, axis B says code is dead in practice). Tag these `X-N` and state both axes in the finding body.

### Why this matters

PRISM's perceived degradation could be rooted in either axis or both. Sessions S43 and S45 showed that operator-perceived issues were Claude-side (tool-search narrowing, banner inconsistency, Rule 9 compliance), not server-side. A codebase-only audit would miss those. Equally, pure behavioral archaeology would miss server-code regressions. Both axes must be covered.

## Hard Rules (operational — violations abort the task)

1. **AUDIT ONLY on source.** You MAY create `reports/s46-framework-audit.md`. You MAY NOT modify source code, tests, configs, or documentation. No fixes.
2. **Live test artifacts must be reversed to byte-identical pre-state.** For every Tier B tool, capture pre-state, invoke, then restore. Verify restoration with SHA comparison. A failed restoration aborts further Tier B testing.
3. **Work on branch `audit/s46-framework-audit`.** Create from `main`. Do NOT commit to `main` directly. The branch is disposable — its sole purpose is carrying the report commit into a PR.
4. **Exactly one commit on the work branch.** The commit adds only `reports/s46-framework-audit.md`. Run `git status` before commit; unstage any other files.
5. **Test artifacts in `brdonath1/prism`.** Live Tier B tests produce transient commits on the prism project's `main`; restoration pushes a second commit. End state: file content byte-identical; commit log shows two extra audit-trail commits. Prefix `audit: s46 test-artifact` + tool name.
6. **Evidence requirement.** Every finding needs concrete evidence: `file:line`, `grep -c` command with match count, test name with pass/fail, captured command output, or explicit sample reference (e.g., `session-log.md S44 Ex 7`). No speculation.
7. **Live-verification labeling.** Runtime-behavior claims labeled `CONFIRMED-LIVE`, `CONFIRMED-TEST`, or `STATIC-ONLY`.
8. **HTTP routing claims.** Come from test inspection (mocked-fetch) OR live curl. Never `grep` alone.
9. **Zero-result discipline.** Before concluding a filter/query is broken on zero results, verify the target class exists in the input.
10. **Severity calibration.** Strict. Don't amplify. Don't minimize.
11. **Single push directive.** Push the work branch exactly once at the end. No interim pushes.
12. **PR at end (mandatory).** Base `main`, head `audit/s46-framework-audit`. PR body contains the report's Executive Summary verbatim.
13. **No fix code inside findings.** End each finding at a fix *category*, not a diff.
14. **Brittle-restore honesty.** Restoration failure = CRITICAL finding + STOP Tier B.
15. **No destructive production calls.** `cc_dispatch(execute)`, `railway_deploy(redeploy|restart)` are Tier C — never live-invoked.
16. **Axis tagging.** Every finding starts with `A-`, `B-`, or `X-`. No untagged findings.

## Pre-Flight

### Step 1 — Environment baseline + branch setup

```bash
node --version
npm --version
git rev-parse HEAD
git log -1 --format='%ci %s'
git status
git branch --show-current                     # should be main
git fetch origin
git checkout -b audit/s46-framework-audit main # create and switch to work branch
git branch --show-current                     # verify on audit/s46-framework-audit
npm ci 2>&1 | tail -5
npm run build 2>&1 | tail -20
npm test 2>&1 | tail -30
find src -type f -name '*.ts' | wc -l
find tests -type f -name '*.test.ts' | wc -l
find src -type f -name '*.ts' -exec wc -l {} + | tail -1
cat package.json
ls -la .github/workflows/ 2>/dev/null
```

Build fails → STOP with CRITICAL. Test counts captured exactly.

### Step 2 — Env loader (multi-repo discovery)

API keys are distributed across the operator's local clones under `~/Desktop/development/`. Source every env file found; later sources overlay earlier.

```bash
SEARCH_ROOTS=(
  "$HOME/Desktop/development"
  "$(dirname "$(pwd)")"
  "$(dirname "$(dirname "$(pwd)")")"
  "$HOME"
  "$HOME/Desktop"
  "$HOME/Documents"
  "$HOME/projects"
  "$HOME/code"
  "$HOME/dev"
)
REPOS=("platformforge-v2" "prism-mcp-server" "prism-framework")
ENV_NAMES=(".env.local" ".env")

echo "=== Env file discovery ==="
LOADED=()
SEEN=()
for root in "${SEARCH_ROOTS[@]}"; do
  for repo in "${REPOS[@]}"; do
    for env in "${ENV_NAMES[@]}"; do
      candidate="$root/$repo/$env"
      if [ -f "$candidate" ]; then
        canonical=$(readlink -f "$candidate" 2>/dev/null || echo "$candidate")
        already=false
        for s in "${SEEN[@]}"; do [ "$s" = "$canonical" ] && already=true; done
        if [ "$already" = false ]; then
          SEEN+=("$canonical"); echo "Found: $canonical"
          set -a
          source "$canonical" 2>/dev/null && LOADED+=("$canonical") || echo "  WARN: parse failed"
          set +a
        fi
      fi
    done
  done
done

echo ""
echo "=== Loaded env files (${#LOADED[@]}) ==="
printf '%s\n' "${LOADED[@]}"

echo ""
echo "=== ENV CHECK ==="
for var in GITHUB_PAT GITHUB_OWNER FRAMEWORK_REPO ANTHROPIC_API_KEY MCP_AUTH_TOKEN RAILWAY_API_TOKEN; do
  if [ -z "${!var}" ]; then echo "MISSING: $var"
  else val="${!var}"; [ ${#val} -ge 8 ] && echo "OK: $var (${val:0:4}…${val: -4})" || echo "OK: $var (short)"
  fi
done
```

Handling missing vars:
- `GITHUB_PAT` or `GITHUB_OWNER` missing → STOP, top-severity Pre-Flight finding.
- `ANTHROPIC_API_KEY` missing → skip `prism_synthesize(generate)` live test + `prism_finalize(commit)` synthesis path. Label `STATIC-ONLY (env-unavailable)`.
- `RAILWAY_API_TOKEN` missing → skip all 4 Railway live invocations.
- `MCP_AUTH_TOKEN` missing → does not block direct-handler testing.

### Step 3 — Reference clone

```bash
cd /tmp && git clone https://$GITHUB_PAT@github.com/brdonath1/prism-framework.git
cd prism-framework && git rev-parse HEAD && git log -5 --format='%ci %s'
cd -
```

### Step 4 — Liveness probe

```bash
curl -s -w '\nHTTP %{http_code} | %{time_total}s\n' https://prism-mcp-server-production.up.railway.app/health
```

### Step 5 — Tier B pre-state snapshot (Axis A preparation)

```bash
curl -s -H "Authorization: token $GITHUB_PAT" \
  "https://api.github.com/repos/brdonath1/prism/git/trees/main?recursive=1" \
  | jq '.tree[] | select(.path | startswith(".prism/")) | {path, sha}' \
  > /tmp/prism-prestate.json
wc -l /tmp/prism-prestate.json
```

### Step 6 — Axis B sample project inventory

Fetch session-log and handoff-history metadata for the three sample projects. These are Axis B's primary evidence source.

```bash
for PROJ in prism platformforge-v2 alterra-design-llc; do
  echo "=== $PROJ ==="
  curl -s -H "Authorization: token $GITHUB_PAT" \
    "https://api.github.com/repos/brdonath1/$PROJ/git/trees/main?recursive=1" \
    | jq -r '.tree[] | select(.path | startswith(".prism/")) | "\(.path)\t\(.size // "dir")"' \
    | head -30
  echo ""
done
```

Store each project's `.prism/handoff.md`, `.prism/session-log.md`, `.prism/decisions/_INDEX.md`, and recent `handoff-history/handoff_v*.md` files (last 5 per project) for Axis B pattern analysis.

---

# Axis A — Codebase fresh-eyes review

## Axis A posture

Approach this codebase as an engineer who has never seen it before.

- **No historical authority.** Prior decisions, briefs, reports, insights describe *intent*, not correctness. A thing that was intentional can still be wrong, slow, unnecessary, or better solved differently.
- **No subsystem sanctity.** You are allowed to conclude a subsystem is unnecessary, misaligned, or should be restructured.
- **No evidence-bar asymmetry.** Contradicting a prior decision carries the same evidence bar as confirming one.
- **No operator premise acceptance.** The request was triggered by a perception of degradation. You have no obligation to confirm or refute.
- **Documents ≠ system.** Self-descriptions can be wrong, outdated, or aspirational. Source code + tests + live behavior are ground truth.

## Axis A reading list

### Read as code (ground truth)
- `src/**/*.ts` — all source. Start with `src/index.ts`.
- `tests/**/*.test.ts` — all tests. Run (`npm test`) and read.
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/*.yml`, `railway.json`, `Dockerfile`, `Procfile`, `.env.example`.

### Read as runtime inputs (evaluate as system components)
- `prism-framework/_templates/**/*.md`
- `prism-framework/_templates/reference/**/*.md`
- `prism-framework/_templates/modules/**/*.md`

### Read as self-descriptions (verify against code)
- `prism-mcp-server/.prism/architecture.md`
- `prism-mcp-server/.prism/known-issues.md` (full)
- `prism-mcp-server/.prism/handoff.md`
- `prism-mcp-server/README.md`
- `prism-mcp-server/CLAUDE.md`

### NOT in Axis A mandatory reading (priming risk; revisit in Axis B)
- `prism-mcp-server/briefs/*`
- `prism-mcp-server/reports/*`
- `prism-mcp-server/.prism/decisions/**`
- `prism-mcp-server/.prism/insights.md`
- `prism-mcp-server/.prism/eliminated.md`
- `prism-mcp-server/.prism/session-log.md`

For Axis A, skim a specific entry ONLY if a finding needs disambiguation; note it in the evidence list.

## Axis A lenses (every A-N finding maps to ≥ 1 lens)

- **L1 Correctness** — spec ↔ implementation, edge cases, type mismatches, races
- **L2 Performance** — hot-path work, serial-vs-parallel, caches, N-scaling, payload boundedness
- **L3 Reliability** — timeouts, retries, error paths, partial-failure, atomicity claims vs implementation
- **L4 Security** — secret handling, input validation, auth enforcement, injection surfaces, masking
- **L5 Maintainability** — legibility, duplication, naming, dead code, abstractions earning their cost
- **L6 Observability** — structured logs, actionable errors, correlation IDs, metrics, /health depth
- **L7 Testability** — transport mocking, URL+method assertions, E2E coverage, flakiness, error-path coverage

## Axis A cross-cutting deep-dives

- **DD1** Bootstrap pathway end-to-end
- **DD2** Finalization pathway (audit/draft/commit)
- **DD3** Write-path atomicity
- **DD4** Cache behavior (template, name-resolution, memoization)
- **DD5** Template delivery (framework files → load → cache → serve)
- **DD6** Intelligence / synthesis subsystem
- **DD7** Archive / retention subsystem
- **DD8** GitHub client integration
- **DD9** Railway integration
- **DD10** Claude Code dispatch subsystem

## Axis A live tool testing (three tiers)

CC imports handlers from `dist/` (after `npm run build`) and invokes them directly, bypassing MCP transport (transport covered in DD5/DD8 via code + test review).

### Tier A — Safe live probes (read-only or idempotent)

Invoke each with minimal valid arguments. Capture request, response, latency, errors.

```
prism_bootstrap("prism", "audit test")      # writes boot-test.md (idempotent, not restored)
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
cc_status()                                 # list mode
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

Protocol per test:
1. **Pre-snapshot** mutable files (SHA + content) → `/tmp/s46-prestate-<tool>/`
2. **Invoke** with test-scoped args
3. **Capture** request / response / latency
4. **Restore** via `prism_push` (no skip_validation); delete created files via GitHub API
5. **Verify** re-fetch, SHA-compare — MUST be byte-identical; mismatch → CRITICAL + STOP
6. **Record** in Appendix C

Test-scoped invocations:

| Tool | Invocation | Mutable files |
|---|---|---|
| `prism_push` | to `test-artifacts/s46-push-<ts>.md` | new file (delete) |
| `prism_patch` | against `test-artifacts/s46-patch-<ts>.md` (create, patch, delete) | test file |
| `prism_log_decision` | `D-9999` domain=`test` | `.prism/decisions/_INDEX.md` + `.prism/decisions/test.md` |
| `prism_log_insight` | `INS-9999` category=`test` standing_rule=false | `.prism/insights.md` |
| `prism_scale_handoff` | `analyze` then `full` | 5–10 `.prism/*.md` + `handoff.md` |
| `prism_synthesize(generate)` | `mode=generate, session_number=46` | `.prism/intelligence-brief.md` |
| `prism_finalize(audit)` | read-only | none |
| `prism_finalize(draft)` | returns drafts | none expected |
| `prism_finalize(commit)` | **HIGHEST RISK.** Snapshot ALL 10 living docs + handoff-history/. Invoke with minimal files=[] array. Restore every affected file + delete new backups + delete new archive files. | all 10 living docs + `handoff-history/handoff_v<N>.md` + possible archives |
| `cc_dispatch(query)` | `prompt="list files in src/", mode=query, async_mode=false, max_turns=3` | none expected |
| `railway_env(set+delete)` | name=`AUDIT_TEST_VAR_S46` value=`test` → get → delete → verify absent via list | none persistent |

After every Tier B test: `git log --oneline -5 origin/main` on `brdonath1/prism` via GitHub API — expect 2 audit-trail commits.

### Tier C — Static / test-only review (never live-invoked)

- `cc_dispatch(mode=execute)`
- `railway_deploy(action=redeploy)`
- `railway_deploy(action=restart)`

Produce full per-tool checklist from source + tests. All claims `CONFIRMED-TEST` or `STATIC-ONLY`.

## Axis A per-tool review (mandatory section per tool)

9-point checklist per tool: purpose (your words) | schema | output shape | error surface | side effects | timeouts | test coverage | dependencies | live test result (A/B only) | findings.

All 18 tools:
```
prism_bootstrap [A] | prism_fetch [A] | prism_push [B] | prism_patch [B]
prism_search [A] | prism_status [A] | prism_finalize [B] | prism_synthesize [A+B]
prism_scale_handoff [B] | prism_log_decision [B] | prism_log_insight [B] | prism_analytics [A]
railway_logs [A] | railway_deploy [A+C] | railway_env [A+B] | railway_status [A]
cc_dispatch [B+C] | cc_status [A]
```

---

# Axis B — Claude behavioral drift audit

## Axis B posture

**Session history IS the evidence.** Read `session-log.md`, `handoff-history/`, `decisions/_INDEX.md`, and `insights.md` across three sample projects. The goal is not to validate the framework's design intent (Axis A's job) but to measure whether Claude — the AI consumer running inside Claude.ai — actually follows that design when handling real sessions.

**Where Axis A says "don't read decisions/," Axis B says "read decisions/."** The two axes examine the same files with different questions. No contradiction.

**Calibration signal: the operator explicitly raised this axis after observing Claude (not the server) failing to use `conversation_search` before asking for information that was in session history.** That single observation is the strongest available evidence that behavioral drift exists. Axis B asks: what else is drifting?

**Second calibration signal: this brief itself.** In its earlier drafts, Claude (the brief author) specified `staging` as the target branch for prism-mcp-server, carrying over a convention from the platformforge-v2 CLAUDE.md it had read in an earlier housekeeping task — without verifying that prism-mcp-server actually uses that branching model. This is in-session evidence of cross-project convention bleed without verification. Axis B should specifically look for this class of drift in other projects (convention inference from one project applied to another without check).

## Axis B reading list

### Primary evidence (READ IN DEPTH)
- `brdonath1/prism/.prism/session-log.md` — full
- `brdonath1/platformforge-v2/.prism/session-log.md` — last 20 sessions
- `brdonath1/alterra-design-llc/.prism/session-log.md` — full
- `brdonath1/prism/.prism/handoff.md` + last 10 `handoff-history/handoff_v*.md`
- `brdonath1/platformforge-v2/.prism/handoff.md` + last 10 `handoff-history/handoff_v*.md`
- `brdonath1/alterra-design-llc/.prism/handoff.md` + last 10 `handoff-history/handoff_v*.md`
- `brdonath1/prism/.prism/decisions/_INDEX.md`
- `brdonath1/prism/.prism/insights.md` — in full (large, ~44KB)

### Secondary evidence
- Recent commits on `prism` main (via GitHub API) — to distinguish operator-prose changes from tool-driven changes
- `prism-framework/_templates/core-template-mcp.md` — the rule text Claude is supposed to follow
- `prism-framework/_templates/modules/*` — on-demand rule modules

### What to extract (before analysis)
1. Rule 9 context-status-line format in each recent response (from session-log). Count literal `[S{N} · Ex {M} · {emoji} ~{P}%]` vs prose-style substitutes.
2. Boot response structure in each session's first entry. Does it match Rule 2's 5-block requirement?
3. Tool-invocation counts per session from session-log (how often does Claude invoke `conversation_search`, `prism_search`, `tool_search` mid-session).
4. Handoff version size progression over last 10 versions per project (is it growing unboundedly despite D-80 archive lifecycle?).
5. Decision-logging pattern: are decisions appearing in session-log as they're made (via `prism_log_decision`), or only in finalize commits (batched)?
6. Instruction-density correlation: does Rule 9 compliance degrade in projects with larger handoffs/insights (instruction saturation)?
7. Operator feedback patterns: grep session-log for user messages containing "you should have", "why didn't you", "I already told you" — each is a candidate behavior-drift signal.

## Axis B lenses (every B-N finding maps to ≥ 1 lens)

- **BL1 Rule adherence** — Hard rule compliance (Rule 2 boot, Rule 9 context line, Rule 11 finalization). Measure literal compliance rate, not proxy.
- **BL2 Tool proactivity** — Are available tools used when the situation calls for them? (`conversation_search` before asking operator for prior info; `tool_search` before claiming a capability is missing; `prism_search` before asking "where is X".)
- **BL3 Instruction-following drift within session** — Does compliance degrade across exchanges as context fills? Sample a session's early vs late responses.
- **BL4 Handoff quality trajectory** — Are handoffs growing unboundedly, staying roughly stable, or shrinking? Is `critical_context` meaningful or ceremonial? Does `resumption_point` actually resume?
- **BL5 Decision/insight logging hygiene** — Are decisions logged atomically (prism_log_decision) mid-session, or batched into finalize commits (indicating Claude isn't using the tool as intended)?
- **BL6 Context-management accuracy** — Are context percentages being computed, or are they eyeballed? Are tier transitions triggering appropriate behavior (no-new-topics at orange, finalize at red)?
- **BL7 Candor / pushback** — Is Claude pushing back on operator premises, or drifting to confirmation? Sample operator-request patterns that had questionable premises — how often did Claude flag the premise vs comply?
- **BL8 Memory discipline** — Does Claude ask for information it should have looked up (past conversations, project context, prior sessions)? Each occurrence is a signal.
- **BL9 Cross-project convention bleed** — Does Claude apply a convention/pattern from one project to another without verifying it applies? (See second calibration signal above.)

## Axis B deep-dives (each MUST have a section)

- **BDD1 Rule 9 compliance sampling.** Across the three sample projects' last 20 responses in session-log (60 responses total), count: (a) literal bracketed context-status-line matches, (b) prose-style mentions ("we're at yellow", "around 65%"), (c) missing entirely. Report per-project compliance rate + trend (is it getting worse?).
- **BDD2 Boot response structure (Rule 2) compliance.** Locate the boot response in the last 5 sessions per project (15 boots). For each, check the 5-block structure: (1) session-name code fence, (2) rename directive, (3) banner code fence with Tool Surface, (4) opening-statement prose, (5) context status line. Report violations by block.
- **BDD3 Tool-proactivity archaeology.** For the three sample projects, count session-log mentions of: `conversation_search`, `tool_search`, `prism_search`, `prism_fetch` with summary_mode, `recent_chats`. Compare to operator questions that could have been answered via those tools. Identify a "tools-available-but-not-used" rate.
- **BDD4 Handoff size trajectory.** For each of 3 projects, fetch `handoff_v{N-10}.md` through `handoff_v{N}.md` and compute byte-size per version. Plot (text representation) the trajectory. Is it bounded (D-80 archive working) or growing (behavior drift)?
- **BDD5 Decision/insight logging pattern.** In each project's last 10 sessions (from session-log), count decisions that appear: (a) in a mid-session commit with `prism_log_decision`, (b) first in the finalize commit. Report the ratio. A high (b) share indicates Claude isn't using the intended tool.
- **BDD6 Instruction-saturation correlation.** Projects with larger handoffs / insights.md presumably load more instructions at boot. Is Rule 9 compliance (BDD1) correlated with instruction load? (Use file sizes as proxy.)
- **BDD7 Operator-frustration signal.** Grep the three session-logs for user messages containing: "you should have", "why didn't you", "I already told you", "you're not", "stop", "no", "wrong", "just", "again", "still". Each hit is a candidate frustration signal. Classify each into (i) legitimate operator correction, (ii) genuine Claude drift, (iii) operator-misread-context. Report the rate over time — is the rate rising?
- **BDD8 Template-rule evolution vs adherence.** Look at `core-template-mcp.md` version history (via git log on the framework repo). Each version bump (v2.9 → v2.10 → v2.11 → v2.12 → v2.13) added / changed rules. For each, measure: did Claude's behavior actually change post-bump, or did the rule text change without behavioral effect? (Comparison: pre-bump vs post-bump sample responses.)
- **BDD9 Cross-project convention bleed.** Search session-logs across the three projects for evidence of Claude applying a convention/configuration from one project to another without verification. Examples: branch naming (main vs staging vs feature branches), commit-prefix patterns, directory structures, tool-launching patterns, model-string references. Quantify occurrences per session over the last 10 sessions per project.

## Axis B methodology

- All Axis B evidence is **session archaeology**, not live invocation. No production calls needed.
- For each finding, cite exact session/exchange references: `prism/session-log.md § S44 Ex 7`, `alterra-design-llc/handoff_v12.md line 42`.
- Quantify where possible. "Rule 9 compliance dropped from 100% in S20-S30 to 78% in S40-S45" beats "Rule 9 compliance seems worse."
- When observing drift, distinguish: (a) rule was added but never effective, (b) rule was effective and degraded, (c) rule was never measurable.
- When a finding implies a code fix (e.g., "the banner renderer has a bug"), promote it to Axis A or cross-axis `X-N`.

## Execution order

1. Pre-Flight Steps 1–6 (including branch creation)
2. Axis A static code reading (src, tests, configs, templates, self-descriptions)
3. Axis A Tier A live probes
4. Axis A Tier B live tests (capture-invoke-restore)
5. Axis A Tier C static review
6. Axis A cross-cutting deep-dives (DD1–DD10) synthesis
7. Axis A per-tool reviews
8. **Shift posture:** now Axis B — read session-log, handoff history, decisions/, insights.md across three projects
9. Axis B deep-dives (BDD1–BDD9)
10. Cross-axis synthesis (`X-N` findings where Axis A and Axis B intersect)
11. Findings consolidation + severity calibration
12. Report assembly
13. Final verification + single commit + push + PR

## Severity scale (strict, applies to both axes)

- **CRITICAL** — Breaks core functionality, risks data loss/corruption, creates security exposure. (Axis B example: a hard rule has 0% compliance across recent sessions.)
- **HIGH** — User-observable degradation: materially worse than design intent, incorrect on common path, significant reliability gap. (Axis B example: a hard rule has <50% compliance and trending down.)
- **MEDIUM** — Latent bug, tech debt, or drift not yet on hot path. (Axis B example: a tool is available but rarely invoked when it should be.)
- **LOW** — Cosmetic, doc drift, minor optimization. (Axis B example: prose-style context-line appeared 3 times across 60 responses.)

## What to output

Path: `reports/s46-framework-audit.md` in `prism-mcp-server`. Structure:

```
# PRISM Two-Axis Audit — Report

## Metadata
- Report generated: <ISO>
- Server commit: <>
- Work branch: audit/s46-framework-audit
- Framework commit: <>
- Test baseline: <p>/<f>/<s>
- Build: <pass|fail>
- Env vars present / missing: <>
- Live /health: <code> in <t>s
- Tier A probes: <N>
- Tier B tests executed / verified / failed-restore: <N> / <N> / <N must be 0>
- Tier C tools reviewed: <N>
- Axis B sample sessions examined: <N>
- Axis B sample handoff versions examined: <N>
- Auditor: Opus 4.7 max
- Wall-clock: <min>

## Executive Summary (≤ 1 page prose, no lists)
Five questions in order:
1. What is this codebase?
2. Axis A overall state — which lenses strong/weak?
3. Axis B overall state — what is Claude actually doing with this framework vs design intent?
4. Top three findings by severity across both axes (by ID).
5. Single investigation that would most change the assessment.

## Pre-Flight Evidence
<Step 1, 2, 4, 5, 6 outputs verbatim>

## Methodology
Both axes. Reading order, tools used, what was live-run vs read vs archaeologically sampled, deliberate exclusions, scope constraints, sampling sizes.

## Axis A — Codebase findings

### A-findings summary table
| ID | Severity | Lens(es) | Tool/Subsystem | Title | Evidence |

### Tier A live probe results
| Tool | Latency | Status | Size | Errors | Notes |

### Tier B capture-invoke-restore results
| Tool | Pre-SHA | Post-invoke-SHA | Post-restore-SHA | Byte-identical | Commit SHAs |

### Tier C static review
| Tool | Code loc | Test coverage | Risks | Evidence |

### Full A-findings (one per finding)

### A-N: <title>
- Severity: …
- Lens(es): L1–L7
- Tool/Subsystem: …
- Status: CONFIRMED-LIVE | CONFIRMED-TEST | STATIC-ONLY
- Description: 2–6 sentences
- Evidence: <concrete>
- Impact: …
- Scope: isolated | N call sites | systemic
- Recommended Fix Category: …
- Impact × Effort: …

### Per-tool review
<one subsection per tool, 9-point checklist>

### Axis A deep-dives
<DD1–DD10, each required>

## Axis B — Behavioral-drift findings

### B-findings summary table
| ID | Severity | Lens(es) | Rule/Pattern | Title | Evidence |

### Axis B deep-dives
<BDD1–BDD9, each required>

### Full B-findings

### B-N: <title>
- Severity: …
- Lens(es): BL1–BL9
- Rule/Pattern: <which rule or behavioral expectation>
- Evidence: <session references, quantified>
- Trend: improving | stable | degrading | unknown
- Scope: which projects, which sessions, which rule
- Recommended Category: rule-strengthening | template-rewrite | tool-automation | observational (watch only) | operator-training | framework-architectural-change
- Impact × Effort: …

## Cross-Axis Findings (X-N)
For findings that span both axes — e.g., a code feature that exists but is never invoked, or a behavioral rule that is well-written but consistently ignored.

### X-N: <title>
- Severity: …
- Axis-A component: <code/subsystem>
- Axis-B component: <behavioral pattern>
- Evidence (both sides): <>
- Recommended Category: code-change + rule-change combined

## Lens Coverage
Both axes. Findings-per-lens tables for L1–L7 and BL1–BL9. Zero-finding lenses need one-sentence justification.

## Out-of-Scope Observations
Notes outside the scope of both axes. No severity.

## Prioritized Recommendations
Across both axes. Ranked Impact × Effort. Groups: Immediate (high-low), Next wave, Long-term, Watch-only.
If Axis B reveals that Axis A code improvements won't be effective without Claude-side behavioral changes, say so explicitly.

## Open Questions
Concrete, answerable questions for operator before fix briefs can be drafted.

## Appendix A — File Inventory
Sizes of src, tests, configs (Axis A).

## Appendix B — Git Log Samples
- Last 20 commits on `prism-mcp-server:main`
- Last 10 commits on `prism-framework:main`
- Tier B audit-trail commits on `prism:main` (expected = 2 × Tier B tests)

## Appendix C — Tier B Restoration Ledger
Per Tier B test: file | pre-SHA | post-invoke-SHA | post-restore-SHA | byte-identical verdict.

## Appendix D — Axis B Sample Inventory
Per sample project: session range examined, handoff versions examined, approximate response count, tool-call counts.

## Appendix E — Axis B Raw Measurements
Rule 9 compliance table, boot-structure compliance table, tool-proactivity counts, handoff-size trajectory data, cross-project convention bleed incident log. The quantitative backing for B-findings.

<!-- EOF: s46-framework-audit.md -->
```

## Completion criteria (verifiable)

1. File exists at `reports/s46-framework-audit.md` on branch `audit/s46-framework-audit`.
2. Executive Summary answers all five numbered questions, addressing both axes.
3. Every finding is tagged `A-`, `B-`, or `X-`. No untagged findings.
4. Axis A: every tool has a per-tool review; Tier A/B results present; Tier C static notes present; DD1–DD10 each have a section.
5. Axis B: BDD1–BDD9 each have a section with quantified measurements (not just impressions). Appendix E contains the raw numbers.
6. Lens Coverage table covers both L1–L7 and BL1–BL9.
7. If any Tier B restoration failed, report documents unrestored state as CRITICAL A-finding and Tier B section header states `ABORTED AFTER: <tool>`.
8. Every runtime-behavior claim labeled CONFIRMED-LIVE / CONFIRMED-TEST / STATIC-ONLY.
9. Every Axis B claim cites specific session/exchange references.
10. `git status` on the work branch shows only the report staged; `git diff --cached --stat` shows exactly one added file.
11. PR exists, base `main`, head `audit/s46-framework-audit`, title `Brief S46: PRISM Two-Axis Audit`.
12. Test target (`prism`) ends in byte-identical state per Appendix C verification.

## Finishing up (single chained command)

```bash
git add reports/s46-framework-audit.md && \
git status && \
git diff --cached --stat && \
git commit -m "docs: s46 two-axis audit report" && \
git push -u origin audit/s46-framework-audit && \
EXEC_SUMMARY=$(awk '/^## Executive Summary/,/^## Pre-Flight Evidence/' reports/s46-framework-audit.md | sed '$d' | head -c 3500) && \
PR_BODY=$(jq -Rs '.' <<< "$EXEC_SUMMARY") && \
curl -s -X POST \
  -H "Authorization: token $GITHUB_PAT" \
  -H "Content-Type: application/json" \
  "https://api.github.com/repos/brdonath1/prism-mcp-server/pulls" \
  -d "{\"title\":\"Brief S46: PRISM Two-Axis Audit\",\"head\":\"audit/s46-framework-audit\",\"base\":\"main\",\"body\":$PR_BODY}" | tee /tmp/pr-response.json && \
grep -oE '"number":[0-9]+' /tmp/pr-response.json && \
git log -1 --stat
```

If any step fails: STOP, report verbatim, exit. Do not retry. Do not push to main.

<!-- EOF: s46-framework-audit.md -->
