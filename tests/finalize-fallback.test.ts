// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

describe("finalize commitPhase commit primitive (S64 Phase 1 Brief 1.5)", () => {
  it("finalize.ts uses safeMutation as the atomic-commit primitive", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("safeMutation");
    // pushFile remains for the handoff backup step but no longer for the commit.
    expect(source).toContain("pushFile");
    // The sequential fallback is gone — atomic-only by design.
    expect(source).not.toContain("falling back to sequential pushFile");
    expect(source).not.toContain("createAtomicCommit");
  });

  it("finalize.ts has draft timeout scaling", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("totalDocBytes");
    expect(source).toContain("draftTimeoutMs");
  });
});
