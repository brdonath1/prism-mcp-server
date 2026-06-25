import { describe, expect, it } from "vitest";
import { CC_DISPATCH_MODEL_ID, SYNTHESIS_MODEL_ID } from "../../models.js";
import { resolveRoute } from "../routing-policy.js";

describe("dormant LLM routing policy", () => {
  it("returns the current Anthropic fallback when routing is unset", () => {
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "long-context" }, {})).toMatchObject({
      provider: "anthropic",
      model: SYNTHESIS_MODEL_ID,
      transport: "existing",
      authEnvVar: "ANTHROPIC_API_KEY",
      liveInvocationAllowed: false,
      reason: "routing-disabled",
      fallbackChain: ["anthropic"],
    });
  });

  it("keeps cc_dispatch on the current Claude Code default while routing is disabled", () => {
    expect(resolveRoute({ surface: "cc_dispatch", taskClass: "code" }, {
      LLM_ROUTING_ENABLED: "false",
    })).toMatchObject({
      provider: "anthropic",
      model: CC_DISPATCH_MODEL_ID,
      transport: "claude_code_oauth",
      authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      liveInvocationAllowed: false,
      reason: "routing-disabled",
      fallbackChain: ["anthropic"],
    });
  });

  it("can report a dry-run non-Anthropic route without authorizing invocation", () => {
    expect(resolveRoute(
      { surface: "synthesis_brief", taskClass: "research-citation" },
      {
        LLM_ROUTING_ENABLED: "true",
        LLM_ROUTING_DRY_RUN: "true",
        LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "perplexity",
      },
    )).toMatchObject({
      provider: "perplexity",
      transport: "future_provider_adapter",
      authEnvVar: "PERPLEXITY_API_KEY",
      liveInvocationAllowed: false,
      reason: "routing-dry-run",
      fallbackChain: ["perplexity", "anthropic"],
    });
  });

  it("blocks protected-boundary negative controls instead of selecting a provider", () => {
    expect(resolveRoute({
      surface: "recommendation",
      taskClass: "protected-boundary-negative-control",
    }, {
      LLM_ROUTING_ENABLED: "true",
      LLM_ROUTING_DRY_RUN: "true",
      LLM_ROUTING_DEFAULT_PROVIDER: "openai",
    })).toMatchObject({
      provider: "none",
      model: "none",
      transport: "blocked",
      authEnvVar: null,
      liveInvocationAllowed: false,
      reason: "protected-boundary",
      fallbackChain: [],
    });
  });
});
