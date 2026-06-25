import {
  CC_DISPATCH_MODEL_ID,
  RECOMMENDATION_MODELS,
  SYNTHESIS_MODEL_ID,
} from "../models.js";
import { getProviderRegistry } from "./provider-registry.js";
import type {
  LlmProviderId,
  LlmQualityTier,
  RouteDecision,
  RouteInput,
  RoutingEnv,
} from "./route-types.js";

const SURFACE_PROVIDER_ENV: Record<RouteInput["surface"], string> = {
  recommendation: "LLM_ROUTING_RECOMMENDATION_PROVIDER",
  synthesis_brief: "LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER",
  synthesis_draft: "LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER",
  synthesis_pdu: "LLM_ROUTING_SYNTHESIS_PDU_PROVIDER",
  cc_dispatch: "LLM_ROUTING_CC_DISPATCH_PROVIDER",
};

export function resolveRoute(
  input: RouteInput,
  env: RoutingEnv = process.env,
): RouteDecision {
  if (input.taskClass === "protected-boundary-negative-control") {
    return {
      surface: input.surface,
      taskClass: input.taskClass,
      provider: "none",
      model: "none",
      transport: "blocked",
      authEnvVar: null,
      reasoningSetting: input.reasoningSetting ?? null,
      qualityTier: "blocked",
      liveInvocationAllowed: false,
      reason: "protected-boundary",
      fallbackChain: [],
    };
  }

  if (!routingEnabled(env)) {
    return currentAnthropicFallback(input, "routing-disabled");
  }

  const selectedProvider = requestedProvider(input.surface, env);
  if (!selectedProvider || selectedProvider === "anthropic") {
    return currentAnthropicFallback(
      input,
      dryRunEnabled(env) ? "routing-dry-run" : "activation-not-authorized",
    );
  }

  if (input.surface === "cc_dispatch") {
    return currentAnthropicFallback(input, "activation-not-authorized");
  }

  const provider = getProviderRegistry().find((entry) => entry.id === selectedProvider);
  if (!provider?.supportedSurfaces.includes(input.surface)) {
    return currentAnthropicFallback(input, "activation-not-authorized");
  }

  const liveCandidate = !dryRunEnabled(env);
  let liveInvocationAllowed = liveCandidate;
  let reason: RouteDecision["reason"] = liveCandidate
    ? "live-provider-route"
    : "routing-dry-run";
  if (liveCandidate && !providerAllowed(provider.id, env)) {
    liveInvocationAllowed = false;
    reason = "provider-not-allowed";
  }
  if (liveCandidate && liveInvocationAllowed && !authConfigured(provider.authEnvVar, env)) {
    liveInvocationAllowed = false;
    reason = "provider-auth-missing";
  }

  return {
    surface: input.surface,
    taskClass: input.taskClass,
    provider: provider.id,
    model: providerModel(provider, env),
    transport: provider.transport,
    authEnvVar: provider.authEnvVar,
    reasoningSetting: input.reasoningSetting ?? null,
    qualityTier: qualityTierFor(input.surface, provider.id),
    liveInvocationAllowed,
    reason,
    fallbackChain: [provider.id, "anthropic"],
  };
}

function routingEnabled(env: RoutingEnv): boolean {
  return normalizeFlag(env.LLM_ROUTING_ENABLED) === "true";
}

function dryRunEnabled(env: RoutingEnv): boolean {
  return normalizeFlag(env.LLM_ROUTING_DRY_RUN) !== "false";
}

function normalizeFlag(value: string | undefined): "true" | "false" | "other" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return "true";
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return "false";
  }
  return "other";
}

function requestedProvider(
  surface: RouteInput["surface"],
  env: RoutingEnv,
): LlmProviderId | null {
  const requested = env[SURFACE_PROVIDER_ENV[surface]] ?? env.LLM_ROUTING_DEFAULT_PROVIDER;
  if (!requested) return null;
  const normalized = requested.trim().toLowerCase();
  const provider = getProviderRegistry().find((entry) => entry.id === normalized);
  return provider?.id ?? null;
}

function providerAllowed(provider: LlmProviderId, env: RoutingEnv): boolean {
  const raw = env.LLM_ROUTING_ALLOWED_PROVIDERS;
  if (!raw || raw.trim().length === 0) return false;
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes(provider);
}

function authConfigured(authEnvVar: string, env: RoutingEnv): boolean {
  return !!env[authEnvVar]?.trim();
}

function providerModel(
  provider: ReturnType<typeof getProviderRegistry>[number],
  env: RoutingEnv,
): string {
  const override = env[provider.modelEnvVar]?.trim();
  return override || provider.defaultModel;
}

function currentAnthropicFallback(
  input: RouteInput,
  reason: RouteDecision["reason"],
): RouteDecision {
  const base = {
    surface: input.surface,
    taskClass: input.taskClass,
    provider: "anthropic" as const,
    reasoningSetting: input.reasoningSetting ?? null,
    liveInvocationAllowed: false as const,
    reason,
    fallbackChain: ["anthropic" as const],
  };

  switch (input.surface) {
    case "recommendation":
      return {
        ...base,
        model: input.currentModel ?? recommendationModelFor(input.taskClass),
        transport: input.currentTransport ?? "advisory_env_override",
        authEnvVar: input.currentAuthEnvVar ?? null,
        qualityTier: "frontier",
      };
    case "synthesis_pdu":
      return {
        ...base,
        model: input.currentModel ?? SYNTHESIS_MODEL_ID,
        transport: input.currentTransport ?? "existing",
        authEnvVar: input.currentAuthEnvVar ?? "ANTHROPIC_API_KEY",
        qualityTier: "frontier-long-context",
      };
    case "cc_dispatch":
      return {
        ...base,
        model: input.currentModel ?? CC_DISPATCH_MODEL_ID,
        transport: input.currentTransport ?? "claude_code_oauth",
        authEnvVar: input.currentAuthEnvVar ?? "CLAUDE_CODE_OAUTH_TOKEN",
        qualityTier: "frontier-code",
      };
    case "synthesis_brief":
    case "synthesis_draft":
      return {
        ...base,
        model: input.currentModel ?? SYNTHESIS_MODEL_ID,
        transport: input.currentTransport ?? "messages_api",
        authEnvVar: input.currentAuthEnvVar ?? "ANTHROPIC_API_KEY",
        qualityTier: "frontier",
      };
  }
}

function recommendationModelFor(taskClass: string): string {
  if (taskClass.includes("executional")) {
    return RECOMMENDATION_MODELS.executional.id;
  }
  if (taskClass.includes("mixed")) {
    return RECOMMENDATION_MODELS.mixed.id;
  }
  return RECOMMENDATION_MODELS.reasoning_heavy.id;
}

function qualityTierFor(
  surface: RouteInput["surface"],
  provider: LlmProviderId,
): LlmQualityTier {
  if (provider === "perplexity") return "research-citation";
  if (surface === "cc_dispatch") return "frontier-code";
  if (surface === "synthesis_pdu") return "frontier-long-context";
  return "frontier";
}
