/**
 * SRV-65 (brief-461 Task B) — graceful shutdown on SIGTERM/SIGINT.
 *
 * Railway sends SIGTERM on every deploy. Without a handler the process is
 * killed immediately, stranding any in-flight atomic commit mid-write and
 * leaving async dispatch records at status 'running' with no reaper. The
 * shutdown path stops accepting new connections, drains in-flight handlers
 * (bounded), runs an optional reaper hook, then exits.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
// S203 R26: the reaper's dispatch sweep is a no-op unless cc_dispatch is
// enabled, so the gate must be on before src/config.ts is imported.
process.env.CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "test-dummy-oauth";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { gracefulShutdown, registerShutdownHandlers } from "../src/shutdown.js";

vi.mock("../src/dispatch-store.js", () => ({
  listDispatchIds: vi.fn(),
  readDispatchRecord: vi.fn(),
  writeDispatchRecord: vi.fn(),
}));

import {
  listDispatchIds,
  readDispatchRecord,
  writeDispatchRecord,
  type DispatchRecord,
} from "../src/dispatch-store.js";
import {
  registerInflight,
  drainInflight,
  inflightCount,
  shutdownReaper,
} from "../src/utils/inflight-registry.js";

const mockListDispatchIds = vi.mocked(listDispatchIds);
const mockReadDispatchRecord = vi.mocked(readDispatchRecord);
const mockWriteDispatchRecord = vi.mocked(writeDispatchRecord);

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    dispatch_id: "cc-1",
    repo: "prism-mcp-server",
    branch: "main",
    mode: "execute",
    prompt: "do the thing",
    status: "running",
    started_at: "2026-08-14T00:00:00Z",
    agent: "claude-code",
    server_version: "4.13.0",
    ...overrides,
  };
}

/** Minimal http.Server stand-in exposing the close(callback) contract. */
function fakeServer(opts: { closeImmediately?: boolean } = {}) {
  const calls = { close: 0 };
  return {
    calls,
    close(cb?: (err?: Error) => void) {
      calls.close += 1;
      // closeImmediately=false simulates a connection that never drains, so
      // the bounded timeout must still let shutdown complete.
      if (opts.closeImmediately !== false && cb) cb();
      return this as unknown as import("node:http").Server;
    },
  };
}

describe("gracefulShutdown", () => {
  it("stops accepting connections (server.close), runs the reaper, then exits 0", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    const onDrain = vi.fn(async () => {});

    await gracefulShutdown({ server: server as never, signal: "SIGTERM", exit, onDrain });

    expect(server.calls.close).toBe(1);
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits when the drain exceeds the bounded timeout (server never closes)", async () => {
    const server = fakeServer({ closeImmediately: false }); // close() never calls cb
    const exit = vi.fn();

    await gracefulShutdown({
      server: server as never,
      signal: "SIGTERM",
      exit,
      drainTimeoutMs: 20,
    });

    expect(server.calls.close).toBe(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not throw when the reaper hook fails (best-effort)", async () => {
    const server = fakeServer();
    const exit = vi.fn();
    const onDrain = vi.fn(async () => {
      throw new Error("reaper boom");
    });

    await expect(
      gracefulShutdown({ server: server as never, signal: "SIGINT", exit, onDrain }),
    ).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("S203 R26 (F-C1-10) — the shutdown reaper is wired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDispatchIds.mockResolvedValue([]);
  });

  it("index.ts supplies an onDrain to registerShutdownHandlers", () => {
    // The finding: index.ts registered graceful shutdown with no reaper, so
    // the bounded drain covered HTTP connections only. Source-level because
    // importing index.ts would bind a port (its app.listen is top-level).
    const source = readFileSync("src/index.ts", "utf-8");
    const call = source.slice(source.indexOf("registerShutdownHandlers(httpServer"));
    expect(call).toMatch(/registerShutdownHandlers\(httpServer,\s*\{[^}]*onDrain/s);
    expect(source).toContain("shutdownReaper");
  });

  it("marks still-'running' dispatch records interrupted, leaving terminal ones alone", async () => {
    mockListDispatchIds.mockResolvedValue(["cc-running", "cc-done", "cc-failed"]);
    mockReadDispatchRecord.mockImplementation(async (id: string) => {
      if (id === "cc-running") return record({ dispatch_id: "cc-running" });
      if (id === "cc-done") return record({ dispatch_id: "cc-done", status: "completed" });
      return record({ dispatch_id: "cc-failed", status: "failed" });
    });

    await shutdownReaper({ drainTimeoutMs: 10 });

    expect(mockWriteDispatchRecord).toHaveBeenCalledTimes(1);
    const written = mockWriteDispatchRecord.mock.calls[0][0];
    expect(written.dispatch_id).toBe("cc-running");
    expect(written.status).toBe("failed");
    expect(written.completed_at).toBeTruthy();
    expect(written.error).toMatch(/interrupted/i);
  });

  it("does not reject when the dispatch sweep throws (shutdown must still proceed)", async () => {
    mockListDispatchIds.mockRejectedValue(new Error("GitHub unreachable"));

    await expect(shutdownReaper({ drainTimeoutMs: 10 })).resolves.toBeUndefined();
  });
});

describe("S203 R26 — in-flight background registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDispatchIds.mockResolvedValue([]);
  });

  it("returns the same promise it was handed (drop-in at the call site)", async () => {
    const work = Promise.resolve("done");
    expect(registerInflight(work, "test")).toBe(work);
    await work;
  });

  it("awaits outstanding work and clears it from the registry on settle", async () => {
    let release: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerInflight(work, "synthesis");
    expect(inflightCount()).toBe(1);

    setTimeout(release, 5);
    const outcome = await drainInflight(1_000);

    expect(outcome).toEqual({ pending: 1, timedOut: false });
    expect(inflightCount()).toBe(0);
  });

  it("a rejected background task does not reject the drain", async () => {
    registerInflight(Promise.reject(new Error("synthesis boom")), "synthesis");

    await expect(drainInflight(200)).resolves.toMatchObject({ timedOut: false });
    expect(inflightCount()).toBe(0);
  });

  // Last in the block on purpose: the wedged promise never settles, so it
  // stays in the module-level registry for the rest of the file.
  it("bounds the drain so a wedged task cannot hold a deploy open", async () => {
    // Pre-R26 nothing awaited background work at all; post-R26 nothing may
    // wait on it forever either.
    registerInflight(new Promise<void>(() => {}), "wedged");

    const start = Date.now();
    const outcome = await drainInflight(20);

    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe("registerShutdownHandlers", () => {
  it("registers SIGTERM and SIGINT listeners", () => {
    const server = fakeServer();
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");

    registerShutdownHandlers(server as never, { exit: vi.fn(), drainTimeoutMs: 10 });

    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);

    // Clean up the listeners this test added so it doesn't leak across files.
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });
});
