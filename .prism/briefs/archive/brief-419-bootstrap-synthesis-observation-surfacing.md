# brief-419 — boot-time synthesis fallback + CS-3 quality warning surfacing in prism_bootstrap

**Repo:** prism-mcp-server
**Origin:** PRISM session S113 — D-201 / Phase 3c-A observation-gate visibility. Phase 3c-A's transport-layer fallback (`SYNTHESIS_TRANSPORT_FALLBACK`) and CS-3 quality warnings (`CS3_QUALITY_BYTE_COUNT_WARNING`, `CS3_QUALITY_PREAMBLE_WARNING`) currently emit Railway logs only. Operator never sees them between sessions unless they manually pull `railway_logs`. S111→S112→S113 correction loop established why this is load-bearing: brief-418's wrapper guard converts silent corruption into clean fallbacks, but if the operator can't see those fallbacks at the next boot, the gate becomes advisory-only.
**Estimated complexity:** medium-large
**Workflow:** direct

> **Note on framework template:** No framework-template companion paragraph required. This brief is a pure prism-mcp-server feature; the boot banner's `⚠` line already auto-renders `result.warnings` per Rule 2 Block 3d. No new client-side rule needed.

---

## Summary

When a PRISM finalization's CS-3 (`generatePendingDocUpdates`) synthesis call falls back from `cc_subprocess` to `messages_api` (per brief-418's wrapper zero-token guard), or emits a quality warning (`CS3_QUALITY_BYTE_COUNT_WARNING` for output bytes outside [50%, 150%] of rolling baseline, or `CS3_QUALITY_PREAMBLE_WARNING` for prompt-leak preamble), the operator currently has no in-session signal that the Phase 3c-A observation gate fired. The next session boots normally and observation-gate datapoints accumulate invisibly until the operator manually queries Railway logs.

This brief adds boot-time visibility: `prism_bootstrap` queries Railway environment logs for the booting project's most-recent CS-3 synthesis events within a configurable lookback window, and surfaces any fallback or quality-warning events as warnings in `result.warnings` (auto-rendered in the banner code fence per the existing `⚠` channel) plus a single structured `SYNTHESIS_OBSERVATION_DETECTED` diagnostic carrying counts per kind plus the full event payload.

To enable per-project filtering of fallback events, the brief also threads `projectSlug` through `synthesize()` so the existing log emissions in `src/ai/client.ts` carry the project tag (already present on CS-3 quality warnings; missing on fallback and synthesis-success logs). Without this plumbing, fallback events cannot be project-scoped.

This closes the Phase 3c-A observation-gate visibility gap noted in S113. Pairs with INS-242 (the existing log-code definitions) and INS-244 (the wrapper-guard semantics).

## Empirical grounding

S113 boot pulled `railway_logs filter:cc_subprocess limit:50` and observed:

| timestamp | event | tokens | model |
|-----------|-------|--------|-------|
| 2026-05-02T00:31:02Z | `cc_subprocess synthesis complete` (pre-fix) | 0/0 | claude-sonnet-4-6 |
| 2026-05-02T00:33:13Z | `cc_subprocess synthesis complete` (pre-fix) | 0/0 | claude-sonnet-4-6 |
| 2026-05-02T01:47:13Z | `cc_subprocess synthesis returned zero tokens despite subtype=success` | 0/0 | claude-sonnet-4-6[1m] |
| 2026-05-02T01:47:13Z | `SYNTHESIS_TRANSPORT_FALLBACK` | n/a | n/a |

The fourth event (S112 finalize) was the first true post-fix datapoint — wrapper guard caught zero-token success, fallback engaged cleanly. **None of these events surfaced to the operator at S113 boot without manual log query.** This brief makes them visible automatically.

Lookback window analysis: typical session-to-session interval on this fleet is 30 min – 4 hours during active work, longer during off-hours. A 4-hour default window covers active-work sessions cleanly while avoiding false positives from old finalizes when the operator returns after a break. Configurable via `SYNTHESIS_LOG_LOOKBACK_MS` env var.

## Detection logic

Bootstrap fires a Railway environment-logs query against the prism-mcp-server production environment, filtered to a compact regex pattern matching all three observation-gate codes plus the project tag. The pure check function inspects each returned log entry:

