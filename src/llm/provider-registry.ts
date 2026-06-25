import type { ProviderMetadata } from "./route-types.js";

const ROUTABLE_SYNTHESIS_SURFACES = [
  "recommendation",
  "synthesis_brief",
  "synthesis_draft",
  "synthesis_pdu",
] as const;

const PROVIDER_REGISTRY: readonly ProviderMetadata[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    authEnvVar: "ANTHROPIC_API_KEY",
    modelEnvVar: "SYNTHESIS_MODEL",
    defaultModel: "claude-opus-4-8",
    transport: "messages_api",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_present",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    authEnvVar: "OPENAI_API_KEY",
    modelEnvVar: "LLM_ROUTING_OPENAI_MODEL",
    defaultModel: "gpt-5.5",
    transport: "openai_responses",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_configured",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "gemini",
    displayName: "Gemini",
    authEnvVar: "GEMINI_API_KEY",
    modelEnvVar: "LLM_ROUTING_GEMINI_MODEL",
    defaultModel: "gemini-3.1-pro-preview",
    transport: "gemini_generate_content",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_configured",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    authEnvVar: "DEEPSEEK_API_KEY",
    modelEnvVar: "LLM_ROUTING_DEEPSEEK_MODEL",
    defaultModel: "deepseek-v4-pro",
    transport: "openai_compatible_chat",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_configured",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "xai",
    displayName: "xAI",
    authEnvVar: "XAI_API_KEY",
    modelEnvVar: "LLM_ROUTING_XAI_MODEL",
    defaultModel: "grok-4.3",
    transport: "xai_responses",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_configured",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    authEnvVar: "PERPLEXITY_API_KEY",
    modelEnvVar: "LLM_ROUTING_PERPLEXITY_MODEL",
    defaultModel: "sonar-pro",
    transport: "openai_compatible_chat",
    supportedSurfaces: [...ROUTABLE_SYNTHESIS_SURFACES],
    activationStatus: "active_when_configured",
    qualityPolicy: "quality-before-cost",
  },
];

export function getProviderRegistry(): ProviderMetadata[] {
  return PROVIDER_REGISTRY.map((provider) => ({
    ...provider,
    supportedSurfaces: [...provider.supportedSurfaces],
  }));
}
