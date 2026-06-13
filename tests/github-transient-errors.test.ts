/**
 * M-009 (brief-461 Task A) — GitHub transient-error classification.
 *
 * Behavioral tests (mock globalThis.fetch) for:
 *   SRV-35  transient 401 retry + classification (INS-311 surface)
 *   SRV-40  403 primary/secondary rate-limit detection + retry
 *   SRV-14  fileExists timeout -> false (the dead AbortError path)
 *   SRV-45  deleteRef 422 refused-vs-already-gone discrimination
 *   SRV-44  resolveDocPath operational-error-vs-not-found discrimination
 *
 * These exercise real code paths rather than grepping source strings — the
 * SRV-83 lesson. The fetch mock mirrors the 429 regression at
 * tests/github-client-timeouts.test.ts:112.
 */

// Set dummy PAT to prevent config.ts from calling process.exit(1) during import.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFile, fileExists, deleteRef } from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";

/** Build a 200 JSON contents response with base64 content. */
function contentsOk(content: string, sha = "sha-1") {
  return new Response(
    JSON.stringify({
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      size: content.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("SRV-35 — transient 401 retry + classification (INS-311)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries a transient 401 and succeeds on the second attempt (no PAT-invalid error)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response("unauthorized", { status: 401 });
      return contentsOk("hello");
    }) as unknown as typeof fetch;

    const result = await fetchFile("test-repo", "handoff.md");
    expect(result.content).toBe("hello");
    expect(calls).toBe(2);
  }, 10_000);

  it("surfaces a transient-aware message (INS-311), not a flat 'PAT invalid', after a persistent 401", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(fetchFile("test-repo", "handoff.md")).rejects.toThrow(/transient|INS-311/i);
    // Bounded retry actually happened — more than one attempt before surfacing.
    expect(calls).toBeGreaterThan(1);
  }, 10_000);
});

describe("SRV-40 — 403 rate-limit detection + retry vs permission failure", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries a 403 secondary rate limit (retry-after header) and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        return new Response("You have exceeded a secondary rate limit", {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      return contentsOk("recovered");
    }) as unknown as typeof fetch;

    const result = await fetchFile("test-repo", "handoff.md");
    expect(result.content).toBe("recovered");
    expect(calls).toBe(2);
  }, 10_000);

  it("retries a 403 primary rate limit (x-ratelimit-remaining: 0) and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        return new Response("API rate limit exceeded", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "0" },
        });
      }
      return contentsOk("recovered");
    }) as unknown as typeof fetch;

    const result = await fetchFile("test-repo", "handoff.md");
    expect(result.content).toBe("recovered");
    expect(calls).toBe(2);
  }, 10_000);

  it("does NOT retry a genuine 403 permission failure and surfaces a scope-oriented error", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      // No retry-after, no x-ratelimit-remaining:0, no rate-limit body.
      return new Response("Resource not accessible by integration", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(fetchFile("test-repo", "handoff.md")).rejects.toThrow(/scope|forbidden/i);
    expect(calls).toBe(1);
  }, 10_000);

  it("classifies a persistent 403 rate limit as rate-limit, not a PAT-scope failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("You have exceeded a secondary rate limit", {
        status: 403,
        headers: { "retry-after": "0" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchFile("test-repo", "handoff.md")).rejects.toThrow(/rate limit/i);
    // Must NOT be classified as the genuine scope/permission failure.
    await expect(fetchFile("test-repo", "handoff.md")).rejects.not.toThrow(/check PAT scopes/i);
  }, 10_000);
});

describe("SRV-14 — fileExists timeout resolves to false", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("treats a hung fetch (TimeoutError abort) as 'file does not exist'", async () => {
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const reason = (signal.reason as { name?: string })?.name ?? "TimeoutError";
          const err = new Error("The operation was aborted");
          (err as { name: string }).name = reason;
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    // Shrink AbortSignal.timeout so we don't wait for the real 10s/15s deadlines.
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) =>
      originalTimeout.call(AbortSignal, Math.min(ms, 150))) as typeof AbortSignal.timeout;

    try {
      await expect(fileExists("test-repo", "handoff.md")).resolves.toBe(false);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  }, 10_000);
});

describe("SRV-45 — deleteRef discriminates 422-refused from 422-already-gone", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports success on a genuine 'Reference does not exist' 422 (idempotent delete)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ message: "Reference does not exist" }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await deleteRef("test-repo", "heads/feature-x");
    expect(result.success).toBe(true);
    expect(result.note).toMatch(/already absent/i);
  }, 10_000);

  it("reports FAILURE on a 422 that refused the deletion (e.g. protected branch)", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: "Validation Failed",
          errors: [{ message: "protected branch cannot be deleted" }],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await deleteRef("test-repo", "heads/main");
    expect(result.success).toBe(false);
    expect(result.note).toBeUndefined();
    expect(result.error).toBeTruthy();
  }, 10_000);
});

describe("SRV-44 — resolveDocPath distinguishes operational errors from not-found", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("propagates an operational (401) error on the .prism/ path instead of silently serving the root copy", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      calls.push(u);
      // .prism/ path errors operationally; root path would succeed.
      if (u.includes(".prism/handoff.md")) {
        return new Response("unauthorized", { status: 401 });
      }
      return contentsOk("LEGACY ROOT CONTENT");
    }) as unknown as typeof fetch;

    await expect(resolveDocPath("test-repo", "handoff.md")).rejects.toThrow(/401|transient|invalid|INS-311/i);
    // It must NOT have served the legacy root copy.
    const servedRoot = calls.some((u) => u.endsWith("/contents/handoff.md"));
    expect(servedRoot).toBe(false);
  }, 10_000);

  it("falls back to the legacy root path on a genuine .prism/ 404 (not-found)", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes(".prism/handoff.md")) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return contentsOk("LEGACY ROOT CONTENT");
    }) as unknown as typeof fetch;

    const result = await resolveDocPath("test-repo", "handoff.md");
    expect(result.legacy).toBe(true);
    expect(result.content).toBe("LEGACY ROOT CONTENT");
  }, 10_000);
});
