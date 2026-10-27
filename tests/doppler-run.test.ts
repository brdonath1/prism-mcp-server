// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DOPPLER_DOWNLOAD_URL,
  DopplerUnavailable,
  fetchDopplerSecrets as fetchSecrets,
  layerEnv,
  run as runWrapper,
} from "../scripts/doppler-run.mjs";

// The module is plain JS, so its parameter types come from the real defaults; tests pass fakes.
const fetchDopplerSecrets = (token: string, options?: Record<string, unknown>) => fetchSecrets(token, options as never);
const run = (argv: string[], options?: Record<string, unknown>) => runWrapper(argv, options as never);

// Synthetic values only; no real token or network.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}

function harness() {
  const child = new FakeChild();
  const proc = new EventEmitter();
  const spawn = vi.fn(() => child);
  return { child, proc, spawn };
}

function quietErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("fetchDopplerSecrets", () => {
  it("sends the bearer token to the download endpoint and drops DOPPLER_* metadata", async () => {
    const fetchImpl = vi.fn(async () => json({ ANTHROPIC_API_KEY: "a", DOPPLER_CONFIG: "prd_web" }));
    await expect(fetchDopplerSecrets("dp.st.synthetic", { fetchImpl, sleep: noSleep })).resolves.toEqual({ ANTHROPIC_API_KEY: "a" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DOPPLER_DOWNLOAD_URL);
    expect(init.headers).toEqual({ Authorization: "Bearer dp.st.synthetic", Accept: "application/json" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries network errors, stalled bodies, 429 and 5xx, then succeeds", async () => {
    const stalled = { ok: true, status: 200, text: async () => Promise.reject(new Error("aborted")) } as unknown as Response;
    const responses = [() => Promise.reject(new Error("offline")), () => Promise.resolve(stalled), () => json({}, 503), () => json({ A: "b" })];
    const fetchImpl = vi.fn(async () => responses.shift()!());
    const sleep = vi.fn(noSleep);
    const result = await fetchDopplerSecrets("t", { fetchImpl, sleep }).catch((error) => error);
    // Three attempts: offline, stalled body, then 503 is the last failure.
    expect(result).toBeInstanceOf(DopplerUnavailable);
    expect(result.message).toBe("HTTP 503");
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    await expect(fetchDopplerSecrets("t", { fetchImpl, sleep })).resolves.toEqual({ A: "b" });
  });

  it("gives up after three retryable failures and reports the last one", async () => {
    const fetchImpl = vi.fn(async () => json({}, 429));
    await expect(fetchDopplerSecrets("t", { fetchImpl, sleep: noSleep })).rejects.toThrow("HTTP 429");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(fetchDopplerSecrets("t", { fetchImpl: offline, sleep: noSleep })).rejects.toThrow("unreachable");
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn(async () => json({}, 401));
    await expect(fetchDopplerSecrets("t", { fetchImpl, sleep: noSleep })).rejects.toThrow("HTTP 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed responses without quoting them", async () => {
    const cases: [Response, string][] = [
      [new Response("KEY=leaked-value"), "response is not JSON"],
      [json(["x"]), "response is not an object"],
      [json(null), "response is not an object"],
      [json({ A: 1 }), "response has an invalid value"],
      [json({ A: "x\0y" }), "response has an invalid value"],
      [json({ "A=B": "x" }), "response has an invalid name"],
      [new Response('{"__proto__": "x"}'), "response has an invalid name"],
    ];
    for (const [response, message] of cases) {
      const error = await fetchDopplerSecrets("t", { fetchImpl: async () => response, sleep: noSleep }).catch((e) => e);
      expect(error).toBeInstanceOf(DopplerUnavailable);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain("leaked");
    }
  });

  it("stops when the caller's signal is aborted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      throw new Error("aborted");
    });
    await expect(fetchDopplerSecrets("t", { fetchImpl, sleep: noSleep, signal: controller.signal })).rejects.toThrow("interrupted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch and a real pause by default", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json({ A: "b" }));
    vi.useFakeTimers();
    const pending = fetchDopplerSecrets("t");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ A: "b" });
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });
});

describe("layerEnv: operator Railway tokens and strict names", () => {
  it("lets Doppler supply operator RAILWAY_API_TOKEN/RAILWAY_TOKEN while Railway keeps injected RAILWAY_*", () => {
    expect(layerEnv({ RAILWAY_SERVICE_NAME: "prism-mcp-server" }, { RAILWAY_API_TOKEN: "api", RAILWAY_TOKEN: "tok", RAILWAY_SERVICE_NAME: "x" }))
      .toEqual({ RAILWAY_SERVICE_NAME: "prism-mcp-server", RAILWAY_API_TOKEN: "api", RAILWAY_TOKEN: "tok" });
  });

  it("refuses a lower-case name in the config (fail closed)", async () => {
    const error = await fetchDopplerSecrets("t", { fetchImpl: async () => json({ MCP_AUTH_TOKEN: "x", lower_key: "y" }), sleep: noSleep }).catch((e) => e);
    expect(error.message).toBe("response has an invalid name");
  });
});

