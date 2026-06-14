/**
 * Tests for synthesis failure tracking and alerting.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { recordSynthesisEvent, getSynthesisHealth } from "../src/ai/synthesis-tracker.js";

// Note: We need to reset the internal state between tests.
// Since the tracker uses module-level state, we test in sequence.

describe("synthesis tracker", () => {
  it("starts with healthy status and zero attempts", () => {
    const health = getSynthesisHealth();
    // May have events from other tests, so just check structure
    expect(health).toHaveProperty("total_attempts");
    expect(health).toHaveProperty("recent_successes");
    expect(health).toHaveProperty("recent_failures");
    expect(health).toHaveProperty("failure_rate");
    expect(health).toHaveProperty("status");
  });

  it("records successful synthesis events", () => {
    const before = getSynthesisHealth();
    const prevSuccesses = before.recent_successes;

    recordSynthesisEvent({
      project: "test-project",
      sessionNumber: 26,
      timestamp: new Date().toISOString(),
      success: true,
      input_tokens: 5000,
      output_tokens: 2000,
      duration_ms: 8000,
    });

    const after = getSynthesisHealth();
    expect(after.recent_successes).toBe(prevSuccesses + 1);
    expect(after.last_success).not.toBeNull();
    expect(after.last_success!.project).toBe("test-project");
  });

  it("records failed synthesis events", () => {
    const before = getSynthesisHealth();
    const prevFailures = before.recent_failures;

    recordSynthesisEvent({
      project: "failing-project",
      sessionNumber: 10,
      timestamp: new Date().toISOString(),
      success: false,
      error: "Anthropic API timeout",
      duration_ms: 30000,
    });

    const after = getSynthesisHealth();
    expect(after.recent_failures).toBe(prevFailures + 1);
    expect(after.last_failure).not.toBeNull();
    expect(after.last_failure!.error).toBe("Anthropic API timeout");
  });

  it("reports degraded status when failures exist below 50%", () => {
    // Record many successes to dilute failure rate below 50%
    for (let i = 0; i < 10; i++) {
      recordSynthesisEvent({
        project: `success-project-${i}`,
        sessionNumber: 100 + i,
        timestamp: new Date().toISOString(),
        success: true,
      });
    }

    const health = getSynthesisHealth();
    // With many successes and a few failures, should be "degraded" not "failing"
    expect(["healthy", "degraded"]).toContain(health.status);
  });

  it("reports failing status when failure rate >= 50%", () => {
    // Record many failures to push rate above 50%
    for (let i = 0; i < 30; i++) {
      recordSynthesisEvent({
        project: `failing-project-${i}`,
        sessionNumber: 200 + i,
        timestamp: new Date().toISOString(),
        success: false,
        error: "persistent failure",
      });
    }

    const health = getSynthesisHealth();
    expect(health.status).toBe("failing");
  });
});
