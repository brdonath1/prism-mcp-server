import { getProviderRegistry } from "./provider-registry.js";
import type { LlmProviderId, RoutingEnv } from "./route-types.js";
import { resolveRoute } from "./routing-policy.js";

const PROVIDER_OVERRIDE_ENV_VARS = [
  "LLM_ROUTING_DEFAULT_PROVIDER",
  "LLM_ROUTING_RECOMMENDATION_PROVIDER",
  "LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER",
  "LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER",
  "LLM_ROUTING_SYNTHESIS_PDU_PROVIDER",
  "LLM_ROUTING_CC_DISPATCH_PROVIDER",
] as const;

const CANDIDATE_ROUTING_ENV_VARS = [
  "LLM_ROUTING_PROFILE",
  "LLM_ROUTING_ENABLED",
  "LLM_ROUTING_DRY_RUN",
  "LLM_ROUTING_ALLOWED_PROVIDERS",
  ...PROVIDER_OVERRIDE_ENV_VARS,
  "LLM_ROUTING_OPENAI_MODEL",
  "LLM_ROUTING_GEMINI_MODEL",
  "LLM_ROUTING_DEEPSEEK_MODEL",
  "LLM_ROUTING_XAI_MODEL",
  "LLM_ROUTING_PERPLEXITY_MODEL",
] as const;

export interface RouteReadinessStatus {
  status: "disabled" | "dry_run" | "live" | "activation_blocked";
  liveInvocationAllowed: boolean;
  profile: string | null;
  allowedProviders: LlmProviderId[];
  configuredProviderOverrides: string[];
  providerEnvVars: string[];
  candidateRoutingEnvVars: string[];
}

export function buildRouteReadinessStatus(
  env: RoutingEnv = process.env,
): RouteReadinessStatus {
  const registry = getProviderRegistry();
  const providerIds = new Set(registry.map((provider) => provider.id));
  const enabled = truthy(env.LLM_ROUTING_ENABLED);
  const dryRun = !falsey(env.LLM_ROUTING_DRY_RUN);
  const liveInvocationAllowed = enabled && !dryRun && hasLiveSynthesisRoute(env);

  return {
    status: !enabled
      ? "disabled"
      : dryRun
        ? "dry_run"
        : liveInvocationAllowed
          ? "live"
          : "activation_blocked",
    liveInvocationAllowed,
    profile: safeLabel(env.LLM_ROUTING_PROFILE),
    allowedProviders: parseAllowedProviders(env.LLM_ROUTING_ALLOWED_PROVIDERS, providerIds),
    configuredProviderOverrides: PROVIDER_OVERRIDE_ENV_VARS.filter((key) => {
      const value = env[key];
      return value !== undefined && value.trim().length > 0;
    }),
    providerEnvVars: registry.map((provider) => provider.authEnvVar),
    candidateRoutingEnvVars: [...CANDIDATE_ROUTING_ENV_VARS],
  };
}

function hasLiveSynthesisRoute(env: RoutingEnv): boolean {
  return [
    { surface: "synthesis_brief" as const, taskClass: "status-synthesis-brief" },
    { surface: "synthesis_draft" as const, taskClass: "status-synthesis-draft" },
    { surface: "synthesis_pdu" as const, taskClass: "status-synthesis-pdu" },
  ].some((input) => resolveRoute(input, env).liveInvocationAllowed);
}

function parseAllowedProviders(
  raw: string | undefined,
  providerIds: Set<string>,
): LlmProviderId[] {
  if (!raw) return [];
  const seen = new Set<LlmProviderId>();
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (providerIds.has(id)) seen.add(id as LlmProviderId);
  }
  return [...seen];
}

function safeLabel(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[a-z0-9._-]{1,64}$/i.test(value)) return null;
  return value;
}

function truthy(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function falsey(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "false" || value === "0" || value === "no";
}
