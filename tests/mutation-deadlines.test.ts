/**
 * SRV-97 (brief-461 Task B) — interactive mutation deadlines must sit at or
 * below MCP_SAFE_TIMEOUT, not at/above the ~60s MCP client ceiling.
 *
 * The old values (PUSH 60s, PATCH 60s, FINALIZE_COMMIT 90s) meant the client
 * gave up (errored turn) before the server's own deadline fired, and the
 * abandoned mutation could land afterwards — the root of the
 * errored-turn-retry-duplicates class. Bringing them under MCP_SAFE_TIMEOUT
 * (50s) lets the structured deadline error reach the client first.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  MCP_SAFE_TIMEOUT,
  PUSH_WALL_CLOCK_DEADLINE_MS,
  PATCH_WALL_CLOCK_DEADLINE_MS,
  FINALIZE_COMMIT_DEADLINE_MS,
} from "../src/config.js";

describe("SRV-97 — interactive mutation deadlines stay under the MCP client ceiling", () => {
  it("MCP_SAFE_TIMEOUT is 50s (10s buffer under the ~60s client ceiling)", () => {
    expect(MCP_SAFE_TIMEOUT).toBe(50_000);
  });

  it("PUSH_WALL_CLOCK_DEADLINE_MS <= MCP_SAFE_TIMEOUT", () => {
    expect(PUSH_WALL_CLOCK_DEADLINE_MS).toBeLessThanOrEqual(MCP_SAFE_TIMEOUT);
  });

  it("PATCH_WALL_CLOCK_DEADLINE_MS <= MCP_SAFE_TIMEOUT", () => {
    expect(PATCH_WALL_CLOCK_DEADLINE_MS).toBeLessThanOrEqual(MCP_SAFE_TIMEOUT);
  });

  it("FINALIZE_COMMIT_DEADLINE_MS <= MCP_SAFE_TIMEOUT (was 90s, above the ceiling — SRV-47/97)", () => {
    expect(FINALIZE_COMMIT_DEADLINE_MS).toBeLessThanOrEqual(MCP_SAFE_TIMEOUT);
  });
});
