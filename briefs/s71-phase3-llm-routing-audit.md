# Brief — S71 Phase 3 Meta-Audit: Per-Task LLM Routing Surface Mapping

> **Brief type:** Audit-only (no source code modifications, single audit document output).
> **Authored:** PRISM S71 (04-26-26).
> **Target repo:** brdonath1/prism-mcp-server.
> **Output:** `audits/s71-phase3-llm-routing-audit.md` — single PR, single new file.
> **Estimated runtime:** 30–60 minutes wall-clock (read-heavy, minimal generation).

## 1. Context

PRISM's Framework Stabilization Initiative (D-151, prism repo) reaches **Phase 3 — Per-task LLM routing**. Phases 0a, 0b, 1, 1.5, and 2 are complete. Phase 3 has carried as a single-line entry in `task-queue.md` and `architecture.md` with no design document, no target inventory, and no exit criteria.

**Operator goal (S71):** leverage the Claude Max 20x subscription quota (OAuth-authenticated) as broadly as possible across PRISM's internal LLM workloads to reduce per-token API spend, **without sacrificing speed, quality, or precision**.

**Verification gap to close.** D-146 (prism, S56) established that Anthropic's Messages API rejects OAuth tokens for direct programmatic access — citing two GitHub issues (anthropics/claude-code #28091 and #37205) and a 2026-02-20 enforcement event. As a result, `src/ai/` was deliberately left on `ANTHROPIC_API_KEY` while `cc_dispatch` migrated to `CLAUDE_CODE_OAUTH_TOKEN`. Approximately 5 months have elapsed; the policy may have shifted. The audit must verify current behavior empirically (Step 1) rather than trust the stale snapshot.

**Why this is an audit, not a fix.** Per INS-177, when verdict shape is uncertain, audit and fix must be separated. Phase 3's verdict is genuinely unknown:

- **A.** Single shared internal-CC primitive — all candidate sites converge on a `dispatchInternalCC()` function.
- **B.** Per-site case-by-case — no shared primitive, independent migrations.
- **C.** Hybrid — some sites migrate via subprocess, some via auth swap (if Step 1 permits), some stay on API.
- **D.** Phase 3 collapses — OAuth boundary holds AND subprocess overhead dominates → no productive intervention.

Verdict D is a valid outcome. Combining audit and fix would short-circuit D, which is the highest-value finding to surface early.

**Operator constraints driving §6 verdict criteria:**

1. No quality/precision regression on user-visible output (intelligence brief, draft-phase output).
2. No latency regression on user-visible call sites (draft phase blocks finalize commit; synthesis is fire-and-forget per D-78).
3. Maximum OAuth quota utilization for non-user-visible / fire-and-forget call sites.

## 2. Pre-flight (mandatory before §3 — INS-33 + INS-180)

Verify inputs contain the target class before assuming the audit's premise holds.

```bash
grep -rn "@anthropic-ai/sdk\|anthropic\.messages\|api\.anthropic\.com\|child_process.*claude\|spawn.*claude" src/ | wc -l
```
— must be ≥ 1. If 0, the audit's premise is wrong; abort and report.

```bash
ls src/ai/ 2>/dev/null
```
— must list at least one file (architecture.md asserts `src/ai/` exists).

```bash
grep -E "@anthropic-ai/sdk|@anthropic-ai/claude-code" package.json
```
— capture exact installed versions for §3 grounding.

Capture all pre-flight outputs verbatim in §1 ("Pre-flight Evidence") of the audit document.

## 3. Steps

### Step 1: Live OAuth-on-Messages-API test (closes D-146 verification gap)

Send a minimal authenticated POST to `https://api.anthropic.com/v1/messages` using an OAuth token, and record the exact response.

Implementation:

1. Confirm `CLAUDE_CODE_OAUTH_TOKEN` is available in local env: `echo "${CLAUDE_CODE_OAUTH_TOKEN:+set}"` should print `set`. If not, run `claude setup-token` (operator-interactive) and re-export.
2. Write a single-purpose Node script at `/tmp/oauth-test.mjs` (do NOT commit) using the project's installed `@anthropic-ai/sdk`. The script should send a minimal user message (`max_tokens: 32`, prompt: `"Reply with the literal token 'OK' and nothing else."`) using whatever model identifier `src/ai/` currently uses (read it from source, do not assume). Test twice:
   - **Test A:** instantiate `new Anthropic({ apiKey: process.env.CLAUDE_CODE_OAUTH_TOKEN })`. Capture HTTP status, response body (first 500 chars), error type/message if any.
   - **Test B (control):** instantiate `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })`. Same capture. This confirms the test path itself works.
