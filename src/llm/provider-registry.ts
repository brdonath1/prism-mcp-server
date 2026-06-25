import type { ProviderMetadata } from "./route-types.js";

const PROVIDER_REGISTRY: readonly ProviderMetadata[] = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    authEnvVar: "ANTHROPIC_API_KEY",
    supportedSurfaces: [
      "recommendation",
      "synthesis_brief",
      "synthesis_draft",
      "synthesis_pdu",
    ],
    activationStatus: "active_when_present",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    authEnvVar: "OPENAI_API_KEY",
    supportedSurfaces: ["recommendation", "synthesis_brief", "synthesis_draft"],
    activationStatus: "readiness_only",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "gemini",
    displayName: "Gemini",
    authEnvVar: "GEMINI_API_KEY",
    supportedSurfaces: ["recommendation", "synthesis_brief", "synthesis_draft"],
    activationStatus: "readiness_only",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    authEnvVar: "DEEPSEEK_API_KEY",
    supportedSurfaces: ["recommendation", "synthesis_draft"],
    activationStatus: "blocked_readiness_only",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "xai",
    displayName: "xAI",
    authEnvVar: "XAI_API_KEY",
    supportedSurfaces: ["recommendation"],
    activationStatus: "x_search_only_inactive_general_routing",
    qualityPolicy: "quality-before-cost",
  },
  {
    id: "perplexity",
    displayName: "Perplexity",
    authEnvVar: "PERPLEXITY_API_KEY",
    supportedSurfaces: ["recommendation", "synthesis_brief", "synthesis_draft"],
    activationStatus: "readiness_only",
    qualityPolicy: "quality-before-cost",
  },
];

export function getProviderRegistry(): ProviderMetadata[] {
  return PROVIDER_REGISTRY.map((provider) => ({
    ...provider,
    supportedSurfaces: [...provider.supportedSurfaces],
  }));
}
