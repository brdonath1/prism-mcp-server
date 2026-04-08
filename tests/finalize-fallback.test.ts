// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

describe("finalize commitPhase fallback", () => {
  it("finalize.ts has atomic commit with sequential pushFile fallback", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("pushFile");
    expect(source).toContain("falling back to sequential pushFile");
    expect(source).toContain("createAtomicCommit");
  });

  it("finalize.ts has draft timeout scaling", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("totalDocBytes");
    expect(source).toContain("draftTimeoutMs");
  });
});
