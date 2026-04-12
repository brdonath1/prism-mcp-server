/**
 * Claude Code client — thin wrapper around `@anthropic-ai/claude-agent-sdk`.
 *
 * Exposes a `dispatchTask()` function that the `cc_dispatch` MCP tool calls.
 * The wrapper handles:
 * - Streaming SDKMessage events from the Agent SDK
 * - Collecting usage/turn counts
 * - Timeout enforcement (via AbortController)
 * - Structured result shape so callers don't need to know SDK internals
 *
 * Design notes:
 * - Runs with `permissionMode: "bypassPermissions"`. The MCP server is a
 *   trusted execution environment (Railway container, no human in the loop),
 *   so there is nothing to prompt. `canUseTool` is the mechanism that would
 *   gate operations if we ever needed to.
 * - Model defaults to `CC_DISPATCH_MODEL` (env-overridable).
 * - The SDK spawns the `claude` CLI as a subprocess, so `pathToClaudeCodeExecutable`
 *   must resolve to the binary installed via `@anthropic-ai/claude-code`. The
 *   subprocess inherits `ANTHROPIC_API_KEY` for auth.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { ANTHROPIC_API_KEY, CC_DISPATCH_MODEL } from "../config.js";
import { logger } from "../utils/logger.js";

/** Options accepted by dispatchTask. Mirrors the subset of Agent SDK
 *  Options we care about, plus a timeout for transport safety. */
export interface DispatchOptions {
  /** The task description. Goes in as the initial user prompt. */
  prompt: string;
  /** Absolute path to the working directory the agent operates in. */
  workingDirectory: string;
  /** Tool allowlist (e.g. ["Read","Grep"] for query mode). */
  allowedTools?: string[];
  /** Maximum agent turns before the SDK stops. */
  maxTurns?: number;
  /** Model alias or full ID (e.g. "opus", "claude-opus-4-6"). */
  model?: string;
  /** Hard deadline in milliseconds. On expiry the underlying query is aborted. */
  timeoutMs?: number;
}

/** Structured result returned to the MCP tool layer. */
export interface DispatchResult {
  success: boolean;
  /** Final assistant output (result.result from SDKResultSuccess). */
  result: string;
  /** Number of conversation turns consumed. */
  turns: number;
  /** Aggregated token usage. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Total cost in USD as reported by the SDK (may be 0 on errors). */
  cost_usd: number;
  /** Duration in milliseconds measured inside this function. */
  duration_ms: number;
  /** Populated on failure or if the run aborted. */
  error?: string;
  /** True when the abort was triggered by our own timeout. */
  timed_out?: boolean;
}

/**
 * Locate the claude CLI binary. Tries multiple strategies:
 * 1. node_modules/.bin/claude (npm local install)
 * 2. `which claude` (global PATH lookup)
 * 3. Falls back to "claude" and lets the SDK resolve it.
 *
 * Returns { path, version?, error? } so callers can log diagnostics.
 */
function findClaudeExecutable(): {
  path: string;
  version?: string;
  error?: string;
} {
  // Strategy 1: Check node_modules/.bin relative to cwd (/app on Railway)
  const localBin = join(process.cwd(), "node_modules", ".bin", "claude");
  if (existsSync(localBin)) {
    try {
      const version = execSync(`${localBin} --version 2>&1`, {
        timeout: 10_000,
        encoding: "utf-8",
      }).trim();
      return { path: localBin, version };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { path: localBin, error: `binary exists but --version failed: ${msg}` };
    }
  }

  // Strategy 2: Global PATH lookup
  try {
    const globalPath = execSync("which claude 2>/dev/null", {
      timeout: 5_000,
      encoding: "utf-8",
    }).trim();
    if (globalPath) {
      try {
        const version = execSync(`${globalPath} --version 2>&1`, {
          timeout: 10_000,
          encoding: "utf-8",
        }).trim();
        return { path: globalPath, version };
      } catch {
        return { path: globalPath, error: "found via PATH but --version failed" };
      }
    }
  } catch {
    // which failed — claude not on PATH
  }

  // Strategy 3: Bare fallback — let the SDK try
  return { path: "claude", error: "not found locally or on PATH — using bare name" };
}

/**
 * Run a direct CLI smoke test to capture stdout/stderr.
 * This bypasses the Agent SDK to get raw error output when the SDK's
 * error messages are too opaque.
 */
