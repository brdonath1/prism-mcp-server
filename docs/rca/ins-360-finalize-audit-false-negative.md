# INS-360 RCA — Finalize-audit false negative: `needs_creation` for a live `session-log.md`

> **Brief:** brief-s195b-ins360-finalize-audit-rca (diagnosis only, INS-177 audit-then-fix).
> **Incident:** During the S191 finalize of project `prism` (2026-07-12, ~21:10 CST),
> `prism_finalize action="audit"` classified `.prism/session-log.md` as
> `needs_creation` although the file existed on `brdonath1/prism` `main`
> (present and untouched since the S189 finalize commit `605751d`). The
> subsequent finalize commit `70af58d` overwrote it (−50 lines, orphaning the
> S185–S189 entries; restored at S192 from the `605751d` parent blob).
> **Characterization tests:** `tests/finalize-audit-false-negative.test.ts`
> (green on the defective behavior; the fix brief must invert them).

## 1. Verdict

**Defect class (a) is CONFIRMED from code:** every non-404 operational error
on a living-document read — transient 401 past the retry budget, any 5xx,
non-rate-limit 403, exhausted rate limit, timeout, socket error, and the
empty/oversize-content shape — collapses into `needs_creation: true` with no
warning, no diagnostic, and (for most classes) no log line. The collapse locus
is `resolveDocFiles`, whose `Promise.allSettled` loop keeps only fulfilled
outcomes and silently discards rejections (`src/utils/doc-resolver.ts:121-126`).

The specific S191 trigger cannot be pinned to a single error class from code
alone (Railway logs from the window rotated), so §4 ranks the candidates with
the exact evidence that discriminates them. The top two candidates — a 401
outlasting the SRV-35 retries, and a single unretried 5xx — are both proven
mechanisms: the characterization tests reproduce the exact S191 audit output
(`exists: false, needs_creation: true` for one doc, nine healthy) from either.

## 2. The existence-determination chain (audit path)

For each of the 10 `LIVING_DOCUMENT_NAMES` (`src/config.ts:376`):

| Step | Code | Behavior |
|---|---|---|
| 1 | `auditPhase` → `resolveDocFiles(projectSlug, [...LIVING_DOCUMENT_NAMES])` — `src/tools/finalize.ts:223` | Fan-out fetch of all 10 docs |
| 2 | `resolveDocFiles` — `src/utils/doc-resolver.ts:114-119` | `Promise.allSettled` over per-doc `resolveDocPath` |
| 3 | `resolveDocPath` — `src/utils/doc-resolver.ts:34-53` | Fetch `.prism/{doc}`; on error: message matching `/Not found/i` → legacy-root fallback; anything else → **rethrow** (SRV-44) |
| 4 | `fetchFile` — `src/github/client.ts:241-266` | `GET /repos/{owner}/{repo}/contents/{path}`, **no `ref`** → GitHub resolves the default branch per request (`contentsUrl`, `client.ts:78-86`) |
| 5 | `fetchWithRetry` — `src/github/client.ts:167-230` | Retries: 429 (≤3), transient 401 (≤2, `MAX_TRANSIENT_401_RETRIES`, `client.ts:142,204-214`), rate-limited 403 (≤3, `client.ts:219-226`). **No retry** for 5xx; timeout (15 s, `client.ts:34`) and network errors throw immediately (`client.ts:180-187`) |
| 6 | `handleApiError` — `src/github/client.ts:91-127` | 404 → `"Not found: …"`; 401 → INS-311 transient-aware message; 403 → scope/rate-limit message; else `"GitHub API {status}: …"` |
| 7 | **The defect:** `resolveDocFiles` — `src/utils/doc-resolver.ts:121-126` | Only `status === "fulfilled"` outcomes enter the map; **rejections are discarded with no log, no failed-list, no error** |
| 8 | `auditPhase` — `src/tools/finalize.ts:225-237` | `docMap.get(doc)` misses → `{ exists: false, needs_creation: true }`. `audit.warnings` never mentions it (warnings cover only handoff-history and commit-history failures, `finalize.ts:317-319,373-375`) |

