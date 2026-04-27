# Brief 200: Replace `tsc --noEmit` lint stopgap with Biome

**Goal:** Replace prism-mcp-server's `"lint": "tsc --noEmit"` stopgap (added in S78) with a real linter (Biome) so `npm run lint` provides actual style/error coverage instead of just typecheck.

**Scope:** Configuration + minimal code-style fixes only. NOT a full refactor or style overhaul. The objective is establishing baseline real-lint coverage; aggressive cleanup of existing patterns is out of scope.

## Background

S78 added `"lint": "tsc --noEmit"` to satisfy `npm run lint` callers (CI scripts, etc.) when no real linter was configured. PRISM's task-queue captured the follow-up:

> S78 added `"lint": "tsc --noEmit"` as a stopgap to satisfy `npm run lint` calls. Real lint coverage requires installing a linter (biome is single-binary zero-config; eslint is more conventional but heavier). Small follow-up brief: add dep + minimal config + update `lint` script.

This brief executes that follow-up. Choosing Biome over ESLint because:
- Single binary, zero-config baseline (no plugin sprawl)
- Native TypeScript support out of the box
- ~10x faster than ESLint on equivalent rule sets
- Modern toolchain, good fit for a small TS project like prism-mcp-server

## Files to change

1. `package.json` — add `@biomejs/biome` to devDependencies; replace the `lint` script; add a separate `typecheck` script
2. `biome.json` — new config file at repo root
3. CI workflow file (if one exists under `.github/workflows/`) — update to run both `lint` and `typecheck`
4. Any source files that fail biome's baseline check (fix in place; see step 4 for bounding)

## Execution plan

1. **Install Biome:**
   ```
   npm install --save-dev --save-exact @biomejs/biome@latest
   ```
   Use `--save-exact` because Biome's API surface is still settling and minor-version bumps can change rule defaults.

2. **Initialize config:**
   ```
   npx @biomejs/biome init
   ```
   Then edit `biome.json` to align with existing code style. Inspect a few source files in `src/` to confirm conventions before writing config. Expected baseline:
   - Indentation: spaces, width 2
   - Quote style: single quotes
   - Trailing commas: all
   - Line width: 100
   - Semicolons: as-needed (matches modern TS)

   Disable any rules that cause >20 violations on the first run — record those in a `// disabled until separate cleanup pass` comment in `biome.json`. The point of this brief is establishing coverage, not retroactive cleanup.

3. **Update `package.json` scripts:**
   - Replace `"lint": "tsc --noEmit"` with `"lint": "biome check src/"`
   - Add `"typecheck": "tsc --noEmit"` as a new separate script
   - Add `"format": "biome format --write src/"` for convenience (not gating)

4. **Run baseline lint:**
   ```
   npm run lint
   ```
   If errors surface:
   - First try `npx biome check --apply src/` to auto-fix what can be auto-fixed
   - For remaining issues: fix in source IF the count is small (≤20 across all files)
   - For remaining issues exceeding 20: disable the producing rule(s) in `biome.json` rather than mass-fixing source. The goal is baseline coverage, not retroactive style cleanup.

5. **Verify other scripts still pass:**
   ```
   npm run typecheck
   npm test
   ```
   Both must exit 0. If `npm test` fails due to a change you made, fix it before opening the PR.

6. **CI update (if applicable):**
   Look for `.github/workflows/*.yml` files. Any step that ran `npm run lint` previously was just running typecheck. Update those steps to run BOTH:
   ```
   - run: npm run lint
   - run: npm run typecheck
   ```
   This preserves the prior typecheck behavior while adding real lint coverage.

7. **Open PR.** Wait for CI green. Confirm no test regressions. Merge.

## Acceptance criteria

- [ ] `npm run lint` invokes Biome and exits 0
- [ ] `npm run typecheck` invokes `tsc --noEmit` and exits 0
- [ ] `npm test` passes (vitest, all existing suites green)
- [ ] `biome.json` exists at repo root with minimal config matching existing code style
- [ ] If a CI workflow file exists, it runs both `lint` and `typecheck`
- [ ] Zero new lint errors at PR-open time (either fixed or rule-disabled with comment)

## PR conventions

**PR title:** `chore: replace typecheck-as-lint stopgap with Biome (brief 200)`

**PR body:**
> Replaces the S78 stopgap of `"lint": "tsc --noEmit"` with Biome.
>
> - Adds `@biomejs/biome` as a dev dependency (`--save-exact`)
> - Adds minimal `biome.json` config aligned to existing code style
> - Splits `package.json` scripts: `lint` runs Biome; new `typecheck` script preserves prior tsc check; new `format` script for convenience
> - Updates CI (if present) to run both `lint` and `typecheck`
> - Fixes baseline lint errors (or disables noisy rules with comment)
>
> Closes PRISM task-queue follow-up: "Replace typecheck-as-lint with real linter on prism-mcp-server (S78)". Brief 200 in `.prism/briefs/queue/`.

## Final-output line

When complete, print exactly: `BRIEF 200 COMPLETE`.