function runCliDiagnostic(executablePath: string, cwd: string): string {
  try {
    // Try a minimal print-mode invocation that should return quickly
    const output = execSync(
      `${executablePath} -p "Say hello" --output-format json --max-turns 1 --dangerously-skip-permissions 2>&1`,
      {
        timeout: 15_000,
        encoding: "utf-8",
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY,
          HOME: process.env.HOME ?? "/root",
        },
      },
    );
    return `CLI test OK: ${output.slice(0, 200)}`;
  } catch (err: any) {
    // execSync throws on non-zero exit — capture stderr/stdout from the error
    const stderr = err?.stderr?.toString?.()?.slice(0, 500) ?? "";
    const stdout = err?.stdout?.toString?.()?.slice(0, 500) ?? "";
    const code = err?.status ?? "unknown";
    return `CLI test FAILED (exit ${code}): stderr=[${stderr}] stdout=[${stdout}]`;
  }
}

/**
 * Dispatch a task to Claude Code and wait for the result.
 *
 * The function resolves when the SDK emits a terminal `result` message, when
 * the timeout fires, or when the stream ends unexpectedly. Errors are captured
 * into `DispatchResult.error` rather than thrown, so the calling MCP tool can
 * serialize a clean response to the client.
 */
export async function dispatchTask(
  options: DispatchOptions,
): Promise<DispatchResult> {
  if (!ANTHROPIC_API_KEY) {
    return {
      success: false,
      result: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      duration_ms: 0,
      error:
        "ANTHROPIC_API_KEY is not set — cc_dispatch requires a key to spawn Claude Code.",
    };
  }

  const {
    prompt,
    workingDirectory,
    allowedTools,
    maxTurns,
    model = CC_DISPATCH_MODEL,
    timeoutMs,
  } = options;

  // Pre-flight: find and validate the claude binary
  const executable = findClaudeExecutable();
  logger.info("dispatchTask pre-flight", {
    executablePath: executable.path,
    version: executable.version ?? "unknown",
    error: executable.error ?? "none",
    model,
    workingDirectory,
    maxTurns,
    allowedTools,
  });

  if (executable.error && !executable.version) {
    logger.warn("dispatchTask: claude binary pre-flight issue", {
      path: executable.path,
      error: executable.error,
    });
  }

  const start = Date.now();
  const abortController = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          logger.warn("dispatchTask timeout reached, aborting", {
            timeoutMs,
            workingDirectory,
          });
          abortController.abort();
        }, timeoutMs)
      : null;

  try {
    const q = query({
      prompt,
      options: {
        cwd: workingDirectory,
        model,
        allowedTools,
        maxTurns,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        pathToClaudeCodeExecutable: executable.path,
        persistSession: false,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY,
        },
      } as any,
    });

    let resultText = "";
    let turns = 0;
    let usageInput = 0;
    let usageOutput = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let costUsd = 0;
    let success = false;
    let errorMsg: string | undefined;

    for await (const message of q) {
      switch (message.type) {
        case "assistant": {
          turns += 1;
          break;
        }
        case "result": {
          turns = message.num_turns ?? turns;
          usageInput = message.usage?.input_tokens ?? usageInput;
          usageOutput = message.usage?.output_tokens ?? usageOutput;
          cacheCreation =
            (message.usage as any)?.cache_creation_input_tokens ??
            cacheCreation;
          cacheRead =
            (message.usage as any)?.cache_read_input_tokens ?? cacheRead;
          costUsd = message.total_cost_usd ?? 0;
          if (message.subtype === "success") {
            success = true;
            resultText = message.result ?? "";
          } else {
            success = false;
            errorMsg = `Agent returned ${message.subtype}: ${
              (message as any).error ?? "unknown"
            }`;
          }
          break;
        }
        default:
          break;
      }
    }

    if (timer) clearTimeout(timer);

    return {
      success,
      result: resultText,
      turns,
      usage: {
        input_tokens: usageInput,
        output_tokens: usageOutput,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
      cost_usd: costUsd,
      duration_ms: Date.now() - start,
      error: errorMsg,
      timed_out: timedOut,
    };
  } catch (error) {
    if (timer) clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    // Run direct CLI diagnostic to capture the actual error output
    const diagnostic = runCliDiagnostic(executable.path, workingDirectory);

    logger.error("dispatchTask failed", {
      error: message,
      stack: stack?.slice(0, 500),
      diagnostic,
      workingDirectory,
      executablePath: executable.path,
      executableVersion: executable.version ?? "unknown",
      model,
    });

    return {
      success: false,
      result: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      duration_ms: Date.now() - start,
      error: `${message} | executable: ${executable.path} (${executable.version ?? "version unknown"}) | diagnostic: ${diagnostic}`,
      timed_out: timedOut,
    };
  }
}