Two aggravating contrasts inside the same codebase:

- The sibling plural fetcher `fetchFiles` (`src/github/client.ts:285-317`)
  **does** track `failed[]`, logs `"github.fetchFiles partial failure"`, and
  returns an `incomplete` flag. `resolveDocFiles` — the one the audit uses —
  reports nothing.
- The SRV-44 hardening deliberately made `resolveDocPath` rethrow operational
  errors so they would *not* masquerade as "not found" — but the plural
  wrapper converts exactly those rethrown errors back into silent absence.
  The single-doc path was fixed; the fan-out path re-introduced the collapse.

## 3. Misclassification table — every path from "exists on main" to `needs_creation`

All paths terminate at the same drop (`doc-resolver.ts:121-126`) and
classification (`finalize.ts:227-236`). "Log evidence" is what production
(`LOG_LEVEL=info`) emits before the silent drop.

| ID | Trigger | Path through code | Retried? | Log evidence | Characterization test |
|---|---|---|---|---|---|
| P1 | 401 persisting past bounded retries (INS-311 blip > ~1.5 s) | `client.ts:204-214` exhausted → `client.ts:98-102` → SRV-44 rethrow → drop | 2 retries (500/1000 ms) | 2× warn `"Transient 401, retrying before diagnosing PAT death (INS-311)"` with the doc URL | ✅ tool-level |
| P2 | Any 5xx (502/503/504 gateway blip) | `client.ts:126` → rethrow → drop | **Never** | **None** | ✅ unit + tool-level |
| P3 | Timeout ≥ 15 s (`GITHUB_REQUEST_TIMEOUT_MS`, `client.ts:34`) | `client.ts:180-182` throw, no retry → drop | Never | 1× warn `"github fetch timed out"` | — (mechanism identical to P2; table entry) |
| P4 | Socket/DNS error (undici `TypeError`) | `client.ts:187` → drop | Never | **None** | — |
| P5 | Non-rate-limit 403 | `client.ts:115` → drop | Never | **None** | ✅ unit |
| P6 | Rate limit exhausted (429 / rate-limited 403 after ≤3 retries) | `client.ts:189-198,219-229` → `client.ts:110-124` → drop | ≤3 | Multiple warn `"Rate limited/403 rate limit, retrying"` | — |
| P7 | Spurious double-404 (GitHub answers 404 for auth-context blips on private repos, or a storage read flake) — requires 404 on **both** `.prism/` and root | `doc-resolver.ts:46-52` fallback → second 404 → `"Not found"` rejection → drop | Never | **None** | — (indistinguishable from genuine absence at this layer) |
| P8 | Contents API returns `content: ""` (empty file, or the >1 MB truncation shape) | `client.ts:258-260` throw → no `/Not found/i` match → rethrow → drop | n/a | **None** | ✅ unit |

**Candidate classes from the brief, confirmed or ruled out:**

- **(a) non-404 errors collapsed into "absent" — CONFIRMED.** P1–P6 and P8
  above; the collapse is structural, not incidental.
- **(b) wrong ref (stale default branch / SHA) — RULED OUT.** Audit reads pass
  no `ref` (`client.ts:84-85`); GitHub resolves the default branch server-side
  per request. The indefinite `defaultBranchCache` (`client.ts:626-636`) feeds
  only `getHeadSha`/`createAtomicCommit` (`client.ts:680,751`) — commit phase,
  not the audit, and `prism`'s default branch never changed.
- **(c) path normalization / `.prism/` redirection mismatch — RULED OUT.** The
  map is keyed by the same `LIVING_DOCUMENT_NAMES` strings used for lookup
  (`finalize.ts:223-227`); `DOC_ROOT = ".prism"` (`config.ts:115`) matches the
  incident file's real path. A key mismatch would misclassify deterministically
  every session — contradicted by clean audits at S189, S190, and S192+.
- **(d) truncated tree/contents listing — RULED OUT for this classification.**
  Existence is determined by per-file contents GETs, never a tree or directory
  listing. `listDirectory` (`finalize.ts:215-218`) feeds only drift detection
  and the backup check, not `living_documents`.
