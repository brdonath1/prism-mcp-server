// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Atomic commit fallback architecture", () => {
  const source = readFileSync("src/tools/finalize.ts", "utf-8");
  const clientSource = readFileSync("src/github/client.ts", "utf-8");

  it("commitPhase tries atomic commit first", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    // Atomic commit should be called before sequential pushFile fallback
    const atomicIdx = commitSection.indexOf("await createAtomicCommit(");
    // Look for the fallback comment specifically, not backup pushFile calls
    const fallbackIdx = commitSection.indexOf("Sequential pushFile");

    expect(atomicIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(atomicIdx).toBeLessThan(fallbackIdx);
  });

  it("fallback only triggers on atomic failure", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    // pushFile fallback should be inside a failure branch
    expect(commitSection).toContain("atomicResult.success");
    expect(commitSection).toContain("falling back to sequential pushFile");
  });

  it("fallback logs a warning when triggered", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    expect(commitSection).toContain("logger.warn");
    expect(commitSection).toContain("Atomic commit failed");
  });

  it("fallback adds warning to response warnings array", () => {
    const commitSection = source.slice(
      source.indexOf("async function commitPhase"),
      source.indexOf("// Synthesis after")
    );

    expect(commitSection).toContain("warnings.push");
    expect(commitSection).toContain("Fell back to sequential file pushes");
  });

  it("createAtomicCommit returns structured error on failure", () => {
    // Verify the function returns { success: false, error: ... } on failure
    const atomicFn = clientSource.slice(
      clientSource.indexOf("export async function createAtomicCommit"),
      clientSource.indexOf("export async function createAtomicCommit") > -1
        ? clientSource.indexOf("\n}\n", clientSource.indexOf("export async function createAtomicCommit")) + 3
        : clientSource.length
    );

    expect(atomicFn).toContain("success: false");
    expect(atomicFn).toContain("error: msg");
  });
});

describe("Branch detection", () => {
  const clientSource = readFileSync("src/github/client.ts", "utf-8");

  it("getDefaultBranch is exported", () => {
    expect(clientSource).toContain("export async function getDefaultBranch");
  });

  it("uses a cache to avoid repeated API calls", () => {
    expect(clientSource).toContain("defaultBranchCache");
    // Should check cache before API call
    const fn = clientSource.slice(
      clientSource.indexOf("export async function getDefaultBranch"),
      clientSource.indexOf("export async function getDefaultBranch") + 1000
    );
    const cacheCheckIdx = fn.indexOf("defaultBranchCache.get");
    const apiCallIdx = fn.indexOf("fetchWithRetry");
    expect(cacheCheckIdx).toBeGreaterThan(-1);
    expect(apiCallIdx).toBeGreaterThan(-1);
    expect(cacheCheckIdx).toBeLessThan(apiCallIdx);
  });

  it("falls back to 'main' on API failure", () => {
    const fn = clientSource.slice(
      clientSource.indexOf("export async function getDefaultBranch"),
      clientSource.indexOf("export async function getDefaultBranch") + 1500
    );
    // Should return "main" in catch blocks
    const mainFallbacks = (fn.match(/return "main"/g) || []).length;
    expect(mainFallbacks).toBeGreaterThanOrEqual(2); // at least: API error + catch block
  });

  it("no hardcoded heads/main in createAtomicCommit", () => {
    expect(clientSource).not.toContain("heads/main");
  });

  it("createAtomicCommit calls getDefaultBranch", () => {
    const atomicFn = clientSource.slice(
      clientSource.indexOf("export async function createAtomicCommit"),
      clientSource.length
    );
    expect(atomicFn).toContain("getDefaultBranch");
  });
});
