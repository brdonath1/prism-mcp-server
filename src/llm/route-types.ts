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
  | "perplexity";

export type RouteProviderId = LlmProviderId | "none";

export type LlmActivationStatus =
  | "active_when_present"
  | "readiness_only"
  | "blocked_readiness_only"
  | "x_search_only_inactive_general_routing";

export type LlmTransport =
  | "advisory_env_override"
  | "messages_api"
  | "cc_subprocess"
  | "claude_code_oauth"
  | "existing"
  | "future_provider_adapter"
  | "blocked";

export type LlmQualityTier =
  | "frontier"
  | "frontier-code"
  | "frontier-long-context"
  | "research-citation"
  | "blocked";

export type RouteReason =
  | "routing-disabled"
  | "routing-dry-run"
  | "activation-not-authorized"
  | "protected-boundary";

export interface ProviderMetadata {
  id: LlmProviderId;
  displayName: string;
  authEnvVar: string;
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
  liveInvocationAllowed: false;
  fallbackChain: LlmProviderId[];
  reason: RouteReason;
}
