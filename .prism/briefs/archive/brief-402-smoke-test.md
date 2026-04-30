# Brief 402: prism-mcp-server smoke test — INS-212 fix non-regression (re-push)

**Scope:** Single-PR documentation refinement on `brdonath1/prism-mcp-server`. Exercises the trigger daemon dispatch lifecycle end-to-end (queue → active → CC dispatch → PR creation → merge → post_merge) following the INS-212 multi-dispatch fix shipped via PR #31 on `brdonath1/trigger` at S95 (squash `6428fe6f4ce8ac506d5f8dab45c84f1391099edc`).

**Mode:** execute (CC creates PR; daemon handles merge per branch_strategy: main-only)

## Background

Brief 401 (same content) preflight-failed twice on an untracked `.env.bak.20260429-183521` artifact left behind by S95 credential cleanup. That blocker is now cleared; brief 402 is the re-push under the same scope. Note: brief 401's two retry records have already validated the INS-212 retry-path behavior live (`error.recoverable: true` cycled via retry_pending without multi-dispatch). Brief 402 covers the remaining happy-path completion check.

PR #31 changed `applyFailure` in `src/state/manager.ts` to respect `failedRecord.error.recoverable`. This brief confirms: (a) happy path is intact — exactly one dispatch, no multi-pane behavior; (b) the daemon's full dispatch lifecycle completes cleanly on a real brief.

## Change shape

Edit a single line in `README.md` to improve clarity. CC picks one of:
- Tighten a sentence's wording without changing meaning
- Fix a minor typo or missing article
- Improve a code-block language hint

Constraints:
- Exactly one file changed: `README.md`
- Diff: ≤3 lines added, ≤3 lines removed
- No structural reorganization (no new/changed headers, no section moves)
- No semantic changes to install instructions, examples, or any factual claim
- Commit message format: `docs: <description>`

## Verification (CC includes in PR body)

1. The exact diff (paste output of `git diff main`)
2. A one-sentence justification of why the change improves clarity
3. The literal string: `Smoke test for INS-212 fix (S96 D-179 closure)`

## Finishing up

- Open ONE pull request with title `docs: smoke-test wording refinement (S96 brief 402)`
- Do NOT push additional commits beyond the single README edit
- Do NOT touch any file other than `README.md`
- Do NOT modify `.prism/`, `.github/`, `package.json`, source code, or tests
- Exit cleanly after the PR is opened — daemon handles merge + post_merge

<!-- EOF: brief-402-smoke-test.md -->
