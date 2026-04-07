/**
 * Thin Anthropic API client for PRISM synthesis operations.
 * Graceful degradation: returns null on any failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, SYNTHESIS_MODEL, SYNTHESIS_MAX_OUTPUT_TOKENS } from "../config.js";
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

/**
 * Call Opus 4.6 for synthesis. Returns null on any failure.
 */
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number
): Promise<SynthesisResult | null> {
  const anthropic = getClient();
  if (!anthropic) {
    logger.info("Synthesis skipped — ANTHROPIC_API_KEY not configured");
    return null;
  }

  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }, {
      timeout: timeoutMs ?? 30000, // B.4: configurable timeout
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const result: SynthesisResult = {
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
    logger.error("Synthesis API call failed", { error: message, ms: Date.now() - start });
    return null;
  }
}
