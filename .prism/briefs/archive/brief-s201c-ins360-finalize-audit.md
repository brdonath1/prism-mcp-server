# Brief s201c — Finalize-audit needs_creation false-negative fix (INS-360) (S201)

> **Purpose:** Implement the INS-360 FIX: `prism_finalize action=audit` (and the audit step inside `full`) can classify an EXISTING living document as `needs_creation` when the content fetch fails transiently, and downstream draft/commit then recreates the doc — overwriting real history (the S192 session-log.md incident; recovery required parent-blob restore). This brief hardens the classification and adds a recreate guard. It is NOT a general finalize refactor.

## Task

1. **Ground truth first.** Locate the audit inventory logic: `grep -rn "needs_creation" src/` (expected in `src/tools/finalize.ts` or a helper it imports). Read the code path that decides a mandatory living doc is missing, and the draft/commit paths that act on that classification. Cite file:line in the PR body.
2. **Implement the invariant:**
   - A doc may be classified `needs_creation` ONLY when its absence is CONFIRMED: the content fetch returns a definitive GitHub 404 AND a path-filtered commit-history check (`GET /repos/{owner}/{repo}/commits?path=<doc-path>&per_page=1`) returns zero commits for that path.
   - Any other failure shape (network error, timeout, 5xx, rate limit, auth blip) OR a 404 where the path HAS commit history → classify as `unverified` (new status), emit a `FINALIZE_AUDIT_UNVERIFIED_DOC` diagnostic naming the doc and the underlying error, and count it as neither healthy nor missing.
   - **Recreate guard:** `draft` and `commit`/`full` must never generate or push a from-scratch replacement for a doc classified `unverified`. Missing-doc creation remains allowed only for confirmed `needs_creation`.
3. **Tests** (per repo conventions; mock the GitHub client and assert on URL + method per INS-31 — do not read source in tests):
   - confirmed 404 + zero path commits → `needs_creation`;
   - fetch error (e.g. 500/timeout) + path commit history exists → `unverified` + diagnostic, NOT `needs_creation`;
   - transient 404 + path commit history exists → `unverified`, NOT `needs_creation`;
   - draft/commit refuses to recreate an `unverified` doc.
4. Run the full suite — must be green. Paste the summary in the PR body. Compute any grep-count verification claims against the code this brief actually prescribes (INS-166), accounting for pre-existing occurrences (INS-341).

## Hard constraints

- Touch ONLY the finalize audit/draft/commit classification paths and their tests. DO NOT modify `sanitizeContentField` or any sanitizer (KI-26 class), bootstrap, synthesis routing, or unrelated tools.
- DO NOT change behavior for docs whose fetch succeeds — healthy-path audit output must be byte-compatible.
- DO NOT add an account-attestation / "STEP 0" block (D-267/INS-319).
- Stay under 40 turns.

## Finishing up

- Branch from `main`: `git checkout main && git pull origin main && git checkout -b fix/brief-s201c-ins360-finalize-audit`
- Commit message: `fix: brief-s201c finalize-audit needs_creation false-negative guard (INS-360)`
- Push and open PR. Title: `fix: finalize-audit needs_creation false-negative guard (INS-360)`. Body: file:line citations, invariant statement, test list, suite output.
- The daemon auto-merges (CI required checks gate) and archives this brief on PR merge; do not delete the queue file yourself.

<!-- EOF: brief-s201c-ins360-finalize-audit.md -->