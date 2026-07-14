# Brief s195-ins360 — Finalize-audit false-negative RCA (S195)

> **Purpose:** Root-cause why `prism_finalize action="audit"` reported `.prism/session-log.md` as `needs_creation` for project `prism` during the S191 finalize (2026-07-12, ~21:10 CST) while the file existed on that repo's `main`; the subsequent finalize commit then overwrote it. This brief is diagnosis ONLY (INS-177 audit-then-fix): no behavior changes to src/. The fix ships in a follow-up brief once the diagnosis is settled. Do not investigate Trigger daemon code — the defect is in this repo's finalize audit path.

## Evidence (pinned — do not re-derive from memory)

- Incident repo: `brdonath1/prism` (the audited project). Repo under audit here: `brdonath1/prism-mcp-server` (this repo — the server that ran the audit).
- The S191 audit classified `.prism/session-log.md` as `needs_creation`. Git history of `brdonath1/prism` shows the file present and untouched since the S189 finalize commit `605751d`; the S191 finalize commit `70af58d` then overwrote it (−50 lines, orphaning the S185–S189 entries; restored at S192 from the `605751d` parent blob).
- Related prior signal: INS-311 — transient GitHub 401s have previously masqueraded as "missing/invalid" on this server's reads.
- Incident window: 2026-07-12 ~21:00–21:15 CST. Railway logs from that window may have rotated — ground the RCA in code reads and tests, not log availability.

## Task

1. Locate the finalize audit implementation (start with the finalize module, e.g. `finalize.ts`; grep for `needs_creation` and the document-inventory/existence-check path).
2. Trace exactly how per-file existence is determined during the audit: which GitHub API call, which ref/branch it resolves, and how errors are classified. Enumerate, with file:line citations, every code path that can yield `needs_creation` for a file that exists on `main`. Explicitly confirm or rule out each candidate class: (a) non-404 errors (401/403/5xx/network/rate-limit/timeout) collapsed into "absent"; (b) wrong ref (stale cached default branch or SHA); (c) path normalization / `.prism/` redirection mismatch; (d) truncated tree or contents listing; (e) race with a concurrent commit.
3. Identify the most probable root cause of the S191 event and grade the evidence. If a single cause cannot be proven from code alone, produce a ranked candidate table and, per candidate, the exact discriminating evidence (log line, response shape, timing) that would settle it. Do NOT exit with a bare INCONCLUSIVE — the ranked table with discriminators is the minimum deliverable for this step.
4. Add passing characterization test(s) that pin the CURRENT behavior of each misclassifying path found in step 2 — e.g., mock the GitHub existence fetch to return a transient 401/5xx and assert the audit presently reports `needs_creation`. Mock fetch and assert on URL + method (INS-31 pattern). Tests MUST pass on this branch: they document the bug and will be inverted by the fix brief.
5. Also cite where the audit result couples destructively into the commit phase (audit `needs_creation` → commit overwrites a live file). The fix design must address classification AND that destructive coupling.
6. Write findings to `docs/rca/ins-360-finalize-audit-false-negative.md`: root cause (or ranked candidates + discriminators), code citations, the step-2 misclassification table, recommended fix design for the follow-up brief, and the destructive-coupling note.

## Hard constraints

- DO NOT modify src/ behavior, the finalize pipeline, validation logic, server config, CI workflows, env, or credentials. New tests + the RCA doc only.
- DO NOT edit this repo's `.prism/` living documents.
- Establish the test-suite baseline BEFORE adding tests and report before/after counts in the PR body; treat pre-existing failures (e.g. env-dependent `client-routing.test.ts` failures recorded at S189) as baseline, not regressions, and do not "fix" them here.
- All added tests must pass. Turn budget: 60.

## Finishing up

- Branch from main: `git checkout main && git pull origin main && git checkout -b docs/brief-s195-ins360-finalize-audit-rca`
- Follow this repo's `CLAUDE.md` commit/PR conventions; if none apply, use commit message `docs: brief-s195-ins360 finalize-audit false-negative RCA`.
- Push and open a PR. Title matches the commit message. Body: root cause or ranked candidates, test before/after counts with the pre-existing-failure baseline, and the dequeue commit SHA (below).
- Self-dequeue (INS-324): immediately after the PR is opened, fetch the `briefs` branch, delete `.prism/briefs/queue/brief-s195-ins360-finalize-audit-rca.md`, and push; on a 409/422 race, re-fetch and retry up to 3 times. Never touch other queue files. Record the dequeue commit SHA in the PR body.
- The daemon watcher handles PR merge, notify, and archive. Do not merge the PR manually.

<!-- EOF: brief-s195-ins360-finalize-audit-rca.md -->
