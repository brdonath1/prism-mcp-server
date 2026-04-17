# S39 Framework Observability & Performance Audit

> Audit performed 2026-04-17 by Claude Opus 4.7 against `prism-mcp-server` at commit `a3876cb` (branch: main).
> No code modified. No PR opened. This report is the only deliverable.

## Executive Summary

**18 findings across 4 dimensions. 2 CRITICAL, 4 HIGH, 7 MEDIUM, 5 LOW.**

The two CRITICAL findings both relate to blind spots that actively mislead diagnosis, consistent with the S39 hypothesis that observability gaps — not synthesis performance per se — drive the operator's "everything takes forever" complaint:

1. **FINDING-1 (CRITICAL):** `railway_logs` GraphQL selection strips every field except `message`, `timestamp`, `severity`. Structured payloads emitted by `logger.info(msg, {...data})` are visible in Railway's web UI but invisible to the MCP tool, so PRISM investigations cannot see error context via `railway_logs`.
2. **FINDING-5 (CRITICAL):** `prism_finalize commit` awaits synthesis inline (up to 120s) with no progress notifications, even though MCP client timeout is ~60s and `MCP_SAFE_TIMEOUT = 50s`. Measured PF-v2 synthesis is 99.6s — the client will disconnect before the server responds, and the operator sees "hung" when the server actually completed.

**Top 3 recommendations (by severity):**
1. Add structured-payload fields to `src/railway/client.ts` GraphQL queries and thread them through `RailwayLog` / `railway_logs` response.
2. Decouple synthesis from the `commit` phase response path — either return-then-synthesize-in-background, or emit progress notifications so the MCP client doesn't time out during a 99-second synthesis.
3. Introduce a lifecycle policy for the two unbounded append-only documents (`session-log.md`, `insights.md`) — the framework has the `*-archive.md` paths reserved but no code manages them.

---

## Dimension 1: Railway Logs Observability

