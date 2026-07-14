export type LlmSurface =
  | "recommendation"
  | "synthesis_brief"
  | "synthesis_draft"
  | "synthesis_pdu"
  | "cc_dispatch";

export type LlmProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "xai"
  | "perplexity"
  | "openrouter";

export type RouteProviderId = LlmProviderId | "none";

export type LlmActivationStatus =
  | "active_when_present"
  | "active_when_configured";

export type LlmTransport =
  | "advisory_env_override"
  | "messages_api"
  | "cc_subprocess"
  | "claude_code_oauth"
  | "existing"
  | "openai_responses"
  | "openai_compatible_chat"
  | "gemini_generate_content"
  | "xai_responses"
  | "blocked";

export type LlmQualityTier =
  | "frontier"
  | "frontier-code"
  | "frontier-long-context"
  | "research-citation"
  | "mechanical-cost"
  | "blocked";

export type RouteReason =
  | "routing-disabled"
  | "routing-dry-run"
  | "activation-not-authorized"
  | "provider-not-allowed"
  | "provider-auth-missing"
  | "live-provider-route"
  | "protected-boundary";

export interface ProviderMetadata {
  id: LlmProviderId;
  displayName: string;
  authEnvVar: string;
  modelEnvVar: string;
  defaultModel: string;
  transport: LlmTransport;
  supportedSurfaces: LlmSurface[];
  activationStatus: LlmActivationStatus;
  qualityPolicy: "quality-before-cost";
}

export interface RouteInput {
  surface: LlmSurface;
  taskClass: string;
  reasoningSetting?: string | null;
  currentModel?: string;
  currentTransport?: LlmTransport;
  currentAuthEnvVar?: string | null;
}

export interface RoutingEnv {
  [key: string]: string | undefined;
}

export interface RouteDecision {
  surface: LlmSurface;
  taskClass: string;
  provider: RouteProviderId;
  model: string;
  transport: LlmTransport;
  authEnvVar: string | null;
  reasoningSetting: string | null;
  qualityTier: LlmQualityTier;
  liveInvocationAllowed: boolean;
  fallbackChain: LlmProviderId[];
  reason: RouteReason;
}
