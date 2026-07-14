/**
 * Thin Anthropic API client for PRISM synthesis operations.
 * Graceful degradation: returns null on any failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_API_KEY,
  CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS,
  SYNTHESIS_MODEL,
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  SYNTHESIS_TIMEOUT_MS,
  MCP_SAFE_TIMEOUT,
} from "../config.js";
import {
  emitLlmCall,
  estimateTokensFromChars,
  type LlmFallbackReason,
} from "../llm/llm-call-telemetry.js";
import { validateOpenrouterSynthesisOutput } from "../llm/openrouter.js";
import {
  isLiveProviderSynthesisDecision,
  synthesizeViaProvider,
  type ProviderSynthesisError,
} from "../llm/provider-adapters.js";
import { observeRoute } from "../llm/route-observer.js";
import type { LlmSurface, LlmTransport } from "../llm/route-types.js";
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
  transport?:
    | "messages_api"
    | "cc_subprocess"
    | "messages_api_fallback"
    | "openai_responses"
    | "openai_compatible_chat"
    | "gemini_generate_content"
    | "xai_responses";
  /** brief-456 (SRV-07): the Messages API stop_reason, propagated so callers
   *  can refuse to push truncated output (`max_tokens`) over a good artifact.
   *  Absent on the cc_subprocess transport (the Agent SDK has its own
   *  zero-token/empty-text guards). */
  stop_reason?: string | null;
  /** D-275: provider-measured cost in USD when the serving provider returned
   *  one (OpenRouter usage.cost). Feeds the LLM_CALL telemetry line. */
  cost_usd?: number | null;
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

const SYNTHESIS_ROUTE_SURFACE: Record<SynthesisCallSite, LlmSurface> = {
  draft: "synthesis_draft",
  brief: "synthesis_brief",
  pdu: "synthesis_pdu",
};

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

  let model = modelEnv && modelEnv.trim().length > 0 ? modelEnv.trim() : SYNTHESIS_MODEL;
  let modelOverridden = !!modelEnv;

  // SRV-50: the `[1m]` suffix is a Claude-Code CLI routing signal (1M-context
  // opt-in), and a bare alias (e.g. "opus", missing the "claude-" prefix) is a
  // CC shorthand — NEITHER is a Messages-API model id. If a per-call-site model
  // override carries one but the transport resolved to messages_api (a typo'd or
  // unset SYNTHESIS_*_TRANSPORT — an empty value is falsy and warns nowhere), the
  // id would be sent verbatim to anthropic.messages.create and HARD-FAIL every
  // synthesis at that call site with no fallback, visible only in error-level
  // logs (invisible to the warn-filtered boot observation gate). Drop the
  // override, fall back to the API-valid SYNTHESIS_MODEL, and warn loudly.
  if (
    transport === "messages_api" &&
    modelOverridden &&
    (/\[1m\]$/.test(model) || !model.startsWith("claude-"))
  ) {
    logger.warn(
      "SYNTHESIS_MODEL_MISCONFIG — per-call-site model is Claude-Code-only ([1m] suffix or bare alias) but transport resolved to messages_api; dropping the override and using SYNTHESIS_MODEL",
      { callSite, attempted_model: model, fallback_model: SYNTHESIS_MODEL },
    );
    model = SYNTHESIS_MODEL;
    modelOverridden = false;
  }

  return { transport, model, modelOverridden };
}

/**
 * Resolve the per-call-site request timeout (SRV-61). The transport decision —
 * cc_subprocess needs the larger CC_SUBPROCESS ceiling because subprocess spawn
 * + OAuth overhead sits on top of inference — was duplicated as a raw
 * `process.env.SYNTHESIS_*_TRANSPORT === "cc_subprocess"` check at four sites
 * that could drift from resolveCallSiteRouting. This is the single source: every
 * timeout-selection site derives the transport HERE.
 */
export function resolveCallSiteTimeout(callSite: SynthesisCallSite): number {
  return resolveCallSiteRouting(callSite).transport === "cc_subprocess"
    ? CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS
    : SYNTHESIS_TIMEOUT_MS;
}

