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
 *   subprocess receives CLAUDE_CODE_OAUTH_TOKEN (Max subscription OAuth)
 *   for auth. ANTHROPIC_API_KEY is explicitly scrubbed from the subprocess
 *   env even though the parent process has it set for synthesis — without
 *   scrubbing, CC's auth precedence ladder would prefer the API key (#3)
 *   over the OAuth token (#5) and silently re-route to per-token API billing.
 * - Container MUST run as non-root user (INS-73, D-118). Claude Code CLI
 *   v2.1+ rejects bypassPermissions when running as root.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CC_DISPATCH_EFFORT, CC_DISPATCH_MODEL, CLAUDE_CODE_OAUTH_TOKEN } from "../config.js";
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
 *
 * Exported so other subprocess wrappers (e.g. src/ai/cc-subprocess.ts —
 * brief-417 Phase 3c-A synthesis routing) can reuse the same resolution
 * logic without duplicating it.
 */
export function findClaudeExecutable(): {
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
 * Build the env passed to the spawned Claude Code subprocess.
 *
 * Scrubs ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN so the child does not
 * inherit them from the parent process. Sets CLAUDE_CODE_OAUTH_TOKEN as the
 * sanctioned auth source for the official Claude Code CLI.
 *
 * Exported solely so the env-scrubbing behavior can be unit-tested without
 * spinning up the Agent SDK.
 */
export function buildDispatchEnv(
  parentEnv: NodeJS.ProcessEnv,
  oauthToken: string,
  effort: string,
): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key === "ANTHROPIC_API_KEY") continue;
    if (key === "ANTHROPIC_AUTH_TOKEN") continue;
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  childEnv.CLAUDE_CODE_EFFORT = effort;
  return childEnv;
}

/**
 * Format a human-readable error message for sync-mode timeout.
 * Replaces the SDK's misleading "aborted by user" message with an actionable
 * explanation. Pure function extracted for testability.
 */
export function formatTimeoutError(timeoutMs: number): string {
  return (
    `cc_dispatch sync timeout reached after ${timeoutMs}ms. ` +
    `The Agent SDK was aborted because the operation exceeded the configured deadline. ` +
    `For tasks expected to exceed ~30s, pass async_mode: true to remove the deadline. ` +
    `To adjust the sync timeout, set the CC_DISPATCH_SYNC_TIMEOUT_MS environment variable ` +
    `(current value: ${timeoutMs}ms).`
  );
}

const OAUTH_REJECTION_SIGNATURES = [
  "OAuth authentication is currently not supported",
  "Invalid bearer token",
  "invalid bearer token",
  "OAuth token expired",
  "Please run /login",
];

/** Returns a specific OAuth-failure error string if `raw` matches any known
 *  rejection signature; otherwise returns null. */
export function detectOAuthRejection(raw: string | undefined): string | null {
  if (!raw) return null;
  const hit = OAUTH_REJECTION_SIGNATURES.find((sig) => raw.includes(sig));
  if (!hit) return null;
  return (
    "Claude Code OAuth token rejected by Anthropic — " +
    "the CLAUDE_CODE_OAUTH_TOKEN is likely expired, revoked, or invalid. " +
    "Regenerate via `claude setup-token` on a Mac signed into the intended " +
    "Max subscription, then update the Railway env var. Underlying signature: " +
    `"${hit}". Original error: ${raw}`
  );
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
  if (!CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      success: false,
      result: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      duration_ms: 0,
      error:
        "CLAUDE_CODE_OAUTH_TOKEN is not set — cc_dispatch requires a Claude " +
        "Max subscription OAuth token. Generate one with `claude setup-token` " +
        "on a Mac signed into the intended Max account, then set " +
        "CLAUDE_CODE_OAUTH_TOKEN as a Railway env var on this service.",
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
    effort: CC_DISPATCH_EFFORT,
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
        // D-124: Pass effort level for max reasoning depth on Opus 4.6.
        // The Agent SDK may or may not forward this to the underlying API.
        // If ignored, Opus 4.6 defaults to "high" effort which is still
        // excellent. "max" is an experimental upgrade for maximum capability.
        effort: CC_DISPATCH_EFFORT,
        env: buildDispatchEnv(process.env, CLAUDE_CODE_OAUTH_TOKEN, CC_DISPATCH_EFFORT),
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
            const rawError = (message as any).error ?? "unknown";
            const oauthErr =
              detectOAuthRejection(rawError) ??
              detectOAuthRejection(message.subtype);
            errorMsg = timedOut
              ? formatTimeoutError(timeoutMs ?? 0)
              : oauthErr ?? `Agent returned ${message.subtype}: ${rawError}`;
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
    logger.error("dispatchTask failed", {
      error: message,
      stack: stack?.slice(0, 500),
      workingDirectory,
      executablePath: executable.path,
      executableVersion: executable.version ?? "unknown",
      executableError: executable.error ?? "none",
      model,
    });
    const oauthErr = detectOAuthRejection(message);
    const errorString = timedOut
      ? formatTimeoutError(timeoutMs ?? 0)
      : oauthErr ??
        `${message} | executable: ${executable.path} (${executable.version ?? "version unknown"})${executable.error ? " | pre-flight: " + executable.error : ""}`;
    return {
      success: false,
      result: "",
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      duration_ms: Date.now() - start,
      error: errorString,
      timed_out: timedOut,
    };
  }
}