3. If neither token is available in the local env, document explicitly and mark Step 1 as `INCONCLUSIVE` — but state the exact reason. Do not fabricate a result.
4. Delete `/tmp/oauth-test.mjs` before committing.

Record the exact result in §3.1 of the audit document. **Do not infer — record what actually happened.**

If Test A returns success (200 with content): **OAuth boundary has relaxed.** Auth swap becomes viable for `src/ai/` — note this prominently as it materially changes §6 verdict shape.

If Test A returns 401/403/policy-rejection: **D-146 finding still holds.** Subprocess path is the only OAuth route for Messages-API workloads.

### Step 2: Enumerate all internal LLM call sites

Grep-driven inventory across `src/`. Run each pattern and capture matches with line numbers:

```bash
grep -rn "import.*@anthropic-ai/sdk" src/
grep -rn "\.messages\.create(" src/
grep -rn "fetch.*api\.anthropic\.com" src/
grep -rn "child_process" src/ | grep -i claude
grep -rn "spawn(" src/ | grep -i claude
grep -rn "@anthropic-ai/claude-code" src/
```

For each unique match, capture: file path, line number, enclosing function/method name, and a one-sentence description of what task it serves (e.g., "intelligence-brief synthesis", "finalize draft phase", "cc_dispatch CC subprocess spawn", etc.). Include grep counts in the audit output (per INS-166).

De-duplicate: a single function with multiple internal calls counts as one call site, but list every line.

### Step 3: Per-site characterization table

Produce a Markdown table with one row per call site enumerated in Step 2. Columns:

| File:line | Function | Task class | Criticality | Input shape | Output shape | Current model | Auth path | Latency budget | Frequency |

Definitions:

- **Task class:** `synthesis` / `draft` / `cc_dispatch_spawn` / `other (specify)`.
- **Criticality:** `blocks-operator` (user is waiting on this call) / `fire-and-forget` (background) / `synchronous-fast` (in-line, <5s expected).
- **Input shape:** approximate token count or KB range; cite source (e.g., "all 10 living docs filtered per D-69, ~30–60KB").
- **Output shape:** `structured (JSON)` / `freeform markdown` / `file deltas`.
- **Current model:** exact model string from code, or `"configurable via env"` with the env-var name.
- **Auth path:** `API key` / `OAuth` / `N/A`.
- **Latency budget:** observed or designed ceiling (cite D-71 timeout scaling, etc.).
- **Frequency:** `per-finalize` / `per-bootstrap` / `per-tool-call` / `per-session` / `on-demand`.

Values for every cell must trace to source-of-truth file reads or production logs — not assumptions.

### Step 4: Production data — Railway logs

Pull last 30 days of Railway logs for the `prism-mcp-server` service. Specific extracts:

1. **Synthesis durations.** Filter for `synthesis`, `intelligence brief`, `synthesize`, `prism_synthesize`. Extract `duration_ms` or equivalent timing fields. Report min / median / p95 / max with sample size.
2. **Draft-phase durations.** Filter for `draftPhase`, `draft phase`, finalize-related markers. Same statistics.
3. **LLM error patterns.** Filter for `anthropic`, `401`, `403`, `429`, `rate_limit`, `OAuth`, `ANTHROPIC_API_KEY`, `policy`. Categorize unique error signatures by frequency.
4. **Token / cost signals.** Any usage-token or cost-related log lines.

If the audit runner does not have Railway API access (no `RAILWAY_API_TOKEN` exposed to the local CC env), document this and mark Step 4 as **`DEFERRED — pending operator-side log pull`**. Do not fabricate. Note in §6 verdict reasoning that Step 4 was deferred and what conclusions are downgraded as a result.

### Step 5: Per-candidate migration shape

For each call site identified in Step 2 as a routing candidate, produce a sub-section with:

**Exclusion rules first:**

- Exclude `cc_dispatch` itself (already on OAuth — D-146).
- Exclude any site where Step 3 marks `blocks-operator` with a tight latency budget AND Step 1 returned rejection (subprocess overhead would regress user latency).
- Document each exclusion explicitly in the audit.

For each non-excluded candidate:

