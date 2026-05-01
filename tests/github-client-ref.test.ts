/**
 * brief-416 — fetchFile() optional `ref` parameter.
 *
 * The brief reads `brdonath1/trigger:state/<slug>.json` from the `state`
 * branch of the trigger repo. fetchFile gained a third `ref?` argument that
 * appends `?ref=<encoded>` to the contents URL when set, while preserving
 * the existing default-branch behavior when omitted.
 *
 * These tests stub global fetch and assert on the exact URL the client
 * constructs — they do not exercise the GitHub API.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.GITHUB_OWNER = "test-owner";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFile } from "../src/github/client.js";

const FAKE_FILE_RESPONSE = {
  content: Buffer.from("hello", "utf-8").toString("base64"),
  sha: "sha-1",
  size: 5,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchFile — optional ref parameter (brief-416)", () => {
  let originalFetch: typeof fetch;
  let lastUrl: string | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastUrl = null;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(): void {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      lastUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse(FAKE_FILE_RESPONSE);
    }) as unknown as typeof fetch;
  }

  it("hits the URL WITHOUT ?ref= when ref is omitted (existing behavior)", async () => {
    stubFetch();
    await fetchFile("trigger", "state/prism.json");
    expect(lastUrl).toBe(
      "https://api.github.com/repos/test-owner/trigger/contents/state/prism.json",
    );
    expect(lastUrl).not.toContain("?ref=");
  });

  it("appends ?ref=state when ref='state' is passed", async () => {
    stubFetch();
    await fetchFile("trigger", "state/prism.json", "state");
    expect(lastUrl).toBe(
      "https://api.github.com/repos/test-owner/trigger/contents/state/prism.json?ref=state",
    );
  });

  it("URL-encodes special characters in the ref (e.g. feature/x → feature%2Fx)", async () => {
    stubFetch();
    await fetchFile("some-repo", "path.md", "feature/x");
    expect(lastUrl).toBe(
      "https://api.github.com/repos/test-owner/some-repo/contents/path.md?ref=feature%2Fx",
    );
  });

  it("treats explicit empty-string ref as no ref (omitted)", async () => {
    // The implementation uses `ref ? ... : base` — an empty string is
    // falsy and produces the no-ref URL. Documented here so a future
    // refactor that tightens the truthy check has a regression guard.
    stubFetch();
    await fetchFile("repo", "path.md", "");
    expect(lastUrl).not.toContain("?ref=");
  });
});
