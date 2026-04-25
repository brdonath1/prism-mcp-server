// Phase 0a: Tests for CC_DISPATCH_SYNC_TIMEOUT_MS env-var parsing in src/config.ts
//
// Config constants are evaluated at module load time, so each test case uses
// vi.resetModules() + dynamic import to re-evaluate after mutating process.env.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stash the original env value (if any) so we can restore it between tests.
const originalEnvValue = process.env.CC_DISPATCH_SYNC_TIMEOUT_MS;

// Ensure GITHUB_PAT is set so config.ts does not call process.exit(1).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Restore the original state so tests don't leak into each other.
  if (originalEnvValue === undefined) {
    delete process.env.CC_DISPATCH_SYNC_TIMEOUT_MS;
  } else {
    process.env.CC_DISPATCH_SYNC_TIMEOUT_MS = originalEnvValue;
  }
});

describe("CC_DISPATCH_SYNC_TIMEOUT_MS — env-var parsing", () => {
  it("defaults to MCP_SAFE_TIMEOUT - 5_000 when env var is unset", async () => {
    delete process.env.CC_DISPATCH_SYNC_TIMEOUT_MS;
    const config = await import("../src/config.js");
    // MCP_SAFE_TIMEOUT is 50_000, so default is 45_000.
    expect(config.CC_DISPATCH_SYNC_TIMEOUT_MS).toBe(
      config.MCP_SAFE_TIMEOUT - 5_000,
    );
    expect(config.CC_DISPATCH_SYNC_TIMEOUT_MS).toBe(45_000);
  });

  it("honors an explicit numeric value", async () => {
    process.env.CC_DISPATCH_SYNC_TIMEOUT_MS = "30000";
    const config = await import("../src/config.js");
    expect(config.CC_DISPATCH_SYNC_TIMEOUT_MS).toBe(30_000);
  });

  it("falls back to default on invalid (non-numeric) value", async () => {
    process.env.CC_DISPATCH_SYNC_TIMEOUT_MS = "abc";
    const config = await import("../src/config.js");
    expect(config.CC_DISPATCH_SYNC_TIMEOUT_MS).toBe(45_000);
  });

  it("falls back to default on empty string", async () => {
    process.env.CC_DISPATCH_SYNC_TIMEOUT_MS = "";
    const config = await import("../src/config.js");
    // Empty string ?? "45000" → parseInt("45000") → 45000
    expect(config.CC_DISPATCH_SYNC_TIMEOUT_MS).toBe(45_000);
  });
});