```
isObservationEvent(log, slug) =
  log has any of: SYNTHESIS_TRANSPORT_FALLBACK, CS3_QUALITY_BYTE_COUNT_WARNING, CS3_QUALITY_PREAMBLE_WARNING
  AND log.attributes.projectSlug == slug
  AND now - log.timestamp < lookbackMs    (strict less-than: exact boundary is NOT surfaced)
```

Edge cases handled:
- No matching events in window → no warning (healthy state, the common case).
- Railway API unreachable / token missing → no warning, debug log only (fail-silent per INS-238).
- Log entry missing `projectSlug` attribute (pre-deploy legacy entries during the first window after deploy) → not matched for current project, no warning. Acceptable false negative.
- Multiple events of same kind in window → surface the most recent one only, with a count suffix (`(× N)`) on the warning line.
- Mixed kinds → surface each kind on its own warning line (max 3 lines added).

## Changes

### `src/utils/synthesis-fallback-check.ts` (new)

Pure-function utility, parallels `src/utils/stale-active-check.ts` (brief-416). Exports:

```ts
export type ObservationEventKind =
  | "SYNTHESIS_TRANSPORT_FALLBACK"
  | "CS3_QUALITY_BYTE_COUNT_WARNING"
  | "CS3_QUALITY_PREAMBLE_WARNING";

export interface ObservationEvent {
  kind: ObservationEventKind;
  timestamp: string;       // ISO
  attributes: Record<string, string>;  // raw flattened attribute map
}

export interface ObservationCheckResult {
  has_events: boolean;
  events: ObservationEvent[];  // grouped by kind, most-recent first within each
  fallback_count: number;
  byte_warning_count: number;
  preamble_warning_count: number;
}

/**
 * Inspect a list of Railway log entries (already filtered by environment +
 * substring/regex by the caller) and extract the subset matching one of the
 * three Phase 3c-A observation codes for the given project slug, within the
 * lookback window.
 *
 * Defensive contract: any malformed log entry, missing attribute, or
 * unparseable timestamp resolves to "skip this entry" — never throws.
 * `has_events: false` when the filtered set is empty.
 */
export function checkSynthesisObservationEvents(
  logs: RailwayLog[],
  projectSlug: string,
  now: Date,
  lookbackMs: number,
): ObservationCheckResult;
```

Defensive contract: invalid timestamps, missing attributes, unknown kinds, and out-of-window entries are silently skipped. The caller cannot distinguish "no events" from "could not check" — visibility hint, not a guard, per INS-238.

### `src/ai/client.ts` (modify — projectSlug plumbing)

Extend `synthesize()` to accept an optional `projectSlug` parameter (positional, 8th argument; documented inline). Plumb it into both `logger` calls:

```ts
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
  thinking?: boolean,
  callSite?: SynthesisCallSite,
  projectSlug?: string,    // NEW — optional; tags log emissions for boot-time observation surfacing
): Promise<SynthesisOutcome>
```

Two log emissions to update:

1. Line 131 — `SYNTHESIS_TRANSPORT_FALLBACK`:
```ts
logger.warn("SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed, retrying via messages_api", {
  callSite,
  attempted_model: routing.model,
  original_error: subprocessOutcome.error,
  original_error_code: subprocessOutcome.error_code,
  projectSlug,    // NEW
});
```

2. Line 239 — `Synthesis API call complete`:
```ts
logger.info("Synthesis API call complete", {
  // ... existing fields
  projectSlug,    // NEW
});
```

Decision: positional 8th argument vs options-object refactor. The function is already 7 positional params deep with comments at each call site mapping positions to semantics; adding an 8th positional with the same comment-pattern is consistent with house style and minimum-diff. Options-object refactor would touch every existing caller (out of scope for this brief; flagged as future cleanup if more parameters are added).

### `src/ai/synthesize.ts` (modify — pass projectSlug at both call sites)

Two call sites in this file already have `projectSlug` in scope. Add it to both `synthesize()` calls:

CS-2 (line ~88, `generateIntelligenceBrief`):
```ts
const result = await synthesize(
  FINALIZATION_SYNTHESIS_PROMPT,
  userMessage,
  undefined,
  SYNTHESIS_TIMEOUT_MS,
  undefined,
  true, // thinking: true — Phase 3a CS-2 adaptive-thinking flag
  undefined, // callSite — CS-2 stays on messages_api per Phase 3c-A scope
  projectSlug, // brief-419: project tagging for boot-time observation surfacing
);
```

