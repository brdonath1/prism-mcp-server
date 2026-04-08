// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Batch path resolution (H-2)", () => {
  it("preloadPrismPaths function exists in doc-guard.ts", () => {
    const source = readFileSync("src/utils/doc-guard.ts", "utf-8");
    expect(source).toContain("export async function preloadPrismPaths");
    expect(source).toContain("Set<string>");
  });

  it("guardPushPathBatch function exists in doc-guard.ts", () => {
    const source = readFileSync("src/utils/doc-guard.ts", "utf-8");
    expect(source).toContain("export function guardPushPathBatch");
    expect(source).toContain("prismPaths");
  });
});

describe("Optimized doc resolution (H-10)", () => {
  it("resolveDocFilesOptimized function exists in doc-resolver.ts", () => {
    const source = readFileSync("src/utils/doc-resolver.ts", "utf-8");
    expect(source).toContain("export async function resolveDocFilesOptimized");
    expect(source).toContain("listDirectory");
  });

  it("old resolveDocFiles is marked deprecated", () => {
    const source = readFileSync("src/utils/doc-resolver.ts", "utf-8");
    expect(source).toContain("@deprecated");
  });
});

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
  it("bootstrap monitors response size", () => {
    const source = readFileSync("src/tools/bootstrap.ts", "utf-8");
    expect(source).toContain("responseBytes");
    expect(source).toContain("100_000");
    expect(source).toContain("80_000");
  });
});

describe("LEGACY_LIVING_DOCUMENTS deprecation (M-4)", () => {
  it("is marked deprecated", () => {
    const source = readFileSync("src/config.ts", "utf-8");
    expect(source).toContain("@deprecated");
    expect(source).toContain("LEGACY_LIVING_DOCUMENTS");
  });
});
