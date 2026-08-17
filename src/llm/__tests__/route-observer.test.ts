/**
 * S208 cerebras-tier follow-up (PR #126 review) -- direct unit pin that the
 * route-observer telemetry record carries the mechanical-cost qualityTier
 * for a cerebras decision. There is no dedicated route-observer test for the
 * openrouter case (its qualityTier is pinned only at the resolveRoute level
 * in routing-policy.test.ts / openrouter-routing.test.ts), so per the review
 * follow-up this adds the direct pin here rather than building out parallel
 * dispatch-level telemetry-capture machinery.
 */

import { describe, expect, it, vi } from "vitest";
import { observeRoute } from "../route-observer.js";

describe("route-observer telemetry -- cerebras decisions", () => {
  it("LLM_ROUTE_OBSERVATION carries qualityTier: mechanical-cost for a cerebras route", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const decision = observeRoute(
        { surface: "synthesis_draft", taskClass: "synthesis-draft" },
        {
          LLM_ROUTING_ENABLED: "true",
          LLM_ROUTING_DRY_RUN: "false",
          LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,cerebras",
          LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER: "cerebras",
          CEREBRAS_API_KEY: "cerebras-test-key",
        },
      );

      expect(decision.qualityTier).toBe("mechanical-cost");

      const routeLogs = stdoutSpy.mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((entry) => entry.msg === "LLM_ROUTE_OBSERVATION");
      expect(routeLogs).toHaveLength(1);
      expect(routeLogs[0]).toMatchObject({
        provider: "cerebras",
        qualityTier: "mechanical-cost",
        liveInvocationAllowed: true,
        reason: "live-provider-route",
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
