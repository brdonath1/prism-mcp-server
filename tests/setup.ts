// Global test setup — set dummy env vars before any module imports.
// GITHUB_OWNER is hard-overwritten because tests assert on its specific value
// (e.g. cc-status.test.ts expects state_repo to be "test-owner/..."). A shell
// export of GITHUB_OWNER (common on developer machines) would otherwise leak
// into the test process and break those assertions.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.GITHUB_OWNER = "test-owner";
process.env.FRAMEWORK_REPO = process.env.FRAMEWORK_REPO || "prism-framework";
