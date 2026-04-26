# Phase 3b — CS-1 `draftPhase` Adaptive-Thinking Benchmark

> **Authored:** S72 (PRISM project main session, 04-26-26)
> **Target repo:** `brdonath1/prism-mcp-server`
> **Brief class:** combined audit-and-fix per INS-177 — verdict shape settled (pass/fail criteria explicit), fix scope bounded (one-line synthesize() arg, possibly one additional config-constant raise if benchmark forces it).
> **Rule grounding:** INS-180 (production-data sanity check before authoring), INS-182 (no graceful deferral on distinguishing steps), INS-163 (local CC default for execute-mode), INS-178 (incremental updates), D-159 (Phase 3a precedent).
> **Cost note:** This benchmark calls the live Anthropic Messages API 6 times (3 inputs × 2 conditions). Each call processes ~20–280KB of input and produces up to 8KB of output. Operator should expect ~$1–$3 in API spend on the prism-mcp-server's `ANTHROPIC_API_KEY`.

---

## 1. Objective

Determine whether enabling `thinking: { type: "adaptive" }` on the CS-1 `draftPhase` `synthesize()` call is safe (latency under the existing tool-level deadline, JSON contract preserved, max-tokens cap holds). If safe, flip the flag and ship. If not, push a no-flip evidence report.

The verdict shape is binary by construction — the benchmark either produces the data that says "flip" or "don't flip", and this brief explicitly forbids `INCONCLUSIVE` exits per INS-182.

---

## 2. Context (read first — do not skip)

Read these files before any code change. Do NOT re-derive from memory.

- `src/ai/client.ts` — `synthesize()` signature. Confirm 6th positional arg is `thinking?: boolean`. The function dispatches the legacy/adaptive distinction internally; `true` becomes `thinking: { type: "adaptive" }` on the request.
- `src/tools/finalize.ts` — locate the `draftPhase()` function. The current `synthesize()` call inside it has FIVE positional args: `synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, draftTimeoutMs, 0)`. There is no thinking arg.
- `src/ai/prompts.ts` — `FINALIZATION_DRAFT_PROMPT` and `buildFinalizationDraftMessage(projectSlug, sessionNumber, docMap, sessionCommits)`. These are exported and reusable for the benchmark.
- `src/config.ts` — confirm `FINALIZE_DRAFT_TIMEOUT_MS` (HTTP-level, 150s) and `FINALIZE_DRAFT_DEADLINE_MS` (tool-level wall-clock, 180s). Confirm `SYNTHESIS_MODEL` is `claude-opus-4-7`. Confirm `SYNTHESIS_MAX_OUTPUT_TOKENS` is 8192.
- `DRAFT_RELEVANT_DOCS` (exported from `src/tools/finalize.ts`) — the doc list draftPhase fetches: handoff, decisions/_INDEX, session-log, task-queue, eliminated, known-issues, insights. Excludes architecture, glossary, intelligence-brief, and all `-archive.md` files.

---

## 3. Known risk surface

Three things can fail:

1. **Latency.** Adaptive thinking adds reasoning time. CS-2 measured 131s on prism in S71; CS-3 measured 65s. CS-1's prompt is similar in size to CS-2 minus architecture/glossary/intelligence-brief. If max(thinking-on duration) exceeds 150s, the HTTP timeout fires; if it exceeds 180s, the tool-level deadline fires — both are user-facing failures.
2. **Max-tokens cap.** `draftPhase` hard-codes `maxTokens: 4096` as the 3rd positional arg to `synthesize()`. With thinking enabled, output token count INCLUDES thinking content blocks counted against `max_tokens`. CS-2's S71 smoke saw output_tokens=6377 — exceeding the prior 4096 ceiling, which is exactly why the synthesis bump went 4096 → 8192. The same risk applies to CS-1: if its output (text + thinking blocks) exceeds 4096, the response truncates mid-output and `extractJSON` fails. The brief's "one-line change" framing UNDERSTATES the risk surface — measure this.
3. **JSON contract.** `extractJSON` (defined in `src/tools/finalize.ts`, robust 4-strategy parser: direct → fence-stripped → brace-bounded → bracket-bounded) is what callers depend on. If thinking changes output shape (e.g., model wraps JSON differently), the parse fails.

---

## 4. Pre-flight (in-session, before benchmark runs)

The dispatching session (PRISM S72) closed three pre-flight gaps in-session:

