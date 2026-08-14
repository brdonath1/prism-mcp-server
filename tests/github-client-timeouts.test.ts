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
import { fetchFile, listRepos, GITHUB_REQUEST_TIMEOUT_MS } from "../src/github/client.js";
import { GITHUB_RETRY_BUDGET_MS } from "../src/config.js";

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

describe("S203 R24 (F-C1-8) — fetchWithRetry total retry budget", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exports a retry budget defaulting to 20s", () => {
    expect(GITHUB_RETRY_BUDGET_MS).toBe(20_000);
  });

  it("Retry-After: 60 with 3 retries returns within the budget, not 300s", async () => {
    // Pre-R24 this chain slept min(60s * 2^attempt, 120s) three times — ~360s
    // of wall clock for one call, 6x the whole MCP request budget. The first
    // sleep alone (60s) overshoots the 20s budget, so none is taken.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(fetchFile("repo", "path.md")).rejects.toThrow(/rate limit/i);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(GITHUB_RETRY_BUDGET_MS);
    expect(elapsed).toBeLessThan(1_000); // No sleep was taken at all.
    // Budget refused the backoff on the FIRST 429 — one request, no retries.
    expect(calls).toBe(1);
  }, 10_000);

  it("still honors a Retry-After that fits inside the budget", async () => {
    // Regression guard: the budget must gate only the overshooting sleeps.
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          content: Buffer.from("ok", "utf-8").toString("base64"),
          sha: "sha-1",
          size: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await fetchFile("repo", "path.md");
    expect(result.content).toBe("ok");
    expect(calls).toBe(3);
  }, 10_000);

  it("surfaces the budget-exhausted 429 with its body still readable", async () => {
    // The budget check runs BEFORE res.body.cancel(), so the response handed
    // back still has a body for handleApiError's `await res.text()`.
    globalThis.fetch = vi.fn(async () =>
      new Response("secondary rate limit hit", {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    ) as unknown as typeof fetch;

    await expect(fetchFile("repo", "path.md")).rejects.toThrow(/rate limit/i);
  }, 10_000);
});

describe("S203 R31 (F-C1-15) — listRepos pagination + body hygiene", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const page = (n: number) =>
    new Response(
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `repo-${i}` }))),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("a 99-item page issues no second request", async () => {
    const fetchSpy = vi.fn(async () => page(99)) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const repos = await listRepos();

    expect(repos).toHaveLength(99);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("still paginates past a full 100-item page", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? page(100) : page(7);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const repos = await listRepos();

    expect(repos).toHaveLength(107);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("caps pagination so a mispaginating API cannot loop unbounded", async () => {
    // Every page full — without the cap this never terminates.
    const fetchSpy = vi.fn(async () => page(100)) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;

    const repos = await listRepos();

    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(repos.length).toBeLessThanOrEqual(2_000);
  }, 20_000);

  it("cancels the response body on both early-return paths", () => {
    const source = readFileSync("src/github/client.ts", "utf-8");
    const bodyOf = (marker: string) => {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const nextExport = source.indexOf("\nexport ", start + 1);
      return source.slice(start, nextExport === -1 ? source.length : nextExport);
    };
    // listDirectory's 404 -> [] and getDefaultBranch's !ok -> "main" were the
    // two paths that dropped an unread body (F-C1-15).
    expect(bodyOf("export async function listDirectory")).toContain("res.body?.cancel()");
    expect(bodyOf("export async function getDefaultBranch")).toContain("res.body?.cancel()");
  });
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