- **(e) race with a concurrent commit — RULED OUT (effectively).** Reads
  resolve default-branch HEAD at request time; a concurrent commit to *other*
  files cannot 404 an existing path on the contents API. The file was
  untouched since `605751d` and the repo history shows no force-push. The only
  race-shaped residue is the P7 flake, ranked below.

## 4. Ranked candidates for the S191 event + discriminating evidence

Prior context: exactly **one of ten** parallel doc fetches failed — this
favors a per-request flake (P1/P2/P4) over systemic causes (P6 rate limiting
or PAT death would degrade several of the ten concurrent requests; P8 is
deterministic and S192+ audits passed on the same file).

| Rank | Candidate | Why ranked here | Discriminating evidence (what settles it) |
|---|---|---|---|
| 1 | **P1 — 401 outlasting SRV-35 retries** | Transient 401s are *documented on this exact server↔GitHub path* (INS-311; SRV-35 was built for them). The retry budget only absorbs blips shorter than ~1.5 s across 3 attempts. | Railway logs 2026-07-12 21:00–21:15 CST: **two** warn lines `"Transient 401, retrying before diagnosing PAT death (INS-311)"` whose `url` ends `/contents/.prism/session-log.md`, with no later 200 for that URL. Additionally the info line `"prism_finalize audit timing"` (`finalize.ts:2338`) would show `ms` inflated by ≈1500 ms over a normal audit — the characterization run measured `ms:1504` (P1) vs `ms:1` (P2) on otherwise identical mocks. |
| 2 | **P2 — single unretried 5xx** | GitHub 502/503 blips are routine; the code has **zero** defense (no retry, no log). Leaves no trace — consistent with no anomaly having been noticed in the window. | *Absence* of both the 401-retry warn lines and the timeout warn line around the audit-timing log, while the audit still misclassified — that combination excludes P1/P3/P6 and leaves {P2, P4, P7}. Separating those three retroactively is impossible with current logging (nothing is emitted); the fix brief's structured fetch-failure log (status, URL, attempt) is what makes this class discriminable next time. |
| 3 | **P3 — 15 s timeout** | Requires a single hung socket among ten parallel requests; possible but the audit would visibly stall. | Warn line `"github fetch timed out"` with the doc URL; audit-timing `ms ≥ 15000`. If the surviving audit-timing line shows `ms < 15000`, P3 is **excluded outright**. |
| 4 | **P4 — socket/DNS error** | Railway egress is stable; rarer than GitHub-side 5xx. | Same elimination signature as P2 (nothing logged). Undici error details would only appear with future structured logging. |
| 5 | **P7 — spurious double-404** | Needs two correlated 404s (`.prism/` then root) within ~1 s; GitHub auth blips on this server have historically manifested as 401 (INS-311), not 404. | Cannot be discriminated server-side even with better logging of statuses alone (a real 404 and a spurious one look identical); requires correlating with GitHub-side availability incidents, or a delayed re-check (the fix's re-verify step) at event time. |
| 6 | **P6 — rate-limit exhaustion** | Ten parallel doc reads + history/commits ≈ 15 requests; PAT budget 5000/h; and rate limiting would have hit several requests, not exactly one. | Warn lines `"Rate limited, retrying"`/`"403 rate limit, retrying"` (absent), and `x-ratelimit-remaining` trending to 0 across the window. |
| 7 | **P8 — empty/oversize content shape** | Deterministic — would have reproduced at S192's restore and at every later audit of the same file. It did not. | S192+ audits passing on the same file already exclude it for S191. |

**Most probable root cause:** P1 (persistent transient 401, INS-311 class),
with P2 (unretried 5xx) close behind — evidence grade for the *mechanism* is
proven-by-test; evidence grade for the *specific S191 trigger* is
circumstantial (log rotation), which is exactly why the fix must make every
path in §3 visible and non-destructive rather than target one status code.

## 5. Destructive coupling: audit `needs_creation` → commit overwrites a live file

The false classification would be harmless if the commit phase could not act
on it destructively. It can, in both modes:

1. **Instruction surface.** The audit returns `living_documents[]` (with
   `needs_creation: true`) plus the session-end rules to the operator
   (`finalize.ts:2385-2393`). The rules treat `needs_creation` as "compose
   this document from scratch" — the operator has no signal that the flag may
   mean "read failed," because the response contains none (§2 step 8).
2. **Phased commit pushes verbatim.** `action=commit` accepts operator-built
   `files[]`; validation checks only content shape — EOF sentinel, non-empty,
   handoff schema (`finalize.ts:1197-1200`). `guardPushPath` only normalizes
   root→`.prism/` paths (`src/utils/doc-guard.ts:101-128`). The write lands
   via `safeMutation` → `createAtomicCommit` (`finalize.ts:1274-1281`) as a
   Git-Trees **whole-file replacement**: no create-vs-update distinction, no
   cross-check that a doc the audit called `needs_creation` is in fact still
   absent at commit time, and no append-only/shrink guard for
   `session-log.md`. GitHub optimistic concurrency (INS-69 rule 4) never
   fires — the overwrite is a "clean" update on top of the current HEAD.
3. **The codebase already knows the safe pattern.** `fullPhase`'s draft
   bridge re-fetches `session-log.md` at assembly time and, on fetch failure,
   **skips the mutation** with a visible `DRAFT_BRIDGE_FETCH_FAILED`
   diagnostic (`finalize.ts:2108-2118`) — fetch-failure ≠ absent, handled
   correctly one code path away from the audit that conflates them.

Sibling risk (same family, write side): `fileExists` maps a timeout to
`false` (SRV-14, `client.ts:427-443`), feeding `resolveDocPushPath`
(`doc-resolver.ts:80-98`). For a legacy root-resident repo, a timing blip
could redirect a living-doc write to `.prism/`, creating a duplicate. Not the
S191 cause (the `prism` repo is `.prism/`-resident, so redirection converges
on the same path), but the fix design should treat it as the same defect
class.

## 6. Recommended fix design (for the follow-up brief)

Classification and coupling must both change; fixing only the first leaves
the next unclassified error destructive.

1. **Three-state resolution.** `resolveDocFiles` returns per-doc outcomes:
   `found {content,sha,size}` / `absent` (only the `/Not found/i` rejection,
   i.e. genuine 404 on both paths) / `fetch_failed {error}`. No rejection is
   ever dropped.
2. **Audit surfaces fetch failures.** `auditPhase` maps `fetch_failed` to
   `{ exists: "unknown", needs_creation: false, fetch_failed: true }`, adds an
   `audit.warnings` entry, and emits an `AUDIT_FETCH_FAILED` diagnostic with
   status + URL. `needs_creation: true` becomes provable-absence-only.
3. **Commit-side guard (destructive-coupling break).** For living documents,
   `commitPhase` verifies before writing: if the supplied content would
   replace an existing doc that the same session's audit reported
   `needs_creation` — or, cheaper and stateless, if a doc-being-created
   already exists at commit time (live SHA present) — fail closed with a
   diagnostic requiring an explicit operator override. For append-only docs
   (`session-log.md`), additionally reject a commit that shrinks the live
   file beyond a small tolerance unless an archive rides the same commit
   (the archive path already computes exactly this split — `applyArchive`,
   `finalize.ts:1052,1139-1140`).
4. **Retry parity for reads.** Extend `fetchWithRetry` with a bounded 5xx
   retry for idempotent GETs (2 attempts, short backoff) — P2 currently
   converts a single gateway blip into a terminal failure.
5. **Observability.** Log every dropped/failed doc resolution at warn with
   URL + status (mirroring `fetchFiles`'s partial-failure log) so the §4
   discriminators exist the next time this fires.
6. **Invert the characterization tests.** The five tests in
   `tests/finalize-audit-false-negative.test.ts` assert the defective
   behavior and MUST be flipped by the fix: map misses become
   `fetch_failed` outcomes; `needs_creation` stays `false`; warnings become
   non-empty.

<!-- EOF: ins-360-finalize-audit-false-negative.md -->
