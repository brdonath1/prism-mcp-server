/**
 * brief-417 Phase 3c-A: live integration test for the cc_subprocess +
 * Sonnet 4.6 routing path on `generatePendingDocUpdates`.
 *
 * This test is gated behind `RUN_LIVE_INTEGRATION_TESTS=true` to avoid
 * burning OAuth quota on CI. To run locally:
 *
 *   RUN_LIVE_INTEGRATION_TESTS=true \
 *   SYNTHESIS_PDU_TRANSPORT=cc_subprocess \
 *   SYNTHESIS_PDU_MODEL=claude-sonnet-4-6 \
 *   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
 *   GITHUB_PAT=ghp-... \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   npm test -- src/ai/__tests__/synthesize-pdu-routing.integration.test.ts
 *
 * The test calls `generatePendingDocUpdates` against a small fixture project
 * (defaults to `prism-mcp-server` itself — the test reads its own repo's
 * living docs to keep quota cost low) and asserts the basic shape of the
 * synthesized output.
 */

import { describe, it, expect } from "vitest";

const LIVE_TESTS_ENABLED = process.env.RUN_LIVE_INTEGRATION_TESTS === "true";
const TARGET_PROJECT = process.env.LIVE_INTEGRATION_PROJECT ?? "prism-mcp-server";

describe.skipIf(!LIVE_TESTS_ENABLED)(
  "generatePendingDocUpdates — cc_subprocess + Sonnet 4.6 (LIVE)",
  () => {
    it("synthesizes a well-formed pending-doc-updates output with the routed transport", async () => {
      // Force cc_subprocess transport for this test if not already configured.
      process.env.SYNTHESIS_PDU_TRANSPORT =
        process.env.SYNTHESIS_PDU_TRANSPORT ?? "cc_subprocess";
      process.env.SYNTHESIS_PDU_MODEL =
        process.env.SYNTHESIS_PDU_MODEL ?? "claude-sonnet-4-6";

      const { generatePendingDocUpdates } = await import("../synthesize.js");

      const sessionNumber = 9999; // synthetic — won't collide with real sessions
      const result = await generatePendingDocUpdates(TARGET_PROJECT, sessionNumber);

      expect(result.success).toBe(true);
      expect(result.bytes_written).toBeGreaterThanOrEqual(1024); // ≥ 1 KB
      // The function pushes to GitHub; verify no error propagated up.
      expect(result.error).toBeUndefined();
    }, 240_000); // align with SYNTHESIS_TIMEOUT_MS default
  },
);

// Always run a sentinel placeholder so vitest doesn't complain about an
// empty file when the suite is skipped.
describe("synthesize-pdu-routing.integration — placeholder", () => {
  it("integration suite is gated behind RUN_LIVE_INTEGRATION_TESTS=true", () => {
    expect(LIVE_TESTS_ENABLED || !LIVE_TESTS_ENABLED).toBe(true);
  });
});
