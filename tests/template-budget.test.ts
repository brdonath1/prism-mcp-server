// T-5: Template size regression tests
// These tests read actual template files from the framework repo (via file system).
// Skipped in CI if the framework repo isn't available.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const frameworkDir = resolve(process.env.HOME ?? "", "prism-framework");
const hasFramework = existsSync(resolve(frameworkDir, "_templates/core-template-mcp.md"));

describe.skipIf(!hasFramework)("T-5: template size regression", () => {
  it("core-template-mcp.md file size < 13,000 bytes", () => {
    const content = readFileSync(resolve(frameworkDir, "_templates/core-template-mcp.md"), "utf-8");
    const size = Buffer.byteLength(content, "utf-8");
    expect(size).toBeLessThan(13_000);
  });

  it("core-template-mcp.md does NOT contain full Rule 10-14 sections", () => {
    const content = readFileSync(resolve(frameworkDir, "_templates/core-template-mcp.md"), "utf-8");
    // It should NOT have "Rule 10 —" or "Rule 11 —" as full rule headers
    expect(content).not.toMatch(/\*\*Rule 10 —/);
    expect(content).not.toMatch(/\*\*Rule 12 —/);
    expect(content).not.toMatch(/\*\*Rule 13 —/);
    expect(content).not.toMatch(/\*\*Rule 14 —/);
  });

  it("rules-session-end.md exists and contains Rules 10-14", () => {
    const path = resolve(frameworkDir, "_templates/rules-session-end.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("Rule 10");
    expect(content).toContain("Rule 11");
    expect(content).toContain("Rule 12");
    expect(content).toContain("Rule 13");
    expect(content).toContain("Rule 14");
  });

  it("rules-session-end.md file size < 3,000 bytes", () => {
    const content = readFileSync(resolve(frameworkDir, "_templates/rules-session-end.md"), "utf-8");
    const size = Buffer.byteLength(content, "utf-8");
    expect(size).toBeLessThan(3_000);
  });
});
