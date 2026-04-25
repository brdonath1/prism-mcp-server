/**
 * S40 C1 — per-request timeouts in src/github/client.ts.
 *
 * These tests mock the global `fetch` so we can simulate a hung socket
 * (never resolves until the AbortSignal aborts) and a 429 retry loop.
 */

// Set dummy PAT to prevent config.ts from calling process.exit(1) during import.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { fetchFile, GITHUB_REQUEST_TIMEOUT_MS } from "../src/github/client.js";

// Shrink the test timeout so we don't wait 15s in CI.
// We assert the error message pattern, not the actual elapsed time.
const TEST_TIMEOUT_MS = 200;

describe("S40 C1 — GITHUB_REQUEST_TIMEOUT_MS constant", () => {
  it("is exported and defaults to 15_000", () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("source declares the constant", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    expect(source).toContain("GITHUB_REQUEST_TIMEOUT_MS = 15_000");
  });
});

describe("S40 C1 — fetchWithRetry hung-socket timeout", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("aborts a hung fetch and throws a 'timed out' error", async () => {
    // Mock global fetch to hang until the AbortSignal fires.
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // Would hang forever — a test harness bug.
        if (signal.aborted) {
          const err = new Error("Aborted");
          (err as { name: string }).name = signal.reason?.name ?? "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const reason = (signal.reason as { name?: string })?.name ?? "AbortError";
          const err = new Error("The operation was aborted");
          (err as { name: string }).name = reason;
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    // Patch AbortSignal.timeout to use a short deadline for this test.
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => originalTimeout.call(AbortSignal, Math.min(ms, TEST_TIMEOUT_MS))) as typeof AbortSignal.timeout;

    try {
      await expect(fetchFile("some-repo", "some-path.md")).rejects.toThrow(/timed out/i);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  }, 5_000);

  it("does NOT retry fetchWithRetry on timeout (clear error surfaces immediately)", async () => {
    const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          (err as { name: string }).name = "TimeoutError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => originalTimeout.call(AbortSignal, Math.min(ms, TEST_TIMEOUT_MS))) as typeof AbortSignal.timeout;

    try {
      await expect(fetchFile("r", "p.md")).rejects.toThrow(/timed out/i);
      // Only one attempt — no retry on timeout.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  }, 5_000);
});

describe("S40 C1 — fetchWithRetry still retries on 429 (regression)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries on 429 and eventually returns 200", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          content: Buffer.from("hello", "utf-8").toString("base64"),
          sha: "sha-1",
          size: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await fetchFile("repo", "path.md");
    expect(result.content).toBe("hello");
    expect(calls).toBe(2);
  }, 5_000);
});

describe("S40 C1/C3 — finalize.ts HEAD-sha checks route through getHeadSha (which uses fetchWithRetry)", () => {
  it("finalize.ts no longer issues raw fetch(refUrl, ...) calls", () => {
    // S40 C3 moved the HEAD-SHA lookup into the shared getHeadSha() helper
    // in src/github/client.ts, which routes through fetchWithRetry() and
    // therefore inherits the C1 timeout automatically. The finalize tool
    // must not fall back to a raw fetch() here.
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    const rawFetchMatches = source.match(/await fetch\(refUrl/g) ?? [];
    expect(rawFetchMatches.length).toBe(0);
  });

  it("finalize.ts routes HEAD-sha checks through safeMutation (S64 Phase 1 Brief 1.5)", () => {
    const source = readFileSync("src/tools/finalize.ts", "utf-8");
    // safeMutation owns the HEAD-snapshot machinery on behalf of finalize.ts.
    expect(source).toContain("safeMutation");
    // safeMutation itself uses getHeadSha, which routes through fetchWithRetry.
    const safeMutationSource = readFileSync("src/utils/safe-mutation.ts", "utf-8");
    expect(safeMutationSource).toContain("getHeadSha");
  });

  it("getHeadSha implementation routes through fetchWithRetry (timeout-bearing)", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    const start = source.indexOf("export async function getHeadSha");
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, nextExport === -1 ? source.length : nextExport);
    expect(body).toContain("fetchWithRetry");
    // And must NOT issue its own raw fetch() — that would bypass the C1 timeout.
    expect(body).not.toMatch(/await fetch\(/);
  });
});
