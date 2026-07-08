// Global test setup — set dummy env vars before any module imports.
// GITHUB_OWNER is hard-overwritten because tests assert on its specific value
// (e.g. cc-status.test.ts expects state_repo to be "test-owner/..."). A shell
// export of GITHUB_OWNER (common on developer machines) would otherwise leak
// into the test process and break those assertions.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.GITHUB_OWNER = "test-owner";
process.env.FRAMEWORK_REPO = process.env.FRAMEWORK_REPO || "prism-framework";

// brief-417: synthesis tests rely on the Anthropic client being initialized
// (getClient() checks ANTHROPIC_API_KEY at module load and returns null when
// unset, which short-circuits routing). Provide a dummy value here so test
// suites that mock @anthropic-ai/sdk don't hit the early-return guard. Tests
// that explicitly want the unset behavior must reset modules and clear the
// env themselves (see synthesize-thinking.test.ts pattern).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";
process.env.CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "sk-ant-oat01-test-dummy";

// Railway tools capture RAILWAY_API_TOKEN as an import-time const in config.ts
// (RAILWAY_ENABLED). Provide a dummy here so railway_* tests that drive the
// REAL client with a mocked fetch clear the "token not configured" guard.
// Tests needing the unset/disabled behavior set/delete it themselves at
// runtime (see bootstrap-synthesis-observation.test.ts).
process.env.RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || "test-railway-token";
