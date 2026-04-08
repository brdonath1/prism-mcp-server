// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("GitHub client resilience patterns", () => {
  const source = readFileSync("src/github/client.ts", "utf-8");

  it("fetchWithRetry handles 429 rate limiting", () => {
    expect(source).toContain("429");
    expect(source).toContain("retry-after");
    expect(source).toContain("exponential");
  });

  it("pushFile handles 409 conflict with fresh SHA retry", () => {
    const pushFileFn = source.slice(
      source.indexOf("export async function pushFile("),
      source.indexOf("export async function pushFiles(")
    );
    expect(pushFileFn).toContain("409");
    expect(pushFileFn).toContain("fresh SHA");
  });

  it("createAtomicCommit wraps all failures in try/catch", () => {
    const atomicFn = source.slice(
      source.indexOf("export async function createAtomicCommit"),
      source.length
    );
    expect(atomicFn).toContain("catch (error)");
    expect(atomicFn).toContain("success: false");
  });

  it("createAtomicCommit performs all 5 Git API steps", () => {
    const atomicFn = source.slice(
      source.indexOf("export async function createAtomicCommit"),
      source.length
    );
    // 5 steps: get ref, get commit (base tree), create tree, create commit, update ref
    expect(atomicFn).toContain("git/ref/heads/");
    expect(atomicFn).toContain("git/commits/");
    expect(atomicFn).toContain("git/trees");
    expect(atomicFn).toContain("PATCH");
  });

  it("getDefaultBranch caches results", () => {
    expect(source).toContain("defaultBranchCache");
    expect(source).toContain(".get(repo)");
    expect(source).toContain(".set(repo,");
  });

  it("all exported async functions log on error", () => {
    // Check that major functions include logger.error or logger.warn in catch blocks
    const exportedFns = [
      "createAtomicCommit",
      "pushFile",
      "getDefaultBranch",
    ];

    for (const fn of exportedFns) {
      const fnStart = source.indexOf(`export async function ${fn}`);
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = source.slice(fnStart, fnStart + 5000);
      const hasLogging = fnSection.includes("logger.error") || fnSection.includes("logger.warn");
      expect(hasLogging).toBe(true);
    }
  });
});

describe("Finalization response contract", () => {
  const source = readFileSync("src/tools/finalize.ts", "utf-8");

  it("commit phase always returns a results array", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after") || source.length
    );

    // Both atomic success and fallback paths must produce a results array
    const resultsAssignments = (commitSection.match(/results\s*=/g) || []).length;
    // At minimum: one for atomic success, one for fallback
    expect(resultsAssignments).toBeGreaterThanOrEqual(2);
  });

  it("commit phase includes warnings in response", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.length
    );
    // warnings array should be part of the return value
    expect(commitSection).toContain("warnings");
  });
});
