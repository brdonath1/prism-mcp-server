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
    // brief-461 SRV-35: a 401 is now retried (bounded) before surfacing, so
    // the GET is attempted MAX_TRANSIENT_401_RETRIES+1 = 3 times. The SRV-75
    // guarantee is unchanged: the persistent 401 surfaces the real cause and
    // pushFile must NOT fall through to a sha-less create-mode PUT (which a
    // server would answer with a misleading 422). The trailing 422 here is the
    // bug-path PUT — it must never be reached.
    const stub = makeFetchStub([
      { status: 401, body: "Bad credentials" }, // GET (fetchSha) attempt 1
      { status: 401, body: "Bad credentials" }, // GET retry 2
      { status: 401, body: "Bad credentials" }, // GET retry 3 (final)
      { status: 422, body: '{"message":"Invalid request. sha required"}' }, // bug-path PUT
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(pushFile("test-project", ".prism/handoff.md", "content", "prism: test")).rejects.toThrow(
      /401|transient|INS-311/i,
    );
    // 3 GET attempts; the create-mode PUT was never reached.
    expect(stub).toHaveBeenCalledTimes(3);
  }, 10_000);

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
    // brief-461 SRV-35: the 409-conflict re-fetchSha 401 is also retried
    // (bounded, 3 attempts) before surfacing. SRV-75 guarantee preserved: the
    // re-fetch 401 surfaces the real cause; the bug-path create-mode PUT #2 is
    // never reached.
    const stub = makeFetchStub([
      { status: 200, body: '{"sha":"old-sha"}' }, // GET (fetchSha)
      { status: 409, body: '{"message":"conflict"}' }, // PUT #1
      { status: 401, body: "Bad credentials" }, // GET (re-fetchSha) attempt 1
      { status: 401, body: "Bad credentials" }, // re-fetchSha retry 2
      { status: 401, body: "Bad credentials" }, // re-fetchSha retry 3 (final)
      { status: 422, body: '{"message":"Invalid request. sha required"}' }, // PUT #2 (bug path)
    ]);
    vi.stubGlobal("fetch", stub);

    await expect(pushFile("test-project", ".prism/handoff.md", "content", "prism: test")).rejects.toThrow(
      /401|transient|INS-311/i,
    );
    // 1 GET + 1 PUT(409) + 3 re-fetch attempts = 5; the bug-path PUT #2 was never reached.
    expect(stub).toHaveBeenCalledTimes(5);
  }, 10_000);

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
