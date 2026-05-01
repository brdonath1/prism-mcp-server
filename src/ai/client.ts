/**
 * Thin Anthropic API client for PRISM synthesis operations.
 * Graceful degradation: returns null on any failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_API_KEY,
  SYNTHESIS_MODEL,
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  MCP_SAFE_TIMEOUT,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { synthesizeViaCcSubprocess } from "./cc-subprocess.js";

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
  /** brief-417: which transport produced this result. Optional because legacy
   *  callers (no callSite passed to synthesize) don't always need to know. */
  transport?: "messages_api" | "cc_subprocess" | "messages_api_fallback";
}

export interface SynthesisError {
  success: false;
  error: string;
  error_code: "TIMEOUT" | "AUTH" | "API_ERROR" | "DISABLED";
}

export type SynthesisOutcome = (SynthesisResult & { success: true }) | SynthesisError;

/** Per-call-site routing identifier (brief-417 Phase 3c-A).
 *  Values map to env-var prefixes (`SYNTHESIS_${UPPER}_*`) used for transport
 *  and model overrides. Adding a new call-site here means consumers can
 *  configure routing for it via Railway env vars without code change. */
export type SynthesisCallSite = "draft" | "brief" | "pdu";

/**
 * Resolve the per-call-site transport + model overrides from environment.
 *
 * Reads `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` and
 * `SYNTHESIS_${CALLSITE_UPPER}_MODEL`. Either may be unset; the caller
 * decides what to do when the transport defaults to messages_api and the
 * model defaults to `SYNTHESIS_MODEL`.
 *
 * Exported for unit tests so the routing decision can be asserted without
 * spinning up the SDK.
 */
export function resolveCallSiteRouting(callSite: SynthesisCallSite): {
  transport: "messages_api" | "cc_subprocess";
  model: string;
  modelOverridden: boolean;
} {
  const upper = callSite.toUpperCase();
  const transportEnv = process.env[`SYNTHESIS_${upper}_TRANSPORT`];
  const modelEnv = process.env[`SYNTHESIS_${upper}_MODEL`];

  let transport: "messages_api" | "cc_subprocess" = "messages_api";
  if (transportEnv === "cc_subprocess") {
    transport = "cc_subprocess";
  } else if (transportEnv && transportEnv !== "messages_api") {
    logger.warn("Unknown SYNTHESIS_*_TRANSPORT value — defaulting to messages_api", {
      callSite,
      value: transportEnv,
    });
  }

  const model = modelEnv && modelEnv.trim().length > 0 ? modelEnv.trim() : SYNTHESIS_MODEL;
  return { transport, model, modelOverridden: !!modelEnv };
}

/**
 * Call Opus for synthesis. Returns structured outcome with success/error info.
 *
 * @param thinking When true, sends `thinking: { type: "adaptive" }` so Opus 4.7
 *   dynamically allocates its thinking-token budget per request. Opus 4.7
 *   accepts ONLY the adaptive variant — the legacy fixed-budget thinking shape
 *   returns HTTP 400. The text-extraction filter below ignores any `thinking`
 *   content blocks emitted alongside `text`, so callers see only the final
 *   text output.
 *
 * @param callSite Optional per-call-site routing identifier (brief-417
 *   Phase 3c-A). When provided, the function reads
 *   `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` and
 *   `SYNTHESIS_${CALLSITE_UPPER}_MODEL` to optionally route through the
 *   Claude Code subprocess (OAuth + Sonnet 4.6 path) instead of the direct
 *   Messages API. On cc_subprocess failure, falls back automatically to
 *   messages_api with the default model and logs `SYNTHESIS_TRANSPORT_FALLBACK`.
 *   When not provided, behavior is unchanged (legacy callers).
 */
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
  thinking?: boolean,
  callSite?: SynthesisCallSite,
): Promise<SynthesisOutcome> {
  // Resolve routing once if a call-site is supplied; legacy callers (no
  // call-site) bypass env-var reads entirely so their behavior is bit-for-bit
  // unchanged.
  const routing = callSite ? resolveCallSiteRouting(callSite) : null;

  if (routing && routing.transport === "cc_subprocess") {
    const subprocessOutcome = await synthesizeViaCcSubprocess(
      systemPrompt,
      userContent,
      routing.model,
      maxTokens,
      timeoutMs,
      thinking,
    );
    if (subprocessOutcome.success) {
      return { ...subprocessOutcome, transport: "cc_subprocess" };
    }
    logger.warn("SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed, retrying via messages_api", {
      callSite,
      attempted_model: routing.model,
      original_error: subprocessOutcome.error,
      original_error_code: subprocessOutcome.error_code,
    });
    // Fall through to messages_api with the default model — the env override
    // is what failed, so we deliberately ignore it on the retry path.
    const fallback = await callMessagesApi({
      systemPrompt,
      userContent,
      maxTokens,
      timeoutMs,
      maxRetries,
      thinking,
      modelOverride: undefined,
    });
    if (fallback.success) {
      return { ...fallback, transport: "messages_api_fallback" };
    }
    return fallback;
  }

  // messages_api path — either legacy (no call-site) or call-site that
  // explicitly routes here. Honor the per-call-site model override when
  // provided.
  const direct = await callMessagesApi({
    systemPrompt,
    userContent,
    maxTokens,
    timeoutMs,
    maxRetries,
    thinking,
    modelOverride: routing?.modelOverridden ? routing.model : undefined,
  });
  if (direct.success && callSite) {
    return { ...direct, transport: "messages_api" };
  }
  return direct;
}

interface MessagesApiCallParams {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  thinking?: boolean;
  modelOverride?: string;
}

async function callMessagesApi(params: MessagesApiCallParams): Promise<SynthesisOutcome> {
  const {
    systemPrompt,
    userContent,
    maxTokens,
    timeoutMs,
    maxRetries,
    thinking,
    modelOverride,
  } = params;

  const anthropic = getClient();
  if (!anthropic) {
    logger.info("Synthesis skipped — ANTHROPIC_API_KEY not configured");
    return { success: false, error: "ANTHROPIC_API_KEY not configured", error_code: "DISABLED" };
  }

  const model = modelOverride ?? SYNTHESIS_MODEL;

  const start = Date.now();
  try {
    const requestOptions: { timeout: number; maxRetries?: number } = {
      timeout: timeoutMs ?? MCP_SAFE_TIMEOUT,
    };
    if (maxRetries !== undefined) {
      requestOptions.maxRetries = maxRetries;
    }

    const requestBody: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    };
    if (thinking) {
      // Opus 4.7 supports ONLY the adaptive variant; the legacy fixed-budget
      // thinking shape returns HTTP 400. Cast through unknown because the
      // installed SDK's ThinkingConfig union does not yet include the
      // "adaptive" variant.
      (requestBody as unknown as { thinking: { type: "adaptive" } }).thinking = { type: "adaptive" };
    }

    const response = await anthropic.messages.create(requestBody, requestOptions);

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const result = {
      success: true as const,
      content: textContent,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model,
    };

    logger.info("Synthesis API call complete", {
      model,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      thinking_enabled: !!thinking,
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
