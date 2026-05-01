/**
 * Stale-active checker tests (brief-416 / D-196 Piece 3).
 *
 * Pure-function coverage. The 9 cases below match the contract in the brief:
 * stale, healthy running, PR opened, null active, threshold edge, just past
 * threshold, malformed JSON, missing timeline, missing execution_started_at.
 * The "fetch failure" case lives in the bootstrap integration test —
 * checkStaleActive itself never sees a fetch.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { checkStaleActive } from "../../src/utils/stale-active-check.js";

const THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes — production default
const NOW = new Date("2026-05-01T20:00:00.000Z");

/** Build a state-file JSON payload with the given timeline fields. */
function makeState(timeline: {
  execution_started_at?: string | null;
  pr_created_at?: string | null;
  brief_id?: string;
}): string {
  return JSON.stringify({
    active: {
      brief_id: timeline.brief_id ?? "brief-test",
      timeline: {
        execution_started_at: timeline.execution_started_at,
        pr_created_at: timeline.pr_created_at ?? null,
      },
    },
  });
}

describe("checkStaleActive — stale detection contract", () => {
  it("flags an active slot started 31 min ago with no PR as stale", () => {
    const startedAt = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    const state = makeState({
      execution_started_at: startedAt,
      pr_created_at: null,
      brief_id: "brief-416",
    });
    const result = checkStaleActive(state, NOW, THRESHOLD_MS);
    expect(result.is_stale).toBe(true);
    expect(result.brief_id).toBe("brief-416");
    expect(result.elapsed_minutes).toBe(31);
    expect(result.execution_started_at).toBe(startedAt);
  });

  it("does NOT flag a healthy in-flight dispatch (started 5 min ago, no PR)", () => {
    const startedAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const state = makeState({ execution_started_at: startedAt, pr_created_at: null });
    const result = checkStaleActive(state, NOW, THRESHOLD_MS);
    expect(result.is_stale).toBe(false);
    expect(result.brief_id).toBe(null);
    expect(result.elapsed_minutes).toBe(null);
    expect(result.execution_started_at).toBe(null);
  });

  it("does NOT flag when a PR is opened, even past the threshold", () => {
    // Post-PR wedges clear via post-merge actions or the next daemon cycle —
    // not the wedge class this surface targets.
    const startedAt = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    const prAt = new Date(NOW.getTime() - 25 * 60_000).toISOString();
    const state = makeState({ execution_started_at: startedAt, pr_created_at: prAt });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("does NOT flag when state.active is null (slot empty)", () => {
    const state = JSON.stringify({ active: null });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });
});

describe("checkStaleActive — threshold edge", () => {
  it("does NOT flag at exactly the threshold (strict >)", () => {
    const startedAt = new Date(NOW.getTime() - THRESHOLD_MS).toISOString();
    const state = makeState({ execution_started_at: startedAt, pr_created_at: null });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("flags at threshold + 1 ms", () => {
    const startedAt = new Date(NOW.getTime() - THRESHOLD_MS - 1).toISOString();
    const state = makeState({ execution_started_at: startedAt, pr_created_at: null });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(true);
  });
});

describe("checkStaleActive — defensive contract", () => {
  it("returns is_stale: false on malformed JSON (no throw)", () => {
    expect(() => checkStaleActive("not json", NOW, THRESHOLD_MS)).not.toThrow();
    expect(checkStaleActive("not json", NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false when timeline is missing", () => {
    const state = JSON.stringify({ active: { brief_id: "x" } });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false when execution_started_at is missing", () => {
    const state = JSON.stringify({
      active: { brief_id: "x", timeline: { pr_created_at: null } },
    });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false when execution_started_at is unparseable", () => {
    const state = makeState({
      execution_started_at: "not-a-date",
      pr_created_at: null,
    });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false on empty string", () => {
    expect(checkStaleActive("", NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false on null/non-object root", () => {
    expect(checkStaleActive("null", NOW, THRESHOLD_MS).is_stale).toBe(false);
    expect(checkStaleActive('"a string"', NOW, THRESHOLD_MS).is_stale).toBe(false);
    expect(checkStaleActive("42", NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("returns is_stale: false when active is not an object", () => {
    const state = JSON.stringify({ active: "not-an-object" });
    expect(checkStaleActive(state, NOW, THRESHOLD_MS).is_stale).toBe(false);
  });

  it("treats missing brief_id as null when stale (does not throw)", () => {
    const startedAt = new Date(NOW.getTime() - 31 * 60_000).toISOString();
    const state = JSON.stringify({
      active: {
        timeline: { execution_started_at: startedAt, pr_created_at: null },
      },
    });
    const result = checkStaleActive(state, NOW, THRESHOLD_MS);
    expect(result.is_stale).toBe(true);
    expect(result.brief_id).toBe(null);
  });
});
