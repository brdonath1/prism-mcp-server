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

  // S208: readiness must surface the new provider's contract by NAME so an
  // operator can see it without reading source -- and must keep reporting
  // it as not-allowed until they add it to LLM_ROUTING_ALLOWED_PROVIDERS.
  it("reports the cerebras auth/model contract without treating it as allowed (S208)", () => {
    const status = buildRouteReadinessStatus({
      LLM_ROUTING_ENABLED: "true",
      LLM_ROUTING_DRY_RUN: "false",
      LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai",
      CEREBRAS_API_KEY: "cerebras-test-secret-should-not-log",
    });

    expect(status.providerEnvVars).toContain("CEREBRAS_API_KEY");
    expect(status.candidateRoutingEnvVars).toContain("LLM_ROUTING_CEREBRAS_MODEL");
    expect(status.allowedProviders).not.toContain("cerebras");
    expect(JSON.stringify(status)).not.toContain("cerebras-test-secret-should-not-log");
  });
});
