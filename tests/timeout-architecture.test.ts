// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { MCP_SAFE_TIMEOUT } from "../src/config.js";

describe("Timeout architecture (C-3)", () => {
  it("MCP_SAFE_TIMEOUT is defined and equals 50000", () => {
    expect(MCP_SAFE_TIMEOUT).toBe(50_000);
  });

  it("MCP_SAFE_TIMEOUT is exported from config", () => {
    const source = readFileSync("src/config.ts", "utf-8");
    expect(source).toContain("export const MCP_SAFE_TIMEOUT = 50_000");
  });

  it("no inline timeout exceeds 50000ms in finalize.ts (D-78: synthesis runs in background, no inline timeout)", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Should not contain old inline timeout values
    expect(source).not.toContain("90_000");

    // Should use MCP_SAFE_TIMEOUT for draft phase
    expect(source).toContain("MCP_SAFE_TIMEOUT");

    // Post-finalization synthesis is fire-and-forget (D-78) — finalize.ts no longer
    // imports SYNTHESIS_TIMEOUT_MS. The constant lives in config.ts and is still
    // used by generateIntelligenceBrief as a per-API-call safety net.
    expect(source).not.toContain("SYNTHESIS_TIMEOUT_MS");
  });

  it("ai/client.ts uses MCP_SAFE_TIMEOUT as default", () => {
    const source = readFileSync("src/ai/client.ts", "utf-8");
    expect(source).toContain("MCP_SAFE_TIMEOUT");
    expect(source).not.toContain("60000");
  });

  it("finalize.ts imports MCP_SAFE_TIMEOUT", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("MCP_SAFE_TIMEOUT");
  });
});

describe("Structured synthesis errors (H-4)", () => {
  it("synthesize returns SynthesisOutcome type", () => {
    const source = readFileSync("src/ai/client.ts", "utf-8");
    expect(source).toContain("SynthesisOutcome");
    expect(source).toContain("SynthesisError");
    expect(source).toContain("error_code");
  });

  it("synthesize returns structured error instead of null", () => {
    const source = readFileSync("src/ai/client.ts", "utf-8");

    // The synthesize function itself should not return null
    const synthFn = source.slice(
      source.indexOf("export async function synthesize"),
      source.length
    );
    expect(synthFn).not.toMatch(/return null;/);

    // Should return success: false with error_code
    expect(source).toContain("success: false");
    expect(source).toContain('"DISABLED"');
    expect(source).toContain('"TIMEOUT"');
    expect(source).toContain('"AUTH"');
    expect(source).toContain('"API_ERROR"');
  });

  it("finalize.ts checks result.success instead of !result", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    // Should NOT check if (!result)
    expect(source).not.toMatch(/if\s*\(\s*!result\s*\)/);
    // Should check result.success
    expect(source).toContain("result.success");
  });

  it("synthesize.ts checks result.success instead of !result", () => {
    const source = readFileSync("src/ai/synthesize.ts", "utf-8");
    expect(source).not.toMatch(/if\s*\(\s*!result\s*\)/);
    expect(source).toContain("result.success");
  });
});
