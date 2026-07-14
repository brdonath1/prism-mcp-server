import { MCP_SAFE_TIMEOUT, SYNTHESIS_MAX_OUTPUT_TOKENS } from "../config.js";
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  openrouterAttributionHeaders,
  resolveOpenrouterReasoningParam,
} from "./openrouter.js";
import { getProviderRegistry } from "./provider-registry.js";
import type { LlmProviderId, LlmTransport, RouteDecision, RoutingEnv } from "./route-types.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderSynthesisParams {
  decision: RouteDecision;
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  timeoutMs?: number;
  env?: RoutingEnv;
  fetchImpl?: FetchLike;
}

export interface ProviderSynthesisResult {
  success: true;
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
  transport: Extract<
    LlmTransport,
    "openai_responses" | "openai_compatible_chat" | "gemini_generate_content" | "xai_responses"
  >;
  stop_reason?: string | null;
  /** D-275 telemetry: provider-measured cost in USD when the provider returns
   *  one (OpenRouter `usage.cost` with `usage: { include: true }`). Absent →
   *  LLM_CALL falls back to the static price-table estimate. */
  cost_usd?: number | null;
}

export interface ProviderSynthesisError {
  success: false;
  error: string;
  error_code: "TIMEOUT" | "AUTH" | "API_ERROR" | "DISABLED";
  /** D-275 telemetry: coarse failure class for the LLM_CALL / fallback logs.
   *  "validation" = the provider answered but the output failed a completion
   *  guard (finish_reason≠stop, empty content) — the GLM thinking-starvation
   *  signature; "timeout" = abort; "http" = transport/HTTP/config failures. */
  failure_class?: "validation" | "timeout" | "http";
}

export type ProviderSynthesisOutcome = ProviderSynthesisResult | ProviderSynthesisError;

export function isLiveProviderSynthesisDecision(
  decision: RouteDecision,
): decision is RouteDecision & { provider: LlmProviderId; liveInvocationAllowed: true } {
  return (
    decision.liveInvocationAllowed &&
    decision.provider !== "anthropic" &&
    decision.provider !== "none" &&
    decision.surface !== "recommendation" &&
    decision.surface !== "cc_dispatch" &&
    isProviderTransport(decision.transport)
  );
}

export async function synthesizeViaProvider({
  decision,
  systemPrompt,
  userContent,
  maxTokens,
  timeoutMs,
  env = process.env,
  fetchImpl = globalThis.fetch,
}: ProviderSynthesisParams): Promise<ProviderSynthesisOutcome> {
  if (decision.provider === "anthropic" || decision.provider === "none") {
    return { success: false, error: "provider adapter is not selected", error_code: "DISABLED" };
  }
  if (!isProviderTransport(decision.transport)) {
    return {
      success: false,
      error: `${decision.transport} is not a provider adapter transport`,
      error_code: "DISABLED",
    };
  }

  const authEnvVar = decision.authEnvVar;
  const apiKey = authEnvVar ? env[authEnvVar]?.trim() : "";
  if (!authEnvVar || !apiKey) {
    return {
      success: false,
      error: `${authEnvVar ?? "provider auth env var"} not configured`,
      error_code: "DISABLED",
    };
  }

  const generationLimit = maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS;
  try {
    switch (decision.transport) {
      case "openai_responses":
      case "xai_responses":
        return await callResponsesApi({
          decision,
          apiKey,
          systemPrompt,
          userContent,
          maxTokens: generationLimit,
          timeoutMs: timeoutMs ?? MCP_SAFE_TIMEOUT,
          env,
          fetchImpl,
        });
      case "openai_compatible_chat":
        return await callOpenAiCompatibleChat({
          decision,
          apiKey,
          systemPrompt,
          userContent,
          maxTokens: generationLimit,
          timeoutMs: timeoutMs ?? MCP_SAFE_TIMEOUT,
          env,
          fetchImpl,
        });
      case "gemini_generate_content":
        return await callGeminiGenerateContent({
          decision,
          apiKey,
          systemPrompt,
          userContent,
          maxTokens: generationLimit,
          timeoutMs: timeoutMs ?? MCP_SAFE_TIMEOUT,
          env,
          fetchImpl,
        });
    }
    return {
      success: false,
      error: `${decision.transport} is not a supported provider transport`,
      error_code: "DISABLED",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeProviderError(message, env);
    const error_code = classifyProviderException(error);
    return {
      success: false,
      error: sanitized,
      error_code,
      failure_class: error_code === "TIMEOUT" ? "timeout" : "http",
    };
  }
}

interface ProviderCallParams {
  decision: RouteDecision;
  apiKey: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  timeoutMs: number;
  env: RoutingEnv;
  fetchImpl: FetchLike;
}

async function callResponsesApi(params: ProviderCallParams): Promise<ProviderSynthesisOutcome> {
  const response = await fetchJson(
    responsesUrl(params.decision.provider),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: params.decision.model,
        input: [
          { role: "developer", content: params.systemPrompt },
          { role: "user", content: params.userContent },
        ],
        max_output_tokens: params.maxTokens,
        store: false,
      }),
    },
    params.timeoutMs,
    params.fetchImpl,
  );

  const payload = await parseProviderPayload(response, params.env);
  if (!response.ok) return providerHttpError(response.status, payload, params.env);

  const incomplete = responsesIncompleteReason(payload);
  if (incomplete) return providerCompletionError(`provider response incomplete (${incomplete})`);

  const content = extractResponsesText(payload).trim();
  if (!content) return emptyProviderResponse(params.decision.model);

  const usage = recordValue(payload, "usage");
  return {
    success: true,
    content,
    input_tokens: numericValue(usage, "input_tokens") ?? 0,
    output_tokens: numericValue(usage, "output_tokens") ?? 0,
    model: params.decision.model,
    transport: params.decision.transport as ProviderSynthesisResult["transport"],
    stop_reason: stringValue(payload, "status") ?? null,
  };
}

