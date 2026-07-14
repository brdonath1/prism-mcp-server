/**
 * D-275 / brief-s196c — LLM_ROUTING_OPENROUTER_SITES routing-policy tests.
 *
 * The load-bearing guarantee (brief rail 3 + design §4.7): openrouter serves
 * exactly (SITES ∩ mechanical synthesis sites); SITES unset/empty ⇒ route
 * resolution is bit-identical to the pre-D-275 router; the master
 * ENABLED/DRY_RUN switches retain their precedence; and no pre-existing
 * shared env var (LLM_ROUTING_ALLOWED_PROVIDERS included) needs mutation for
 * activation.
 */

import { describe, expect, it } from "vitest";
import { resolveRoute } from "../routing-policy.js";
import type { LlmSurface, RoutingEnv } from "../route-types.js";

/** Tonight's live Railway env shape (names + routing values only — the audit
 *  §2 chains): brief→openai, draft→gemini, pdu→anthropic/cc_subprocess. */
function liveEnvWithoutOpenrouter(): RoutingEnv {
  return {
    LLM_ROUTING_ENABLED: "true",
    LLM_ROUTING_DRY_RUN: "false",
    LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai,gemini,xai",
    LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
    LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER: "gemini",
    LLM_ROUTING_SYNTHESIS_PDU_PROVIDER: "anthropic",
    OPENAI_API_KEY: "test-openai-key",
    GEMINI_API_KEY: "test-gemini-key",
    XAI_API_KEY: "test-xai-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
  };
}

/** The same env with the D-275 staged openrouter triplet added. */
function stagedEnv(sites = "synthesis_draft,synthesis_pdu"): RoutingEnv {
  return {
    ...liveEnvWithoutOpenrouter(),
    OPENROUTER_API_KEY: "test-openrouter-key",
    LLM_ROUTING_OPENROUTER_MODEL: "z-ai/glm-5.2",
    LLM_ROUTING_OPENROUTER_SITES: sites,
  };
}

const SYNTHESIS_SURFACES: LlmSurface[] = [
  "synthesis_brief",
  "synthesis_draft",
  "synthesis_pdu",
];

