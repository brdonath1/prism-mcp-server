import { describe, expect, it } from "vitest";
import { buildRouteReadinessStatus } from "../route-status.js";

describe("route readiness status", () => {
  it("summarizes routing readiness using names only", () => {
    const status = buildRouteReadinessStatus({
      LLM_ROUTING_ENABLED: "true",
      LLM_ROUTING_DRY_RUN: "false",
      LLM_ROUTING_PROFILE: "frontier-quality",
      LLM_ROUTING_ALLOWED_PROVIDERS:
        "anthropic,openai,openai-test-secret-should-not-log",
      LLM_ROUTING_DEFAULT_PROVIDER: "openai",
      LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-test-secret-should-not-log",
    });

    expect(status).toMatchObject({
      status: "live",
      profile: "frontier-quality",
      liveInvocationAllowed: true,
      allowedProviders: ["anthropic", "openai"],
      configuredProviderOverrides: [
        "LLM_ROUTING_DEFAULT_PROVIDER",
        "LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER",
      ],
    });
    expect(status.providerEnvVars).toContain("OPENAI_API_KEY");
    expect(status.candidateRoutingEnvVars).toContain("LLM_ROUTING_OPENAI_MODEL");
    expect(JSON.stringify(status)).not.toContain("openai-test-secret-should-not-log");
  });

  it("does not report live invocation allowed without an invocable configured route", () => {
    const status = buildRouteReadinessStatus({
      LLM_ROUTING_ENABLED: "true",
      LLM_ROUTING_DRY_RUN: "false",
      LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai",
      LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
    });

    expect(status).toMatchObject({
      status: "activation_blocked",
      liveInvocationAllowed: false,
      allowedProviders: ["anthropic", "openai"],
    });
  });
});
