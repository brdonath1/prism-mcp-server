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
        // Required by the SDK when bypassPermissions is used — documents
        // intent and disables the built-in "you sure?" guard.
        allowDangerouslySkipPermissions: true,
        abortController,
        // We run inside a Railway Node container with no persistent volume.
        // Session files on disk are useless and waste space.
        persistSession: false,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY,
        },
      } as any, // SDK Options has more fields than we care about; cast for readability.
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
          // Count each assistant turn. Usage is reported on the final result,
          // but partial usage shows up here for streaming observability.
          turns += 1;
          break;
        }
        case "result": {
          // Terminal message — always the last event in a successful run.
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
          // system / partial / tool events — we don't forward them, but the
          // Agent SDK will emit useful diagnostics via its own logger.
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
    logger.error("dispatchTask failed", { error: message, workingDirectory });
    return {
      success: false,
      result: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      duration_ms: Date.now() - start,
      error: message,
      timed_out: timedOut,
    };
  }
}