describe("LLM_ROUTING_OPENROUTER_SITES — activation semantics", () => {
  it("routes staged sites (draft + pdu) to live openrouter/z-ai/glm-5.2 and leaves brief on openai", () => {
    const env = stagedEnv();

    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "synthesis-draft" }, env)).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      authEnvVar: "OPENROUTER_API_KEY",
      qualityTier: "mechanical-cost",
      reasoningSetting: "off",
      liveInvocationAllowed: true,
      reason: "live-provider-route",
      fallbackChain: ["openrouter", "anthropic"],
    });
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "synthesis-pdu" }, env)).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      liveInvocationAllowed: true,
      reason: "live-provider-route",
    });
    // Stage 2 has NOT flipped: the brief stays on its existing openai route.
    expect(resolveRoute({ surface: "synthesis_brief", taskClass: "synthesis-brief" }, env)).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      transport: "openai_responses",
      liveInvocationAllowed: true,
      reason: "live-provider-route",
    });
  });

  it("REGRESSION: SITES unset → every surface resolves bit-identical to the pre-D-275 router", () => {
    const baseline = liveEnvWithoutOpenrouter();
    // Key + model staged but SITES ABSENT — the exact pre-activation state.
    const unset: RoutingEnv = {
      ...baseline,
      OPENROUTER_API_KEY: "test-openrouter-key",
      LLM_ROUTING_OPENROUTER_MODEL: "z-ai/glm-5.2",
    };
    for (const surface of [...SYNTHESIS_SURFACES, "recommendation", "cc_dispatch"] as LlmSurface[]) {
      const input = { surface, taskClass: `regression-${surface}` };
      expect(resolveRoute(input, unset)).toEqual(resolveRoute(input, baseline));
    }
  });

  it("REGRESSION: SITES empty/whitespace behaves exactly like unset", () => {
    for (const emptyValue of ["", "   ", ","]) {
      const env = stagedEnv(emptyValue);
      const baseline = liveEnvWithoutOpenrouter();
      for (const surface of SYNTHESIS_SURFACES) {
        const input = { surface, taskClass: `regression-empty-${surface}` };
        expect(resolveRoute(input, env)).toEqual(resolveRoute(input, baseline));
      }
    }
  });

  it("parses SITES tolerantly (whitespace, case, empty entries)", () => {
    const env = stagedEnv("  Synthesis_Draft ,, SYNTHESIS_PDU  ");
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, env).provider).toBe("openrouter");
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, env).provider).toBe("openrouter");
    expect(resolveRoute({ surface: "synthesis_brief", taskClass: "t" }, env).provider).toBe("openai");
  });

  it("serves exactly (SITES ∩ mechanical): non-mechanical ids in SITES have no effect", () => {
    const env = stagedEnv("synthesis_draft,cc_dispatch,recommendation,x_sentiment,not-a-site");

    // cc_dispatch stays hard-walled on the Claude judgment tier.
    expect(resolveRoute({ surface: "cc_dispatch", taskClass: "code" }, env)).toMatchObject({
      provider: "anthropic",
      transport: "claude_code_oauth",
      liveInvocationAllowed: false,
    });
    // recommendation keeps its current fallback shape (NON-LLM surface).
    expect(resolveRoute({ surface: "recommendation", taskClass: "reasoning" }, env)).toMatchObject({
      provider: "anthropic",
      liveInvocationAllowed: false,
    });
    // The one mechanical id listed still works.
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, env).provider).toBe("openrouter");
  });

  it("falls through to today's chain when OPENROUTER_API_KEY is absent (SITES set)", () => {
    const env = stagedEnv();
    delete env.OPENROUTER_API_KEY;

    // draft: SITES lists it, but with no key the pre-existing gemini live
    // route serves — activation never pins a site to a dead provider.
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, env)).toMatchObject({
      provider: "gemini",
      liveInvocationAllowed: true,
      reason: "live-provider-route",
    });
    // pdu: back to the anthropic transport chain.
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, env)).toMatchObject({
      provider: "anthropic",
      liveInvocationAllowed: false,
    });
  });

  it("keeps master-switch precedence: ENABLED≠true wins over SITES", () => {
    const env = stagedEnv();
    env.LLM_ROUTING_ENABLED = "false";
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, env)).toMatchObject({
      provider: "anthropic",
      liveInvocationAllowed: false,
      reason: "routing-disabled",
    });
  });

  it("keeps dry-run precedence: decision observed as openrouter but never live", () => {
    const env = stagedEnv();
    env.LLM_ROUTING_DRY_RUN = "true";
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, env)).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      liveInvocationAllowed: false,
      reason: "routing-dry-run",
    });
  });

  it("honors the LLM_ROUTING_OPENROUTER_MODEL override and its z-ai/glm-5.2 default", () => {
    const withOverride = stagedEnv();
    withOverride.LLM_ROUTING_OPENROUTER_MODEL = "z-ai/glm-5.2-air";
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, withOverride).model)
      .toBe("z-ai/glm-5.2-air");

    const withoutOverride = stagedEnv();
    delete withoutOverride.LLM_ROUTING_OPENROUTER_MODEL;
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, withoutOverride).model)
      .toBe("z-ai/glm-5.2");
  });

  it("requires no LLM_ROUTING_ALLOWED_PROVIDERS mutation — and openrouter cannot serve via provider vars without SITES", () => {
    // Activation path: ALLOWED_PROVIDERS deliberately does NOT list openrouter.
    const env = stagedEnv();
    expect(env.LLM_ROUTING_ALLOWED_PROVIDERS).not.toContain("openrouter");
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, env).liveInvocationAllowed).toBe(true);

    // Naming openrouter via the per-surface provider var WITHOUT SITES stays
    // gated by the allowed-providers list — SITES is the only activation surface.
    const providerVarOnly = liveEnvWithoutOpenrouter();
    providerVarOnly.LLM_ROUTING_SYNTHESIS_PDU_PROVIDER = "openrouter";
    providerVarOnly.OPENROUTER_API_KEY = "test-openrouter-key";
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, providerVarOnly)).toMatchObject({
      provider: "openrouter",
      liveInvocationAllowed: false,
      reason: "provider-not-allowed",
    });
  });

  it("carries the per-site reasoning level into the decision's reasoningSetting", () => {
    const env = stagedEnv();
    env.LLM_ROUTING_OPENROUTER_REASONING_PDU = "low";
    expect(resolveRoute({ surface: "synthesis_pdu", taskClass: "t" }, env).reasoningSetting).toBe("low");
    expect(resolveRoute({ surface: "synthesis_draft", taskClass: "t" }, env).reasoningSetting).toBe("off");
  });
});
