import { describe, expect, it } from "vitest";
import { getProviderRegistry } from "../provider-registry.js";
import { SYNTHESIS_MODEL_ID } from "../../models.js";

describe("provider registry", () => {
  it("lists the value-free provider auth contract for routing readiness", () => {
    const registry = getProviderRegistry();

    expect(registry.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "deepseek",
      "cerebras",
      "xai",
      "perplexity",
      "openrouter",
    ]);
    expect(registry.map((provider) => provider.authEnvVar)).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "DEEPSEEK_API_KEY",
      "CEREBRAS_API_KEY",
      "XAI_API_KEY",
      "PERPLEXITY_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
  });

  it("scopes openrouter to the three mechanical synthesis surfaces (D-275)", () => {
    const openrouter = getProviderRegistry().find((provider) => provider.id === "openrouter");

    expect(openrouter).toMatchObject({
      displayName: "OpenRouter",
      authEnvVar: "OPENROUTER_API_KEY",
      modelEnvVar: "LLM_ROUTING_OPENROUTER_MODEL",
      defaultModel: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      activationStatus: "active_when_configured",
    });
    // Exactly the migrate-to-GLM-5.2 sites from d275-callsite-inventory.json —
    // never recommendation (NON-LLM) and never cc_dispatch (protected tier).
    expect(openrouter?.supportedSurfaces).toEqual([
      "synthesis_brief",
      "synthesis_draft",
      "synthesis_pdu",
    ]);
  });

  // S208 Cerebras registration. The shape is pinned here so a later edit
  // cannot silently repoint the row at a model the operator's account does
  // not serve, or swap the OpenAI-compatible transport for something else.
  it("registers Cerebras on the OpenAI-compatible transport with the GLM default (S208)", () => {
    const cerebras = getProviderRegistry().find((provider) => provider.id === "cerebras");

    expect(cerebras).toMatchObject({
      displayName: "Cerebras",
      authEnvVar: "CEREBRAS_API_KEY",
      modelEnvVar: "LLM_ROUTING_CEREBRAS_MODEL",
      defaultModel: "zai-glm-4.7",
      transport: "openai_compatible_chat",
      activationStatus: "active_when_configured",
      qualityPolicy: "quality-before-cost",
    });
    // Same routable synthesis surfaces as the other configured providers --
    // never cc_dispatch (protected Claude judgment tier).
    expect(cerebras?.supportedSurfaces).toEqual([
      "recommendation",
      "synthesis_brief",
      "synthesis_draft",
      "synthesis_pdu",
    ]);
    // The default must be one of the three models the account actually
    // serves (verified live 2026-08-16 against /v1/models).
    expect(["zai-glm-4.7", "gpt-oss-120b", "gemma-4-31b"]).toContain(cerebras?.defaultModel);
  });

  it("marks synthesis providers active when configured while keeping cc_dispatch on Claude Code", () => {
    const registry = getProviderRegistry();

    expect(registry.find((provider) => provider.id === "anthropic")).toMatchObject({
      activationStatus: "active_when_present",
      supportedSurfaces: ["recommendation", "synthesis_brief", "synthesis_draft", "synthesis_pdu"],
    });
    for (const provider of registry.filter((entry) => entry.id !== "anthropic")) {
      expect(provider.supportedSurfaces).not.toContain("cc_dispatch");
      expect(provider.activationStatus).toBe("active_when_configured");
      expect(provider.defaultModel).toMatch(/\S/);
      expect(provider.modelEnvVar).toMatch(/^LLM_ROUTING_/);
    }
  });

  // S203 F-B7: the Anthropic row used to carry its own "claude-opus-4-8"
  // literal, so the model-bump SOP's "single switch" claim was false — a bump
  // to src/models.ts left this row a generation behind, silently. The row now
  // reads the registry pin; this test fails the moment anyone re-inlines it.
  it("keys the Anthropic default off the models.ts single switch, not a literal", () => {
    const anthropic = getProviderRegistry().find((provider) => provider.id === "anthropic");

    expect(anthropic?.defaultModel).toBe(SYNTHESIS_MODEL_ID);
  });

  it("does not contain credential values, account identifiers, or live payload samples", () => {
    const serialized = JSON.stringify(getProviderRegistry());

    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]+/);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(serialized).not.toMatch(/api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/i);
    expect(serialized).not.toContain("live_response");
  });
});
