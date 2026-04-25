// Phase 0a: Tests for the formatTimeoutError helper in src/claude-code/client.ts
//
// The helper replaces the SDK's misleading "aborted by user" message with a
// clear, actionable timeout explanation when cc_dispatch sync mode hits its
// deadline.
import { describe, it, expect } from "vitest";
import { formatTimeoutError } from "../src/claude-code/client.js";

describe("formatTimeoutError — sync-timeout message override", () => {
  it("mentions that a timeout was reached", () => {
    const msg = formatTimeoutError(45_000);
    expect(msg.toLowerCase()).toContain("timeout");
  });

  it("includes the configured timeoutMs value", () => {
    const msg = formatTimeoutError(30_000);
    expect(msg).toContain("30000");
  });

  it("recommends async_mode: true for longer tasks", () => {
    const msg = formatTimeoutError(45_000);
    expect(msg).toContain("async_mode");
  });

  it("references CC_DISPATCH_SYNC_TIMEOUT_MS env var", () => {
    const msg = formatTimeoutError(45_000);
    expect(msg).toContain("CC_DISPATCH_SYNC_TIMEOUT_MS");
  });

  it("does NOT contain the misleading SDK abort message", () => {
    const msg = formatTimeoutError(45_000);
    expect(msg).not.toContain("aborted by user");
  });

  it("works with different timeout values", () => {
    const msg = formatTimeoutError(12_345);
    expect(msg).toContain("12345");
    expect(msg).toContain("timeout");
    expect(msg).toContain("async_mode");
    expect(msg).toContain("CC_DISPATCH_SYNC_TIMEOUT_MS");
  });
});
