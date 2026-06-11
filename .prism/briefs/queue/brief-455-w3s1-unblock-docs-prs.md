---
brief: 455
title: "W3-S1 — unblock docs-only PRs: required contexts must report on every PR (companion/no-op mechanism per SRV-38), scripts/** whitelist (SRV-56), bump-PR token (SRV-57) — D-257 wave 3, M-001"
parallel: false
affects:
  - .github/workflows/
complexity: small
workflow: metaswarm
---

# Brief 455 — W3-S1: unblock docs-only PRs (prism-mcp-server)

**Status: PENDING**
**Repo:** prism-mcp-server
**Origin:** D-257 wave 3, backlog item #1 (M-001, operator pre-settled slot 1). Sources: SRV-38 (primary) + SRV-56 + SRV-57 — read their FULL finding text from `.prism/audits/s167-server-audit.md` on `origin/brief/454-s167-server-audit` before designing anything (`git fetch origin brief/454-s167-server-audit` then `git show origin/brief/454-s167-server-audit:.prism/audits/s167-server-audit.md`). The backlog entry and master ledger live in the prism repo (`.prism/audits/s168-wave3-backlog.md`, `s168-master-findings.md`) — reference only; the SRV finding text is your spec.

**THE WHY (verbatim from the operator charter — your design lens):** "the system was built to carry an extreme level of context and intelligence from chat session to chat session throughout the entire life of each enrolled PRISM project; the outcome must be a system that delivers MUCH higher context+intelligence while becoming much more streamlined, token-efficient, effective, and reliable."

## STEP 0 — ACCOUNT ATTESTATION (D-259 / INS-319 + INS-320 — run before ANY other action)

Run exactly this as your first action and ensure its full output is visible in the pane:

```bash
claude auth status --text 2>&1; echo "CLAUDE_CODE_OAUTH_TOKEN: $([ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo present || echo absent)"; echo "ANTHROPIC_API_KEY: $([ -n "$ANTHROPIC_API_KEY" ] && echo present || echo absent)"
```

Then, MANDATORY FIRST QUESTION before any other command (INS-320): answer "Which email address is associated with this Claude Max account?" — derived EXCLUSIVELY from the auth-status output above; print it in the pane as `ACCOUNT EMAIL: <email>`. PROHIBITED answer sources: ~/.claude.json, Keychain, shell history, assumption. If no email field appears, print `ACCOUNT EMAIL: UNKNOWN — claude auth status exposes no email field; identity fields shown: <list>`. Copy the entire attestation (status output + flags + ACCOUNT EMAIL line) VERBATIM into the PR body under `## Account attestation`. Never print token/key values, prefixes, or fragments. ANTHROPIC_API_KEY present = RED FLAG: mark it in pane + PR body and continue (observational; enforcement is M-047).

## Verified ground truth (S168 chat-side reads — re-verify locally before editing)