CS-3 (line ~260, `generatePendingDocUpdates`):
```ts
const result = await synthesize(
  PENDING_DOC_UPDATES_PROMPT,
  userMessage,
  undefined,
  SYNTHESIS_TIMEOUT_MS,
  undefined,
  true, // thinking: true — Phase 3a CS-3 adaptive-thinking flag
  "pdu", // brief-417: per-call-site routing
  projectSlug, // brief-419: project tagging for boot-time observation surfacing
);
```

`CS3_QUALITY_BYTE_COUNT_WARNING` and `CS3_QUALITY_PREAMBLE_WARNING` already include `projectSlug` in their attribute payloads (verified at synthesize.ts:313 and synthesize.ts:331). No changes needed there.

### `src/tools/bootstrap.ts` (modify — new parallel fetch + warning emission)

Add a new helper function `checkSynthesisObservation(slug)` modeled exactly on the existing `checkTriggerStaleActive(slug)` pattern (bootstrap.ts:266–296). Pseudocode:

```ts
async function checkSynthesisObservation(
  slug: string,
): Promise<ObservationCheckResult | null> {
  if (!RAILWAY_API_TOKEN) return null;  // fail-silent if Railway not configured

  // The synthesis-emitting service is the prism-mcp-server itself, regardless
  // of which PRISM project is booting. Resolve the production environment ID
  // once at module load (cache).
  const envId = await resolveSelfProductionEnvId();
  if (!envId) return null;

  let logs: RailwayLog[];
  try {
    // Filter `@level:warn` catches all three observation codes in one call:
    // SYNTHESIS_TRANSPORT_FALLBACK and both CS3_QUALITY_* warnings are all
    // `logger.warn` emissions. Other warn-level entries (e.g. the
    // ai/client.ts:76 unknown-transport warning) are returned too but the
    // pure check function filters by kind — they're cheap to discard.
    // A naive substring filter on "SYNTHESIS_" would miss the CS3_QUALITY_*
    // codes; substring is single-token in the Railway filter syntax and
    // can't OR multiple prefixes. limit:200 amply covers a 4h window even
    // on a busy fleet.
    logs = await getEnvironmentLogs(envId, 200, "@level:warn");
  } catch (err) {
    logger.debug("synthesis observation fetch skipped", { slug, error: ... });
    return null;
  }

  return checkSynthesisObservationEvents(
    logs,
    slug,
    new Date(),
    SYNTHESIS_LOG_LOOKBACK_MS,
  );
}
```

Add to the existing parallel-fetch group (currently `Promise.all([... triggerEnrollmentPromise, staleActivePromise])`):

```ts
const [..., triggerEnrollment, staleActive, observation] = await Promise.all([
  ...
  triggerEnrollmentPromise,
  staleActivePromise,
  checkSynthesisObservation(resolvedSlug),
]);
```

Then immediately after the existing `if (staleActive)` block (bootstrap.ts:542–558), add:

```ts
if (observation && observation.has_events) {
  const lines: string[] = [];
  if (observation.fallback_count > 0) {
    const suffix = observation.fallback_count > 1 ? ` (× ${observation.fallback_count})` : "";
    lines.push(`Synthesis transport fallback detected last finalize${suffix} — CS-3 routed via messages_api fallback (see INS-242).`);
  }
  if (observation.byte_warning_count > 0) {
    const suffix = observation.byte_warning_count > 1 ? ` (× ${observation.byte_warning_count})` : "";
    lines.push(`CS-3 output byte-count outside baseline last finalize${suffix} — verify pending-doc-updates.md content (see INS-242).`);
  }
  if (observation.preamble_warning_count > 0) {
    const suffix = observation.preamble_warning_count > 1 ? ` (× ${observation.preamble_warning_count})` : "";
    lines.push(`CS-3 preamble-leak warning last finalize${suffix} — first non-empty line not "## "/"**"/"# " (see INS-242).`);
  }
  for (const line of lines) {
    warnings.push(line);
  }
  diagnostics.info(
    "SYNTHESIS_OBSERVATION_DETECTED",
    `Phase 3c-A observation events detected for ${resolvedSlug}`,
    {
      fallback_count: observation.fallback_count,
      byte_warning_count: observation.byte_warning_count,
      preamble_warning_count: observation.preamble_warning_count,
      events: observation.events.slice(0, 10),  // cap for diagnostic payload size
      lookback_minutes: Math.round(SYNTHESIS_LOG_LOOKBACK_MS / 60_000),
    },
  );
}
```