- **Project candidates** — pre-identified by `prism_status` size scan. The benchmark MUST use these slugs:
  - SMALL: `dans-bagels-platform` (DRAFT_RELEVANT_DOCS sum ≈ 21KB)
  - MEDIUM: `paypal-aaa-arbitration` (≈ 104KB)
  - LARGE: `prism` (≈ 277KB; insights.md = 159KB single-handedly)
- **Call-site shape** — confirmed in §2 above; runner does NOT need to re-discover it.
- **Cost expectation** — surfaced above; runner does NOT defer the run on cost grounds.

If for any reason the benchmark CANNOT run against these three projects (e.g., one is missing required docs), ABORT the brief and push a markdown abort report to `briefs/results/phase-3b-aborted.md` naming the specific blocker. Do NOT substitute synthetic inputs — that would defeat the benchmark's purpose.

---

## 5. Benchmark script

Author `scripts/benchmark-phase-3b.ts` in the `prism-mcp-server` repo. Add it to `.gitignore` if not already covered (the script is local-only and should not commit). The script:

1. **Imports** from the production source (no copies):
   - `buildFinalizationDraftMessage` and `FINALIZATION_DRAFT_PROMPT` from `src/ai/prompts.ts`
   - `synthesize` from `src/ai/client.ts`
   - `resolveDocFiles` from `src/utils/doc-resolver.ts`
   - `DRAFT_RELEVANT_DOCS` from `src/tools/finalize.ts`
   - `FINALIZE_DRAFT_TIMEOUT_MS` from `src/config.ts`