### FINDING-1: GraphQL log queries discard structured payloads
- **Severity:** CRITICAL
- **Dimension:** 1
- **File(s):** `src/railway/client.ts:336-395` (both `getDeploymentLogs` and `getEnvironmentLogs`), `src/railway/types.ts:33-37`, `src/tools/railway-logs.ts:85-113`
- **Observation:** Both GraphQL queries use the same spread selection:
  ```graphql
  ... on Log {
    message
    timestamp
    severity
  }
  ```
  This explicitly asks Railway for three fields only. The `RailwayLog` TypeScript type (`types.ts:33-37`) matches — it declares `message`, `timestamp`, `severity` and nothing else. The tool response at `railway-logs.ts:85-113` passes `logs` through unmodified. Meanwhile `src/utils/logger.ts:26-42` emits the entire structured object (level, msg, ts, and every caller-supplied field via `...data`) as one stringified JSON line to stdout/stderr. Railway ingests the stringified JSON — and (based on Railway's public docs) parses JSON log lines into structured `attributes` accessible via the `@key:value` filter syntax — but because the GraphQL selection doesn't request those parsed fields, they are stripped at query time before `filterLogs` ever sees them.
- **Impact:** Exactly the PF-v2 INS-125 symptom. Every `logger.error("X failed", { project, err, stackTrace, ... })` call is reduced to just the string `"X failed"` (or to the entire serialized JSON depending on how Railway stores it — see Methodology Notes). PRISM investigation sessions querying `railway_logs @level:error` get top-level summaries but no structured context. The operator's diagnosis loop (sees "something failed" → no details → guesses → wrong fix) is directly caused by this.
- **Recommendation:** In `src/railway/client.ts`, expand the `... on Log { ... }` selection in both `getDeploymentLogs` and `getEnvironmentLogs` to request `attributes` (Railway exposes a JSON/key-value field for parsed structured logs — confirm exact name via a live GraphQL introspection call against `backboard.railway.app`). Update `RailwayLog` in `types.ts` to carry the new field. Thread it through `railway-logs.ts` response. If Railway's schema uses a different field name (e.g. `tags`, `payload`, `data`), adapt accordingly — but the fix shape is identical.
- **Risk if unfixed:** Future incidents continue to be triaged from `logger.error(msg)` top-lines with all structured context invisible. The already-reported INS-125 keeps biting. Operator frustration compounds across 17 projects.

### FINDING-2: Logger writes `level`, Railway filter matches `severity` — mismatched field names
> **STATUS: INVALIDATED (S41 live verification — 2026-04-17)**
>
> The core mechanical claim of this finding is false in the current deployment. S41 ran `railway_logs project:prism-mcp-server filter:"@level:warn"` against production and got 10 correct matches, every one with `severity: "warn"` at the top level. Railway's JSON log parser IS promoting the emitted `level` field to the top-level `severity` — stream classification (stderr → `error`, stdout → `info`) is only the fallback for non-JSON lines. The auditor reasoned from a code read without running the tool against Railway.
>
> **No fix is needed.** Both the server-side filter (environment-scoped `getEnvironmentLogs`) and the client-side `filterLogs()` function (service-scoped path) work correctly for `@level:warn` because `l.severity` is populated from the parsed JSON.
>
> Minor residual items NOT worth a fix brief: (a) the tool description at `railway-logs.ts:43-45` could explicitly state that the filter works because Railway parses JSON log lines; (b) `attributes.level` values come through with literal surrounding quotes (`"\"warn\""`) which is cosmetic and does not affect filtering. Neither is severity-worthy.
>
> See INS-29 (STANDING RULE): audit claims about tool output must be verified against live tool behavior, not inferred from code reads.


- **Severity:** HIGH
- **Dimension:** 1
- **File(s):** `src/utils/logger.ts:19-42`, `src/railway/client.ts:404-417`
- **Observation:** `logger.ts` emits a LogEntry with a `level` field (`"debug" | "info" | "warn" | "error"`). The client-side filter `filterLogs` at `railway/client.ts:404-417` reads `l.severity` — which comes from Railway's own classification of the line (typically derived from stdout vs. stderr stream and/or parsed `level`). There is no explicit `severity` field in the emitted JSON. This works in practice only because `emit()` at `logger.ts:37-41` routes `level: "error"` to `process.stderr` and Railway maps stderr → `severity: "error"` — but `warn` goes to stdout and is NOT classified as a warning severity by Railway. A filter expression `@level:warn` will therefore match zero logs even when warnings have been emitted.
- **Impact:** The one non-error severity the server emits (`warn`) is effectively unfilterable via `railway_logs @level:warn`. Silent failures logged at warn level (e.g. `railway_logs` at `railway-logs.ts:128` logs failures with `logger.error` — OK — but `railway-logs.ts:73-83` deployment-not-found cases use `logger.info` or `logger.warn` elsewhere) are invisible to level-filtered queries. Also, the `filter` parameter documentation at `railway-logs.ts:43-45` claims `@level:` works, but the semantics depend on Railway-side classification, not the logger's own field. This is a contract mismatch the user-visible description does not acknowledge.
- **Recommendation:** Either (a) make the logger explicitly write `severity: level` into the JSON so Railway's JSON parser picks it up consistently, or (b) route `warn` to stderr with a prefix so Railway classifies it. Also update the tool description on `railway-logs.ts:43-45` once the semantics are pinned down. No code change in this audit.
- **Risk if unfixed:** A filter that looks correct returns no results, fooling investigators into concluding "no warnings" when warnings exist. Same class of bug as FINDING-1, smaller blast radius.

### FINDING-3: `railway_logs` response has no channel for structured fields even if query were fixed
- **Severity:** MEDIUM
- **Dimension:** 1
- **File(s):** `src/tools/railway-logs.ts:85-113`, `src/railway/types.ts:33-37`
- **Observation:** Even if FINDING-1 is fixed at the GraphQL layer, the response path flattens every log to `{ message, timestamp, severity }` because that is what `RailwayLog` declares. The `logs` array in the tool response (line 100 for deployment logs, line 112 for environment logs) is passed through directly. There is no schema slot for `attributes`. A caller decoding the MCP tool response has no way to see structured fields.
- **Impact:** Half-fix risk: fixing only the GraphQL query without widening the TS type and response surface leaves the field dropped at the serialization boundary.
- **Recommendation:** When executing the FINDING-1 fix, expand `RailwayLog` in `types.ts` to `{ message, timestamp, severity, attributes?: Record<string, unknown> }` and ensure `railway-logs.ts` response includes the new field in the `logs` array entries.
- **Risk if unfixed:** Fix attempt ships partial — schema-level gap remains.

### FINDING-4: `railway_logs` scope is a single deployment, not cross-deployment rolling window
- **Severity:** LOW
- **Dimension:** 1
- **File(s):** `src/tools/railway-logs.ts:69-101`, `src/railway/client.ts:285-307`
- **Observation:** When `service` is specified, `railway_logs` calls `getLatestDeployment` (line 71) and then queries logs from only that deployment. On a deploy-churn investigation (common when the server was just redeployed, as in the `556ab6ff` measurements), an error that occurred on deployment N-1 is invisible even though it's the incident the operator is diagnosing.
- **Impact:** During active investigation with recent deploys, the "latest" deployment's logs are nearly empty and the relevant error lives on the previous deployment.
- **Recommendation:** Either default to environment-wide logs (which already span deployments — `getEnvironmentLogs` at `client.ts:367`) when no `service` is specified, AND add a `deployment_id` parameter or `time_range` parameter to the tool so the investigator can scope explicitly.
- **Risk if unfixed:** Minor — workaround exists (omit `service`).

---

## Dimension 2: Finalization Pipeline

### FINDING-5: `commit` phase awaits synthesis inline with no progress notifications — exceeds MCP client timeout on mature projects
- **Severity:** CRITICAL
- **Dimension:** 2
- **File(s):** `src/tools/finalize.ts:573-609`, `src/ai/synthesize.ts:76-88`, `src/config.ts:52-82`
- **Observation:** Inside `commitPhase` at `finalize.ts:573-609`, synthesis is awaited:
  ```ts
  const synthPromise = generateIntelligenceBrief(projectSlug, sessionNumber);
  const timeoutPromise = new Promise(...setTimeout(..., SYNTHESIS_TIMEOUT_MS));
  const synthOutcome = await Promise.race([synthPromise, timeoutPromise]);
  ```
  `SYNTHESIS_TIMEOUT_MS` is `120_000` (`config.ts:82`). `MCP_SAFE_TIMEOUT` is `50_000` (`config.ts:53`) and the inline comment at `config.ts:51` documents "MCP client timeout is ~60s." Measured data: PRISM 82.5s, PF-v2 99.6s. No progress notifications are sent during the synthesis wait — the only tool that sends them is `prism_scale_handoff` (`src/tools/scale.ts:91-111`). `finalize.ts` contains zero calls to `extra.sendNotification` or an equivalent.
- **Impact:** On mature projects, `prism_finalize commit` runs for 90-120 seconds server-side while the claude.ai client disconnects at ~60s. The operator sees a "hung" or "timed out" tool call and typically retries — but the server has already pushed the commit atomic (line 475) before synthesis starts, so the retry finds a clean state. The `synthesis_warning` field and `synthesis_banner` updates never reach the operator on the timed-out call. This is a direct candidate for the "everything takes forever" complaint because the client-visible wall time is bounded by the 60s timeout, and the follow-up state is unclear.
- **Recommendation:** Two options; either is acceptable. (A) **Return-then-synthesize:** push commit, serialize the response, then fire synthesis as a background task (unawaited) while still responding to the client. Status visible via `prism_synthesize mode=status`. This matches the `skip_synthesis=true` path that already exists (`finalize.ts:570-572`) — make it the default behavior and remove the inline wait. (B) **Progress-ping:** during the synthesis wait, call `extra.sendNotification` every 15-20s with a `notifications/progress` frame (the SDK resets the client timeout on each — see `scale.ts:98-111` for the pattern). Needs the tool handler to receive `extra` (MCP SDK change — still API-compatible). Name the right files/functions: `finalize.ts` `commitPhase` and `registerFinalize`.
- **Risk if unfixed:** Every mature-project finalize is user-visible pathological slowness. This is the #1 candidate for the operator's reported UX issue.

### FINDING-6: No overall finalize timeout; worst case exceeds 170s across three phases
- **Severity:** HIGH
- **Dimension:** 2
- **File(s):** `src/tools/finalize.ts:62-256` (audit), `finalize.ts:262-346` (draft), `finalize.ts:351-629` (commit)
- **Observation:** `prism_finalize` is dispatched as three separate MCP calls via the `action` parameter. Each has its own timeout or no timeout:
  - `audit` — no declared timeout. Does 10-doc parallel fetch via `resolveDocFiles` + up to 2 handoff-history listings (cached after first, `finalize.ts:67-74`) + 1 previous-handoff fetch + 1 commit-list fetch + up to 5 commit-detail fetches (sequential `Promise.allSettled` on 5). On a mature project ~3-5s expected; not a timeout risk but a non-trivial cost.
  - `draft` — timeout is `draftTimeoutMs = totalDocBytes > 50_000 ? MCP_SAFE_TIMEOUT : 45_000` (`finalize.ts:305`). For PF-v2 with 7 draft-relevant docs totaling ~120KB (excluding arch/glossary/brief), this caps at 50s. But the Opus call for 120KB of prompt is observed in the same neighborhood as the synthesis (~60-80s projected based on the S39 "~13s per 10K input tokens" model for ~30K tokens of draft content). **Draft phase is likely to time out on PF-v2-scale projects.**
  - `commit` — awaits synthesis up to 120s (FINDING-5), plus ~5-10s of commit/push work upstream. 125-130s total. No overall cap.
- **Impact:** Total finalize wall time (client perceives each phase as a separate tool call): audit 3-5s + draft 45-50s (possibly timed out) + commit 125s = **180+ seconds cumulative**, with the last phase invisible to the client. Draft phase timing out silently degrades the pipeline to manual composition (see the fallback at `finalize.ts:318-324`) — operator loses the Opus-drafted session-log/handoff/task-queue content they expected.
- **Recommendation:** (a) Add a single overall budget for each phase visible in the response (`phase_timings: { audit_ms, draft_ms, commit_ms, synthesis_ms }`). (b) For the draft phase, measure actual token count (from docMap bytes) and select model/tokens accordingly, or split into smaller drafts. (c) As in FINDING-5, detach synthesis from commit. Cite: `finalize.ts:262-346` (draft), `finalize.ts:573-609` (synthesis).
- **Risk if unfixed:** Draft silently falls back for mature projects, operator stops trusting it. Commit phase client-timeout masks success. Compounding distrust of finalize.

### FINDING-7: Audit phase performs redundant / near-redundant GitHub calls
- **Severity:** MEDIUM
- **Dimension:** 2
- **File(s):** `src/tools/finalize.ts:62-256`
- **Observation:** `auditPhase` fetches all 10 living documents via `resolveDocFiles` (`finalize.ts:77`). Then it also:
  - Fetches handoff-history listing twice (lines 68-74, cached) — OK.
  - Fetches the PREVIOUS handoff.md (line 142) — cannot use the already-fetched current handoff docMap; this is a NEW fetch.
  - Fetches commit list (line 197) + up to 5 individual commit details (lines 211-220) — independent but sequential-per-outcome.
  - Recomputes decision table parsing here (line 129) and again in `bootstrap.ts` / elsewhere — fine, different tools.
  
  Net: audit does ~12-17 GitHub API calls on a mature project (10 docMap + 2 history listings + 1 prev handoff + 1 commit list + up to 5 commit details). Each call has 50-200ms roundtrip. Sequential Promise.allSettled on commit details adds up.
- **Impact:** ~3-5 second audit latency on mature projects. Each redundant call also consumes part of the GitHub 5000/hr rate-limit budget — not critical at 17 projects but observable.
- **Recommendation:** Cache the commit-list result and reuse across drift detection + session work products. Batch commit detail fetches via Promise.all (already `Promise.allSettled` but sequential-feel is a code-reading issue only). No critical fix; flag for future cleanup.
- **Risk if unfixed:** Slow audit erodes finalize's "fast phase" reputation. Minor.

### FINDING-8: Draft phase timeout too tight for PF-v2-scale projects
- **Severity:** HIGH
- **Dimension:** 2
- **File(s):** `src/tools/finalize.ts:273-346`, `src/ai/prompts.ts` (FINALIZATION_DRAFT_PROMPT)
- **Observation:** At `finalize.ts:273-275`, draft excludes architecture.md, glossary.md, intelligence-brief.md — a deliberate token-budget optimization. At line 305, `draftTimeoutMs` is 50s (`MCP_SAFE_TIMEOUT`) for >50KB, else 45s. But the remaining 7 docs on PF-v2 (handoff, decisions/_INDEX, session-log, task-queue, eliminated, known-issues, insights) total ~107KB based on S39 sizes. The S39 timing model is "~13s per 10K input tokens + fixed overhead." 107KB ≈ 27K input tokens → ~35s + overhead. Likely fits in 50s at median but not at tail.
- **Impact:** Intermittent draft timeouts on the largest projects. Visible symptom: `draftPhase` returns `{ success: false, fallback: "Compose finalization files manually." }` (lines 320-324), operator loses the Opus-drafted content.
- **Recommendation:** Raise draft timeout to 90s for the >50KB case and scale token budget (max_tokens is hard-coded to 4096 at line 316). Alternatively, tier the draft (handoff + session-log only in one call, task-queue + decisions in a second) to stay inside client timeouts. Names: `draftPhase` in `finalize.ts`, `FINALIZATION_DRAFT_PROMPT` constant in `ai/prompts.ts`.
- **Risk if unfixed:** Tail-risk finalize failures on mature projects. Operator ends up manually composing session-log / handoff / task-queue — the PRISM automation breaks exactly when it's most valuable.

### FINDING-9: Commit phase atomic-fallback path has no overall timeout
- **Severity:** MEDIUM
- **Dimension:** 2
- **File(s):** `src/tools/finalize.ts:528-547`
- **Observation:** When `createAtomicCommit` fails and HEAD is unchanged, the code falls back to sequential `pushFile` calls in a plain `for...of` loop (`finalize.ts:536-546`). No outer `AbortSignal`, no timeout wrapper. Each `pushFile` internally makes 2 GitHub API calls (get SHA + PUT). At typical 200-400ms roundtrip × 10 files = 4-8s — fine. At worst-case network stall × 10 = pathological.
- **Impact:** Rare but uncapped. In a GitHub incident where each PUT is retrying 429s, this loop can stall for minutes inside commitPhase, piled onto the already-long synthesis wait.
- **Recommendation:** Wrap the sequential fallback in a Promise.race against a 30s cap; on cap, return partial success with a clear warning. Alternatively, use `Promise.all` if commit ordering is not semantically required (the comment at line 535 says "sequential ... to avoid 409 conflicts" — verify whether 409s are still a risk since each file is a different path; if they're independent paths, 409s on different paths are impossible).
- **Risk if unfixed:** Rare tail scenario becomes a gigantic commit stall.

### FINDING-10: `SYNTHESIS_TIMEOUT_MS` is a hard-coded const, not an environment variable
- **Severity:** LOW
- **Dimension:** 2
- **File(s):** `src/config.ts:82`
- **Observation:** The brief asked to identify the "read path" for `SYNTHESIS_TIMEOUT_MS` env var. It is NOT read from env — it is declared as `export const SYNTHESIS_TIMEOUT_MS = 120_000;` with no `process.env.SYNTHESIS_TIMEOUT_MS` fallback. To change it on Railway, you must redeploy the source. The `.env.example` (not read, confirming) and the CLAUDE.md env-var table do not list it.
- **Impact:** Operators cannot tune synthesis budget per-project or per-deploy without a rebuild. If a mature project needs 150s, there is no runtime knob.
- **Recommendation:** `export const SYNTHESIS_TIMEOUT_MS = parseInt(process.env.SYNTHESIS_TIMEOUT_MS ?? "120000", 10);` — identical pattern to `CC_DISPATCH_MAX_TURNS` at `config.ts:237`. Update CLAUDE.md env-var table.
- **Risk if unfixed:** Minor. Mostly documentation drift — the CLAUDE.md table implies it is an env var when it isn't.

---

## Dimension 3: Bootstrap Pre-Fetch

### FINDING-11: Prefetch also triggers on `next_steps` content, not just `opening_message` — counter to documented behavior
- **Severity:** MEDIUM
- **Dimension:** 3
- **File(s):** `src/tools/bootstrap.ts:346-361`, `src/config.ts:179-207`
- **Observation:** `bootstrap.ts:346-357` merges prefetch triggers from both `opening_message` AND the handoff's `nextSteps` list (parsed from the `Next Steps` section of handoff.md). This is the key code:
  ```ts
  if (opening_message) {
    for (const f of determinePrefetchFiles(opening_message)) prefetchSet.add(f);
  }
  if (nextSteps.length > 0) {
    for (const f of determinePrefetchFiles(nextSteps.join(" "))) prefetchSet.add(f);
  }
  const prefetchPaths = Array.from(prefetchSet).slice(0, 2);
  ```
  The measured data noted `prefetched_documents: []` on a PF-v2 bootstrap with `opening_message: "Begin next session"` — implying prefetch was empty. But that's only because PF-v2's next_steps text didn't contain any `PREFETCH_KEYWORDS` (`config.ts:179-207`). On a different session where the handoff's next_steps includes "update the architecture", prefetch WILL trigger even with a generic opener. The tool schema at `bootstrap.ts:35-38` documents `opening_message` as the trigger source — but in reality next_steps is a silent secondary trigger.
- **Impact:** Operator expecting to control prefetch via opening message is surprised by prefetches they didn't ask for. Conversely, if an operator writes a keyword-rich opening_message and expects heavy prefetch, they get at most 2 docs (the cap). The hard cap is well-designed (`slice(0, 2)`) but the two-source trigger model is hidden.
- **Recommendation:** Either (a) document the dual-trigger behavior explicitly in the tool description and bootstrap logs, or (b) drop the next_steps trigger (it was likely added to help "cold starts" but now creates surprise). Confidence not high enough to recommend which — flag for operator decision.
- **Risk if unfixed:** Minor — bounded by the 2-doc cap.

### FINDING-12: `bytes_delivered` accounting overstates actual response payload by prefetch doc size minus summary size
- **Severity:** LOW
- **Dimension:** 3
- **File(s):** `src/tools/bootstrap.ts:369-376`
- **Observation:** At `bootstrap.ts:374`: `bytesDelivered += resolved.content.length;` — the FULL prefetched document byte count is added to the response's `bytes_delivered` field. But the actual response at line 549 contains only `prefetchedDocuments[].summary` (first 500 chars + headers from `summarizeMarkdown` at `src/utils/summarizer.ts:10-18`), not the full content. So for PF-v2 with a 45KB architecture.md prefetch, `bytes_delivered` reports ~45KB more than the response actually delivers.
- **Impact:** The S39-measured `bytes_delivered: 42417` for PF-v2 bootstrap is misleading — actual payload is likely closer to ~39KB if no prefetch occurred, or 39KB + ~2KB summary if a prefetch did occur. This accounting bug confuses capacity planning against the 100KB response limit (`bootstrap.ts:603-607`).
- **Recommendation:** Change to `bytesDelivered += summary.length;` at line 374, or rename the field to `source_bytes_scanned` and add a separate `response_bytes` field. Minor — purely observability hygiene.
- **Risk if unfixed:** Bytes-delivered metric stays misleading; unlikely to cause operational harm.

### FINDING-13: Prefetch is parallel but each path does up to 2 sequential fetches (`.prism/` then legacy root)
- **Severity:** LOW
- **Dimension:** 3
- **File(s):** `src/tools/bootstrap.ts:364-380`, `src/utils/doc-resolver.ts:19-39`
- **Observation:** `prefetchPromise = Promise.all(prefetchPaths.map(async (filePath) => await resolveDocPath(...)))` — parallel at the top. But `resolveDocPath` (`doc-resolver.ts:19-39`) tries `.prism/{docName}` first and, on 404, falls back to `{docName}` at root. That's two sequential API calls per document on legacy repos, one call on migrated repos. With the 2-doc cap, worst case is 4 API calls — still bounded.
- **Impact:** Legacy repos pay a 2× cost on prefetch. All PRISM projects are migrated per D-67, so this is theoretical now, but the code is still present.
- **Recommendation:** The `resolveDocFilesOptimized` utility at `doc-resolver.ts:93-146` already solves this with a single `listDirectory` call — but prefetch uses the slower `resolveDocPath`. Migrate prefetch to the optimized path once repos are fully confirmed on `.prism/`.
- **Risk if unfixed:** Minor. Scheduled cleanup — not urgent.

---

## Dimension 4: Document Growth

### FINDING-14: `session-log.md` and `insights.md` have no automatic archival; grow unbounded
- **Severity:** HIGH
- **Dimension:** 4
- **File(s):** `src/tools/log-insight.ts:75-81`, `src/tools/scale.ts:626-667` (session-log append), `src/tools/finalize.ts:417-548` (commit replaces with operator content)
- **Observation:** I traced every write path for the 10 mandatory docs:
  - `handoff.md` — replaced wholesale by `prism_finalize commit`; backup/prune policy at `finalize.ts:362-411` keeps only last 3 versions. **GOOD.**
  - `decisions/_INDEX.md` — appended row-by-row by `prism_log_decision` at `log-decision.ts:122-130`; no dedup, no pruning.
  - `decisions/{domain}.md` — appended by `prism_log_decision` at `log-decision.ts:161-165`; no archival.
  - `session-log.md` — appended to by `prism_scale_handoff` (extracted handoff session history) and by operator content pushed through `prism_finalize commit`. **No server-side archival.**
  - `task-queue.md` — operator-controlled via `prism_finalize commit` (full replace) or `prism_patch` (section ops). Size depends on operator discipline. No server truncation.
  - `eliminated.md` — extracted-to by `prism_scale_handoff` (appended), replaced by finalize commit.
  - `architecture.md` — replaced by finalize commit AND appended to by scale_handoff. See FINDING-15.
  - `glossary.md` — only replaced by finalize commit. Grows only via operator discipline.
  - `known-issues.md` — only replaced by finalize commit. Same.
  - `insights.md` — appended to by `prism_log_insight` at `log-insight.ts:75-81`: inserts new entry into `## Active` section. **No server-side archival. Standing rules accumulate across all 172+ sessions.**
  - `intelligence-brief.md` — fully replaced by synthesis. Bounded by the 2000-4000 token instruction in `ai/prompts.ts:41`.
  
  **The operator's data**: PF-v2 at S172 has `insights.md` 34.8KB and `session-log.md` 29.8KB — both unbounded-growth docs. That's a 3-year-old project accumulating everything ever learned.
- **Impact:** On mature projects, insights.md dominates the bootstrap payload (extractStandingRules runs over 34.8KB at `bootstrap.ts:446`). session-log.md dominates draft context (included in `DRAFT_RELEVANT_DOCS` at `finalize.ts:273-275`). Both inflate the synthesis input — directly driving the 99.6s PF-v2 synthesis time. **This is a principal contributor to mature-project synthesis slowness.**
- **Recommendation:** Introduce a lifecycle at `prism_log_insight` and during `commit` for session-log. Proposed shape:
  - At `log-insight.ts`: when `insights.md` exceeds 20KB AND a new insight is added, migrate all entries older than 50 sessions from `## Active` to a new `.prism/insights-archive.md`. Keep standing rules regardless of age.
  - At `finalize.ts commit`: when `session-log.md` exceeds 20KB, migrate session entries older than 30 sessions to `.prism/session-log-archive.md`.
  - The framework already reserves both archive paths at `src/utils/doc-guard.ts:77-78`, confirming the design intent was there but never implemented.
  
  Do NOT touch decisions/_INDEX.md — per CLAUDE.md: "Decision registry (NEVER compressed or deleted)."
- **Risk if unfixed:** Mature projects approach handoff-sized bloat across multiple files, each compounding synthesis token cost. S39's "~13s per 10K input tokens" model means every extra 10KB of insights costs ~1.3s per synthesis, forever. Compounds the FINDING-5 client-timeout crisis.

### FINDING-15: `architecture.md` has a dual-write pattern that encourages accumulation
- **Severity:** MEDIUM
- **Dimension:** 4
- **File(s):** `src/tools/scale.ts:421-438, 542-567`, `src/tools/finalize.ts` (commit phase)
- **Observation:** `prism_scale_handoff` appends extracted sections to `architecture.md` in two cases (`scale.ts:421-438` for "Artifacts Registry" sections >2KB, and `scale.ts:542-567` for "Architecture" sections >2KB). The appended content (`scale.ts:657-666`) is accumulated in `destinationContent` and pushed to architecture.md. Separately, `prism_finalize commit` REPLACES architecture.md wholesale if the operator includes it in the `files` array. There is no dedup or reconciliation between these two paths — a scale_handoff run followed by a finalize that doesn't include an architecture.md file leaves the appended content in place; a scale_handoff followed by a finalize that DOES include architecture.md silently discards the scaled content.
- **Impact:** PF-v2's `architecture.md` at 45.8KB is consistent with extended extraction over many scale_handoff runs without corresponding operator cleanup. The "replace wholesale" model discourages operators from carrying forward everything, but the scale.ts append model silently grows the file.
- **Recommendation:** Either (a) make `scale.ts` insert extracted content into a CLEARLY-marked section (e.g. `## Extracted from Handoff S{N}`) so operators know what to consolidate, or (b) on finalize commit, if architecture.md is in the files array, check for scaled-but-unconsolidated markers and warn. This is a design question — flag for operator.
- **Risk if unfixed:** architecture.md continues monotonic growth on scale-heavy projects.

### FINDING-16: `prism_scale_handoff` scope is narrow — cannot rescale mature insights/task-queue/known-issues/glossary
- **Severity:** MEDIUM
- **Dimension:** 4
- **File(s):** `src/tools/scale.ts:380-567`
- **Observation:** scale_handoff's action list (`scale.ts:380-567`) writes to exactly 5 destinations: `decisions/_INDEX.md`, `session-log.md`, `architecture.md`, `eliminated.md`, and `handoff.md` itself. It does NOT touch `task-queue.md`, `insights.md`, `known-issues.md`, `glossary.md`, or `intelligence-brief.md`. This was presumably deliberate (scale_handoff is "scale the HANDOFF, not everything") but means there is no analogous scaling tool for the other docs when they bloat — on PF-v2 the insights.md (34.8KB) and glossary.md (32.4KB) will never be touched by automation.
- **Impact:** The scaling mechanism is single-purpose. Aligns with FINDING-14 — the framework lacks any lifecycle management for the append-only docs beyond the single scale_handoff entry point.
- **Recommendation:** Either expand scale_handoff to an optional `target_doc` parameter that can condense insights.md / session-log.md / known-issues.md against analogous size thresholds, or add a new tool `prism_compact_docs` with similar shape. Out-of-audit-scope — flag only.
- **Risk if unfixed:** Operator must manually edit insights.md / glossary.md / etc. to stay under size thresholds. PRISM framework mission statement is "structured external memory" — unbounded growth undermines it.

### FINDING-17: `*-archive.md` paths are reserved in `doc-guard` but no code creates or manages them
- **Severity:** LOW
- **Dimension:** 4
- **File(s):** `src/utils/doc-guard.ts:77-80`
- **Observation:** KNOWN_PRISM_PATHS includes `session-log-archive.md`, `known-issues-archive.md`, `build-history-archive.md`. A grep of `src/` confirms no server-side code ever writes to these paths. The guard would correctly redirect a push targeting these paths to `.prism/...`, but no tool actually executes such a push.
- **Impact:** Nothing operational. Legacy design artifact — the archive lifecycle was considered and partially encoded (path protection) but never implemented (tools that write archives).
- **Recommendation:** Implement the archive writers as part of FINDING-14's recommendation, OR remove the unused archive paths from `doc-guard.ts` to reduce the illusion that archival exists.
- **Risk if unfixed:** Confusing to new contributors; negligible.

### FINDING-18: Only `handoff-history/` has a pruning lifecycle
- **Severity:** LOW
- **Dimension:** 4
- **File(s):** `src/tools/finalize.ts:390-411`
- **Observation:** The only automatic archival lifecycle in the framework is `handoff-history/` pruning: keep the last 3 versioned handoff backups, delete older. No other document type has any analogous lifecycle.
- **Impact:** Reinforces FINDING-14. This is a single datapoint rather than a new finding per se — included for completeness of the Dimension 4 inventory.
- **Recommendation:** Use the handoff-history prune pattern as a template when implementing FINDING-14 archive lifecycles.
- **Risk if unfixed:** Already covered by FINDING-14.

---

## Findings Index

| ID | Severity | Dimension | Short Title | File(s) |
|---|---|---|---|---|
| FINDING-1 | CRITICAL | 1 | GraphQL log queries discard structured payloads | `src/railway/client.ts:336-395`, `src/railway/types.ts:33-37` |
| FINDING-2 | HIGH | 1 | Logger `level` vs. Railway `severity` field mismatch | `src/utils/logger.ts:19-42`, `src/railway/client.ts:404-417` |
| FINDING-3 | MEDIUM | 1 | `railway_logs` response has no channel for structured fields | `src/tools/railway-logs.ts:85-113`, `src/railway/types.ts` |
| FINDING-4 | LOW | 1 | `railway_logs` scope is single latest deployment | `src/tools/railway-logs.ts:69-101` |
| FINDING-5 | CRITICAL | 2 | Commit synthesis awaited inline, exceeds MCP client timeout | `src/tools/finalize.ts:573-609`, `src/config.ts:82` |
| FINDING-6 | HIGH | 2 | No overall finalize timeout; worst-case 170+ seconds | `src/tools/finalize.ts:62-629` |
| FINDING-7 | MEDIUM | 2 | Audit phase redundant/near-redundant GitHub calls | `src/tools/finalize.ts:62-256` |
| FINDING-8 | HIGH | 2 | Draft timeout too tight for PF-v2-scale projects | `src/tools/finalize.ts:273-346` |
| FINDING-9 | MEDIUM | 2 | Commit sequential-fallback has no overall timeout | `src/tools/finalize.ts:528-547` |
| FINDING-10 | LOW | 2 | `SYNTHESIS_TIMEOUT_MS` is hard-coded, not env var | `src/config.ts:82` |
| FINDING-11 | MEDIUM | 3 | Prefetch also triggers on `next_steps`, not only `opening_message` | `src/tools/bootstrap.ts:346-361` |
| FINDING-12 | LOW | 3 | `bytes_delivered` overstates response payload | `src/tools/bootstrap.ts:369-376` |
| FINDING-13 | LOW | 3 | Prefetch parallel but uses 2-try `resolveDocPath` | `src/tools/bootstrap.ts:364-380` |
| FINDING-14 | HIGH | 4 | `insights.md` and `session-log.md` unbounded growth | `src/tools/log-insight.ts:75-81`, `src/tools/scale.ts`, `src/tools/finalize.ts` |
| FINDING-15 | MEDIUM | 4 | `architecture.md` has conflicting dual write paths | `src/tools/scale.ts:421-438, 542-567`, `src/tools/finalize.ts` |
| FINDING-16 | MEDIUM | 4 | `prism_scale_handoff` scope is narrow | `src/tools/scale.ts:380-567` |
| FINDING-17 | LOW | 4 | `*-archive.md` paths reserved but unmanaged | `src/utils/doc-guard.ts:77-80` |
| FINDING-18 | LOW | 4 | Only `handoff-history/` has a pruning lifecycle | `src/tools/finalize.ts:390-411` |

---

## Methodology Notes

**Where evidence is strong (verified directly from code reads):**

- Every Dimension 1 finding is grounded in exact line references to the GraphQL query shape (`src/railway/client.ts:341-349` and `:379-387`) and the logger emission path (`src/utils/logger.ts:26-42`). No code dynamically modifies the field selection; the query is static. Confidence: HIGH.
- FINDING-5 timing claims come directly from CLAUDE.md's stated MCP client timeout (~60s) combined with the hard-coded `SYNTHESIS_TIMEOUT_MS = 120_000` at `config.ts:82` and the `await Promise.race` at `finalize.ts:582`. The code path is unambiguous. Confidence: HIGH.
- FINDING-14's document-growth claim is built by enumerating every `pushFile(...)` / `pushFile(projectSlug, ...)` call site under `src/tools/`. Each doc has exactly the write paths I listed. Confidence: HIGH.

**Where evidence has gaps (flagged explicitly below):**

1. **Railway GraphQL schema:** I did NOT run a live introspection query against `backboard.railway.app/graphql/v2` to confirm whether `Log.attributes` / `Log.tags` / `Log.payload` is the correct field name. The FINDING-1 recommendation is shape-correct but the exact field name may need adjustment at implementation time. The brief explicitly said not to re-measure — so this is a deliberate gap. A 30-second introspection query would close it.
2. **Actual MCP client timeout value:** CLAUDE.md says "~60 seconds" but the S39 measured data (PRISM 82.5s and PF-v2 99.6s) suggests the client must be holding longer than 60s to have received those responses at all. Possibilities: (a) the 60s figure is outdated and the current client holds 120s+; (b) the measurements were captured server-side from Railway logs with no corresponding client-side response (the operator may have only seen the logs, not the returned payload); (c) the Anthropic SDK or MCP SDK resets the timeout on the first byte flushed, and the server's JSON response streams out before the 60s mark. I treated (a) and (b) as equally plausible — FINDING-5 is severity CRITICAL regardless of which is true, because the 50s `MCP_SAFE_TIMEOUT` constant in the code explicitly commits to "all server-side operations must complete within 50s" and synthesis violates that. If the real client timeout is 120s, FINDING-5 downgrades to HIGH but the recommendation stands. The operator should verify on the next live finalize.
3. **PF-v2 draft token count:** I estimated 107KB → ~27K input tokens → ~35s based on the S39-reported ratio of ~13s/10K tokens. This is inferential, not measured. The "35s ± tail risk" framing in FINDING-8 depends on actual byte-to-token ratio for these specific PF-v2 documents (which vary by language density). The headline claim (draft can time out on PF-v2) holds even at median — but the exact threshold is estimated.
4. **Bootstrap real-world prefetch frequency:** I could not verify from code alone how often the `next_steps` fallback actually triggers a prefetch across 17 projects. FINDING-11 describes the mechanism honestly; quantifying the rate would need Railway log analysis.
5. **Scale.ts architecture append dedup:** I read scale.ts lines 421-438 and 542-567 and traced the destinationContent accumulation (lines 628-684). I did NOT trace whether a second scale_handoff run against the same project would re-extract the same content from handoff.md (unlikely — scale only extracts if the handoff STILL contains the bloated section, which it wouldn't after the first scale). So FINDING-15's "silently appends" risk is primarily about the architecture.md-replace-vs-append race between scale and finalize, not about serial scale runs. Reasonable confidence but not verified end-to-end.

**Where I chose not to dig further (out of scope per brief):**

- MCP authentication layer (out of scope unless implicated by Dimension 1 — it is not).
- KI-83/84/85/86 internal PF-v2 issues.
- Legacy `LEGACY_LIVING_DOCUMENTS` / `resolveDocPath` fallback removal (already in task queue per brief).
- Opus 4.7 migration status.

---

## Open Questions for Operator

1. **For FINDING-1 / FINDING-3 (Railway structured payloads):** Do you want me to run live GraphQL introspection against `backboard.railway.app/graphql/v2` in a follow-up session to pin down the exact field name (`attributes` vs `tags` vs `payload`)? Or will you run it once and embed the result in the next fix brief?
2. **For FINDING-5 (synthesis in commit path):** Do you prefer (A) always return-then-synthesize-in-background (simpler, loses the `synthesis_banner_html` on the commit response), or (B) progress-notification-keepalive during inline synthesis (preserves the banner, requires MCP SDK `extra` plumbing through `commitPhase`)? The two have different UX tradeoffs.
3. **For FINDING-11 (bootstrap dual-trigger):** Is the `next_steps`-based prefetch behavior intentional, or was it added speculatively? If intentional, should the tool description reflect it? If not, should it be removed?
4. **For FINDING-14 (archive lifecycle):** What are the correct thresholds for session-log.md / insights.md archival — 20KB, 30KB, 50KB? And how many sessions' worth of entries should remain in the live doc (30, 50, 100)? These are policy decisions that affect many projects.
5. **For FINDING-15 (architecture.md dual writes):** Is it acceptable for `scale_handoff` to ever modify architecture.md, or should architecture.md be "finalize-commit only" (operator-controlled) and scale_handoff should extract to a different destination like a new `.prism/extracted/` directory?
6. **For FINDING-10 (SYNTHESIS_TIMEOUT_MS):** Is this intentionally hard-coded for safety, or just a convenience? Converting it to an env var is trivial but adds one more knob to document.
7. **For Methodology Note 2 (real MCP client timeout):** Can you confirm what the actual claude.ai MCP client timeout is today? If it's ≥120s, FINDING-5 is still serious but less dire. If it's 60s, it's an operator-visible crisis on mature projects.

<!-- EOF: s39-observability-perf-audit.md -->
