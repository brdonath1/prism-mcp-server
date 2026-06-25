import { logger } from "../utils/logger.js";
import { resolveRoute } from "./routing-policy.js";
import type { RouteDecision, RouteInput, RoutingEnv } from "./route-types.js";

export function observeRoute(
  input: RouteInput,
  env: RoutingEnv = process.env,
): RouteDecision {
  const decision = resolveRoute(input, env);
  logger.info("LLM_ROUTE_OBSERVATION", {
    surface: decision.surface,
    taskClass: decision.taskClass,
    provider: decision.provider,
    model: decision.model,
    transport: decision.transport,
    authEnvVar: decision.authEnvVar,
    reasoningSetting: decision.reasoningSetting,
    qualityTier: decision.qualityTier,
    liveInvocationAllowed: decision.liveInvocationAllowed,
    fallbackChain: decision.fallbackChain,
    reason: decision.reason,
  });
  return decision;
}