describe("layerEnv", () => {
  it("lets Doppler win except for PORT and RAILWAY_*, and strips the token", () => {
    const platform = { DOPPLER_TOKEN: "t", PORT: "8080", RAILWAY_ENVIRONMENT_NAME: "production", AI_MODEL: "old" };
    const secrets = { AI_MODEL: "new", PORT: "1", RAILWAY_ENVIRONMENT_NAME: "x", RAILWAY_EXTRA: "y" };
    expect(layerEnv(platform, secrets)).toEqual({ PORT: "8080", RAILWAY_ENVIRONMENT_NAME: "production", AI_MODEL: "new" });
  });
});

describe("run", () => {
  it("prints usage without a command", async () => {
    const error = quietErrors();
    await expect(run([])).resolves.toBe(2);
    error.mockRestore();
  });

  it("passes the environment through unchanged off Railway without a token", async () => {
    const { child, proc, spawn } = harness();
    const fetchImpl = vi.fn();
    const env = { PORT: "8080" };
    const pending = run(["node", "app.js"], { env, fetchImpl, spawn, proc });
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith("node", ["app.js"], { env, stdio: "inherit" });
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("refuses to start on Railway without a token", async () => {
    const error = quietErrors();
    const { proc, spawn } = harness();
    await expect(run(["node", "app.js"], { env: { RAILWAY_ENVIRONMENT_NAME: "production" }, spawn, proc })).resolves.toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("doppler-run: DOPPLER_TOKEN is not set on this Railway service; not starting");
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    error.mockRestore();
  });

  it("starts the command with Doppler values and without the token, and forwards signals", async () => {
    const { child, proc, spawn } = harness();
    const pending = run(["npm", "run", "start"], {
      env: { DOPPLER_TOKEN: "t", PORT: "8080" },
      fetchImpl: async () => json({ RESEND_API_KEY: "r" }),
      spawn,
      proc,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    expect(spawn).toHaveBeenCalledWith("npm", ["run", "start"], { env: { PORT: "8080", RESEND_API_KEY: "r" }, stdio: "inherit" });
    proc.emit("SIGTERM", "SIGTERM");
    expect(child.killed).toEqual(["SIGTERM"]);
    child.emit("exit", null, "SIGTERM");
    await expect(pending).resolves.toBe(143);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops promptly on a signal during the fetch without starting the app", async () => {
    const { proc, spawn } = harness();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const pending = run(["node", "app.js"], { env: { DOPPLER_TOKEN: "t" }, fetchImpl, sleep: noSleep, spawn, proc });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    proc.emit("SIGTERM", "SIGTERM");
    proc.emit("SIGINT", "SIGINT");
    await expect(pending).resolves.toBe(143);
    expect(spawn).not.toHaveBeenCalled();
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("does not start the app when a signal lands just as the fetch succeeds", async () => {
    const { proc, spawn } = harness();
    const fetchImpl = async () => {
      proc.emit("SIGHUP", "SIGHUP");
      return json({ A: "b" });
    };
    await expect(run(["node", "app.js"], { env: { DOPPLER_TOKEN: "t" }, fetchImpl, spawn, proc })).resolves.toBe(129);
    expect(spawn).not.toHaveBeenCalled();
    expect(proc.listenerCount("SIGHUP")).toBe(0);
  });

  it("fails closed when the token is set but Doppler is unavailable", async () => {
    const error = quietErrors();
    const { proc, spawn } = harness();
    await expect(run(["node", "app.js"], { env: { DOPPLER_TOKEN: "t" }, fetchImpl: async () => json({}, 403), spawn, proc })).resolves.toBe(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("doppler-run: Doppler settings unavailable (HTTP 403); not starting");
    error.mockRestore();
  });

  it("reports an unexpected failure without details", async () => {
    const error = quietErrors();
    const { proc, spawn } = harness();
    const badSleep = async () => {
      throw new Error("detail that must not be logged");
    };
    await expect(run(["x"], { env: { DOPPLER_TOKEN: "t" }, fetchImpl: async () => json({}, 500), sleep: badSleep, spawn, proc })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("doppler-run: Doppler settings unavailable (unexpected error); not starting");
    error.mockRestore();
  });

  it("returns 1 when spawn throws synchronously", async () => {
    const error = quietErrors();
    const proc = new EventEmitter();
    const spawn = vi.fn(() => {
      throw new TypeError("ERR_INVALID_ARG_VALUE");
    });
    await expect(run(["node"], { env: {}, spawn, proc })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("doppler-run: could not start node");
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    error.mockRestore();
  });

  it("returns 127 when the command cannot be started, ignores later errors, and maps unknown signals to 128", async () => {
    const error = quietErrors();
    const first = harness();
    const missing = run(["nope"], { env: {}, spawn: first.spawn, proc: first.proc });
    first.child.emit("error", new Error("ENOENT"));
    await expect(missing).resolves.toBe(127);
    expect(error).toHaveBeenCalledWith("doppler-run: could not start nope");

    const second = harness();
    second.child.pid = 42;
    const running = run(["x"], { env: {}, spawn: second.spawn, proc: second.proc });
    second.child.emit("error", new Error("kill failed"));
    second.child.emit("exit", null, "SIGNOTREAL");
    await expect(running).resolves.toBe(128);
    error.mockRestore();
  });
});
