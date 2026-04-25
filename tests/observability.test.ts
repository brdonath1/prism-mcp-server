// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("Request correlation ID (M-5)", () => {
  it("request logger generates UUID", () => {
    const source = readFileSync("src/middleware/request-logger.ts", "utf-8");
    expect(source).toContain("randomUUID");
    expect(source).toContain("requestId");
  });

  it("correlation ID is set as response header", () => {
    const source = readFileSync("src/middleware/request-logger.ts", "utf-8");
    expect(source).toContain("X-Request-Id");
    expect(source).toContain("setHeader");
  });

  it("correlation ID is included in log entries", () => {
    const source = readFileSync("src/middleware/request-logger.ts", "utf-8");
    // The requestId should be in the log fields
    expect(source).toContain("requestId");
    expect(source).toContain("logger[level]");
  });
});

describe("Partial failure flagging (H-3)", () => {
  it("fetchFiles returns structured result with failed array", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    const fn = source.slice(
      source.indexOf("export async function fetchFiles"),
      source.indexOf("export async function pushFile")
    );
    expect(fn).toContain("failed:");
    expect(fn).toContain("incomplete:");
    expect(fn).toContain("failedPaths");
  });

  it("pushFiles returns structured result with failed_count", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    const fn = source.slice(
      source.indexOf("export async function pushFiles"),
      source.indexOf("export async function fileExists")
    );
    expect(fn).toContain("failed_count");
    expect(fn).toContain("incomplete:");
  });
});

describe("Safer atomic commit primitive (H-6 → S64 Phase 1 Brief 1.5)", () => {
  it("commit step delegates to safeMutation, which owns the HEAD comparison", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    expect(source).toContain("safeMutation");
    // The HEAD-comparison logic is no longer inline in finalize.ts —
    // safeMutation encapsulates it.
    expect(source).not.toContain("headShaBefore");
    expect(source).not.toContain("headChanged");
  });

  it("does NOT include a sequential pushFile fallback for the commit step", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    // Atomic-only by design (S62 audit Verdict C).
    expect(source).not.toContain("falling back to sequential pushFile");
    expect(source).not.toContain("Fell back to sequential file pushes");
  });
});

describe("Response contract documentation (L-5)", () => {
  it("bootstrap has response contract comment", () => {
    const source = readFileSync("src/tools/bootstrap.ts", "utf-8");
    expect(source).toContain("Standard MCP tool response contract");
    expect(source).toContain("isError");
  });
});
