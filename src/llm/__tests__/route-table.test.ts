/**
 * D-275 / brief-s196c — LLM_ROUTING_TABLE startup table (§4.8).
 *
 * Under tonight's staged env the table must show synthesis_draft +
 * synthesis_pdu → openrouter/z-ai/glm-5.2 and everything else unchanged
 * (brief verification item 2) — and never carry a secret value.
 *
 * NOTE: buildResolvedRoutingTable consults resolveCallSiteRouting, which
 * reads process.env directly, so the staged env is applied to process.env
 * and restored after each test.
 */

// Set required env BEFORE imports — config.ts reads at module load time.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
// Hermeticity: the default-effort assertions below pin the
// UNSET-SYNTHESIS_EFFORT contract; strip any ambient value.
delete process.env.SYNTHESIS_EFFORT;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildResolvedRoutingTable } from "../route-table.js";
import { logger } from "../../utils/logger.js";

const STAGED_ENV: Record<string, string> = {
  LLM_ROUTING_ENABLED: "true",
  LLM_ROUTING_DRY_RUN: "false",
  LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,openai,gemini,xai",
  LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER: "openai",
  LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER: "gemini",
  LLM_ROUTING_SYNTHESIS_PDU_PROVIDER: "anthropic",
  OPENAI_API_KEY: "openai-test-secret-value",
  GEMINI_API_KEY: "gemini-test-secret-value",
  XAI_API_KEY: "xai-test-secret-value",
  SYNTHESIS_BRIEF_TRANSPORT: "cc_subprocess",
  SYNTHESIS_DRAFT_TRANSPORT: "cc_subprocess",
  SYNTHESIS_PDU_TRANSPORT: "cc_subprocess",
  SYNTHESIS_PDU_MODEL: "claude-opus-4-8",
  OPENROUTER_API_KEY: "openrouter-test-secret-value",
  LLM_ROUTING_OPENROUTER_MODEL: "z-ai/glm-5.2",
  LLM_ROUTING_OPENROUTER_SITES: "synthesis_draft,synthesis_pdu",
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(STAGED_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of Object.keys(STAGED_ENV)) {
    const prior = saved[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
});

describe("LLM_ROUTING_TABLE — resolved startup routing table", () => {
  it("shows draft+pdu on live openrouter/z-ai/glm-5.2 and everything else unchanged", () => {
    const rows = buildResolvedRoutingTable();
    const bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));

    expect(bySite.synthesis_draft).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      live: true,
      reason: "live-provider-route",
    });
    expect(bySite.synthesis_pdu).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      live: true,
    });
    // Stage 2 not flipped: brief remains the live openai route.
    expect(bySite.synthesis_brief).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      transport: "openai_responses",
      live: true,
    });
    // Non-migratable surfaces unchanged.
    expect(bySite.cc_dispatch).toMatchObject({
      provider: "anthropic",
      transport: "claude_code_oauth",
      live: false,
    });
    expect(bySite.recommendation).toMatchObject({
      provider: "anthropic",
      live: false,
    });
    expect(String(bySite.recommendation.note)).toContain("non-LLM");
    expect(rows).toHaveLength(5);

    // All three synthesis rows are live (non-anthropic) under the staged
    // env, plus cc_dispatch and recommendation are never anthropic-serving
    // synthesis rows -- none of these carry the effort column.
    expect(bySite.synthesis_draft).not.toHaveProperty("effort");
    expect(bySite.synthesis_pdu).not.toHaveProperty("effort");
    expect(bySite.synthesis_brief).not.toHaveProperty("effort");
    expect(bySite.cc_dispatch).not.toHaveProperty("effort");
    expect(bySite.recommendation).not.toHaveProperty("effort");
  });

  it("shows the serving Anthropic leg when SITES is cleared (kill-switch view)", () => {
    delete process.env.LLM_ROUTING_OPENROUTER_SITES;
    const rows = buildResolvedRoutingTable();
    const bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));

    // draft returns to its live gemini route; pdu to its cc_subprocess leg.
    expect(bySite.synthesis_draft).toMatchObject({
      provider: "gemini",
      live: true,
    });
    expect(bySite.synthesis_draft).not.toHaveProperty("effort");
    expect(bySite.synthesis_pdu).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      transport: "cc_subprocess",
      live: false,
      // claude-opus-4-8 is not the explicit Sonnet 5 id, so the
      // cc_subprocess per-model default is "high" (ccSubprocessEffortForModel).
      effort: "high",
    });
  });

  it("SYNTHESIS_EFFORT=xhigh overrides the anthropic-serving synthesis row's effort", () => {
    delete process.env.LLM_ROUTING_OPENROUTER_SITES;
    process.env.SYNTHESIS_EFFORT = "xhigh";
    try {
      const rows = buildResolvedRoutingTable();
      const bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));

      expect(bySite.synthesis_pdu).toMatchObject({
        provider: "anthropic",
        transport: "cc_subprocess",
        live: false,
        effort: "xhigh",
      });
    } finally {
      delete process.env.SYNTHESIS_EFFORT;
    }
  });

  it("an invalid SYNTHESIS_EFFORT logs exactly one warn and rows fall back to per-path defaults", () => {
    delete process.env.LLM_ROUTING_OPENROUTER_SITES;
    process.env.SYNTHESIS_EFFORT = "ultra-turbo";
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const rows = buildResolvedRoutingTable();
      const bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));

      expect(bySite.synthesis_pdu).toMatchObject({
        provider: "anthropic",
        transport: "cc_subprocess",
        live: false,
        effort: "high",
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("SYNTHESIS_EFFORT");
    } finally {
      delete process.env.SYNTHESIS_EFFORT;
      warnSpy.mockRestore();
    }
  });

  it("omits effort on a messages_api synthesis row whose thinking resolves off, keeps it when on", () => {
    delete process.env.LLM_ROUTING_OPENROUTER_SITES;
    process.env.LLM_ROUTING_SYNTHESIS_BRIEF_PROVIDER = "anthropic";
    process.env.SYNTHESIS_BRIEF_TRANSPORT = "messages_api";
    process.env.SYNTHESIS_BRIEF_THINKING = "false";
    try {
      let rows = buildResolvedRoutingTable();
      let bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));
      expect(bySite.synthesis_brief).toMatchObject({
        provider: "anthropic",
        transport: "messages_api",
        live: false,
      });
      // thinking off -> the messages_api leg sends no output_config.effort,
      // so the row must not advertise one (the configured-but-not-serving
      // class this table exists to kill).
      expect(bySite.synthesis_brief).not.toHaveProperty("effort");

      // thinking back on (default true) -> the leg sends effort again.
      delete process.env.SYNTHESIS_BRIEF_THINKING;
      rows = buildResolvedRoutingTable();
      bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));
      expect(bySite.synthesis_brief).toMatchObject({
        transport: "messages_api",
        effort: "max",
      });
    } finally {
      delete process.env.SYNTHESIS_BRIEF_THINKING;
    }
  });

  it("draft on messages_api keeps effort (draft thinking hardcoded on at the finalize call site)", () => {
    delete process.env.LLM_ROUTING_OPENROUTER_SITES;
    process.env.LLM_ROUTING_SYNTHESIS_DRAFT_PROVIDER = "anthropic";
    process.env.SYNTHESIS_DRAFT_TRANSPORT = "messages_api";
    const rows = buildResolvedRoutingTable();
    const bySite = Object.fromEntries(rows.map((row) => [row.call_site, row]));
    expect(bySite.synthesis_draft).toMatchObject({
      provider: "anthropic",
      transport: "messages_api",
      live: false,
      effort: "max",
    });
  });

  it("never carries env secret values", () => {
    const serialized = JSON.stringify(buildResolvedRoutingTable());
    for (const secret of [
      "openai-test-secret-value",
      "gemini-test-secret-value",
      "xai-test-secret-value",
      "openrouter-test-secret-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