async function callOpenAiCompatibleChat(
  params: ProviderCallParams,
): Promise<ProviderSynthesisOutcome> {
  const isOpenrouter = params.decision.provider === "openrouter";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
    // OpenRouter attribution headers (design §4.1) — app identity only.
    ...(isOpenrouter ? openrouterAttributionHeaders(params.env) : {}),
  };

  const body: Record<string, unknown> = {
    model: params.decision.model,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userContent },
    ],
    max_tokens: params.maxTokens,
    stream: false,
  };
  if (isOpenrouter) {
    // D-275 openrouter-only request extensions (design §4.1/§4.2):
    // - usage.include → provider-computed cost lands in usage.cost, giving the
    //   LLM_CALL telemetry a MEASURED est_cost_usd instead of an estimate.
    // - provider.data_collection=deny → request-level data-governance backstop
    //   on top of the operator's account-level training toggles (§7 risk 1).
    // - reasoning → GLM-5.2 defaults to thinking mode, and reasoning tokens
    //   consume max_tokens (live-verified: finish_reason=length with zero
    //   answer text). Off by default; per-site opt-in via
    //   LLM_ROUTING_OPENROUTER_REASONING_* with the 16384-floor guard. The
    //   caller's Anthropic `thinking` flag is deliberately ignored here.
    body.usage = { include: true };
    body.provider = { data_collection: "deny" };
    body.reasoning = resolveOpenrouterReasoningParam(
      params.decision.surface,
      params.maxTokens,
      params.env,
    );
  }

  const response = await fetchJson(
    openAiCompatibleChatUrl(params.decision.provider),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    params.timeoutMs,
    params.fetchImpl,
  );

  const payload = await parseProviderPayload(response, params.env);
  if (!response.ok) return providerHttpError(response.status, payload, params.env);

  const choice = firstRecord(payload, "choices");
  const finishReason = stringValue(choice, "finish_reason");
  if (finishReason && finishReason !== "stop") {
    return providerCompletionError(`provider response did not stop cleanly (${finishReason})`);
  }
  const message = recordValue(choice, "message");
  const content = stringValue(message, "content")?.trim() ?? "";
  if (!content) return emptyProviderResponse(params.decision.model);

  const usage = recordValue(payload, "usage");
  return {
    success: true,
    content,
    input_tokens: numericValue(usage, "prompt_tokens") ?? 0,
    output_tokens: numericValue(usage, "completion_tokens") ?? 0,
    model: params.decision.model,
    transport: params.decision.transport as ProviderSynthesisResult["transport"],
    stop_reason: finishReason ?? null,
    // OpenRouter returns a measured USD cost when usage.include is set.
    cost_usd: numericValue(usage, "cost"),
  };
}

