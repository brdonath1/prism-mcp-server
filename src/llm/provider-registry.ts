import type { ProviderMetadata } from "./route-types.js";
import { SYNTHESIS_MODEL_ID } from "../models.js";

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
    // D-254 single switch (F-B7 / R-DOCS-MS): the Anthropic row's default IS
    // the registry's synthesis pin — a literal here drifts silently on the
    // next model bump, which is exactly what the model-bump pin audit caught.
    defaultModel: SYNTHESIS_MODEL_ID,
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
    // S208 Cerebras registration. The operator's Cerebras account serves
    // exactly three models (verified live against
    // https://api.cerebras.ai/v1/models, 2026-08-16): gemma-4-31b,
    // gpt-oss-120b, zai-glm-4.7.
    //
    // Default pin rationale: the estate's synthesis lanes already run
    // GLM-class models via OpenRouter per D-275, so zai-glm-4.7 is the
    // continuity choice AND Cerebras serves it natively at high throughput.
    // gpt-oss-120b and gemma-4-31b are the account's alternates, reachable
    // via LLM_ROUTING_CEREBRAS_MODEL without a code change.
    //
    // Registered but INERT: like every active_when_configured row, a live
    // cerebras route additionally requires LLM_ROUTING_ENABLED=true,
    // LLM_ROUTING_DRY_RUN=false, a surface provider override naming
    // cerebras, cerebras present in LLM_ROUTING_ALLOWED_PROVIDERS, and
    // CEREBRAS_API_KEY. Nothing routes here until an operator env action.
    id: "cerebras",
    displayName: "Cerebras",
    authEnvVar: "CEREBRAS_API_KEY",
    modelEnvVar: "LLM_ROUTING_CEREBRAS_MODEL",
    defaultModel: "zai-glm-4.7",
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
  {
    // D-275 mechanical tier (brief-s196c): GLM-5.2 via OpenRouter's
    // OpenAI-compatible chat endpoint. Serves ONLY the three mechanical
    // synthesis sites — never recommendation (NON-LLM) or cc_dispatch
    // (protected Claude judgment tier). Activated per-site via
    // LLM_ROUTING_OPENROUTER_SITES (src/llm/openrouter.ts), not via
    // LLM_ROUTING_ALLOWED_PROVIDERS.
    id: "openrouter",
    displayName: "OpenRouter",
    authEnvVar: "OPENROUTER_API_KEY",
    modelEnvVar: "LLM_ROUTING_OPENROUTER_MODEL",
    defaultModel: "z-ai/glm-5.2",
    transport: "openai_compatible_chat",
    supportedSurfaces: ["synthesis_brief", "synthesis_draft", "synthesis_pdu"],
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