**Bytes accounting:** Do NOT increment `bytesDelivered` or `filesFetched` for the Railway log fetch. The log content is server-side-only; only the resulting warning strings (each ≤200 chars, max 3 lines) reach the response.

**Self-environment resolution.** The server queries its own Railway production environment for synthesis logs. Two implementation options:

- (a) Cache `RAILWAY_PROJECT_ID` + `RAILWAY_ENVIRONMENT_ID` as env vars set by Railway at deploy time (Railway injects these by default into every running container).
- (b) Resolve dynamically at first-call by walking `getProjects()` → match by name → `getEnvironments()` → match by name `production`.

Use (a) — Railway injects these reliably and the static path adds no API calls. Document the env-var dependency in the new `SYNTHESIS_LOG_LOOKBACK_MS` config block. If the Railway-provided env vars are absent at runtime (local dev, alternate deploy), fall through to (b) with caching, OR just return null (fail-silent). Recommend: try (a), fall through to null on absence; do NOT add (b) — keeps the brief tight.

### `src/config.ts` (modify)

Add `SYNTHESIS_LOG_LOOKBACK_MS`:

```ts
/**
 * Lookback window for boot-time synthesis observation surfacing (brief-419).
 * Default 4 hours covers active-work sessions cleanly without false positives
 * from older finalizations when the operator returns after a break.
 */
export const SYNTHESIS_LOG_LOOKBACK_MS = Number(
  process.env.SYNTHESIS_LOG_LOOKBACK_MS ?? 4 * 60 * 60 * 1000,
);
```

Optional: add `RAILWAY_SELF_ENV_ID` (read directly inside bootstrap from `process.env.RAILWAY_ENVIRONMENT_ID` — no config.ts change needed if read inline).

### `src/config.ts` SERVER_VERSION (modify)

Bump SERVER_VERSION from 4.5.1 to 4.6.0 with explanatory comment referencing brief-419.

### `package.json` (modify)

Bump version from 4.5.1 to 4.6.0 to match SERVER_VERSION.

### `tests/utils/synthesis-fallback-check.test.ts` (new)

Unit tests for the pure check function. Cover:

- Empty input array → `has_events: false`, all counts 0.
- Single SYNTHESIS_TRANSPORT_FALLBACK matching project + within window → `has_events: true`, `fallback_count: 1`.
- Single CS3_QUALITY_BYTE_COUNT_WARNING matching project + within window → `has_events: true`, `byte_warning_count: 1`.
- Single CS3_QUALITY_PREAMBLE_WARNING matching project + within window → `has_events: true`, `preamble_warning_count: 1`.
- Three of each kind → counts of 3/3/3.
- Event matching kind but wrong project → not surfaced.
- Event matching kind but missing projectSlug attribute (legacy) → not surfaced.
- Event within window but unknown kind → not surfaced.
- Event matching kind + project but timestamp older than lookback → not surfaced.
- Event matching kind + project + window but unparseable timestamp → not surfaced (silent skip).
- Event with malformed attributes (non-array, non-object) → not surfaced (silent skip).
- Lookback window edge: exactly at boundary (now - timestamp == lookbackMs) → not surfaced (strict `<`, per pseudocode).
- Mixed events in single input → counts independent, all kinds extracted.

### `tests/bootstrap-synthesis-observation.test.ts` (new)

Integration test (mock `getEnvironmentLogs` calls) verifies:

- No env token → no warning, no diagnostics, bootstrap succeeds.
- `getEnvironmentLogs` throws → no warning, bootstrap succeeds (defensive contract).
- Logs returned with no matching events → no warning, no diagnostics.
- Logs with one fallback event for booting project → warning in `result.warnings`, `SYNTHESIS_OBSERVATION_DETECTED` diagnostic with `fallback_count: 1`, banner_text includes the warning line.
- Logs with one fallback event for ANOTHER project → no warning.
- Logs with one of each kind → three warning lines in `result.warnings`.
- Logs with three fallbacks for booting project → warning includes `(× 3)` count suffix.

### `tests/synthesize-project-tagging.test.ts` (new)