async function callGeminiGenerateContent(
  params: ProviderCallParams,
): Promise<ProviderSynthesisOutcome> {
  const response = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.decision.model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": params.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: params.userContent }] }],
        generationConfig: { maxOutputTokens: params.maxTokens },
      }),
    },
    params.timeoutMs,
    params.fetchImpl,
  );

  const payload = await parseProviderPayload(response, params.env);
  if (!response.ok) return providerHttpError(response.status, payload, params.env);

  const candidate = firstRecord(payload, "candidates");
  const finishReason = stringValue(candidate, "finishReason");
  if (finishReason && finishReason !== "STOP") {
    return providerCompletionError(`provider response did not stop cleanly (${finishReason})`);
  }
  const contentRecord = recordValue(candidate, "content");
  const parts = arrayValue(contentRecord, "parts");
  const content = parts
    .map((part) => (isRecord(part) ? stringValue(part, "text") : null))
    .filter((part): part is string => !!part)
    .join("\n")
    .trim();
  if (!content) return emptyProviderResponse(params.decision.model);

  const usage = recordValue(payload, "usageMetadata");
  return {
    success: true,
    content,
    input_tokens: numericValue(usage, "promptTokenCount") ?? 0,
    output_tokens: numericValue(usage, "candidatesTokenCount") ?? 0,
    model: params.decision.model,
    transport: "gemini_generate_content",
    stop_reason: finishReason ?? null,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseProviderPayload(response: Response, env: RoutingEnv): Promise<unknown> {
  const body = await response.text();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { error: sanitizeProviderError(body.slice(0, 500), env) };
  }
}

function providerHttpError(
  status: number,
  _payload: unknown,
  _env: RoutingEnv,
): ProviderSynthesisError {
  return {
    success: false,
    error: `provider HTTP ${status}`,
    error_code: status === 401 || status === 403 ? "AUTH" : "API_ERROR",
    failure_class: "http",
  };
}

function emptyProviderResponse(model: string): ProviderSynthesisError {
  return {
    success: false,
    error: `${model} returned empty text content`,
    error_code: "API_ERROR",
    failure_class: "validation",
  };
}

function providerCompletionError(message: string): ProviderSynthesisError {
  return {
    success: false,
    error: message,
    error_code: "API_ERROR",
    failure_class: "validation",
  };
}

function responsesUrl(provider: RouteDecision["provider"]): string {
  if (provider === "xai") return "https://api.x.ai/v1/responses";
  return "https://api.openai.com/v1/responses";
}

function openAiCompatibleChatUrl(provider: RouteDecision["provider"]): string {
  if (provider === "deepseek") return "https://api.deepseek.com/chat/completions";
  if (provider === "perplexity") return "https://api.perplexity.ai/chat/completions";
  if (provider === "openrouter") return OPENROUTER_CHAT_COMPLETIONS_URL;
  return "https://api.openai.com/v1/chat/completions";
}

function isProviderTransport(
  transport: LlmTransport,
): transport is ProviderSynthesisResult["transport"] {
  return (
    transport === "openai_responses" ||
    transport === "openai_compatible_chat" ||
    transport === "gemini_generate_content" ||
    transport === "xai_responses"
  );
}

function extractResponsesText(payload: unknown): string {
  const direct = stringValue(payload, "output_text");
  if (direct) return direct;
  return arrayValue(payload, "output")
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const content = arrayValue(entry, "content");
      return content
        .map((part) => {
          if (!isRecord(part)) return null;
          return stringValue(part, "text") ?? stringValue(part, "content");
        })
        .filter((part): part is string => !!part);
    })
    .join("\n");
}

function responsesIncompleteReason(payload: unknown): string | null {
  const status = stringValue(payload, "status");
  if (!status || status === "completed") return null;
  const details = recordValue(payload, "incomplete_details");
  const reason = stringValue(details, "reason");
  return reason ? `status=${status}, reason=${reason}` : `status=${status}`;
}

function sanitizeProviderError(message: string, env: RoutingEnv): string {
  let sanitized = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***REDACTED***")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***REDACTED***");
  for (const provider of getProviderRegistry()) {
    const value = env[provider.authEnvVar]?.trim();
    if (value) {
      sanitized = sanitized.split(value).join("***REDACTED***");
    }
  }
  return sanitized;
}

function classifyProviderException(error: unknown): ProviderSynthesisError["error_code"] {
  const message = error instanceof Error ? error.message : String(error);
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  const lower = message.toLowerCase();
  if (name === "AbortError" || lower.includes("abort") || lower.includes("timeout")) {
    return "TIMEOUT";
  }
  if (message.includes("401") || lower.includes("auth")) {
    return "AUTH";
  }
  return "API_ERROR";
}

function firstRecord(value: unknown, key: string): Record<string, unknown> {
  const first = arrayValue(value, key)[0];
  return isRecord(first) ? first : {};
}

function recordValue(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const child = value[key];
  return isRecord(child) ? child : {};
}

function arrayValue(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function stringValue(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return typeof child === "string" ? child : null;
}

function numericValue(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