2. **Setup** — reads `GITHUB_PAT`, `GITHUB_OWNER`, `ANTHROPIC_API_KEY` from `.env` (use the repo's existing dotenv config). Confirm all three are present; abort with explicit error if any missing.
3. **Per-project loop** — for each slug in `["dans-bagels-platform", "paypal-aaa-arbitration", "prism"]`:
   - Fetch `DRAFT_RELEVANT_DOCS` via `resolveDocFiles(slug, [...DRAFT_RELEVANT_DOCS])`.
   - Skip session-commits collection (the production code best-effort fetches commits; benchmark can pass an empty array — production behavior degrades gracefully and benchmark is about prompt-shape representativeness, not commit-list fidelity).
   - Construct the user message via `buildFinalizationDraftMessage(slug, 999, docMap, [])`.
   - **Run condition A (baseline, thinking=false):**
     - Call `synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, FINALIZE_DRAFT_TIMEOUT_MS, 0)` — five positional args, exactly matching production.
     - Capture: wall-clock duration_ms, success, output_tokens (or null on failure), error text (if any), extractJSON outcome (success/failure + which strategy succeeded).
   - **Run condition B (thinking=true):**
     - Call `synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, FINALIZE_DRAFT_TIMEOUT_MS, 0, true)` — six positional args.
     - Capture same metrics.
   - Print interim row to stdout after each run so the operator can monitor progress.
4. **Output** — write a markdown report to `briefs/results/phase-3b-benchmark.md` (or stdout if writes fail) with:
   - A table of all 6 runs (project, condition, duration_ms, output_tokens, extractJSON_success, parse_strategy, content_bytes, error_text).
   - Aggregate row: max(duration thinking-on), max(output_tokens thinking-on), extractJSON success rate per condition.
   - A verdict line: PASS or FAIL based on the predicate in §6.
5. **Total runtime budget** — each call up to 150s. Worst case 6 × 150s = 15 minutes wall-clock. Local CC should NOT timeout on a script that runs that long; if you're uncertain, run the benchmark via `pnpm exec tsx scripts/benchmark-phase-3b.ts` with the script writing to a results file rather than blocking on stdout.

---

## 6. Decision predicate

PASS — ALL of these hold:
- All 6 runs complete without thrown exceptions.
- max(duration_ms) for thinking=true runs < 150_000 (HTTP timeout).
- max(output_tokens) for thinking=true runs ≤ 4096 (existing maxTokens cap is sufficient).
- extractJSON success rate (thinking=true) ≥ extractJSON success rate (thinking=false).

FAIL — any one of the above is false. Branch on the specific failure mode:
- **Latency exceeds 150s on any input:** don't flip. Report identifies which input(s) blew the budget. Do not propose a timeout raise — the 150s tool-level timeout is a deliberate UX decision (operator-blocking call site).
- **output_tokens exceeds 4096 on any input:** maxTokens cap insufficient. Report quantifies the overflow. Do NOT silently raise 4096 → 8192 in this dispatch. The decision to raise is the operator's — it changes the cost profile of every finalize draft. Report should propose the raise as a follow-up brief, not auto-execute.
- **extractJSON regression on any input:** don't flip. Report includes a snippet of the problematic output for diagnosis.

---

## 7. Action on PASS

1. Edit `src/tools/finalize.ts`. Locate the `synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096, draftTimeoutMs, 0,` line in `draftPhase()`. Append `true,` as the 6th positional arg with comment `// thinking: true — Phase 3b CS-1 adaptive-thinking flag (D-159 successor)`. Closing paren goes on the next line. Result:
   ```typescript
   const result = await synthesize(
     FINALIZATION_DRAFT_PROMPT,
     userMessage,
     4096,
     draftTimeoutMs,
     0, // maxRetries — retry storms on draft are worse than fast failure (S41)
     true, // thinking: true — Phase 3b CS-1 adaptive-thinking flag (D-159 successor)
   );
   ```
2. Run `pnpm test`. Expected: 715 tests pass + 1 pre-existing `cc-status.test.ts` env-stub failure (the Phase 1.5 baseline, unchanged from PR #15). Any DEVIATION from this baseline blocks the PR.
3. Open a PR titled `feat: enable adaptive thinking on CS-1 draftPhase (Phase 3b)`. PR body:
   - Link to the benchmark report at `briefs/results/phase-3b-benchmark.md`.
   - Inline the aggregate row from the report.
   - Note: this completes Phase 3b of the Framework Stabilization Initiative; CS-1 now matches CS-2 + CS-3 (Phase 3a, D-159) on adaptive thinking.
4. Push the benchmark report to the repo at `briefs/results/phase-3b-benchmark.md`. This is the FIRST commit in the PR (separate from the source change so the evidence trail is auditable).

---

## 8. Action on FAIL

1. **Do NOT modify `src/tools/finalize.ts`** or any source file.
2. Push the benchmark report to `briefs/results/phase-3b-benchmark.md` with the failure-mode analysis.
3. Open a PR titled `docs: Phase 3b benchmark results — DON'T FLIP, evidence`. PR body:
   - The aggregate row + the specific predicate(s) that failed.
   - The proposed follow-up (e.g., "raise maxTokens cap as a separate Phase 3b' brief; benchmark again").
   - Status: open for operator review. Do NOT merge.

---

## 9. Bounded scope (negative space)

Do NOT, in this dispatch:
- Modify `src/ai/client.ts`, `src/ai/synthesize.ts`, or `src/ai/prompts.ts`.
- Touch CS-2, CS-3, or CS-4 call sites (`generateIntelligenceBrief`, `generatePendingDocUpdates`, `dispatchTask`).
- Modify `FINALIZE_DRAFT_TIMEOUT_MS`, `FINALIZE_DRAFT_DEADLINE_MS`, or `SYNTHESIS_MODEL`.
- Raise the 4096 maxTokens cap in `draftPhase` (the cap-raise is operator-decision territory, see §6).
- Touch any production project's `.prism/` directory. The benchmark is read-only against project state.

---

## 10. Distinguishing-step audit (INS-182 self-check)

Distinguishing steps in this brief — each MUST run, no graceful-deferral exit:
- Step 5 (benchmark execution against all 3 projects, both conditions). The benchmark IS the verdict. If it can't run, the brief aborts (per §4).
- Step 6 (predicate evaluation). Mechanical given the data; but if the data isn't there, the brief aborts.

Informational steps (deferral acceptable, but the runner should still attempt them):
- Step 4 (in-session pre-flight). Already closed by the dispatching session.
- Step 7.2 (`pnpm test`). If the test runner has an unrelated failure, the runner can document it and proceed — the test harness is verification of the source edit, not of the benchmark.

If the runner finds itself writing `INCONCLUSIVE` or `DEFERRED` against any §5 or §6 step, the brief is misaligned with the runner's environment — STOP, report, do not proceed with a hollow verdict.

---

## 11. Closing

- This brief assumes the operator is at the keyboard for local CC (per INS-163).
- Approximate runtime: 15–25 minutes (mostly waiting on Anthropic API responses, especially the LARGE input case).
- Approximate API spend: $1–$3 on `ANTHROPIC_API_KEY`.
- On completion (PASS or FAIL path), the next PRISM session inherits the result via the merged PR or the open evidence PR.

<!-- EOF: phase-3b-cs1-thinking-benchmark.md -->
