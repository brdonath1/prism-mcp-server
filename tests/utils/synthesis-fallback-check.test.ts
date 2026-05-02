/**
 * Unit tests for the synthesis observation-event extractor (brief-419).
 *
 * Pure-function coverage. The cases below match the contract in the brief:
 * empty input, each kind in isolation, mixed kinds, wrong-project filter,
 * missing project tag, unknown kind, out-of-window, malformed timestamp,
 * malformed attributes, threshold edge (strict <), and counts on three of
 * each kind.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  checkSynthesisObservationEvents,
  type ObservationEventKind,
} from "../../src/utils/synthesis-fallback-check.js";
import type { RailwayLog } from "../../src/railway/types.js";

const NOW = new Date("2026-05-02T00:00:00.000Z");
const LOOKBACK_MS = 4 * 60 * 60 * 1000; // 4 hours — production default
const SLUG = "prism";

/** Build a RailwayLog with default valid attribute payload. */
function makeLog(overrides: {
  message?: string;
  timestamp?: string;
  severity?: string;
  attributes?: Array<{ key: string; value: string }> | null | undefined;
}): RailwayLog {
  return {
    message: overrides.message ?? "SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed",
    timestamp: overrides.timestamp ?? new Date(NOW.getTime() - 60_000).toISOString(),
    severity: overrides.severity ?? "warn",
    // The narrow declaration on RailwayLog is `attributes?: RailwayLogAttribute[]`,
    // but the defensive contract must handle truly malformed inputs (non-array,
    // missing entries). The helper accepts the test override at runtime.
    attributes: overrides.attributes as never,
  };
}

const PROJECT_TAG = { key: "projectSlug", value: SLUG };

describe("checkSynthesisObservationEvents — empty / no match", () => {
  it("returns has_events: false on empty array", () => {
    const result = checkSynthesisObservationEvents([], SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.fallback_count).toBe(0);
    expect(result.byte_warning_count).toBe(0);
    expect(result.preamble_warning_count).toBe(0);
  });

  it("returns has_events: false when no log entry matches an observation kind", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "Some unrelated warn-level event",
        attributes: [PROJECT_TAG],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
  });
});

describe("checkSynthesisObservationEvents — single events per kind", () => {
  it("matches a single SYNTHESIS_TRANSPORT_FALLBACK for the given project + window", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed, retrying via messages_api",
        attributes: [PROJECT_TAG, { key: "callSite", value: "pdu" }],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(true);
    expect(result.fallback_count).toBe(1);
    expect(result.byte_warning_count).toBe(0);
    expect(result.preamble_warning_count).toBe(0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe("SYNTHESIS_TRANSPORT_FALLBACK");
    expect(result.events[0].attributes.callSite).toBe("pdu");
    expect(result.events[0].attributes.projectSlug).toBe(SLUG);
  });

  it("matches a single CS3_QUALITY_BYTE_COUNT_WARNING", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "CS3_QUALITY_BYTE_COUNT_WARNING",
        attributes: [PROJECT_TAG, { key: "current_bytes", value: "120" }],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(true);
    expect(result.byte_warning_count).toBe(1);
    expect(result.fallback_count).toBe(0);
    expect(result.preamble_warning_count).toBe(0);
    expect(result.events[0].kind).toBe("CS3_QUALITY_BYTE_COUNT_WARNING");
  });

  it("matches a single CS3_QUALITY_PREAMBLE_WARNING", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "CS3_QUALITY_PREAMBLE_WARNING",
        attributes: [PROJECT_TAG, { key: "first_200_chars", value: "Sure, here is..." }],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(true);
    expect(result.preamble_warning_count).toBe(1);
    expect(result.fallback_count).toBe(0);
    expect(result.byte_warning_count).toBe(0);
    expect(result.events[0].kind).toBe("CS3_QUALITY_PREAMBLE_WARNING");
  });
});

