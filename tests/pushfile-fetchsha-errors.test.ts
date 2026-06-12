/**
 * brief-456 / W3-S2 (M-002, SRV-75) — pushFile must not swallow non-404
 * fetchSha errors.
 *
 * The pre-PUT SHA fetch (and the 409-conflict re-fetch) previously swallowed
 * ALL errors, converting transient failures (401/403/timeout) into misleading
 * 422 "validation failed" results. Only genuine "Not found" (404) may be
 * swallowed — that is the legitimate create-mode signal. Operational errors
 * must surface as thrown errors carrying the real cause.
 *
 * These tests exercise the REAL github client with a stubbed global fetch.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushFile } from "../src/github/client.js";

type StubResponse = { status: number; body: string };

function makeFetchStub(queue: StubResponse[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch stub queue exhausted");
    return new Response(next.body, {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SRV-75 — pushFile fetchSha error handling", () => {
  it("initial fetchSha 401 → pushFile throws the real cause (not a misleading 422)", async () => {
    const stub = makeFetchStub([
      { status: 401, body: "Bad credentials" }, // GET (fetchSha)
      // If the swallow bug is present, a PUT follows; GitHub answers 422 for
      // a missing-sha update of an existing file.
      { status: 422, body: '{"message":"Invalid request. sha required"}' },
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(pushFile("test-project", ".prism/handoff.md", "content", "prism: test")).rejects.toThrow(
      /PAT is invalid or expired/,
    );
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("initial fetchSha 404 → create mode: PUT without sha, success", async () => {
    const stub = makeFetchStub([
      { status: 404, body: '{"message":"Not Found"}' }, // GET (fetchSha)
      { status: 201, body: '{"content":{"sha":"new-sha"}}' }, // PUT (create)
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await pushFile("test-project", ".prism/new-file.md", "content", "prism: test");

    expect(result.success).toBe(true);
    expect(result.sha).toBe("new-sha");
    const putBody = JSON.parse((stub.mock.calls[1][1] as RequestInit).body as string);
    expect(putBody).not.toHaveProperty("sha");
  });

  it("409-conflict re-fetch 401 → pushFile throws the real cause instead of blind create-mode retry", async () => {
    const stub = makeFetchStub([
      { status: 200, body: '{"sha":"old-sha"}' }, // GET (fetchSha)
      { status: 409, body: '{"message":"conflict"}' }, // PUT #1
      { status: 401, body: "Bad credentials" }, // GET (re-fetchSha)
      { status: 422, body: '{"message":"Invalid request. sha required"}' }, // PUT #2 (bug path)
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(pushFile("test-project", ".prism/handoff.md", "content", "prism: test")).rejects.toThrow(
      /PAT is invalid or expired/,
    );
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it("409-conflict re-fetch 404 (file deleted between attempts) → create-mode retry succeeds", async () => {
    const stub = makeFetchStub([
      { status: 200, body: '{"sha":"old-sha"}' }, // GET (fetchSha)
      { status: 409, body: '{"message":"conflict"}' }, // PUT #1
      { status: 404, body: '{"message":"Not Found"}' }, // GET (re-fetchSha)
      { status: 201, body: '{"content":{"sha":"recreated-sha"}}' }, // PUT #2 (create)
    ]);
    vi.stubGlobal("fetch", stub);

    const result = await pushFile("test-project", ".prism/handoff.md", "content", "prism: test");

    expect(result.success).toBe(true);
    expect(result.sha).toBe("recreated-sha");
    const retryPutBody = JSON.parse((stub.mock.calls[3][1] as RequestInit).body as string);
    expect(retryPutBody).not.toHaveProperty("sha");
  });
});