/**
 * Call the synthesis model. Returns structured outcome with success/error info.
 *
 * @param thinking When true, sends `thinking: { type: "adaptive" }` plus
 *   `output_config: { effort: "max" }` so current Claude models dynamically
 *   allocate the highest first-party reasoning effort per request. Current
 *   Opus-tier models (Opus 4.8) and Sonnet 5 accept ONLY the adaptive
 *   thinking variant — the legacy fixed-budget thinking shape returns HTTP
 *   400. The text-extraction filter below ignores any `thinking` content
 *   blocks emitted alongside `text`, so callers see only the final text output.
 *
 * @param callSite Optional per-call-site routing identifier (brief-417
 *   Phase 3c-A). When provided, the function reads
 *   `SYNTHESIS_${CALLSITE_UPPER}_TRANSPORT` and
 *   `SYNTHESIS_${CALLSITE_UPPER}_MODEL` to optionally route through the
 *   Claude Code subprocess (OAuth path, env-selected model) instead of the
 *   direct Messages API. On cc_subprocess failure, falls back automatically to
 *   messages_api with the default model and logs `SYNTHESIS_TRANSPORT_FALLBACK`.
 *   When not provided, behavior is unchanged (legacy callers).
 *
 * @param projectSlug Optional project slug tag (brief-419). When provided,
 *   it is attached to the `SYNTHESIS_TRANSPORT_FALLBACK` warn log and the
 *   `Synthesis API call complete` info log so prism_bootstrap can filter
 *   synthesis observation events by project. Legacy callers that omit it
 *   continue to emit the same logs without the field — backwards-compatible.
 */
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number,
  timeoutMs?: number,
  maxRetries?: number,
  thinking?: boolean,
  callSite?: SynthesisCallSite,
  projectSlug?: string,
): Promise<SynthesisOutcome> {
  // D-275 (brief-s196c) §4.8: LLM_CALL telemetry wrapper. The chain state
  // records which hop was last attempted/served and whether/why the primary
  // route fell back; the single LLM_CALL line is emitted here so EVERY
  // synthesis transport (provider adapters, cc_subprocess, messages_api)
  // passes through one emission point.
  const startedAt = Date.now();
  const chain: SynthesisChainState = {
    provider: "anthropic",
    model: SYNTHESIS_MODEL,
    transport: "messages_api",
    fallback_used: false,
    fallback_reason: null,
    measured_cost_usd: null,
  };

  const outcome = await synthesizeChain(
    systemPrompt,
    userContent,
    maxTokens,
    timeoutMs,
    maxRetries,
    thinking,
    callSite,
    projectSlug,
    chain,
  );

  const transport = outcome.success ? (outcome.transport ?? chain.transport) : chain.transport;
  const usageInput = outcome.success ? outcome.input_tokens : 0;
  const usageOutput = outcome.success ? outcome.output_tokens : 0;
  const haveUsage = usageInput > 0 || usageOutput > 0;
  emitLlmCall({
    call_site: callSite ? SYNTHESIS_ROUTE_SURFACE[callSite] : "synthesis_uncategorized",
    provider: providerForTransport(transport, chain.provider),
    model: outcome.success ? outcome.model : chain.model,
    transport,
    success: outcome.success,
    input_tokens: haveUsage
      ? usageInput
      : estimateTokensFromChars(systemPrompt.length + userContent.length),
    output_tokens: haveUsage
      ? usageOutput
      : outcome.success
        ? estimateTokensFromChars(outcome.content.length)
        : 0,
    token_source: haveUsage ? "usage" : "chars_estimate",
    measured_cost_usd: chain.measured_cost_usd,
    latency_ms: Date.now() - startedAt,
    fallback_used: chain.fallback_used,
    fallback_reason: chain.fallback_reason,
    project_slug: projectSlug,
  });

  return outcome;
}

/** Mutable per-call record of the serving chain, for the LLM_CALL line. */
interface SynthesisChainState {
  /** Last attempted hop — on total failure this is what the line reports. */
  provider: string;
  model: string;
  transport: string;
  fallback_used: boolean;
  /** Why the PRIMARY route fell back (first failure wins — design §4.6). */
  fallback_reason: LlmFallbackReason | null;
  /** Provider-measured cost captured when the serving hop returned one. */
  measured_cost_usd: number | null;
}

/** Provider label for a serving transport: non-Anthropic transports carry the
 *  provider recorded at the provider hop; every Anthropic transport
 *  (messages_api, cc_subprocess, messages_api_fallback) is anthropic. */
