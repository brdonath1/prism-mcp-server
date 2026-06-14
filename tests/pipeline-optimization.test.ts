// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// SRV-111: the "Batch path resolution (H-2)" and "Optimized doc resolution
// (H-10)" grep-the-source blocks were removed alongside the never-wired
// preloadPrismPaths / guardPushPathBatch / resolveDocFilesOptimized trio they
// pinned. The remaining blocks cover live code.

describe("Synthesis tracker scoped by project (H-9)", () => {
  it("uses Map keyed by project", () => {
    const source = readFileSync("src/ai/synthesis-tracker.ts", "utf-8");
    expect(source).toContain("Map<string, SynthesisEvent[]>");
    expect(source).toContain("projectEvents");
  });

  it("has TTL for stale events", () => {
    const source = readFileSync("src/ai/synthesis-tracker.ts", "utf-8");
    expect(source).toContain("TTL_MS");
    expect(source).toContain("pruneStale");
  });

  it("caps per-project events", () => {
    const source = readFileSync("src/ai/synthesis-tracker.ts", "utf-8");
    expect(source).toContain("MAX_EVENTS_PER_PROJECT");
    expect(source).toContain("20");
  });

  it("getSynthesisHealth accepts optional project filter", () => {
    const source = readFileSync("src/ai/synthesis-tracker.ts", "utf-8");
    expect(source).toContain("getSynthesisHealth(projectSlug?:");
  });
});

describe("defaultBranchCache size cap (L-1)", () => {
  it("cache has size limit", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    expect(source).toContain("defaultBranchCache.size >= 100");
    expect(source).toContain("defaultBranchCache.clear()");
  });
});

describe("MemoryCache eviction (L-2)", () => {
  it("has proactive eviction interval", () => {
    const source = readFileSync("src/utils/cache.ts", "utf-8");
    expect(source).toContain("setInterval");
    expect(source).toContain("evictExpired");
    expect(source).toContain(".unref()");
  });
});

describe("Response size monitoring (M-7)", () => {
  it("bootstrap monitors response size against the recalibrated config thresholds (SRV-39)", () => {
    const source = readFileSync("src/tools/bootstrap.ts", "utf-8");
    expect(source).toContain("responseBytes");
    expect(source).toContain("BOOTSTRAP_OVERSIZE");
    // SRV-39: the 80KB/100KB literals (which ERROR-fired on every ~115KB boot)
    // moved to env-tunable config constants recalibrated against the real cap.
    expect(source).toContain("BOOTSTRAP_OVERSIZE_ERROR_BYTES");
    expect(source).toContain("BOOTSTRAP_OVERSIZE_WARN_BYTES");
    const config = readFileSync("src/config.ts", "utf-8");
    expect(config).toContain("BOOTSTRAP_OVERSIZE_ERROR_BYTES");
    expect(config).toContain("200000"); // error threshold default
  });
});

describe("LIVING_DOCUMENT_NAMES canonical list (S41 Phase 4)", () => {
  it("is exported with canonical JSDoc", () => {
    const source = readFileSync("src/config.ts", "utf-8");
    expect(source).toContain("Canonical list of living-document filenames");
    expect(source).toContain("LIVING_DOCUMENT_NAMES");
  });
});
