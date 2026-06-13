/**
 * Graceful shutdown for the PRISM MCP Server (SRV-65 / brief-461 Task B).
 *
 * Railway sends SIGTERM on every deploy/restart. Without a handler the Node
 * process is killed immediately — which can strand an in-flight atomic commit
 * mid-write and leaves async cc_dispatch records at status 'running' with no
 * reaper. These helpers stop the HTTP server from accepting new connections,
 * give in-flight handlers a bounded window to drain, run an optional reaper
 * hook (e.g. mark still-'running' dispatches as interrupted), then exit.
 *
 * Extracted into its own side-effect-free module so the logic is unit-testable
 * without importing index.ts (whose top-level app.listen would bind a port).
 */

import type { Server } from "node:http";
import { logger } from "./utils/logger.js";

export interface ShutdownOptions {
  /** The listening HTTP server to stop. Only the close(cb) contract is used. */
  server: Pick<Server, "close">;
  /** Signal name, for logging. */
  signal: string;
  /** Max ms to wait for in-flight connections to drain before forcing exit. */
  drainTimeoutMs?: number;
  /** Best-effort reaper run after draining (e.g. mark running dispatches failed). */
  onDrain?: () => Promise<void>;
  /** Process exit, injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Perform a bounded graceful shutdown. Idempotent per call — callers should
 * guard against re-entry (registerShutdownHandlers does).
 */
export async function gracefulShutdown(opts: ShutdownOptions): Promise<void> {
  const { server, signal, onDrain } = opts;
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  logger.info("graceful shutdown initiated", { signal, drainTimeoutMs });

  // 1. Stop accepting new connections; let existing ones finish.
  const closed = new Promise<void>((resolve) => {
    server.close((err?: Error) => {
      if (err) {
        logger.warn("server.close reported an error during shutdown", {
          signal,
          error: err.message,
        });
      }
      resolve();
    });
  });

  // 2. Bound the drain — a wedged connection must not block deploy forever.
  const timedOut = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), drainTimeoutMs);
  });
  const outcome = await Promise.race([closed.then(() => "drained" as const), timedOut]);
  if (outcome === "timeout") {
    logger.warn("graceful shutdown drain timed out — forcing exit", {
      signal,
      drainTimeoutMs,
    });
  }

  // 3. Best-effort reaper (e.g. mark still-'running' records interrupted).
  if (onDrain) {
    try {
      await onDrain();
    } catch (err) {
      logger.warn("graceful shutdown reaper hook failed (non-fatal)", {
        signal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("graceful shutdown complete", { signal });
  exit(0);
}

/**
 * Register SIGTERM + SIGINT handlers that invoke {@link gracefulShutdown} once.
 * Re-entrant signals after the first are ignored so a SIGINT during a SIGTERM
 * drain does not kick off a second shutdown.
 */
export function registerShutdownHandlers(
  server: Pick<Server, "close">,
  opts?: Omit<ShutdownOptions, "server" | "signal">,
): void {
  let started = false;
  const handle = (signal: string) => {
    if (started) {
      logger.debug("shutdown already in progress — ignoring signal", { signal });
      return;
    }
    started = true;
    void gracefulShutdown({ server, signal, ...opts });
  };
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}
