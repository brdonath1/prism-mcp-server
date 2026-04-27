# CC Brief: GitHub Actions CI Pipeline

> **Priority:** Low — quick win, no production impact
> **Scope:** 1 new file (`.github/workflows/ci.yml`), no code changes
> **Branch:** `main` (direct push)
> **Estimated complexity:** Low — 15 minutes

---

## Mission

Add a GitHub Actions CI pipeline that runs the existing vitest test suite on every push to `main` and on every pull request. The project already has 32+ tests across 3 suites — this just automates running them.

Do NOT ask questions. This is a straightforward CI setup.

---

## Task Checklist

### Task 1: Create the workflow file

Create `.github/workflows/ci.yml` with the following requirements:

- **Triggers:** `push` to `main`, `pull_request` to `main`
- **Runner:** `ubuntu-latest`
- **Node version:** 20 (match the project's runtime)
- **Steps:**
  1. Checkout code
  2. Setup Node.js 20 with npm cache
  3. `npm ci` (clean install from lockfile)
  4. `npm run build` (TypeScript must compile clean)
  5. `npm test` (vitest must pass all tests)

**Environment variables for tests:**
- `GITHUB_PAT=test-pat-not-real` (tests use a dummy PAT)
- `GITHUB_OWNER=test-owner`
- `FRAMEWORK_REPO=prism-framework`

The workflow file should look approximately like this:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
        env:
          GITHUB_PAT: test-pat-not-real
          GITHUB_OWNER: test-owner
          FRAMEWORK_REPO: prism-framework
```

### Task 2: Verify locally

```bash
# Confirm tests pass before pushing
npm run build
npm test
```

### Task 3: Commit and push

```bash
git add -A && git commit -m "chore: add GitHub Actions CI pipeline — build + vitest on push" && git push origin main
```

---

## Completion Criteria

1. `.github/workflows/ci.yml` exists with the correct triggers and steps
2. `npm run build` passes locally
3. `npm test` passes locally
4. Changes pushed to `main`

---

## What NOT to Do

- Do NOT modify any source code
- Do NOT modify any existing tests
- Do NOT add secrets or real PAT values to the workflow
- Do NOT add deployment steps — Railway handles deployment via auto-deploy from GitHub
- Do NOT add code coverage, linting, or other steps — keep it minimal

<!-- EOF: ci-pipeline.md -->