- Branch protection on `main`: required status checks `build-and-test (18)` and `build-and-test (20)` (app_id 15368 = GitHub Actions), `strict: false`, `enforce_admins: true`. Re-read with `gh api repos/brdonath1/prism-mcp-server/branches/main/protection` and confirm before designing.
- `.github/workflows/ci.yml` (SHA 7fe1d799 at read time): job `build-and-test`, matrix `node-version: [18, 20]`; identical `paths` whitelist on push:main and pull_request — `src/**, tests/**, package.json, package-lock.json, tsconfig.json, biome.jsonc, vitest.config.ts, Dockerfile, railway.json, .github/workflows/ci.yml`. `scripts/**` is NOT whitelisted (SRV-56). `.github/workflows/model-freshness.yml` exists (SRV-57's bump-PR producer).
- Mechanism of the defect: a PR touching only non-whitelisted paths (e.g. `.prism/**`) never triggers ci.yml → the two required contexts never report → the PR is permanently unmergeable; `enforce_admins: true` blocks bypass. PR #74 (brief-454's report) is live proof.

## Required changes

1. **Required contexts report on EVERY pull_request (SRV-38).** Implement per SRV-38's fix spec (default direction: a companion no-op workflow producing the exact contexts `build-and-test (18)` and `build-and-test (20)` when ci.yml's whitelist does not fire). HARD INVARIANT regardless of mechanism: a failing real CI run must NEVER be maskable by a green no-op on the same PR. If your mechanism allows both to produce the same context names on one PR (e.g. paths-ignore complement on mixed code+docs PRs), you must either make co-firing provably impossible or switch to a single-workflow internal-gate design (always-on workflow, changed-files check gates the heavy steps, contexts always report true results). State in the PR body which design you chose, why, and how the no-masking invariant holds.
2. **Whitelist correction (SRV-56):** add `scripts/**` to BOTH the push and pull_request paths lists in ci.yml (confirm against SRV-56's text for any additional paths it names).
3. **Bump-PR token (SRV-57):** apply SRV-57's fix so model-freshness auto-PRs trigger CI (GITHUB_TOKEN-created PRs do not fire pull_request workflows; the finding's prescribed token/mechanism governs — do not invent scope beyond it).
4. **Do NOT touch branch protection.** `enforce_admins` and the required-context list stay exactly as-is (posture is M-039, operator-decided, out of scope).

## Verification (HARD BLOCK — evidence lands on GitHub, INS-148)

After your deliverable PR's own checks are green and it is MERGED (watcher auto-merge applies; if checks pass but merge has not occurred within ~5 minutes, say so in a PR comment and stop — do not force):
1. **Docs-only proof:** create a throwaway branch `test/455-docs-only-check` off post-merge `main` changing ONLY a file under `.prism/` (e.g. add `.prism/audits/.w3s1-probe`), open PR, capture both contexts reporting success + GitHub's mergeable state, then CLOSE the PR unmerged and delete the branch. Paste the captured evidence (context names, conclusions, mergeable state) into the DELIVERABLE PR body via comment.
2. **PR #74 unblock:** update PR #74's branch with post-merge main (`gh pr update-branch 74` or merge main into `brief/454-s167-server-audit` and push). Confirm both contexts report on #74 and it becomes mergeable. Do not merge #74 yourself; record its final check + mergeable state in a comment on the deliverable PR.
3. Existing tests: `npm run lint && npm run typecheck && npm run build && npm test` pass locally on your branch before opening the PR (pre-existing failures, if any, are recorded verbatim per INS-26 — not silently absorbed).

## PR body (evidence)

`## Account attestation` (verbatim, incl. ACCOUNT EMAIL line) · chosen mechanism + no-masking invariant proof · ci.yml whitelist diff summary · SRV-57 change summary · local test results · (via follow-up comments) docs-only probe evidence + PR #74 unblock evidence.

## Push directive (exactly one deliverable PR)

Create branch `brief/455-w3s1-unblock-docs-prs` off `origin/main`, commit the workflow changes, push, open ONE PR to `main` titled `fix(ci): required contexts report on every PR — unblock docs-only PRs (brief-455, M-001/SRV-38+56+57)` with the evidence block in the body. The throwaway `test/455-docs-only-check` PR in Verification step 1 is explicitly authorized as a closed-unmerged probe — it is not a second deliverable. No other PRs. Never push to main directly.

## Out of scope

- Branch protection settings (M-039, operator-decided).
- Any `.prism/` living document, server source (`src/**`), or test content changes beyond what SRV-56/57 prescribe.
- Merging PR #74 (watcher/operator owns it).
- All other wave-3 items (W3-S2..S7).

## Brief author notes

- model/effort deliberately UNPINNED — inherit the current CC user default (Fable 5 + max effort through 2026-06-21) per INS-309.
- First brief executing the full INS-319 + INS-320 attestation (email question mandatory). brief-454 remains in this queue pending PR #74's merge — leave it untouched; its post_merge archive is handled outside this brief.
- This fix PR self-validates: ci.yml is in its own whitelist, so your PR runs real CI.

<!-- EOF: brief-455-w3s1-unblock-docs-prs.md -->
