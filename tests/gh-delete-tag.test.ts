/**
 * gh_delete_tag — unit tests for the brief-404 tool.
 *
 * Per INS-31, HTTP-routing tests must mock global fetch and route by URL +
 * method. The tool is a thin wrapper over `deleteRef(repo, "tags/" + tag)`,
 * so these tests exercise it through the underlying primitive — the same
 * surface the tool reports back through its MCP response.
 *
 * Behavior coverage:
 *   1. Success path: 204 No Content → success
 *   2. Idempotency: 422 → success with `note: "ref already absent"`
 *      (deleteRef treats all 422 as ref-absent — matches gh_delete_branch)
 *   3. Propagation: non-422 error (404) → { success: false, error }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deleteRef } from "../src/github/client.js";

interface RecordedCall {
  url: string;
  method: string;
}

describe("brief-404 — gh_delete_tag via deleteRef('tags/{tag}')", () => {
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

  it("success path: 204 No Content → { success: true }", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (method === "DELETE" && url.endsWith("/git/refs/tags/v1.0.0")) {
        return new Response(null, { status: 204 });
      }
      return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await deleteRef("test-repo", "tags/v1.0.0");

    expect(result.success).toBe(true);
    expect(result.note).toBeUndefined();
    expect(result.error).toBeUndefined();

    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    // The DELETE must hit the plural /git/refs/ endpoint with the tags/ prefix.
    expect(deleteCall!.url).toContain("/git/refs/tags/v1.0.0");
  });

  it("idempotency: 422 ref-absent → { success: true, note: 'ref already absent' }", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (method === "DELETE" && url.endsWith("/git/refs/tags/v9.9.9")) {
        return new Response(
          JSON.stringify({ message: "Reference does not exist" }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await deleteRef("test-repo", "tags/v9.9.9");

    expect(result.success).toBe(true);
    expect(result.note).toBe("ref already absent");
    expect(result.error).toBeUndefined();
  });

  it("propagation: 404 → { success: false, error } (non-422 errors propagate)", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (method === "DELETE" && url.endsWith("/git/refs/tags/v1.0.0")) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await deleteRef("missing-repo", "tags/v1.0.0");

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Not found");
  });
});
