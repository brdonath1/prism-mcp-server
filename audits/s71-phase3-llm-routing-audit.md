# Audit — S71 Phase 3: Per-Task LLM Routing Surface Mapping

> **Brief:** `briefs/s71-phase3-llm-routing-audit.md`
> **Audit type:** Read-only meta-audit; no source modifications.
> **Scope target:** `src/` of `brdonath1/prism-mcp-server`.
> **Authored:** 2026-04-26 (S71).

## §1 — Pre-flight Evidence

Per brief §2 (INS-33 / INS-180): verify the audit's premise (that LLM call sites
exist in `src/`) before continuing. All commands run from repo root.

### Pre-flight #1 — target-class hit count (must be ≥ 1)

```
$ grep -rn "@anthropic-ai/sdk\|anthropic\.messages\|api\.anthropic\.com\|child_process.*claude\|spawn.*claude" src/ | wc -l
3
```

Verbatim hits (for context — used in Step 2 below):

```
src/claude-code/client.ts:17: * - The SDK spawns the `claude` CLI as a subprocess, so `pathToClaudeCodeExecutable`
src/ai/client.ts:6:import Anthropic from "@anthropic-ai/sdk";
src/ai/client.ts:62:    const response = await anthropic.messages.create(
```

Result: **3 ≥ 1 — premise holds.** The first hit is a comment in
`src/claude-code/client.ts` rather than a runtime LLM call; the actual subprocess
spawn happens inside `query()` from `@anthropic-ai/claude-agent-sdk` (covered
under grep pattern P6 in Step 2).

### Pre-flight #2 — `src/ai/` exists

```
$ ls src/ai/
client.ts
prompts.ts
synthesis-tracker.ts
synthesize.ts
```

Result: **4 files present** — matches `architecture.md`'s assertion that
`src/ai/` is the AI client module.

### Pre-flight #3 — installed Anthropic SDK versions

```
$ grep -E "@anthropic-ai/sdk|@anthropic-ai/claude-code" package.json
    "@anthropic-ai/claude-code": "latest",
    "@anthropic-ai/sdk": "^0.81.0",
```

(Note: `@anthropic-ai/claude-agent-sdk` is also imported in
`src/claude-code/client.ts:28` — captured in Step 2 / P6.)

Pre-flight passes. Proceed to Steps.

## §2 — Audit Steps

### Step 1 — Live OAuth-on-Messages-API test (D-146 verification gap)

**Purpose:** empirically confirm whether Anthropic's Messages API still rejects
OAuth tokens (as captured in D-146, S56, ~5 months prior to this audit).

#### §3.1 — Result

**Result: `INCONCLUSIVE`.**

**Reason (verbatim shell capture):**

```
$ echo "OAUTH=${CLAUDE_CODE_OAUTH_TOKEN:+set}"; echo "APIKEY=${ANTHROPIC_API_KEY:+set}"
OAUTH=
APIKEY=
```

Neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is exported into the
local environment in which this audit was executed. Per brief §3.1 step 3:

> If neither token is available in the local env, document explicitly and mark
> Step 1 as `INCONCLUSIVE` — but state the exact reason. Do not fabricate a
> result.

The brief's contingency for an absent OAuth token (`run \`claude setup-token\`
(operator-interactive) and re-export`) requires interactive operator input,
which is not available to this audit runner. No HTTP request was sent. No
status code (200 / 401 / 403) was observed. Test A (OAuth) and Test B (API key
control) were both skipped.

**No `/tmp/oauth-test.mjs` was created** (the brief instructed creation only
when at least one token was available; with zero tokens the script would have
no purpose, and the brief forbids fabricated results).

**Downgrade impact on the rest of the audit:**

- Auth-swap viability for `src/ai/` (the path that would replace
  `ANTHROPIC_API_KEY` with `CLAUDE_CODE_OAUTH_TOKEN` in
  `new Anthropic({ apiKey })`) is **undetermined**.
- D-146's finding that OAuth → Messages API is rejected with 401/403 remains
  the most-recent grounded data point and is treated as the conservative
  default for §6 reasoning, but this audit cannot claim to have re-verified
  it.
- §6 verdict shape must explicitly account for the INCONCLUSIVE Step 1 result
  — see §6 reasoning paragraph.

**Action required for the next brief:** re-run Step 1 in an environment where
both tokens are exported (e.g., operator local shell after `claude setup-token`,
or Railway shell where both env vars exist). The result of that re-run is a
gating input for selecting between auth-swap and subprocess as the
implementation mechanism in any candidate site that requires OAuth.

### Step 2 — Internal LLM call-site inventory

**Method:** the six grep patterns from brief §3.2, run against `src/` from repo
root.

#### Verbatim grep output

```
=== P1: import @anthropic-ai/sdk ===
src/ai/client.ts:6:import Anthropic from "@anthropic-ai/sdk";

