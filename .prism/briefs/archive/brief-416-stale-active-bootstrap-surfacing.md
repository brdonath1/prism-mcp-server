# brief-416 — boot-time stale-active surfacing in prism_bootstrap (D-196 Piece 3)

**Repo:** prism-mcp-server
**Origin:** PRISM session S110 — D-196 Piece 3 (closes the visibility piece of the four-piece reliability hardening; Pieces 1+2 shipped as PR #38 on brdonath1/trigger and verified live in S110).
**Estimated complexity:** medium
**Workflow:** direct

> **Note on framework template:** The companion paragraph for `_templates/core-template-mcp.md` (Rule 1) is intentionally NOT in this brief. PRISM operator will push it chat-side after this brief's PR merges and Railway deploys cleanly, so the framework documentation matches verified-live server behavior.

---

## Summary

When a Trigger-enrolled project's daemon-side `active` slot is stuck (brief started but never opened a PR, daemon down or wedged), the operator currently has no in-session signal that recovery is needed. The next session boots normally and substantial work proceeds without flagging the wedge — the operator only discovers it when they try to dispatch and nothing happens.

This brief adds boot-time visibility: `prism_bootstrap` reads the project's trigger state file (`brdonath1/trigger:state/<slug>.json`), and when the active slot is occupied beyond a threshold without a PR opened, surfaces a warning in `result.warnings` (auto-rendered in the banner code fence per the existing `⚠` channel) and a structured `STALE_ACTIVE_DETECTED` entry in `result.diagnostics` with the recovery procedure inline.

This closes Piece 3 of D-196. Pieces 1 (wrong-repo guard) and 2 (pane liveness) prevent the dispatch-pipeline failure modes that produce stale active records; Piece 3 surfaces ones that slip through (e.g., daemon down between sessions) so the operator can recover before queuing more work.

## Empirical grounding

The 10-minute threshold mentioned in S109 closure narrative was a placeholder. Audit of `state/prism-mcp-server.json` history shows actual CC dispatch durations on this project:

| brief | execution_started_at → pr_created_at | duration |
|-------|--------------------------------------|----------|
| brief-105 | 2026-04-27T12:38:07 → 12:51:24 | 13m 17s |
| brief-200 | 2026-04-27T22:29:31 → 22:41:48 | 12m 17s |
| brief-402 | 2026-04-30T01:37:03 → 01:43:09 | 6m 6s |
| brief-403 | 2026-04-30T22:46:50 → 22:54:54 | 8m 4s |
| brief-404 | 2026-05-01T01:12:25 → 01:18:03 | 5m 38s |
| brief-405 | 2026-05-01T14:37:04 → 14:49:43 | 12m 40s |
| brief-411 | 2026-05-01T16:53:03 → 17:06:20 | 13m 17s |
| brief-415 | 2026-05-01T19:59:13 → 20:10:27 | 11m 14s |

Range 5m 38s to 13m 17s; median ~11.5m. Five of eight normal runs exceed 10 minutes. Compare to historical wedges: brief-trigger-marker-template-queue-archive at 2h 53m, brief-412 at 1h 53m. **Threshold 30 minutes** sits well above max-normal (13m 17s) and well below wedge-floor (1h 53m), giving zero false positives on the historical sample while still catching wedges within ~17 minutes of the longest normal completion.

## Detection logic

```
isStaleActive(state, now, thresholdMs) =
  state != null
  && state.active != null
  && state.active.timeline.execution_started_at != null
  && (now - state.active.timeline.execution_started_at) > thresholdMs
  && state.active.timeline.pr_created_at == null
```

Edge cases handled:
- `state == null` → no surfacing (project not enrolled or no state yet).
- `state.active == null` → no surfacing (slot empty, nominal).
- `pr_created_at != null` → no surfacing (PR opened; even if merge/post-merge stuck, the active slot will clear via post-merge actions or the next daemon cycle — not the wedge class this surface targets).
- `execution_started_at == null` → no surfacing (queued but not yet executing — pre-dispatch state, not wedge).

## Changes

### `src/utils/stale-active-check.ts` (new)

Pure-function utility, parallels the `parsePersistedRecommendation` / `injectPersistedRecommendation` pattern in `session-classifier.ts`. Exports:

```ts
export interface StaleActiveResult {
  is_stale: boolean;
  brief_id: string | null;
  elapsed_minutes: number | null;
  execution_started_at: string | null;
}

/**
 * Parse a Trigger state file (the JSON content read from
 * brdonath1/trigger:state/<slug>.json) and determine whether the active
 * slot is stuck. Returns is_stale=false on any parse failure or absent
 * field — never throws. Caller surfaces the warning only when is_stale=true.
 */
export function checkStaleActive(
  stateJson: string,
  now: Date,
  thresholdMs: number,
): StaleActiveResult;
```

Defensive contract: invalid JSON, schema mismatch, or missing nested fields all resolve to `{ is_stale: false, ...nulls }`. The caller cannot distinguish "not stale" from "could not check" — that's intentional: this is a visibility hint, not a guard, and false negatives are acceptable.

### `src/tools/bootstrap.ts` (modify)

Add a new parallel fetch alongside the existing core/prefetch/marker groups. The state file fetch:
- Targets `brdonath1/trigger`, branch `state`, path `state/${resolvedSlug}.json`.
- 404 / fetch error → silently treat as "no state file"; no warning surfaced. Same non-fatal contract as `ensureTriggerMarker`.
- Success → pass content to `checkStaleActive(content, new Date(), STALE_ACTIVE_THRESHOLD_MS)`.
- On `is_stale: true`, push a one-line warning to `warnings` and an info-level `STALE_ACTIVE_DETECTED` diagnostics entry with the structured payload.

**Important: cross-repo + cross-branch fetch.** The existing `fetchFile(repo, path)` in `src/github/client.ts` does NOT accept a ref parameter — it always reads from the repo's default branch. The Trigger state files live on the `state` branch of `brdonath1/trigger`, so a minimal backwards-compatible extension is required (see next subsection). Do NOT introduce a separate fetch path or duplicate Octokit setup — the existing client is the single read path.

### `src/github/client.ts` (modify — minimal `fetchFile` extension)

Extend the existing `contentsUrl` helper and `fetchFile` exported function to accept an optional `ref` parameter:

```ts
function contentsUrl(repo: string, path: string, ref?: string): string {
  const base = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/contents/${path}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

export async function fetchFile(
  repo: string,
  path: string,
  ref?: string,   // NEW — optional; omit for default branch (existing behavior)
): Promise<FileResult> {
  const url = contentsUrl(repo, path, ref);
  // ... rest of function body unchanged
}
```

`fetchSha`, `fileExists`, `getFileSize`, and `listDirectory` also call `contentsUrl` — they should NOT gain a ref parameter in this brief. They are used only on PRISM-managed default-branch paths; widening their signatures has no current caller need and adds surface area for misuse. Leave them as-is.

`tests/github-client.test.ts` (or equivalent — check existing test file naming): add cases verifying:
- `fetchFile(repo, path)` (no ref) hits the URL without `?ref=` (current behavior preserved).
- `fetchFile(repo, path, "state")` hits the URL with `?ref=state` query string.
- Special characters in ref are URL-encoded (`fetchFile(repo, path, "feature/x")` → `?ref=feature%2Fx`).

**Bytes accounting:** Do NOT increment `bytesDelivered` or `filesFetched` for the state file. Its content is server-side-only — it never reaches Claude's context. Only the resulting warning string (≤ ~200 chars) reaches the response.

Warning text (single line, fits banner format):

```
Trigger active slot stuck on {brief_id} ({N}m elapsed, no PR). Daemon restart required (see INS-236).
```

Diagnostics entry (structured, available to operator/observer code):

```ts
diagnostics.info("STALE_ACTIVE_DETECTED", `Trigger active slot stuck on ${brief_id}`, {
  brief_id,
  elapsed_minutes: N,
  execution_started_at: <iso>,
  threshold_minutes: 30,
  recovery_procedure: "INS-236",
});
```

### `src/config.ts` (modify)

Add `STALE_ACTIVE_THRESHOLD_MS` env-var-backed constant:

```ts
export const STALE_ACTIVE_THRESHOLD_MS = Number(
  process.env.TRIGGER_STALE_ACTIVE_THRESHOLD_MS ?? 30 * 60 * 1000,
);
```

Default 30 minutes. Operator can tune via Railway env-set without code change.

### `src/config.ts` SERVER_VERSION (modify)

Bump SERVER_VERSION from 4.3.0 to 4.4.0 with explanatory comment.

### `package.json` (modify)

Bump version from 4.2.0 to 4.4.0 to match SERVER_VERSION. Note: brief-415 left package.json at 4.2.0 while bumping SERVER_VERSION to 4.3.0; this brief should bring them back in sync (skipping 4.3.0 in package.json is fine — semver is for the runtime, and the gap matches the actual deploy history).

### `tests/utils/stale-active-check.test.ts` (new)

Unit tests cover:
- Stale: active set, started 31 min ago, no PR → `is_stale: true`, correct elapsed_minutes
- Healthy running: active set, started 5 min ago, no PR → `is_stale: false`
- PR opened: active set, started 31 min ago, pr_created_at set → `is_stale: false`
- Null active: `state.active == null` → `is_stale: false`
- Threshold edge: started exactly threshold ago → `is_stale: false` (strict `>`)
- Just past threshold: started threshold + 1ms ago → `is_stale: true`
- Malformed JSON: `checkStaleActive("not json", ...)` → `is_stale: false` (no throw)
- Missing timeline field: `{ active: { brief_id: "x" } }` → `is_stale: false`
- Missing execution_started_at: `{ active: { timeline: { pr_created_at: null } } }` → `is_stale: false`

### `tests/bootstrap-stale-active.test.ts` (new)

Integration test (mock `fetchFile` calls) verifies:
- State file 404 → no warning, no diagnostics
- State file with stale active → warning in `result.warnings`, `STALE_ACTIVE_DETECTED` in diagnostics, banner_text includes the warning line
- State file with healthy active → no warning, no diagnostics
- State file with null active → no warning
- State file fetch throws 5xx → no warning, bootstrap still succeeds (defensive contract)

### `tests/tool-surface.test.ts` (no change expected)

The brief does not register a new tool, so tool-surface counts stay at 23/23. Re-run as a regression guard.

---

## Out of scope

- **Banner-line auto-suppression.** No special UX for "skip the recommendation when stale-active warning fires." If both warnings exist they both render — operator decides. Combining them is a separate concern.
- **Auto-recovery.** This brief does not attempt to clear the stale active record from the bootstrap path. Recovery is operator-side per INS-236; bootstrap only surfaces the need.
- **Detection of pane-dead or quarantined-wrong-repo statuses in history.** PR #38's daemon-side guards already write structured history records for these cases, so the active slot clears automatically on detection. Surfacing those status patterns from history is a future visibility piece if it becomes useful — not this brief.
- **Multi-project stale-active scan.** Bootstrap only checks the project being booted, not all enrolled projects. Cross-project visibility is a separate concern (analytics or status-tool surface).
- **Daemon health probe.** The brief checks state, not daemon liveness directly. A daemon that's down but has a clean active slot looks the same as a healthy idle daemon from this surface — that's correct behavior; the wedge is what matters.

---

## Test plan

Automated (CI gates — Claude Code runs these during execution):

- [ ] `npm run lint` — biome clean
- [ ] `npm run build` — tsc clean
- [ ] `npm test` — all tests pass (current count is 880 from brief-415; expect ~905 after this brief: ~15 new in `stale-active-check`, ~5 integration in `bootstrap-stale-active`, ~3 in `github-client` for the ref extension)
- [ ] `npx tsc --noEmit` — clean
- [ ] New unit tests cover all 9 cases listed in `tests/utils/stale-active-check.test.ts`
- [ ] New integration tests cover all 5 cases listed in `tests/bootstrap-stale-active.test.ts`

Post-deploy (operator confirms after Railway redeploys):

- [ ] Server logs show `version: "4.4.0"` on next container start (`PRISM MCP Server started` line, `version` attribute).
- [ ] `npm start` log line shows `prism-mcp-server@4.4.0` (package.json bump landed).

**Live verification of the surfacing itself:** No manufactured stale-active scenario is required. The five integration test cases above exercise the full surfacing pipeline end-to-end with deterministic state-file fixtures — the same logic that fires in production, just driven by mocks instead of a real wedge. Real-world verification will happen naturally the next time a stale-active actually occurs in the wild (rarer post-Pieces 1+2 but not impossible — daemon-down-between-sessions still produces them). When that happens, the surfacing fires for real; until then, the test coverage is the verification.

---

## INS-234 self-check

- Brief declares: `Repo: prism-mcp-server` ✓
- Brief queue path: `brdonath1/prism-mcp-server/.prism/briefs/queue/brief-416-stale-active-bootstrap-surfacing.md` ✓
- All execution lives on prism-mcp-server. No cross-repo edits. Match. ✓

<!-- EOF: brief-416-stale-active-bootstrap-surfacing.md -->