describe("checkSynthesisObservationEvents — counts and mixed kinds", () => {
  it("counts three of each kind correctly", () => {
    const kinds: ObservationEventKind[] = [
      "SYNTHESIS_TRANSPORT_FALLBACK",
      "CS3_QUALITY_BYTE_COUNT_WARNING",
      "CS3_QUALITY_PREAMBLE_WARNING",
    ];
    const logs: RailwayLog[] = [];
    for (const kind of kinds) {
      for (let i = 0; i < 3; i++) {
        logs.push(
          makeLog({
            message: `${kind} sample ${i}`,
            timestamp: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
            attributes: [PROJECT_TAG],
          }),
        );
      }
    }
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(true);
    expect(result.fallback_count).toBe(3);
    expect(result.byte_warning_count).toBe(3);
    expect(result.preamble_warning_count).toBe(3);
    expect(result.events).toHaveLength(9);
  });

  it("extracts mixed kinds independently", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [PROJECT_TAG],
        timestamp: new Date(NOW.getTime() - 60_000).toISOString(),
      }),
      makeLog({
        message: "CS3_QUALITY_PREAMBLE_WARNING",
        attributes: [PROJECT_TAG],
        timestamp: new Date(NOW.getTime() - 90_000).toISOString(),
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.fallback_count).toBe(1);
    expect(result.preamble_warning_count).toBe(1);
    expect(result.byte_warning_count).toBe(0);
    expect(result.events).toHaveLength(2);
  });
});

describe("checkSynthesisObservationEvents — filtering rules", () => {
  it("does NOT surface an event whose project tag belongs to a different project", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [{ key: "projectSlug", value: "platformforge-v2" }],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
  });

  it("does NOT surface an event whose attributes lack a projectSlug field (legacy)", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [{ key: "callSite", value: "pdu" }],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
  });

  it("does NOT surface a warn entry whose message is not one of the three kinds", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "Unknown SYNTHESIS_*_TRANSPORT value — defaulting to messages_api",
        attributes: [PROJECT_TAG],
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
  });

  it("does NOT surface an event older than the lookback window", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [PROJECT_TAG],
        timestamp: new Date(NOW.getTime() - LOOKBACK_MS - 60_000).toISOString(),
      }),
    ];
    const result = checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS);
    expect(result.has_events).toBe(false);
  });
});

describe("checkSynthesisObservationEvents — defensive contract", () => {
  it("silently skips entries with unparseable timestamps", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [PROJECT_TAG],
        timestamp: "not-a-date",
      }),
    ];
    expect(() => checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS)).not.toThrow();
    expect(checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS).has_events).toBe(false);
  });

  it("silently skips entries with malformed (non-array) attributes", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        // @ts-expect-error — testing runtime defense, not the type contract
        attributes: "not-an-array",
      }),
    ];
    expect(() => checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS)).not.toThrow();
    expect(checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS).has_events).toBe(false);
  });

  it("silently skips entries with malformed attribute objects", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        // @ts-expect-error — testing runtime defense
        attributes: [{ key: 1, value: 2 }],
      }),
    ];
    expect(checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS).has_events).toBe(false);
  });
});

describe("checkSynthesisObservationEvents — boundary", () => {
  it("does NOT surface an event exactly at the lookback boundary (strict <)", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [PROJECT_TAG],
        timestamp: new Date(NOW.getTime() - LOOKBACK_MS).toISOString(),
      }),
    ];
    expect(checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS).has_events).toBe(false);
  });

  it("DOES surface an event at lookback - 1 ms", () => {
    const logs: RailwayLog[] = [
      makeLog({
        message: "SYNTHESIS_TRANSPORT_FALLBACK",
        attributes: [PROJECT_TAG],
        timestamp: new Date(NOW.getTime() - LOOKBACK_MS + 1).toISOString(),
      }),
    ];
    expect(checkSynthesisObservationEvents(logs, SLUG, NOW, LOOKBACK_MS).has_events).toBe(true);
  });
});