=== P2: .messages.create( ===
src/ai/client.ts:62:    const response = await anthropic.messages.create(

=== P3: fetch api.anthropic.com ===
(no matches)

=== P4: child_process | claude ===
src/claude-code/repo.ts:15:import { execFileSync } from "child_process";
src/claude-code/client.ts:29:import { execSync } from "child_process";

=== P5: spawn( | claude ===
(no matches)

=== P6: @anthropic-ai/claude-code ===
src/claude-code/client.ts:18: *   must resolve to the binary installed via `@anthropic-ai/claude-code`. The
```

#### Per-pattern counts (INS-166)

| Pattern | Hits |
|---------|------|
| P1 `import.*@anthropic-ai/sdk` | 1 |
| P2 `\.messages\.create(` | 1 |
| P3 `fetch.*api\.anthropic\.com` | 0 |
| P4 `child_process` ∩ /claude/i | 2 (path-based; see triage below) |
| P5 `spawn(` ∩ /claude/i | 0 |
| P6 `@anthropic-ai/claude-code` | 1 (comment ref) |

#### Triage of P4 / P6 hits

P4 returns two `child_process` imports, both inside `src/claude-code/` (so the
case-insensitive `claude` filter matches the file path, not the line content).
Direct read of those imports' usages:

- `src/claude-code/repo.ts:15` — `execFileSync` is used at lines 70, 81, 148 to
  invoke **`git`** (clone, head, etc.), not `claude`. Not an LLM call site.
- `src/claude-code/client.ts:29` — `execSync` is used at lines 93, 106, 112 to
  resolve and version-check the **`claude` CLI binary** (path discovery).
  Not an LLM call itself, but supports the actual subprocess LLM call further
  down (`query()` at line 265).

P6 hits a comment, not a runtime call. The actual runtime entry into the
Claude Code subprocess SDK is `import { query } from "@anthropic-ai/claude-agent-sdk"`
at `src/claude-code/client.ts:28`, which the audit-target pattern set did not
explicitly enumerate but which is the only true subprocess LLM dispatch path
in the codebase. It is included as a routing-candidate site below for
completeness.

#### Routing-candidate enumeration (de-duplicated by task context)

Per brief §3.2 dedup rule: a single primitive function is one site even if
multiple internal lines exist; distinct **task contexts** are distinct sites
because each represents an independent routing decision.

There are **two underlying primitives** in `src/`:

- **PRIM-1** — `synthesize()` in `src/ai/client.ts:40-104`, single
  `anthropic.messages.create()` call at line 62. Wraps the `@anthropic-ai/sdk`
  Messages API.
- **PRIM-2** — `dispatchTask()` in `src/claude-code/client.ts:201-378`, single
  `query()` invocation from `@anthropic-ai/claude-agent-sdk` at line 265.
  Spawns the `claude` CLI subprocess.

There are **four routing-candidate task contexts** that consume those
primitives:

| # | Task context (file:line) | Primitive |
|---|---|---|
| CS-1 | `src/tools/finalize.ts:396` (`draftPhase`) | PRIM-1 |
| CS-2 | `src/ai/synthesize.ts:84` (`generateIntelligenceBrief`) | PRIM-1 |
| CS-3 | `src/ai/synthesize.ts:245` (`generatePendingDocUpdates`) | PRIM-1 |
| CS-4 | `src/claude-code/client.ts:265` (`dispatchTask` → `query()`) | PRIM-2 |

**Final call-site count: 4** (CS-1, CS-2, CS-3, CS-4). This number is the
input to verification predicate #2 in §4.

### Step 3 — Per-site characterization

All values traced to source file reads on this branch (`audits/s71-phase3-llm-routing`).
Latency / frequency cells cite `src/config.ts` constants where applicable.

| File:line | Function | Task class | Criticality | Input shape | Output shape | Current model | Auth path | Latency budget | Frequency |
|---|---|---|---|---|---|---|---|---|---|
| `src/tools/finalize.ts:396` | `draftPhase` | draft | blocks-operator (finalize draft action awaits this; deadline-raced with `FINALIZE_DRAFT_DEADLINE_MS`) | 7 of 10 living docs (`DRAFT_RELEVANT_DOCS` excludes architecture.md, glossary.md, intelligence-brief.md, archives — `src/tools/finalize.ts:76-82`) plus session commit list (≤50, `src/tools/finalize.ts:359`); empirically ~10–40KB per S40 FINDING-14 reasoning | structured (JSON; parsed via `extractJSON` at `src/tools/finalize.ts:414`, fallback to `raw_content`) | `SYNTHESIS_MODEL` (env-overridable) — default `claude-opus-4-6` (`src/config.ts:72`) | API key (PRIM-1 / `ANTHROPIC_API_KEY`, see `src/ai/client.ts:13-17`) | draft call: `FINALIZE_DRAFT_TIMEOUT_MS` = 150 000ms (`src/config.ts:112-113`); outer race deadline `FINALIZE_DRAFT_DEADLINE_MS` = 180 000ms (`src/config.ts:119-120`); `maxRetries: 0` per S41 (`src/tools/finalize.ts:401`) | per-finalize (`action: "draft"` phase only) |
| `src/ai/synthesize.ts:84` | `generateIntelligenceBrief` | synthesis | fire-and-forget (D-78 / FINDING-5; dispatched via `void Promise.allSettled` at `src/tools/finalize.ts:722`) | 9 of 10 living docs (LIVING minus `intelligence-brief.md`, `src/ai/synthesize.ts:47`) plus up to 7 decision-domain files (`src/ai/synthesize.ts:51-59`); brief asserts ~30–60KB total | freeform markdown (six required H2 sections: Project State, Standing Rules & Workflows, Active Operational Knowledge, Recent Trajectory, Risk Flags, Quality Audit — `src/ai/synthesize.ts:99-106`) | `SYNTHESIS_MODEL` — default `claude-opus-4-6` | API key (PRIM-1) | `SYNTHESIS_TIMEOUT_MS` = 120 000ms (`src/config.ts:82`); no MCP-response coupling | per-finalize (commit phase, post-success) AND per-`prism_synthesize` invocation (manual / `mode=generate`) |
| `src/ai/synthesize.ts:245` | `generatePendingDocUpdates` | synthesis | fire-and-forget (parallel-dispatched alongside intelligence-brief, INS-178) | Same input bundle as CS-2 minus `pending-doc-updates.md` (`src/ai/synthesize.ts:203-205`); identical magnitude | freeform markdown (four required H2 sections: architecture.md, glossary.md, insights.md, No Updates Needed — `src/ai/synthesize.ts:266-271`) | `SYNTHESIS_MODEL` — default `claude-opus-4-6` | API key (PRIM-1) | `SYNTHESIS_TIMEOUT_MS` = 120 000ms | per-finalize (commit phase) AND per-`prism_synthesize generate` |
| `src/claude-code/client.ts:265` | `dispatchTask` (→ `query()`) | cc_dispatch_spawn | async-default (sync mode capped at `MCP_SAFE_TIMEOUT - 5_000` = 45 000ms; `async_mode: true` removes deadline) | freeform user prompt + cloned-repo working directory; agent harness loop (Read/Edit/Bash tool turns) | file deltas (commits, optional PR) | `CC_DISPATCH_MODEL` (env-overridable) — default `"opus"` (`src/config.ts:310`); `CC_DISPATCH_EFFORT="max"` (`src/config.ts:324`) | OAuth (`CLAUDE_CODE_OAUTH_TOKEN`; subprocess env scrubbed of `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` per `src/claude-code/client.ts:139-153`) | sync: `CC_DISPATCH_SYNC_TIMEOUT_MS` (default `MCP_SAFE_TIMEOUT - 5000` = 45 000ms, `src/config.ts:341`); async: caller-provided `timeoutMs` | on-demand (operator-triggered) |

**Cross-references:**

- `MCP_SAFE_TIMEOUT` = 50 000ms (`src/config.ts:53`).
- `SYNTHESIS_MAX_OUTPUT_TOKENS` = 4096 (`src/config.ts:78`); draft call passes
  `4096` explicitly at `src/tools/finalize.ts:399`.
- `SYNTHESIS_ENABLED` is a boolean derived from `ANTHROPIC_API_KEY` presence —
  every PRIM-1 call short-circuits to `{success: false, error_code: "DISABLED"}`
  when unset. There is no fallback model or alternative auth source today.

### Step 4 — Production data (Railway logs)

**Result: `DEFERRED — pending operator-side log pull`.**

**Reason (verbatim shell capture):**

```
$ echo "RAILWAY=${RAILWAY_API_TOKEN:+set}"
RAILWAY=
```

`RAILWAY_API_TOKEN` is not exported in this audit runner's environment; the
`railway_logs` MCP tool registers only when this env var is set (per
`CLAUDE.md` env-vars table). No Railway log query was executed.

**Conclusions downgraded by this deferral:**

1. **Synthesis duration distribution (min / median / p95 / max)** — unmeasured.
   §6 reasoning treats SYNTHESIS_TIMEOUT_MS (120s) and the FINDING-14
   "60–100s on mature projects" comment in `src/tools/finalize.ts:702` as the
   best available proxy.
2. **Draft-phase duration distribution** — unmeasured. Reasoning relies on
   the configured budget (FINALIZE_DRAFT_TIMEOUT_MS = 150s, deadline 180s)
   rather than observed p95.
3. **LLM error patterns** (401 / 403 / 429 / rate_limit / OAuth signatures) —
   uncategorized. Cannot confirm or refute whether the OAuth-rejection
   pattern surfaced during routine `cc_dispatch` operations remains stable,
   nor whether `ANTHROPIC_API_KEY` calls are quota-stressed.
4. **Token / cost signals** — unquantified. Cannot rank candidate sites by
   $-impact of migration.

**Action required for the next brief:** the operator (or an audit re-run with
`RAILWAY_API_TOKEN` exported) must pull last-30-day logs and apply the four
filters from brief §3.4. Without this data, latency-comparison claims in any
fix brief are at-best qualitative.

### Step 5 — Per-candidate migration shape

#### Exclusions (documented per brief §3.5)

| # | Site | Excluded? | Reason |
|---|---|---|---|
| EX-1 | CS-4 (`dispatchTask`) | Yes | Already on OAuth (D-146); `cc_dispatch` is the existing internal-CC primitive. Excluding per brief §3.5 bullet 1. |
| EX-2 | CS-1 (`draftPhase`) | **Conditionally — see §5.1** | `blocks-operator` per Step 3, AND Step 1 returned INCONCLUSIVE (not "rejection"). The brief excludes only when Step 1 returned rejection AND latency budget is tight; here Step 1 is INCONCLUSIVE and the budget (150–180s) is generous relative to subprocess cold-start estimates. Exclusion does not apply automatically — analyzed below. |

CS-2 and CS-3 are not excluded under any brief rule (fire-and-forget; no
operator-blocking latency).

#### §5.1 — CS-1 (`draftPhase`)

Per Step 3: `task=draft`, `criticality=blocks-operator`, `budget=150s draft + 180s deadline`,
`output=structured JSON`, `current=ANTHROPIC_API_KEY → claude-opus-4-6`.

| Option | Mechanism | Effort | Risk | Notes |
|---|---|---|---|---|
| A — auth swap | Replace `apiKey: ANTHROPIC_API_KEY` with `apiKey: CLAUDE_CODE_OAUTH_TOKEN` in `src/ai/client.ts:17` (or via a new `getClient()` branch). | Trivial (one line + config). | **Unknown** — viability gated by Step 1 re-run. If Anthropic still rejects OAuth on Messages API (D-146 default), this option fails at runtime with 401/403. | Cannot be committed in fix brief until Step 1 re-runs and returns a deterministic result. |
| B — internal-CC subprocess | Replace the `synthesize()` call at `src/tools/finalize.ts:396` with a new `dispatchInternalLLM()` that wraps `query()` (single-turn, `allowedTools: []`, `maxTurns: 1`, prompt = constructed system+user). Reuses the env-scrubbing + binary-resolution logic in `src/claude-code/client.ts`. | Moderate — new wrapper, prompt re-engineering to coax structured JSON out of an agent harness, side-by-side validation tests. | Subprocess cold-start (`@anthropic-ai/claude-agent-sdk` boot + `claude` CLI spawn) — **estimated 10–30s, unverified**. Quality risk: agent harness adds variability vs raw `messages.create`. | Latency budget (150s) gives ~120s headroom over a 30s cold-start estimate. Step 4 deferral means the cold-start estimate is unconfirmed for this codebase — needs a smoke benchmark in the fix brief. |
| C — status quo | Leave on `ANTHROPIC_API_KEY`. | Zero. | Operator goal (max OAuth utilization) unmet for the highest-cost call site. Continuing per-token spend on Opus 4.6 with input budget ~10–40KB × per-finalize frequency. | Acceptable interim if A is unavailable AND B's latency overhead measures unacceptable. |

**Speed/cost/quality tradeoff:**
- Speed: A ≈ C (same transport); B adds 10–30s estimated cold-start (qualitative — Step 4 deferred).
- Cost: A = B = $0 marginal (both ride OAuth quota); C = ongoing per-token spend.
- Quality: A = C (identical behavior); B requires validation that single-turn
  agent-harness output matches direct API output for the JSON-shaped contract.

**Quality preservation strategy:** golden-fixture test. Capture 3 representative
finalize-draft inputs (small/medium/large project) and assert that
`extractJSON()` succeeds AND each top-level key (`session_log_entry`,
`handoff_where_we_are`, `handoff_next_steps`, `handoff_session_history`,
`task_queue_completed`, `task_queue_new`) is present and non-empty across
≥10 consecutive runs of the candidate option. Justification: the parse
contract at `src/tools/finalize.ts:412-431` already has a `parse_warning`
fallback path, but the fix brief should not regress the success rate.

#### §5.2 — CS-2 (`generateIntelligenceBrief`)

Per Step 3: `task=synthesis`, `criticality=fire-and-forget`,
`budget=120s timeout`, `output=freeform markdown (6 required sections)`,
`current=ANTHROPIC_API_KEY → claude-opus-4-6`.

| Option | Mechanism | Effort | Risk | Notes |
|---|---|---|---|---|
| A — auth swap | Same as CS-1 §5.1 option A. Single shared `getClient()` change benefits all PRIM-1 consumers. | Trivial. | Same Step-1-gated unknown. | If A works for CS-1 it works here too — same primitive. |
| B — internal-CC subprocess | Wrap `synthesize()` call at `src/ai/synthesize.ts:84` with `dispatchInternalLLM()`. The fire-and-forget criticality removes any latency concern — even a 60s cold-start fits comfortably within the 120s budget. | Moderate — same as CS-1 §5.1 option B. | Quality: 6-section markdown contract is enforced by lenient validator (`src/ai/synthesize.ts:108-112`: warn-and-push, partial brief is still pushed). Risk floor is therefore lower than CS-1's strict-JSON contract. | Strongest immediate candidate for migration — fire-and-forget plus permissive validator. |
| C — status quo | Leave on `ANTHROPIC_API_KEY`. | Zero. | Per-token spend on the largest input bundle (full living docs + decision domains). | Operator goal violation is most severe at this site (largest bundle, runs every finalize). |

**Speed/cost/quality tradeoff:** Speed irrelevant (fire-and-forget). Cost A=B
(OAuth) vs C (per-token, largest bundle). Quality A=C; B has validator
slack — partial output is shipped today.

**Quality preservation strategy:** side-by-side comparison test. For 5
finalized sessions, run both the API and subprocess paths, diff section
presence (the 6 required H2 headings) and total output length within ±20%.
Operator manual review of first 3 production invocations. Justification:
the validator already accepts partial output, so the equivalence bar is
"≥ as many sections as API path AND length not catastrophically shorter."

#### §5.3 — CS-3 (`generatePendingDocUpdates`)

Per Step 3: `task=synthesis`, `criticality=fire-and-forget`,
`budget=120s timeout`, `output=freeform markdown (4 required sections)`,
`current=ANTHROPIC_API_KEY → claude-opus-4-6`.

| Option | Mechanism | Effort | Risk | Notes |
|---|---|---|---|---|
| A — auth swap | Same as CS-1 / CS-2 — primitive-level change. | Trivial. | Step-1-gated. | — |
| B — internal-CC subprocess | Wrap `synthesize()` call at `src/ai/synthesize.ts:245`. Same wrapper as CS-2; one parameter diff (system prompt + input bundle filter). | Moderate (incremental over CS-2). | Identical to CS-2 — both share the `synthesize()` primitive and the warn-and-push validator pattern (`src/ai/synthesize.ts:272-275`). | If CS-2 migrates to B, CS-3 should follow in the same brief — no marginal cost. |
| C — status quo | Leave on `ANTHROPIC_API_KEY`. | Zero. | Same per-token cost class as CS-2 (slightly smaller input — minus `pending-doc-updates.md`). | — |

**Speed/cost/quality tradeoff:** Identical to CS-2. The two functions are
behavioral siblings (D-156 §3.6 / D-155 — same input shape, different
system prompt, different output file) and share their primitive.

**Quality preservation strategy:** identical golden-fixture / side-by-side
shape as CS-2 §5.2. Coupled migration — testing CS-2 covers CS-3 modulo the
4-section vs 6-section contract.

#### §5.4 — CS-4 (`dispatchTask`)

Excluded (EX-1). Already on OAuth via the subprocess path. The `dispatchTask`
function is the **existing reference implementation** of "internal-CC
primitive" — any new `dispatchInternalLLM()` for PRIM-1 should pattern-match
its env-scrubbing (`buildDispatchEnv`), binary-resolution
(`findClaudeExecutable`), OAuth-rejection-detection (`detectOAuthRejection`),
and timeout handling.

### Step 6 — Verdict

## Verdict

C

**Hybrid migration with subprocess fallback. Verdict-letter rationale:**

This audit cannot commit to **A** (single shared internal-CC primitive for all
candidate sites) because two of the four prescribed inputs are missing:

- **Step 1 (auth-swap viability) returned `INCONCLUSIVE`** — neither
  `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` was available in the
  audit runner's local environment, so no live `Anthropic({ apiKey:
  CLAUDE_CODE_OAUTH_TOKEN }).messages.create()` request was issued. D-146's
  finding (OAuth → Messages API rejected with 401/403, ~5 months prior) remains
  the most-recent grounded data point and is treated as the conservative
  default, but the audit cannot claim re-verification. If a re-run of Step 1
  returns **HTTP 200 / success**, the right shape collapses toward auth-swap
  for all three PRIM-1 consumers (CS-1, CS-2, CS-3) and the verdict can be
  upgraded to A in the next brief. If it returns **HTTP 401/403**, subprocess
  becomes the only OAuth route and the verdict still consolidates at A — but
  the auth-source choice within A flips. Either branch is defensible;
  committing now would prejudge a determination this audit was specifically
  scoped to make.

- **Step 4 (production-log latency distribution) was `DEFERRED`** — no
  `RAILWAY_API_TOKEN` in the local env. Subprocess cold-start estimates
  (10–30s) are qualitative; without an observed p95 for the existing
  `dispatchTask` invocations (CS-4) on this Railway service, claims that B
  fits inside CS-1's 150s budget are bounded by configured timeouts, not
  measurements. This downgrades any all-sites-go subprocess commitment.

The audit found **4 routing-candidate task contexts** (CS-1 through CS-4 —
see Step 2). One (CS-4 / `dispatchTask`) is excluded as already-on-OAuth.
The remaining three all consume a single primitive (`synthesize()` at
`src/ai/client.ts:62`), which is structurally favorable for A — but A is
unavailable until the gating questions resolve.

**Per Step 5 candidate analysis:**

- **CS-2 (`generateIntelligenceBrief`, §5.2)** is the strongest immediate
  migration target. Fire-and-forget criticality removes the latency risk;
  the synthesis validator already warn-and-pushes partial output
  (`src/ai/synthesize.ts:108-112`), so the equivalence bar is permissive;
  and the input bundle (full living docs + decision domains) is the
  largest single per-token cost in the system, so OAuth utilization
  yields maximum operator-goal-impact.
- **CS-1 (`draftPhase`, §5.1)** is the highest-risk migration target.
  `blocks-operator` criticality means subprocess cold-start variance
  directly affects user-visible finalize latency, and the strict
  `extractJSON` contract (`src/tools/finalize.ts:412-431`) means
  agent-harness output drift can break the parse path. This is the site
  whose migration must be gated on Step 1 re-run AND a measured
  cold-start benchmark.

**Operator-constraint check (brief §1):**

1. **No quality regression on user-visible output.** Verdict C honors this
   by holding CS-1 (the only blocks-operator site) on the status-quo
   API path until Step 1 (auth path) and a subprocess cold-start
   benchmark (latency) are both resolved with grounded data. CS-2 and
   CS-3 outputs are user-visible only on the next bootstrap (intelligence
   brief is read by the next session, not the current one), and the
   warn-and-push validator absorbs minor format drift — golden-fixture
   tests in the fix brief enforce the floor.
2. **No latency regression on user-visible call sites.** Same mechanism —
   CS-1 stays on API until measurement. CS-2/CS-3 are fire-and-forget
   (`void Promise.allSettled` at `src/tools/finalize.ts:722`) so they
   cannot regress operator-perceived latency by construction.
3. **Maximum OAuth quota utilization for non-user-visible / fire-and-forget
   call sites.** Verdict C fully realizes this for CS-2 and CS-3 (the two
   largest-input fire-and-forget calls) in the immediate fix brief. CS-1
   joins the OAuth pool conditionally, after gating data lands.

**If Step 1 re-run returns success (HTTP 200) AND a subprocess benchmark
shows p95 cold-start ≤ 30s, the next brief should upgrade to Verdict A**
(single shared primitive routes all three PRIM-1 consumers through OAuth —
auth-swap mechanism preferred for lower transport overhead). **If Step 1
returns rejection (HTTP 401/403) but the benchmark passes, Verdict A still
holds, but with subprocess as the only mechanism. If neither input
resolves favorably, Verdict C remains in force as a stable end-state
(CS-2/CS-3 on subprocess, CS-1 on API).**

Verdict D (Phase 3 collapses entirely) is **not** supported by the evidence:
even under the worst-case combination (Step 1 = rejection, subprocess
overhead = high), CS-2 and CS-3's fire-and-forget criticality keeps them
viable as subprocess migrations. There is at minimum a two-site productive
intervention available regardless of how the gating questions resolve.

### Step 7 — Brief skeleton sketch

For the chosen Verdict C, the next brief is **two phases**: an immediate
low-risk migration (CS-2 + CS-3) and a follow-up gated migration (CS-1).
Skeleton in bulleted form per brief §3.7 ("Do NOT write code. Sketch only.").

#### Phase 3a — Subprocess migration for fire-and-forget synthesis (CS-2, CS-3)

- **File targets:**
  - `src/claude-code/client.ts` — extract a new exported helper `dispatchInternalLLM(systemPrompt, userMessage, opts)` that wraps `query()` with `{ allowedTools: [], maxTurns: 1, persistSession: false }` and reuses `findClaudeExecutable()` + `buildDispatchEnv()` + `detectOAuthRejection()`. Returns a shape compatible with `SynthesisOutcome` (`success`, `content`, `input_tokens`, `output_tokens`, `error_code`).
  - `src/ai/client.ts` — modify `synthesize()` to dispatch via `dispatchInternalLLM` when an `auth_route: "oauth"` flag is set (config-driven). Default routing for CS-2/CS-3 callers becomes OAuth/subprocess; CS-1 callers (draft) remain on the API key path until Phase 3b.
  - `src/config.ts` — add `SYNTHESIS_AUTH_ROUTE` env var (`"api_key" | "oauth"`, default `"api_key"` in this phase) gating per-call-site routing. Note: a per-task-class override (e.g. `SYNTHESIS_AUTH_ROUTE_DRAFT`) may be needed in Phase 3b.
  - `src/ai/synthesize.ts` — wire `auth_route: "oauth"` for `generateIntelligenceBrief` and `generatePendingDocUpdates`. No call-site signature change.
  - `tests/` — golden-fixture test under `tests/integration/synthesis-routing.test.ts`: 3 fixtures (small / medium / large) × 2 routes (api_key / oauth) × ≥10 runs; assert section-header count ≥ API baseline AND output length within ±20%. Mock both routes if Step 1 still INCONCLUSIVE; record skip-reason.

- **Primitive shape (signature sketch — no code):**
  - `dispatchInternalLLM({ systemPrompt: string, userMessage: string, maxOutputTokens?: number, timeoutMs?: number }) → Promise<SynthesisOutcome>`.
  - Internally: builds an Agent SDK `query()` with the prompt assembled as `<system>\n${systemPrompt}\n</system>\n\n${userMessage}` (or whatever single-turn convention the SDK prefers — confirm during implementation), `cwd: os.tmpdir()` (no working-directory side effects), `allowedTools: []`.
  - Returns the same `SynthesisOutcome` shape `synthesize()` returns today, so `generateIntelligenceBrief` / `generatePendingDocUpdates` consumers are unchanged.
  - Lives alongside `dispatchTask` in `src/claude-code/client.ts`, reusing all of its env/binary plumbing.

- **Verification gates (must be computed against the changed code, INS-166):**
  - `grep -c "anthropic\.messages\.create" src/` — must remain ≥ 1 (CS-1 still uses it).
  - `grep -c "dispatchInternalLLM" src/` — must be ≥ 3 (one definition + two call-site routing branches OR one definition + two call sites).
  - Smoke run: `npm test -- synthesis-routing` returns 0 exit and golden-fixture assertions hold.
  - Behavioral assertion: `prism_synthesize project_slug=<test_project> session_number=N mode=generate` succeeds with both `intelligence_brief.success=true` and `pending_doc_updates.success=true` after the migration is enabled (env flag set).

- **Quality preservation mechanism:**
  - Golden-fixture diffs as above.
  - Operator manual review of first 3 production-finalize intelligence briefs after deploy; rollback gate is "if any brief is missing > 1 of the 6 required sections OR length is < 50% of the 30-session rolling median, flip the route flag back."
  - Synthesis-tracker (`src/ai/synthesis-tracker.ts`) already records per-event metadata; add a `route` field (`"api_key" | "oauth"`) so post-migration health comparisons are trivial.

#### Phase 3b — Conditional draft-phase migration (CS-1)

- **Pre-conditions to start (each must hold before this phase opens):**
  - Step 1 re-run with both tokens present, result captured in a follow-up audit. If `success`, route mechanism = auth swap; if `rejection`, mechanism = subprocess; if `INCONCLUSIVE` again, this phase does not open.
  - Subprocess cold-start benchmark: minimum 20 sequential `dispatchInternalLLM` calls on the Railway service measured for total `duration_ms`; p95 must be ≤ 30s.
  - Phase 3a in production for ≥ 10 finalize cycles with zero `recordSynthesisEvent` failures attributable to `route=oauth`.

- **File targets (sketch — exact shape depends on Step 1 outcome):**
  - `src/tools/finalize.ts:396` — switch `synthesize(FINALIZATION_DRAFT_PROMPT, …)` call to use the same `dispatchInternalLLM` (subprocess path) OR an updated `synthesize()` with auth-swapped client (API path), governed by config.
  - `src/config.ts` — promote routing flag(s) to support per-call-site overrides if Phase 3a's single flag is too coarse.
  - `tests/` — extend the golden-fixture suite to assert `extractJSON()` success rate ≥ 99% over ≥30 runs across the migrated route.

- **Verification gates:** same shape as Phase 3a, with the additional constraint that the parse-success rate (`extractJSON` succeeds vs falls into `raw_content` branch) does not regress vs the API baseline.

- **Quality preservation mechanism:** golden-fixture (3 fixtures × ≥30 runs × strict JSON-shape assertions) + the existing `parse_warning` fallback at `src/tools/finalize.ts:423-431` provides graceful degradation if any single run falls back to `raw_content` — but the fix brief must hold the success rate within ≤1 percentage-point of the API baseline to ship.

#### Out-of-scope for the fix brief(s)

- No changes to `cc_dispatch` (CS-4) — already at the target state.
- No changes to `prism_*` GitHub-mutation tools — they do not invoke LLMs.
- No changes to the 18-tool MCP surface — routing is internal to `src/ai/` and `src/claude-code/`.

<!-- EOF: s71-phase3-llm-routing-audit.md -->
