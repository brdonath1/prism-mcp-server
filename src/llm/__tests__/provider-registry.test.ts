import { describe, expect, it } from "vitest";
import { getProviderRegistry } from "../provider-registry.js";

describe("provider registry", () => {
  it("lists the value-free provider auth contract for routing readiness", () => {
    const registry = getProviderRegistry();

    expect(registry.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "gemini",
      "deepseek",
      "xai",
      "perplexity",
    ]);
    expect(registry.map((provider) => provider.authEnvVar)).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "DEEPSEEK_API_KEY",
      "XAI_API_KEY",
      "PERPLEXITY_API_KEY",
    ]);
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

  it("does not contain credential values, account identifiers, or live payload samples", () => {
    const serialized = JSON.stringify(getProviderRegistry());

    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]+/);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9_]+/);
    expect(serialized).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(serialized).not.toMatch(/api[_-]?key["']?\s*[:=]\s*["'][^"']+["']/i);
    expect(serialized).not.toContain("live_response");
  });
});
