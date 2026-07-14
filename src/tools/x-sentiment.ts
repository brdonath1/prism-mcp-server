/**
 * prism_x_sentiment — aggregate public X sentiment via xAI x_search.
 *
 * The tool returns source-backed aggregate labels only. It does not return raw
 * post text, handles, provider payloads, or credential material.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SAFE_TIMEOUT } from "../config.js";
import { emitLlmCall } from "../llm/llm-call-telemetry.js";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const DEFAULT_MODEL = "grok-4.3";
const SENTIMENT_LABELS = [
  "positive",
  "neutral",
  "negative",
  "mixed",
  "insufficient-evidence",
] as const;
const CONFIDENCE_LABELS = ["low", "medium", "high"] as const;
const CAVEAT_LABELS = [
  "source-limited",
  "sample-limited",
  "time-window-limited",
  "not-demographically-representative",
] as const;

type SentimentLabel = (typeof SENTIMENT_LABELS)[number];
type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];
type CaveatLabel = (typeof CAVEAT_LABELS)[number];
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface XStatusSource {
  url: string;
  source_type: "x_status";
}

export interface XSentimentOk {
  status: "ok";
  provider: "xai";
  model: string;
  tool: "x_search";
  sentiment: SentimentLabel;
  confidence: ConfidenceLabel;
  summary: string;
  caveats: CaveatLabel[];
  sources: XStatusSource[];
  warnings: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface XSentimentUnavailable {
  status: "unavailable" | "error";
  provider: "xai";
  model: string;
  tool: "x_search";
  warning: string;
  error?: string;
}

export type XSentimentResult = XSentimentOk | XSentimentUnavailable;

interface AnalyzeOptions {
  topic: string;
  fromDate?: string;
  toDate?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface RegisterOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export async function analyzeXSentiment({
  topic,
  fromDate,
  toDate,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = MCP_SAFE_TIMEOUT,
}: AnalyzeOptions): Promise<XSentimentResult> {
  const apiKey = env.XAI_API_KEY?.trim();
  const model = env.LLM_ROUTING_XAI_MODEL?.trim() || DEFAULT_MODEL;
  const authorization = xSentimentAuthorization(env);
  if (!authorization.ok) {
    return {
      status: "unavailable",
      provider: "xai",
      model,
      tool: "x_search",
      warning: "live-invocation-disabled",
      error: authorization.error,
    };
  }
  if (!apiKey) {
    return {
      status: "unavailable",
      provider: "xai",
      model,
      tool: "x_search",
      warning: "live-invocation-disabled",
      error: "XAI_API_KEY is not configured",
    };
  }

  if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) {
    return {
      status: "error",
      provider: "xai",
      model,
      tool: "x_search",
      warning: "invalid-date",
      error: "from_date and to_date must use YYYY-MM-DD when provided",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // D-275 §4.8 (brief-s196c): CS-4 leg of the per-invocation LLM_CALL
  // telemetry — emitted for every attempted xAI call (never for the gated
  // unavailable paths above, where no invocation happens). Aggregate counts
  // and latency only; no payload content.
  const invocationStart = Date.now();
  const emitXSentimentCall = (
    success: boolean,
    usage?: { input_tokens: number; output_tokens: number },
  ): void => {
    emitLlmCall({
      call_site: "x_sentiment",
      provider: "xai",
      model,
      transport: "xai_responses",
      success,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      token_source: "usage",
      measured_cost_usd: null,
      latency_ms: Date.now() - invocationStart,
      fallback_used: false,
      fallback_reason: null,
    });
  };
  try {
    const tool: Record<string, string> = { type: "x_search" };
    if (fromDate) tool.from_date = fromDate;
    if (toDate) tool.to_date = toDate;

    const response = await fetchImpl(XAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [
              "Return aggregate public X sentiment only.",
              "Do not quote posts, include handles, profile individuals, or recommend engagement.",
              "Return compact JSON with sentiment, confidence, summary, and caveats.",
              `Allowed sentiments: ${SENTIMENT_LABELS.join(", ")}.`,
              `Allowed caveats: ${CAVEAT_LABELS.join(", ")}.`,
            ].join(" "),
          },
          {
            role: "user",
            content: `Assess public X sentiment about: ${topic}`,
          },
        ],
        tools: [tool],
        max_output_tokens: 1200,
        store: false,
      }),
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      emitXSentimentCall(false);
      return providerError(model, `xAI HTTP ${response.status}`);
    }

    const text = extractResponsesText(payload);
    const parsed = parseSentimentJson(text);
    const extraction = extractXSearchSources(payload);
    const warnings = extraction.warnings;
    if (extraction.sources.length === 0) {
      warnings.push("non-audit-grade-no-sources");
    }

    const sentiment = pickEnum(parsed.sentiment, SENTIMENT_LABELS, "insufficient-evidence")
      ?? "insufficient-evidence";
    const confidence = pickEnum(parsed.confidence, CONFIDENCE_LABELS, "low") ?? "low";
    const caveats = asStringArray(parsed.caveats)
      .map((value) => pickEnum(value, CAVEAT_LABELS, null))
      .filter((value): value is CaveatLabel => value !== null);

    emitXSentimentCall(true, {
      input_tokens: numericPath(payload, ["usage", "input_tokens"]) ?? 0,
      output_tokens: numericPath(payload, ["usage", "output_tokens"]) ?? 0,
    });

    return {
      status: "ok",
      provider: "xai",
      model,
      tool: "x_search",
      sentiment: extraction.sources.length === 0 ? "insufficient-evidence" : sentiment,
      confidence,
      summary: makeAggregateSummary({
        sentiment: extraction.sources.length === 0 ? "insufficient-evidence" : sentiment,
        confidence,
        sourceCount: extraction.sources.length,
        caveats: unique(caveats.length > 0 ? caveats : ["source-limited"]),
      }),
      caveats: unique(caveats.length > 0 ? caveats : ["source-limited"]),
      sources: extraction.sources,
      warnings: unique(warnings),
      usage: {
        input_tokens: numericPath(payload, ["usage", "input_tokens"]) ?? 0,
        output_tokens: numericPath(payload, ["usage", "output_tokens"]) ?? 0,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitXSentimentCall(false);
    return providerError(model, message.includes("abort") ? "xAI request timed out" : "xAI provider request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export function extractXSearchSources(payload: unknown): {
  sources: XStatusSource[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (Array.isArray((payload as { citations?: unknown })?.citations)
    && ((payload as { citations?: unknown[] }).citations?.length ?? 0) > 0) {
    warnings.push("top-level-citations-ignored");
  }

  const sources: XStatusSource[] = [];
  const seen = new Set<string>();
  for (const annotation of collectAnnotations(payload)) {
    if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
    const validation = validateXStatusUrl(annotation.url);
    if (!validation.ok) {
      warnings.push(validation.warning);
      continue;
    }
    if (seen.has(validation.url)) {
      warnings.push("duplicate-source-url");
      continue;
    }
    seen.add(validation.url);
    sources.push({ url: validation.url, source_type: "x_status" });
  }
  return { sources, warnings: unique(warnings) };
}

export function registerXSentiment(server: McpServer, options: RegisterOptions = {}): void {
  server.tool(
    "prism_x_sentiment",
    "Analyze aggregate public X sentiment for a topic using xAI x_search. Returns handle-free source URLs and aggregate labels only; never raw post text.",
    {
      topic: z.string().min(1).max(200).describe("Topic, product, repo, or public phenomenon to analyze"),
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional YYYY-MM-DD start date"),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional YYYY-MM-DD end date"),
    },
    async ({ topic, from_date, to_date }) => {
      const result = await analyzeXSentiment({
        topic,
        fromDate: from_date,
        toDate: to_date,
        env: options.env ?? process.env,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: result.status !== "ok",
      };
    },
  );
}

function parseSentimentJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function extractResponsesText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const output of Array.isArray(payload.output) ? payload.output : []) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (!isRecord(content)) continue;
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

function collectAnnotations(payload: unknown): unknown[] {
  const annotations: unknown[] = [];
  if (!isRecord(payload)) return annotations;
  for (const output of Array.isArray(payload.output) ? payload.output : []) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
      annotations.push(...content.annotations);
    }
  }
  return annotations;
}

function validateXStatusUrl(value: unknown):
  | { ok: true; url: string }
  | { ok: false; warning: string } {
  if (typeof value !== "string") return { ok: false, warning: "non-string-url" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, warning: "invalid-url" };
  }
  if (url.protocol !== "https:") return { ok: false, warning: "non-https-url" };
  if (!["x.com", "twitter.com"].includes(url.hostname.toLowerCase())) {
    return { ok: false, warning: "unsupported-host" };
  }
  if (url.search || url.hash) return { ok: false, warning: "query-or-fragment-not-allowed" };
  const parts = url.pathname.split("/").filter(Boolean);
  const statusId = parts.at(-1);
  if (!statusId || !/^\d+$/.test(statusId)) {
    return { ok: false, warning: "unsupported-x-url" };
  }
  if (parts.length === 3 && parts[0] === "i" && parts[1] === "status") {
    return { ok: true, url: `https://x.com/i/status/${statusId}` };
  }
  if (parts.length === 3 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && parts[1] === "status") {
    return { ok: true, url: `https://x.com/i/status/${statusId}` };
  }
  return { ok: false, warning: "unsupported-x-url" };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function providerError(model: string, message: string): XSentimentUnavailable {
  return {
    status: "error",
    provider: "xai",
    model,
    tool: "x_search",
    warning: "provider-error",
    error: sanitizeProviderMessage(message),
  };
}

function makeAggregateSummary({
  sentiment,
  confidence,
  sourceCount,
  caveats,
}: {
  sentiment: SentimentLabel;
  confidence: ConfidenceLabel;
  sourceCount: number;
  caveats: CaveatLabel[];
}): string {
  const sourcePhrase = sourceCount === 1 ? "1 accepted source annotation" : `${sourceCount} accepted source annotations`;
  const caveatPhrase = caveats.length > 0 ? ` Caveats: ${caveats.join(", ")}.` : "";
  return `Aggregate public X sentiment is ${sentiment} with ${confidence} confidence from ${sourcePhrase}.${caveatPhrase}`;
}

function sanitizeProviderMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***REDACTED***")
    .replace(/xai-[A-Za-z0-9_-]+/gi, "xai-***REDACTED***");
}

function xSentimentAuthorization(env: Record<string, string | undefined>):
  | { ok: true }
  | { ok: false; error: string } {
  if (!flagTrue(env.LLM_ROUTING_X_SENTIMENT_ENABLED)) {
    return { ok: false, error: "LLM_ROUTING_X_SENTIMENT_ENABLED is not true" };
  }
  if (!flagTrue(env.LLM_ROUTING_ENABLED)) {
    return { ok: false, error: "LLM_ROUTING_ENABLED is not true" };
  }
  if (!flagFalse(env.LLM_ROUTING_DRY_RUN)) {
    return { ok: false, error: "LLM_ROUTING_DRY_RUN is not false" };
  }
  if (!allowedProvider("xai", env.LLM_ROUTING_ALLOWED_PROVIDERS)) {
    return { ok: false, error: "xai is not listed in LLM_ROUTING_ALLOWED_PROVIDERS" };
  }
  return { ok: true };
}

function flagTrue(value: string | undefined): boolean {
  return ["true", "1", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function flagFalse(value: string | undefined): boolean {
  return ["false", "0", "no"].includes(value?.trim().toLowerCase() ?? "");
}

function allowedProvider(provider: string, raw: string | undefined): boolean {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes(provider);
}

function isValidIsoDate(value: string | undefined): boolean {
  return value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function pickEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number] | null,
): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T[number]
    : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numericPath(value: unknown, path: string[]): number | null {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
