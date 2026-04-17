# PRISM Framework Observability & Performance Audit — S39

> **Brief type:** AUDIT-ONLY. No code changes. Report only.
> **Source:** PRISM Session 39 (04-17-26). Drafted by Claude (Opus 4.7) based on measured data from live synthesis + bootstrap calls against prism (80KB docs) and platformforge-v2 (204KB docs).
> **Target repo:** `brdonath1/prism-mcp-server`
> **Deliverable:** One markdown report at `reports/s39-observability-perf-audit.md`.

---

## Mission

Perform a structured audit of four specific dimensions of the PRISM framework's runtime behavior. Produce a written report with severity-labeled findings. **Change no code. Fix no bugs you find. Describe them.**

If during the audit you identify a finding that seems urgent enough to fix inline, STOP — describe it in the report with severity `CRITICAL` and move on. The operator decides what to fix, in a separate brief.

---

## Launch Command

```bash
cd ~/Desktop/Development/prism-mcp-server && git fetch origin && git reset --hard origin/main && claude --dangerously-skip-permissions --model claude-opus-4-7 --effort max
```

Then paste: `Read briefs/s39-observability-perf-audit.md and execute it fully. Produce the report at reports/s39-observability-perf-audit.md. Do not modify any other file. Do not open a PR. Exit when the report is written.`

---

## Context — What Triggered This Audit

PRISM S39 investigated reports from the operator that "every single thing takes forever" when working in PF-v2 and alterra-design-llc. Live measurement in S39 found:

- PRISM synthesis (80 KB docs): 82.5 seconds
- PF-v2 synthesis (204 KB docs, 75,912 input tokens): 99.6 seconds
- PF-v2 bootstrap: server-side log events completed in <1ms (likely fast overall; round-trip not instrumented)
- Cross-project health: 22 projects tracked, 10 critical / 6 needs-attention / 6 healthy
- Synthesis timing model: ~13 s per 10K input tokens, with substantial fixed overhead

The data does NOT support synthesis or bootstrap being the primary slowness cause. The most likely actual contributors are: (1) observability blind spots hiding real errors from diagnosis, (2) cumulative client-side inference latency as session context fills with large prefetched docs, (3) finalization total time (not just synthesis), (4) accumulated document mass in mature projects.

This audit investigates dimensions (1), (3), and (4), plus a bonus dimension on document growth patterns.

---

## Measured Data (Reference — DO NOT Re-Measure)

| Metric | Value | Source |
|---|---|---|
| PRISM synthesis duration | 82.5 s | Railway deploy `556ab6ff` logs, 2026-04-17 15:40:20 → 15:41:39 UTC |
| PF-v2 synthesis duration | 99.6 s | Same deploy, 2026-04-17 15:53:43 → 15:55:22 UTC |
| PRISM synthesis input | 30,950 tokens | `prism_synthesize` response |
| PF-v2 synthesis input | 75,912 tokens | `prism_synthesize` response |
| PF-v2 bootstrap payload | 42,417 bytes | `prism_bootstrap` response `bytes_delivered` |
| PF-v2 boot token estimate | 5,613 + 5,000 + 2,500 = 13,113 | Same response `context_estimate` |
| PF-v2 living doc total | ~204 KB | `prism_status` detail sum |
| Largest single doc on PF-v2 | `architecture.md` @ 45,796 B | Same |

Known observability gap (from PF-v2 INS-125, S172): the `railway_logs` tool returns only top-level `message` fields, stripping JSON structured payloads. Error details, stack traces, and structured context are not reaching PRISM's investigations via this tool. **This is the #1 dimension of the audit.**

---

## Audit Dimensions

For each finding, use the template:

```
### FINDING-N: [Short title]
- **Severity:** CRITICAL / HIGH / MEDIUM / LOW
- **Dimension:** 1 / 2 / 3 / 4
- **File(s):** path:line-range
- **Observation:** what is.
- **Impact:** what this causes operationally.
- **Recommendation:** specific proposed fix (name files and functions). No code.
- **Risk if unfixed:** continuation cost.
```

Severity guide:
- **CRITICAL** — causes silent data loss, hidden production errors, or actively misleads debugging.
- **HIGH** — causes user-visible slowness or failure on current-scale projects.
- **MEDIUM** — will cause issues as projects grow; not biting yet.
- **LOW** — code hygiene, minor redundancy, documentation drift.

---

### Dimension 1: Railway Logs Observability Gap (INS-125)

**Known symptom (from PF-v2 S172):** the `railway_logs` tool strips JSON payloads from log entries, returning only the top-level `message` field. Structured error context is lost.

**Questions to answer:**

1. Find the Railway logs fetch implementation — `src/tools/railway.ts` or similar. Identify the Railway API query being issued (GraphQL `deploymentLogs` or equivalent).
2. Does the Railway API return structured log payloads, and is the tool discarding them during parsing?
3. Read `src/logger.ts` (or wherever PRISM emits logs from within its own handlers). How are multi-field log events serialized? Is it `console.log({...})` style, or `pino`/`winston` structured JSON? Is the full object reaching Railway's ingest?
4. If both sides are correct but the filter is the problem: what exactly does the Railway filter expression `@level:error` match against, and why does it not see structured fields?
5. Propose the minimum change needed to surface structured payloads via this tool. Do NOT implement it.

**Input files to read at minimum:**
- `src/tools/railway.ts` (or wherever `railway_logs` is implemented)
- `src/logger.ts` (or wherever logs are emitted)
- `src/tools/railway-api.ts` if Railway GraphQL client is isolated
- Any recent changes to these files (git log `--since="2 months ago"`)

