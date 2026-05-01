/**
 * Lightweight Claude Code subprocess wrapper for synthesis (brief-417 Phase 3c-A).
 *
 * Distinct from `src/claude-code/cc_dispatch` (which clones a repo, allows
 * tools, and opens PRs). This wrapper is purely prompt-in / text-out:
 *
 *   - No working directory writes (cwd is just `process.cwd()` for the SDK).
 *   - No tools allowed (`tools: []` disables all built-ins).
 *   - No PR machinery, no commits.
 *   - Authentication via `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max OAuth).
 *     `ANTHROPIC_API_KEY` is scrubbed from the spawned subprocess env.
 *
 * The wrapper is invoked from `synthesize()` in `./client.ts` when a call
 * site has `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT=cc_subprocess` set in its
 * Railway env. On any failure (subprocess crash, timeout, parse error,
 * non-success terminal subtype) it returns a `SynthesisError` with
 * `error_code: "TIMEOUT" | "API_ERROR" | "AUTH"` so the caller can fall back
 * to the Messages API path automatically.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_OAUTH_TOKEN, MCP_SAFE_TIMEOUT } from "../config.js";
import {
  buildDispatchEnv,
  detectOAuthRejection,
  findClaudeExecutable,
} from "../claude-code/client.js";
import { logger } from "../utils/logger.js";
import type { SynthesisOutcome } from "./client.js";

/**
 * Run a single-turn synthesis prompt through the Claude Code subprocess.
 *
 * @param systemPrompt System prompt that fully replaces CC's default
 *   coding-agent prompt (D-161 concern #3 — prompt-cache geometry).
 * @param userContent Initial user message (the actual synthesis input bundle).
 * @param model Model identifier — passed straight to the SDK's `model` option.
 *   Aliases (`sonnet`, `opus`) and full IDs (`claude-sonnet-4-6`) both work.
 * @param maxTokens Reserved for future use — the Agent SDK does not currently
 *   expose a per-call max-output-tokens override, so this parameter is
 *   accepted for signature parity with `synthesize()` but not yet forwarded.
 * @param timeoutMs Wall-clock deadline. Defaults to `MCP_SAFE_TIMEOUT`.
 * @param thinking When true, requests adaptive thinking via the SDK's
 *   `thinking: { type: "adaptive" }` option. SDKs that ignore this on
 *   unsupported models simply pass through without error.
 */
export async function synthesizeViaCcSubprocess(
  systemPrompt: string,
  userContent: string,
  model: string,
  maxTokens?: number,
  timeoutMs?: number,
  thinking?: boolean,
): Promise<SynthesisOutcome> {
  // maxTokens is currently unused (see JSDoc) — referenced here so lint
  // recognizes intent, no behavior change.
  void maxTokens;

  if (!CLAUDE_CODE_OAUTH_TOKEN) {
    logger.warn("cc_subprocess synthesis unavailable — CLAUDE_CODE_OAUTH_TOKEN unset");
    return {
      success: false,
      error: "CLAUDE_CODE_OAUTH_TOKEN is not set — cc_subprocess transport unavailable",
      error_code: "AUTH",
    };
  }

  const start = Date.now();
  const executable = findClaudeExecutable();

  const abortController = new AbortController();
  let timedOut = false;
  const deadline = timeoutMs ?? MCP_SAFE_TIMEOUT;
  const timer = setTimeout(() => {
    timedOut = true;
    logger.warn("cc_subprocess synthesis timeout — aborting", { model, deadline });
    abortController.abort();
  }, deadline);

  try {
    const queryOptions = {
      cwd: process.cwd(),
      model,
      systemPrompt, // string form fully overrides CC's default coding-agent prompt
      tools: [], // disable all built-in tools — synthesis is prompt-in / text-out
      maxTurns: 1,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      abortController,
      pathToClaudeCodeExecutable: executable.path,
      persistSession: false,
      env: buildDispatchEnv(process.env, CLAUDE_CODE_OAUTH_TOKEN, "high"),
      ...(thinking ? { thinking: { type: "adaptive" as const } } : {}),
    };

    const q = query({
      prompt: userContent,
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });

    let resultText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let success = false;
    let errorMsg: string | undefined;

    for await (const message of q) {
      if (message.type === "result") {
        const usage = (message as unknown as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        inputTokens = usage?.input_tokens ?? 0;
        outputTokens = usage?.output_tokens ?? 0;
        if (message.subtype === "success") {
          success = true;
          resultText = (message as unknown as { result?: string }).result ?? "";
        } else {
          success = false;
          const rawError =
            (message as unknown as { error?: unknown }).error ??
            message.subtype ??
            "unknown";
          const rawErrorStr = typeof rawError === "string" ? rawError : JSON.stringify(rawError);
          errorMsg = timedOut
            ? `cc_subprocess timeout after ${deadline}ms`
            : detectOAuthRejection(rawErrorStr) ??
              `cc_subprocess returned ${message.subtype}: ${rawErrorStr}`;
        }
        break;
      }
    }

    clearTimeout(timer);

    if (!success) {
      logger.warn("cc_subprocess synthesis failed", {
        model,
        error: errorMsg ?? "no terminal result message",
        timed_out: timedOut,
        ms: Date.now() - start,
      });
      const isAuth =
        !!errorMsg && /CLAUDE_CODE_OAUTH_TOKEN|OAuth|bearer token/i.test(errorMsg);
      return {
        success: false,
        error: errorMsg ?? "cc_subprocess returned no terminal result message",
        error_code: timedOut ? "TIMEOUT" : isAuth ? "AUTH" : "API_ERROR",
      };
    }

    if (!resultText || resultText.length === 0) {
      logger.warn("cc_subprocess synthesis returned empty text", {
        model,
        ms: Date.now() - start,
      });
      return {
        success: false,
        error: "cc_subprocess returned empty result text",
        error_code: "API_ERROR",
      };
    }

    logger.info("cc_subprocess synthesis complete", {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thinking_enabled: !!thinking,
      ms: Date.now() - start,
    });

    return {
      success: true,
      content: resultText,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model,
    };
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = message.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***REDACTED***");
    logger.error("cc_subprocess synthesis crashed", {
      model,
      error: sanitized,
      timed_out: timedOut,
      ms: Date.now() - start,
    });
    const oauthErr = detectOAuthRejection(sanitized);
    return {
      success: false,
      error: oauthErr ?? sanitized,
      error_code: timedOut ? "TIMEOUT" : oauthErr ? "AUTH" : "API_ERROR",
    };
  }
}
