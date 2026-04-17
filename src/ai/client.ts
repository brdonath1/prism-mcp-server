/**
 * Thin Anthropic API client for PRISM synthesis operations.
 * Graceful degradation: returns null on any failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, SYNTHESIS_MODEL, SYNTHESIS_MAX_OUTPUT_TOKENS, MCP_SAFE_TIMEOUT } from "../config.js";
import { logger } from "../utils/logger.js";

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }
  if (!client) {
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

export interface SynthesisResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export interface SynthesisError {
  success: false;
  error: string;
  error_code: "TIMEOUT" | "AUTH" | "API_ERROR" | "DISABLED";
}

export type SynthesisOutcome = (SynthesisResult & { success: true }) | SynthesisError;

/**
 * Call Opus 4.6 for synthesis. Returns structured outcome with success/error info.
 */
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
): Promise<SynthesisOutcome> {
  const anthropic = getClient();
  if (!anthropic) {
    logger.info("Synthesis skipped — ANTHROPIC_API_KEY not configured");
    return { success: false, error: "ANTHROPIC_API_KEY not configured", error_code: "DISABLED" };
  }

  const start = Date.now();
  try {
    const requestOptions: { timeout: number; maxRetries?: number } = {
      timeout: timeoutMs ?? MCP_SAFE_TIMEOUT,
    };
    if (maxRetries !== undefined) {
      requestOptions.maxRetries = maxRetries;
    }

    const response = await anthropic.messages.create(
      {
        model: SYNTHESIS_MODEL,
        max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      },
      requestOptions,
    );

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const result = {
      success: true as const,
      content: textContent,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model: SYNTHESIS_MODEL,
    };

    logger.info("Synthesis API call complete", {
      model: SYNTHESIS_MODEL,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      ms: Date.now() - start,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = message.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***REDACTED***");
    logger.error("Synthesis API call failed", { error: sanitized, ms: Date.now() - start });

    const isTimeout = message.includes("timeout") || message.includes("ETIMEDOUT");
    const isAuth = message.includes("401") || message.includes("authentication");
    const error_code: SynthesisError["error_code"] = isTimeout ? "TIMEOUT" : isAuth ? "AUTH" : "API_ERROR";

    return { success: false, error: sanitized, error_code };
  }
}