### Dimension 2: Finalization Pipeline — What Does It Actually Do, and Where Does Time Go?

**Known data:** synthesis is ONE step of finalization. Total finalize time may be 2-3× synthesis time when other steps (audit, doc generation, multiple pushes) are included. No measurement exists.

**Questions to answer:**

1. Locate the finalization tool: `src/tools/finalize.ts` or `src/finalization/*`. Enumerate every step it performs, in order. For each step, name the files/APIs it touches.
2. Which steps are sequential and which could parallelize without breaking ordering constraints?
3. Are any steps redundant? (E.g., fetching the same file twice, running validation twice.)
4. What failure modes exist per step, and which are retried vs. fatal?
5. If an operator runs `prism_finalize` on PF-v2 at current doc sizes, estimate total time per step based on the S39 measured data table. Flag any step projected to exceed 60 seconds.
6. Identify the `SYNTHESIS_TIMEOUT_MS` env var read path. Confirm it's 120000 ms in production. Is there a similar timeout on the finalize call as a whole? If not, what happens if finalize runs for 5+ minutes?

### Dimension 3: Bootstrap Pre-Fetch Heuristics

**Known data:** PF-v2 bootstrap with `opening_message: "Begin next session"` returned `prefetched_documents: []`. Smart prefetch is conservative in this case.

**Questions to answer:**

1. Locate smart prefetch logic — likely `src/bootstrap/prefetch.ts` or inside `src/tools/bootstrap.ts`. What are the trigger conditions? (Keyword matching opening_message against handoff `next_steps`? Something else?)
2. What's the size cap per document and total? What happens on a large-project bootstrap when the opening message is keyword-rich ("update the architecture doc")?
3. Does the prefetcher fetch files in parallel or sequentially? If sequential with 5+ matches, that's several round-trips.
4. Is there a case where prefetch loads a 45 KB doc (like PF-v2's architecture.md) and delivers it in the bootstrap payload, pushing total `bytes_delivered` past ~90 KB? If so, that's a real client-side context load cost worth flagging.

### Dimension 4: Document Growth — Why Are Mature Projects' Docs Monolithic?

**Known data:** PF-v2 `architecture.md` is 45.8 KB. `insights.md` is 34.8 KB. `glossary.md` is 32.4 KB. `session-log.md` is 29.8 KB. These grew over 172 sessions.

**Questions to answer:**

1. Locate the write paths for each of the 10 mandatory living docs. How is content appended vs. replaced? Does any doc have an automatic archival or truncation lifecycle?
2. Architecture.md and glossary.md tend to be "replace in place" documents (state-describing), while session-log.md and insights.md are append-only. Confirm this pattern in the code. Then: is there a pattern where architecture.md is accumulating stale content because there's no "remove obsolete" protocol?
3. Does `prism_scale_handoff` touch any of these other documents, or just `handoff.md`?
4. Propose (do not implement) a lifecycle for the append-only docs: at what threshold does content migrate to an archive subdirectory, and what remains in the live doc?

---

## Output: Report Format

Write the final report to: `reports/s39-observability-perf-audit.md`

**Report structure:**

```markdown
# S39 Framework Observability & Performance Audit

## Executive Summary
[3-5 sentences. Total findings count. Critical count. Top 3 recommendations by severity.]

## Dimension 1: Railway Logs Observability
[Findings as per template above.]

## Dimension 2: Finalization Pipeline
[Findings.]

## Dimension 3: Bootstrap Pre-Fetch
[Findings.]

## Dimension 4: Document Growth
[Findings.]

## Findings Index
[Table: FINDING-N | Severity | Dimension | Short title | File]

## Methodology Notes
[Any places where you couldn't fully answer a question, or evidence was ambiguous. Be explicit about uncertainty.]

## Open Questions for Operator
[Things that need human decision before a fix brief can be written.]
```

---

## Out of Scope — Do Not Audit

- **KI-83, KI-84, KI-85, KI-86** (PF-v2 internal issues). Those are the operator's active problems in PF-v2 itself and will be handled in a PF-v2 session.
- **Opus 4.7 migration status.** D-77 (PRISM) and D-139 (PF-v2) already handled the model bump. Do not re-audit model references.
- **The MCP server's authentication layer** unless Dimension 1 findings directly implicate it.
- **Deferred legacy cleanup** items (Phase 4 fallback removal, `LEGACY_LIVING_DOCUMENTS`, `resolveDocPath`) — these are already in the task queue, not in this audit.

---

## Completion Criteria

You are done when ALL of the following are true:

1. `reports/s39-observability-perf-audit.md` exists, follows the structure above, and ends with the EOF sentinel comment.
2. Every finding uses the template and has a severity label.
3. The Findings Index table is present and complete.
4. No files outside `reports/s39-observability-perf-audit.md` have been modified. Verify with `git status` — only one untracked file should appear.
5. No commits have been pushed. No PRs opened.
6. The Methodology Notes section honestly records anywhere you were uncertain or could not fully verify.

If you finish the report in under 20 minutes of wall time, go back and strengthen the weakest-evidence finding — add code references, re-read the file, quote exact lines. Errors here waste operator time.

---

## Finishing Up

After writing the report, run:

```bash
git add reports/s39-observability-perf-audit.md && git commit -m "docs: s39 observability and perf audit report" && git push origin main
```

Then exit. Do not start on any findings. Do not propose follow-up briefs.

<!-- EOF: s39-observability-perf-audit.md -->