function providerForTransport(transport: string, chainProvider: string): string {
  switch (transport) {
    case "openai_responses":
    case "openai_compatible_chat":
    case "gemini_generate_content":
    case "xai_responses":
      return chainProvider;
    default:
      return "anthropic";
  }
}

/** Map a provider-adapter failure to the LLM_CALL/fallback-warn reason enum.
 *  finish_reason≠stop and empty-content failures are classed "validation" by
 *  the adapter (the GLM thinking-starvation signature) → validation_failed. */
function fallbackReasonFromProviderError(err: ProviderSynthesisError): LlmFallbackReason {
  if (err.failure_class === "validation") return "validation_failed";
  if (err.failure_class === "timeout" || err.error_code === "TIMEOUT") return "timeout";
  return "provider_error";
}

async function synthesizeChain(
  systemPrompt: string,
  userContent: string,
  maxTokens: number | undefined,
  timeoutMs: number | undefined,
  maxRetries: number | undefined,
  thinking: boolean | undefined,
  callSite: SynthesisCallSite | undefined,
  projectSlug: string | undefined,
  chain: SynthesisChainState,
): Promise<SynthesisOutcome> {
  // Resolve routing once if a call-site is supplied; legacy callers (no
  // call-site) bypass env-var reads entirely so their behavior is bit-for-bit
  // unchanged.
  const routing = callSite ? resolveCallSiteRouting(callSite) : null;
  const routeSurface = callSite ? SYNTHESIS_ROUTE_SURFACE[callSite] : undefined;
  let routeDecision: ReturnType<typeof observeRoute> | null = null;
  if (routing && routeSurface) {
    routeDecision = observeRoute({
      surface: routeSurface,
      taskClass: `synthesis-${callSite}`,
      reasoningSetting: thinking ? "adaptive" : null,
      currentModel: routing.model,
      currentTransport: routing.transport as LlmTransport,
      currentAuthEnvVar:
        routing.transport === "cc_subprocess"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : "ANTHROPIC_API_KEY",
    });
  }

  if (routeDecision && isLiveProviderSynthesisDecision(routeDecision)) {
    chain.provider = routeDecision.provider;
    chain.model = routeDecision.model;
    chain.transport = routeDecision.transport;
    const providerOutcome = await synthesizeViaProvider({
      decision: routeDecision,
      systemPrompt,
      userContent,
      maxTokens,
      timeoutMs,
    });
    if (providerOutcome.success) {
      // D-275 §4.5: openrouter results must pass the per-site quality gate
      // BEFORE counting as success — a gate failure is treated exactly like a
      // provider failure and falls through to the site's existing Anthropic
      // chain. Anthropic/frontier legs keep today's lenient warn-level checks.
      const gate =
        routeDecision.provider === "openrouter"
          ? validateOpenrouterSynthesisOutput(routeDecision.surface, providerOutcome.content)
          : ({ ok: true } as const);
      if (gate.ok) {
        chain.measured_cost_usd = providerOutcome.cost_usd ?? null;
        logger.info("Synthesis provider call complete", {
          provider: routeDecision.provider,
          model: providerOutcome.model,
          transport: providerOutcome.transport,
          input_tokens: providerOutcome.input_tokens,
          output_tokens: providerOutcome.output_tokens,
          projectSlug,
        });
        return providerOutcome;
      }
      chain.fallback_used = true;
      chain.fallback_reason = "validation_failed";
      logger.warn("SYNTHESIS_PROVIDER_FALLBACK — provider route failed, retrying Anthropic path", {
        provider: routeDecision.provider,
        model: routeDecision.model,
        transport: routeDecision.transport,
        original_error: `provider output failed quality gate: ${gate.reason}`,
        original_error_code: "VALIDATION",
        fallback_reason: "validation_failed",
        validation_failure: gate.reason,
        projectSlug,
      });
    } else {
      chain.fallback_used = true;
      chain.fallback_reason = fallbackReasonFromProviderError(providerOutcome);
      logger.warn("SYNTHESIS_PROVIDER_FALLBACK — provider route failed, retrying Anthropic path", {
        provider: routeDecision.provider,
        model: routeDecision.model,
        transport: routeDecision.transport,
        original_error: providerOutcome.error,
        original_error_code: providerOutcome.error_code,
        fallback_reason: chain.fallback_reason,
        projectSlug,
      });
    }
  }

  if (routing && routing.transport === "cc_subprocess") {
    chain.provider = "anthropic";
    chain.model = routing.model;
    chain.transport = "cc_subprocess";
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
    chain.fallback_used = true;
    // First failure wins: when a provider hop already set the reason, the
    // LLM_CALL line keeps reporting why the PRIMARY route was left.
    chain.fallback_reason ??=
      subprocessOutcome.error_code === "TIMEOUT" ? "timeout" : "provider_error";
    logger.warn("SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed, retrying via messages_api", {
      callSite,
      attempted_model: routing.model,
      original_error: subprocessOutcome.error,
      original_error_code: subprocessOutcome.error_code,
      projectSlug,
    });
    // Fall through to messages_api with the default model — the env override
    // is what failed, so we deliberately ignore it on the retry path.
    chain.model = SYNTHESIS_MODEL;
    chain.transport = "messages_api_fallback";
    const fallback = await callMessagesApi({
      systemPrompt,
      userContent,
      maxTokens,
      timeoutMs,
      maxRetries,
      thinking,
      modelOverride: undefined,
      projectSlug,
    });
    if (fallback.success) {
      return { ...fallback, transport: "messages_api_fallback" };
    }
    return fallback;
  }

  // messages_api path — either legacy (no call-site) or call-site that
  // explicitly routes here. Honor the per-call-site model override when
  // provided.
  chain.provider = "anthropic";
  chain.model = routing?.modelOverridden ? routing.model : SYNTHESIS_MODEL;
  chain.transport = "messages_api";
  const direct = await callMessagesApi({
    systemPrompt,
    userContent,
    maxTokens,
    timeoutMs,
    maxRetries,
    thinking,
    modelOverride: routing?.modelOverridden ? routing.model : undefined,
    projectSlug,
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
  /** brief-419: optional project slug tag attached to the success log. */
  projectSlug?: string;
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
    projectSlug,
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
      // Current Opus-tier models (Opus 4.8) and Sonnet 5 support ONLY the
      // adaptive thinking variant; the legacy fixed-budget thinking shape
      // returns HTTP 400. Cast through unknown because the installed SDK's
      // declarations do not yet include adaptive thinking/output_config effort.
      const adaptiveRequest = requestBody as unknown as {
        thinking: { type: "adaptive" };
        output_config: { effort: "max" };
      };
      adaptiveRequest.thinking = { type: "adaptive" };
      adaptiveRequest.output_config = { effort: "max" };
    }

    const response = await anthropic.messages.create(requestBody, requestOptions);

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // brief-456 (SRV-07): output guards — mirror the cc_subprocess path's
    // empty-text / zero-token guards. An HTTP-200 refusal or an empty text
    // body must never flow downstream as a successful synthesis; it would
    // overwrite intelligence-brief.md / pending-doc-updates.md with nothing.
    const stopReason = response.stop_reason;
    if (stopReason === "refusal") {
      logger.warn("Synthesis response refused (stop_reason=refusal) — treating as failure", {
        model,
        projectSlug,
        ms: Date.now() - start,
      });
      return {
        success: false,
        error: "synthesis returned stop_reason=refusal",
        error_code: "API_ERROR",
      };
    }
    if (textContent.trim().length === 0) {
      logger.warn("Synthesis returned empty text content — treating as failure", {
        model,
        projectSlug,
        stop_reason: stopReason ?? "unknown",
        ms: Date.now() - start,
      });
      return {
        success: false,
        error: `synthesis returned empty text content (stop_reason=${stopReason ?? "unknown"})`,
        error_code: "API_ERROR",
      };
    }
    if (stopReason === "max_tokens") {
      // Truncation is visible here but only the caller knows whether the
      // output is still usable (required sections present) — propagate via
      // result.stop_reason and surface a structured warn for operators.
      logger.warn("SYNTHESIS_OUTPUT_TRUNCATED — stop_reason=max_tokens, output may be incomplete", {
        model,
        projectSlug,
        output_tokens: response.usage.output_tokens,
        ms: Date.now() - start,
      });
    }

    const result = {
      success: true as const,
      content: textContent,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model,
      stop_reason: stopReason,
    };

    logger.info("Synthesis API call complete", {
      model,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      thinking_enabled: !!thinking,
      ms: Date.now() - start,
      projectSlug,
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