- **Migration option A (auth swap):** Viable only if Step 1 returned acceptance. Effort: trivial (env var rename or auth-source swap). Risk: minimal if Test A succeeded.
- **Migration option B (CC subprocess via internal-CC primitive):** Spawn `claude --print` (or the SDK equivalent) with a constructed prompt; parse response. Effort: moderate (new wrapper + prompt-engineering for structured output). Risk: subprocess overhead (estimate ~10–30s cold start; needs measurement).
- **Migration option C (status quo):** Stay on API key. Cost: ongoing per-token spend. Risk: operator goal unmet for this site.
- **Speed/cost/quality tradeoff:** Quantitative where Step 4 supplies data; qualitative otherwise. Be explicit about which.
- **Quality preservation strategy:** How to validate the migrated output equivalence. Options: side-by-side comparison test, golden-fixture test, operator manual review for first N invocations. Pick the appropriate one and justify.

### Step 6: Verdict

State explicit verdict letter (A/B/C/D) on its own line under a `## Verdict` heading, followed by a reasoning paragraph that:

- Cites Step 1 result (auth swap viability — yes/no/inconclusive).
- Cites Step 2 inventory count (exact number of call sites).
- Cites Step 4 production data, OR states explicitly that Step 4 was deferred and which verdict components rely on missing data.
- Cites at least 2 specific Step 5 candidate analyses by name.
- Explicitly evaluates against each operator constraint from §1 (no quality regression, no latency regression on user-visible sites, maximum OAuth utilization where safe).

**Verdict D is a valid outcome.** Do not avoid concluding D if the evidence supports it.

### Step 7: Brief skeleton sketch

For the chosen verdict, sketch the structure of the next brief (the fix brief). Include:

- File targets (exact paths to modify).
- Primitive shape (if A or C) — function signature, where it lives, what it abstracts.
- Verification gates (grep counts, smoke-test shape, behavioral assertions).
- Quality-preservation mechanism (how the next brief proves no regression on output equivalence).

**Do NOT write code. Do NOT commit any source changes.** Sketch only, in bulleted structural form.

If Verdict = D, Step 7 documents what alternative work would replace Phase 3 (re-scope, defer, or close).

## 4. Verification (mandatory — INS-166)

Verification predicates must be computable against the audit file. Run these as the FINAL action and quote outputs verbatim in the PR body:

1. `grep -c "^### Step" audits/s71-phase3-llm-routing-audit.md` → must be **≥ 7** (one heading per audit step).
2. `grep -c "^| " audits/s71-phase3-llm-routing-audit.md` → must be **≥ (call-site count from Step 2 + 6)** (Step 3 table + Step 5 sub-tables).
3. `grep -c "^## Verdict" audits/s71-phase3-llm-routing-audit.md` → must be **= 1**.
4. `grep -E "^[ABCD]\b" audits/s71-phase3-llm-routing-audit.md | head -1` → must produce a verdict letter on its own line under the Verdict heading.
5. `grep -E "HTTP|status|401|403|200|INCONCLUSIVE" audits/s71-phase3-llm-routing-audit.md` → must produce at least one match in §3.1 (Step 1 result).

If any predicate fails, fix the audit document before committing — do not commit a non-conforming audit.

## 5. Finishing Up

- Single PR on a new branch (suggested name: `audits/s71-phase3-llm-routing`).
- PR title: `audit: S71 Phase 3 LLM routing surface mapping`
- PR body must include: §6 verdict letter + reasoning summary + §4 verification grep outputs verbatim.
- Audit file at `audits/s71-phase3-llm-routing-audit.md` — exactly **one** file added.
- DO NOT modify anything under `src/`, `tests/`, `package.json`, or `package-lock.json`.
- DO NOT add new dependencies.
- DO NOT commit any throwaway test scripts from Step 1 (`/tmp/oauth-test.mjs` must be deleted).
- DO NOT run `npm test` or any build commands — read-only audit.

## 6. References

- D-146 (prism, S56) — cc_dispatch auth migration; Messages API OAuth rejection finding.
- D-151 (prism, S60) — Framework Stabilization Initiative adoption.
- D-154 (prism, S62) — Phase 1 meta-audit precedent (Verdict C structure; PR #11 squash `e981fde9`).
- D-156 (prism, S66) — Phase 2 design committed (precedent for shape of Phase-N design decisions).
- D-78 (prism, S39) — synthesis decoupled from finalize response path (fire-and-forget).
- D-69, D-71 (prism, S32–S33) — draft phase filtering and timeout scaling.
- INS-7 — brief-on-repo workflow.
- INS-32 — deep-dive before proposing framework fixes.
- INS-33 — zero-result inference; verify input contains target class before concluding tool/audit broken.
- INS-166 — verification claims must be computed against the brief's prescribed code.
- INS-177 — separate audit-then-fix when verdict shape uncertain.
- INS-180 — production-data grounding for spec authoring.

<!-- EOF: s71-phase3-llm-routing-audit.md -->
