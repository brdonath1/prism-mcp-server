// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

describe("GitHub client resilience (S34b)", () => {
  const source = readFileSync("src/github/client.ts", "utf-8");

  const functionsToCheck = [
    "getFileSize",
    "listDirectory",
    "listCommits",
    "getCommit",
    "fileExists",
    "deleteFile",
  ];

  for (const fn of functionsToCheck) {
    it(`${fn} uses fetchWithRetry instead of plain fetch`, () => {
      const fnStart = source.indexOf(`export async function ${fn}`);
      expect(fnStart).toBeGreaterThan(-1);

      // Find the next exported function (or end of file)
      const nextExport = source.indexOf("export async function ", fnStart + 1);
      const fnEnd = nextExport !== -1 ? nextExport : source.length;
      const fnBody = source.slice(fnStart, fnEnd);

      expect(fnBody).toContain("fetchWithRetry");
    });
  }

  it("fileExists has AbortSignal.timeout", () => {
    const fnStart = source.indexOf("export async function fileExists");
    const fnEnd = source.indexOf("export async function ", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd);

    expect(fnBody).toContain("AbortSignal.timeout");
    expect(fnBody).toContain("10_000");
  });

  it("fileExists handles AbortError gracefully", () => {
    const fnStart = source.indexOf("export async function fileExists");
    const fnEnd = source.indexOf("export async function ", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd);

    expect(fnBody).toContain("AbortError");
    expect(fnBody).toContain("return false");
  });

  it("deleteFile returns structured object", () => {
    const fnStart = source.indexOf("export async function deleteFile");
    const fnEnd = source.indexOf("export async function ", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd !== -1 ? fnEnd : source.length);

    expect(fnBody).toContain("{ success: boolean; error?: string }");
    expect(fnBody).toContain("{ success: true }");
    expect(fnBody).toContain("{ success: false, error:");
  });

  it("429 response body is cancelled before retry", () => {
    const retryFn = source.slice(
      source.indexOf("async function fetchWithRetry"),
      source.indexOf("export async function fetchFile")
    );

    expect(retryFn).toContain("res.body?.cancel()");
  });

  it("handleApiError handles 422 validation errors", () => {
    const handleFn = source.slice(
      source.indexOf("function handleApiError"),
      source.indexOf("function sleep")
    );

    expect(handleFn).toContain("422");
    expect(handleFn).toContain("validation failed");
  });

  it("Retry-After caps at 120s instead of 10s", () => {
    const retryFn = source.slice(
      source.indexOf("async function fetchWithRetry"),
      source.indexOf("export async function fetchFile")
    );

    expect(retryFn).toContain("120_000");
    expect(retryFn).not.toContain("10000)");
  });
});
