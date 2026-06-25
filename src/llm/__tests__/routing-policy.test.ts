import { describe, expect, it } from "vitest";
import { CC_DISPATCH_MODEL_ID, SYNTHESIS_MODEL_ID } from "../../models.js";
import { resolveRoute } from "../routing-policy.js";

describe("LLM routing policy", () => {
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
      model: "sonar-pro",
      transport: "openai_compatible_chat",
      authEnvVar: "PERPLEXITY_API_KEY",
      liveInvocationAllowed: false,
      reason: "routing-dry-run",
      fallbackChain: ["perplexity", "anthropic"],
    });
  });

  it("authorizes live OpenAI synthesis routing only when dry-run is disabled and auth is present", () => {
    expect(resolveRoute(
      { surface: "synthesis_brief", taskClass: "synthesis-brief" },
      {
        LLM_ROUTING_ENABLED: "true",
        LLM_ROUTING_DRY_RUN: "false",
        LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai",
        LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
        OPENAI_API_KEY: "test-openai-key",
      },
    )).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      transport: "openai_responses",
      authEnvVar: "OPENAI_API_KEY",
      liveInvocationAllowed: true,
      reason: "live-provider-route",
      fallbackChain: ["openai", "anthropic"],
    });
  });

  it("does not authorize a live provider route when its auth env var is absent", () => {
    expect(resolveRoute(
      { surface: "synthesis_draft", taskClass: "synthesis-draft" },
      {
        LLM_ROUTING_ENABLED: "true",
        LLM_ROUTING_DRY_RUN: "false",
        LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,gemini",
        LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER: "gemini",
      },
    )).toMatchObject({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
      transport: "gemini_generate_content",
      authEnvVar: "GEMINI_API_KEY",
      liveInvocationAllowed: false,
      reason: "provider-auth-missing",
      fallbackChain: ["gemini", "anthropic"],
    });
  });

  it("does not authorize live non-Anthropic routing unless the provider is explicitly allowed", () => {
    expect(resolveRoute(
      { surface: "synthesis_brief", taskClass: "synthesis-brief" },
      {
        LLM_ROUTING_ENABLED: "true",
        LLM_ROUTING_DRY_RUN: "false",
        LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
        OPENAI_API_KEY: "test-openai-key",
      },
    )).toMatchObject({
      provider: "openai",
      liveInvocationAllowed: false,
      reason: "provider-not-allowed",
      fallbackChain: ["openai", "anthropic"],
    });
  });

  it("keeps cc_dispatch on Claude Code even if a non-Claude provider is requested", () => {
    expect(resolveRoute(
      { surface: "cc_dispatch", taskClass: "code" },
      {
        LLM_ROUTING_ENABLED: "true",
        LLM_ROUTING_DRY_RUN: "false",
        LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai",
        LLM_ROUTING_CC_DISPATCH_PROVIDER: "openai",
        OPENAI_API_KEY: "test-openai-key",
      },
    )).toMatchObject({
      provider: "anthropic",
      model: CC_DISPATCH_MODEL_ID,
      transport: "claude_code_oauth",
      authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      liveInvocationAllowed: false,
      reason: "activation-not-authorized",
      fallbackChain: ["anthropic"],
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
