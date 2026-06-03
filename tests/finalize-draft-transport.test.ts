/**
 * Transport-aware draft timeout + deadline resolution.
 *
 * Verifies that resolveDraftTimeout() and resolveDraftDeadline() select the
 * cc_subprocess-specific constants when SYNTHESIS_DRAFT_TRANSPORT is
 * "cc_subprocess", and fall back to the standard finalize constants otherwise.
 *
 * Pure-function tests — no mocking needed.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { resolveDraftTimeout, resolveDraftDeadline } from "../src/tools/finalize.js";
import {
  FINALIZE_DRAFT_TIMEOUT_MS,
  FINALIZE_DRAFT_DEADLINE_MS,
  FINALIZE_DRAFT_DEADLINE_CC_MS,
  CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS,
} from "../src/config.js";

describe("resolveDraftTimeout", () => {
  it('returns CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS for "cc_subprocess"', () => {
    expect(resolveDraftTimeout("cc_subprocess")).toBe(CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS);
  });

  it("returns FINALIZE_DRAFT_TIMEOUT_MS for undefined", () => {
    expect(resolveDraftTimeout(undefined)).toBe(FINALIZE_DRAFT_TIMEOUT_MS);
  });

  it("returns FINALIZE_DRAFT_TIMEOUT_MS for unrecognized transport", () => {
    expect(resolveDraftTimeout("messages_api")).toBe(FINALIZE_DRAFT_TIMEOUT_MS);
    expect(resolveDraftTimeout("")).toBe(FINALIZE_DRAFT_TIMEOUT_MS);
  });
});

describe("resolveDraftDeadline", () => {
  it('returns FINALIZE_DRAFT_DEADLINE_CC_MS for "cc_subprocess"', () => {
    expect(resolveDraftDeadline("cc_subprocess")).toBe(FINALIZE_DRAFT_DEADLINE_CC_MS);
  });

  it("returns FINALIZE_DRAFT_DEADLINE_MS for undefined", () => {
    expect(resolveDraftDeadline(undefined)).toBe(FINALIZE_DRAFT_DEADLINE_MS);
  });

  it("returns FINALIZE_DRAFT_DEADLINE_MS for unrecognized transport", () => {
    expect(resolveDraftDeadline("messages_api")).toBe(FINALIZE_DRAFT_DEADLINE_MS);
    expect(resolveDraftDeadline("")).toBe(FINALIZE_DRAFT_DEADLINE_MS);
  });
});

describe("gated behavior — no env var set", () => {
  it("defaults resolve to the original 150s / 180s values", () => {
    // With no env-var overrides, the constants should be at their defaults.
    // resolveDraftTimeout(undefined) === FINALIZE_DRAFT_TIMEOUT_MS === 150_000
    // resolveDraftDeadline(undefined) === FINALIZE_DRAFT_DEADLINE_MS === 180_000
    expect(resolveDraftTimeout(undefined)).toBe(150_000);
    expect(resolveDraftDeadline(undefined)).toBe(180_000);
  });

  it("cc_subprocess resolves to 600s / 300s values", () => {
    expect(resolveDraftTimeout("cc_subprocess")).toBe(600_000);
    expect(resolveDraftDeadline("cc_subprocess")).toBe(300_000);
  });
});