Verifies:
- `synthesize(...)` called without `projectSlug` (legacy callers) emits log entries WITHOUT a `projectSlug` field — backwards-compat preserved.
- `synthesize(systemPrompt, userContent, ..., callSite, projectSlug)` emits log entries WITH `projectSlug: <value>` field on both success path (line 239) and fallback path (line 131).
- Mock the underlying `callMessagesApi` and `synthesizeViaCcSubprocess` to control routing branches; assert on captured `logger.info` / `logger.warn` payloads.

### `tests/tool-surface.test.ts` (no change expected)

The brief does not register a new MCP tool. Tool surface stays at 23/23. Re-run as regression guard.

---

## Out of scope

- **Refactoring synthesize() to options-object signature.** Positional 8th argument is the minimum-diff path. If a 9th parameter ever needs to be added, that's the time to refactor — flagged for future maintenance, not this brief.
- **Surfacing synthesis observability events on every PRISM project's boot, regardless of which finalize emitted them.** The brief filters by `projectSlug` → only the booting project's events surface. Cross-project visibility is a separate analytics concern.
- **CS-1 / CS-2 transport fallback surfacing.** Phase 3c-A is CS-3 only. When Phase 3c-B (CS-2) and Phase 3c-C (CS-1) flip, equivalent log codes will exist (`SYNTHESIS_BRIEF_FALLBACK`, `SYNTHESIS_DRAFT_FALLBACK`); extending this surface to those codes is a one-line addition in the pure check function at that time.
- **Auto-recovery / auto-revert.** This brief surfaces events; it does not flip env vars to revert Phase 3c-A on detected fallbacks. Recovery is operator-side per INS-242 step 6 (`railway_env set SYNTHESIS_PDU_TRANSPORT=messages_api`).
- **Daemon health probe / Railway service liveness.** Out of scope. This is observation-gate visibility for synthesis, not infrastructure health.
- **Rolling-window rate calculation.** Per Q1 resolution (S113 chat), surface fires on any single event, not on rate threshold. Rate-based surfacing would require persistent state across boots; the per-event approach uses only the current Railway log query and is bounded.
- **Quality-warning auto-revert.** Per INS-244 step 5: quality warnings remain advisory. The fix to make them auto-revert-capable is a separate brief.

---

## Test plan

Automated (CI gates — Claude Code runs these during execution):

- [ ] `npm run lint` — biome clean
- [ ] `npm run build` — tsc clean
- [ ] `npm test` — all tests pass (current count is 931 from brief-418; expect ~960 after this brief: ~13 new in `synthesis-fallback-check`, ~7 integration in `bootstrap-synthesis-observation`, ~6 in `synthesize-project-tagging` for the projectSlug plumbing, ~3 regression updates expected)
- [ ] `npx tsc --noEmit` — clean
- [ ] All 13 unit-test cases in `synthesis-fallback-check.test.ts` pass
- [ ] All 7 integration-test cases in `bootstrap-synthesis-observation.test.ts` pass
- [ ] All 6 unit-test cases in `synthesize-project-tagging.test.ts` pass

Post-deploy (operator confirms after Railway redeploys):

- [ ] Server logs show `version: "4.6.0"` on next container start (`PRISM MCP Server started` line, `version` attribute).
- [ ] `npm start` log line shows `prism-mcp-server@4.6.0` (package.json bump landed).

**Live verification.** No manufactured fallback or quality warning required. The integration test cases above exercise the full surfacing pipeline end-to-end with deterministic mock-log fixtures. Real-world verification will happen naturally on the next Phase 3c-A observation event (statistically likely within 3–5 finalizations given the current OAuth-routing config). When that happens, the surfacing fires for real on the next session's boot; until then, the test coverage is the verification.

**Backwards-compat note for first window after deploy.** Pre-deploy fallback events lack the new `projectSlug` attribute. The pure check function treats absence as "could not match project" → not surfaced. This is an acceptable false-negative window of at most `SYNTHESIS_LOG_LOOKBACK_MS` (default 4 hours) starting at deploy time. After that window, all fallback events carry project tags and surface correctly.

---

## INS-234 self-check

- Brief declares: `Repo: prism-mcp-server` ✓
- Brief queue path: `brdonath1/prism-mcp-server/.prism/briefs/queue/brief-419-bootstrap-synthesis-observation-surfacing.md` ✓
- All execution lives on prism-mcp-server. No cross-repo edits. Match. ✓

<!-- EOF: brief-419-bootstrap-synthesis-observation-surfacing.md -->
