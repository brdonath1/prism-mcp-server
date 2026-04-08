// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

describe("getDefaultBranch", () => {
  it("is exported from github/client", async () => {
    const client = await import("../src/github/client.js");
    expect(typeof client.getDefaultBranch).toBe("function");
  });
});

describe("createAtomicCommit does not hardcode branch", () => {
  it("source code does not contain heads/main", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/github/client.ts", "utf-8");
    expect(source).not.toContain("heads/main");
    expect(source).toContain("getDefaultBranch");
  });
});
