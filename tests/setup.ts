// Global test setup — set dummy env vars before any module imports
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.GITHUB_OWNER = process.env.GITHUB_OWNER || "test-owner";
process.env.FRAMEWORK_REPO = process.env.FRAMEWORK_REPO || "prism-framework";
