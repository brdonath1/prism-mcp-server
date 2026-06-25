import { describe, expect, it } from "vitest";
import { buildRouteReadinessStatus } from "../route-status.js";

describe("route readiness status", () => {
  it("summarizes routing readiness using names only", () => {
    const status = buildRouteReadinessStatus({
      LLM_ROUTING_ENABLED: "true",
      LLM_ROUTING_DRY_RUN: "true",
      LLM_ROUTING_PROFILE: "frontier-quality",
      LLM_ROUTING_ALLOWED_PROVIDERS:
        "anthropic,perplexity,openai-test-secret-should-not-log",
      LLM_ROUTING_DEFAULT_PROVIDER: "perplexity",
      LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-test-secret-should-not-log",
    });

    expect(status).toMatchObject({
      status: "dry_run",
      profile: "frontier-quality",
      liveInvocationAllowed: false,
      allowedProviders: ["anthropic", "perplexity"],
      configuredProviderOverrides: [
        "LLM_ROUTING_DEFAULT_PROVIDER",
        "LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER",
      ],
    });
    expect(status.providerEnvVars).toContain("OPENAI_API_KEY");
    expect(JSON.stringify(status)).not.toContain("openai-test-secret-should-not-log");
  });
});
