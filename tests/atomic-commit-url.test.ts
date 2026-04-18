/**
 * S42 regression test — createAtomicCommit must use plural /git/refs/ for PATCH.
 *
 * The pre-S42 bug reused the singular /git/ref/{ref} GET URL for the step-5
 * PATCH (update-ref). GitHub returns a fast 404 ("Not found: updateRef <repo>")
 * because the update endpoint is /git/refs/{ref} (plural). Every atomic commit
 * silently fell back to sequential pushFile for ~5 days after S40 C3 deploy
 * because no existing test exercised HTTP routing — the atomic-fallback.test.ts
 * suite is entirely static string-pattern reads against source code.
 *
 * These tests mock the global fetch and assert the URL path + method contract.
 * Pairs with INS-31 (HTTP-routing tests must mock fetch and distinguish routes
 * by URL path + method, not via static source reads).
 */

// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAtomicCommit } from "../src/github/client.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

/**
 * Build a happy-path fetch mock that routes GitHub Git Data API calls to
 * canned responses. Records every call for post-hoc URL + method assertions.
 *
 * Routes the asymmetry explicitly:
 *   GET  /git/ref/heads/{branch}   → step 1 (singular, correct)
 *   PATCH /git/refs/heads/{branch} → step 5 (plural, correct)
 *
 * If the code regresses back to singular for PATCH, the "Any other path"
 * branch returns 404 and the tests fail loudly.
 */
function buildHappyPathFetch(calls: RecordedCall[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });

    // getDefaultBranch — GET /repos/{owner}/{repo}
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Step 1 — GET /git/ref/heads/main (singular, correct for GET)
    if (method === "GET" && url.includes("/git/ref/heads/main")) {
      return new Response(JSON.stringify({ object: { sha: "head-sha" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Step 2 — GET /git/commits/{sha}
    if (method === "GET" && url.includes("/git/commits/head-sha")) {
      return new Response(JSON.stringify({ tree: { sha: "base-tree" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // Step 3 — POST /git/trees
    if (method === "POST" && url.endsWith("/git/trees")) {
      return new Response(JSON.stringify({ sha: "new-tree" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    // Step 4 — POST /git/commits
    if (method === "POST" && url.endsWith("/git/commits")) {
      return new Response(JSON.stringify({ sha: "new-commit" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    // Step 5 — PATCH /git/refs/heads/main (plural, correct for PATCH)
    if (method === "PATCH" && url.includes("/git/refs/heads/main")) {
      return new Response(JSON.stringify({ object: { sha: "new-commit" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // PATCH to singular /git/ref/ — the pre-S42 mis-route. Return 404 so it
    // surfaces loudly as a test failure instead of a silent 200.
    if (method === "PATCH" && url.includes("/git/ref/heads/")) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(`Unexpected call: ${method} ${url}`, { status: 500 });
  }) as unknown as typeof fetch;
}

describe("S42 — createAtomicCommit URL routing", () => {
  let originalFetch: typeof fetch;
  let calls: RecordedCall[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses plural /git/refs/heads/{branch} for the step-5 PATCH", async () => {
    globalThis.fetch = buildHappyPathFetch(calls);

    const result = await createAtomicCommit(
      "s42-test-repo-a",
      [{ path: "README.md", content: "hello" }],
      "test: atomic commit",
    );

    expect(result.success).toBe(true);
    expect(result.sha).toBe("new-commit");

    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    // Must use plural /git/refs/ — this is the S42 regression guard.
    expect(patchCall!.url).toContain("/git/refs/heads/main");
    // Must NOT reuse the singular GET endpoint for PATCH.
    expect(patchCall!.url).not.toMatch(/\/git\/ref\/heads\//);
  });

  it("uses singular /git/ref/heads/{branch} for the step-1 GET", async () => {
    globalThis.fetch = buildHappyPathFetch(calls);

    await createAtomicCommit(
      "s42-test-repo-b",
      [{ path: "README.md", content: "hello" }],
      "test: atomic commit",
    );

    const getRefCall = calls.find(
      (c) => c.method === "GET" && /\/git\/refs?\/heads\//.test(c.url),
    );
    expect(getRefCall).toBeDefined();
    // GET must use singular /git/ref/ — this asymmetry with PATCH is the point.
    expect(getRefCall!.url).toMatch(/\/git\/ref\/heads\/main/);
    expect(getRefCall!.url).not.toMatch(/\/git\/refs\/heads\//);
  });

  it("executes all 5 git-data API steps in the correct order", async () => {
    globalThis.fetch = buildHappyPathFetch(calls);

    await createAtomicCommit(
      "s42-test-repo-c",
      [{ path: "README.md", content: "hello" }],
      "test: atomic commit",
    );

    // Label each call by its functional role.
    const labels = calls.map((c) => {
      if (c.method === "GET" && /\/git\/ref\/heads\//.test(c.url)) return "getRef";
      if (c.method === "GET" && /\/git\/commits\/[^/?]+$/.test(c.url)) return "getCommit";
      if (c.method === "POST" && c.url.endsWith("/git/trees")) return "createTree";
      if (c.method === "POST" && c.url.endsWith("/git/commits")) return "createCommit";
      if (c.method === "PATCH" && /\/git\/refs\/heads\//.test(c.url)) return "updateRef";
      return null;
    }).filter((x): x is string => x !== null);

    expect(labels).toEqual([
      "getRef",
      "getCommit",
      "createTree",
      "createCommit",
      "updateRef",
    ]);
  });

  it("surfaces 404 as structured error when PATCH is mis-routed (pre-S42 bug shape)", async () => {
    // Simulate the pre-fix bug: every PATCH returns 404. Verifies the error
    // surfaces as { success: false, error: "Not found: updateRef <repo>" } —
    // the exact message operators saw in production Railway logs.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (method === "GET" && url.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "head-sha" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/git/commits/head-sha")) {
        return new Response(JSON.stringify({ tree: { sha: "base-tree" } }), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "new-tree" }), { status: 201 });
      }
      if (method === "POST" && url.endsWith("/git/commits")) {
        return new Response(JSON.stringify({ sha: "new-commit" }), { status: 201 });
      }
      if (method === "PATCH") {
        return new Response("Not Found", { status: 404 });
      }
      return new Response("Unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await createAtomicCommit(
      "s42-test-repo-d",
      [{ path: "README.md", content: "hello" }],
      "test: atomic commit",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Not found");
    expect(result.error).toContain("updateRef");
    // Repo name must appear in the error context — production logs filter on
    // `repo` attribute for this exact shape.
    expect(result.error).toContain("s42-test-repo-d");
  });
});
