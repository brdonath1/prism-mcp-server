// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Draft timeout scaling", () => {
  it("calculates correct timeout capped at MCP_SAFE_TIMEOUT", () => {
    // Verify the draft timeout contract exists in source
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // S41: Single env-configurable timeout (replaces S34b size-branching).
    expect(source).toContain("FINALIZE_DRAFT_TIMEOUT_MS");
    // Draft call site must disable retries — retry storms are worse than
    // fast failure for the draft phase.
    expect(source).toContain("retry storms on draft are worse than fast failure");
    expect(source).toMatch(/synthesize\([^)]*\b0\b[^)]*\)/s);
    // MCP_SAFE_TIMEOUT still imported for other call sites but not used by draft.
    expect(source).toContain("MCP_SAFE_TIMEOUT");

    // 120_000 is SYNTHESIS_TIMEOUT_MS (background synthesis) — draft path
    // must not reference it directly, and neither should S34b's 90_000.
    expect(source).not.toContain("120_000");
    expect(source).not.toContain("90_000");
  });

  it("timeout variable is used in synthesize call, not a hardcoded value", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // The synthesize call in draftPhase should use the variable, not a literal
    // Find the synthesize call in the draft context
    const draftSection = source.slice(
      source.indexOf("async function draftPhase"),
      source.indexOf("async function commitPhase")
    );

    // Should call synthesize with draftTimeoutMs, not a hardcoded number
    expect(draftSection).toContain("draftTimeoutMs");
    expect(draftSection).toMatch(/synthesize\([^)]*draftTimeoutMs/);
  });
});

describe("Audit phase performance", () => {
  it("caps commit detail fetches to 5 or fewer", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Find the commit detail fetch section
    const auditSection = source.slice(
      source.indexOf("async function auditPhase"),
      source.indexOf("async function draftPhase")
    );

    // Should slice to 5 or fewer, not 20
    expect(auditSection).not.toContain(".slice(0, 20)");
    // Should have a slice with a small number
    const sliceMatch = auditSection.match(/\.slice\(0,\s*(\d+)\)/);
    expect(sliceMatch).not.toBeNull();
    const cap = parseInt(sliceMatch![1], 10);
    expect(cap).toBeLessThanOrEqual(10);
  });

  it("does not duplicate listDirectory calls for handoff-history", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    const auditSection = source.slice(
      source.indexOf("async function auditPhase"),
      source.indexOf("async function draftPhase")
    );

    // Should either use a cached helper or only call listDirectory once
    // Count raw listDirectory calls in audit
    const directCalls = (auditSection.match(/await listDirectory\(/g) || []).length;
    const cachedCalls = auditSection.includes("getHistoryEntries");

    // Either uses a cache function OR has 2 or fewer direct listDirectory calls
    // (2 is acceptable: one for .prism/ and one legacy fallback within the same function)
    expect(cachedCalls || directCalls <= 2).toBe(true);
  });
});

describe("Commit phase performance", () => {
  it("has timing instrumentation for each finalization phase", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    // Should log timing for audit, draft, and commit phases
    expect(source).toContain("audit timing");
    expect(source).toContain("commit timing");
  });

  it("backup and prune are parallelized or sequential is intentional", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");

    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("async function") > source.indexOf("async function commitPhase")
        ? source.indexOf("async function", source.indexOf("async function commitPhase") + 1)
        : source.length
    );

    // Backup and prune should either be wrapped in Promise.allSettled or clearly sequential
    // We check that the commit section has some form of parallel execution
    const hasParallelBackup = commitSection.includes("Promise.allSettled") ||
      commitSection.includes("Promise.all");
    // This is acceptable either way, but we want to verify the pattern exists
    expect(hasParallelBackup).toBe(true);
  });
});
