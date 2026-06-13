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

import { describe, it, expect, vi } from "vitest";
import { gracefulShutdown, registerShutdownHandlers } from "../src/shutdown.js";

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
