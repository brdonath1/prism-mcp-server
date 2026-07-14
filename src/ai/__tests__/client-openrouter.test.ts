/**
 * D-275 / brief-s196c — synthesize() openrouter integration: the GLM leg
 * serves as hop 0 when SITES activates a site, quality-gate failures fall
 * back transparently to the site's existing Anthropic chain with a
 * structured SYNTHESIS_PROVIDER_FALLBACK {fallback_reason}, and every call
 * emits exactly one LLM_CALL telemetry line (design §4.5/§4.6/§4.8).
 *
 * cc_subprocess and the Anthropic SDK are module-mocked; the provider leg
 * uses a stubbed global fetch. No live network, no real keys (INS-31).
 */

// Set required env BEFORE imports — config.ts reads at module load time.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../cc-subprocess.js", () => ({
  synthesizeViaCcSubprocess: vi.fn(),
}));

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockMessagesCreate },
    })),
  };
});

import { SYNTHESIS_MODEL_ID } from "../../models.js";
import { synthesize } from "../client.js";
import { synthesizeViaCcSubprocess } from "../cc-subprocess.js";

const mockSubprocess = vi.mocked(synthesizeViaCcSubprocess);

const ENV_KEYS_TO_RESET = [
  "SYNTHESIS_PDU_TRANSPORT",
  "SYNTHESIS_PDU_MODEL",
  "SYNTHESIS_DRAFT_TRANSPORT",
  "SYNTHESIS_DRAFT_MODEL",
  "SYNTHESIS_BRIEF_TRANSPORT",
  "SYNTHESIS_BRIEF_MODEL",
  "LLM_ROUTING_ENABLED",
  "LLM_ROUTING_DRY_RUN",
  "LLM_ROUTING_ALLOWED_PROVIDERS",
  "LLM_ROUTING_SYNTHESIS_PDU_PROVIDER",
  "LLM_ROUTING_OPENROUTER_MODEL",
  "LLM_ROUTING_OPENROUTER_SITES",
  "LLM_ROUTING_OPENROUTER_REASONING_PDU",
  "OPENROUTER_API_KEY",
];

/** A PDU body that passes the §4.5 gate (4 grammar sections, ≥500 bytes). */
function passingPduContent(): string {
  const body = [
    "# Pending Doc Updates — test",
    "",
    "## architecture.md",
    "No updates needed at this time.",
    "## glossary.md",
    "No updates needed at this time.",
    "## insights.md",
    "No updates needed at this time.",
    "## No Updates Needed",
    "All sections reviewed this session.",
  ].join("\n");
  // No trailing whitespace — the adapter trims content, and the serve test
  // asserts byte-for-byte passthrough.
  return body + "\n" + "content-".repeat(60) + "end";
}

function openrouterOk(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 44, completion_tokens: 21, cost: 0.000123 },
    }),
    { status: 200 },
  );
}

function stagePduOnOpenrouter(): void {
  process.env.LLM_ROUTING_ENABLED = "true";
  process.env.LLM_ROUTING_DRY_RUN = "false";
  process.env.OPENROUTER_API_KEY = "openrouter-test-secret";
  process.env.LLM_ROUTING_OPENROUTER_SITES = "synthesis_pdu";
}

/** Minimal structural view of the stdout write spy — vi.spyOn's overloaded
 *  MockInstance type doesn't unify with the generic ReturnType form. */
interface StdoutSpyLike {
  mock: { calls: unknown[][] };
  mockRestore(): void;
}

function capturedLogs(spy: StdoutSpyLike): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
}

let stdoutSpy: StdoutSpyLike;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];

  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text: "## architecture.md\n\nfallback body" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  mockSubprocess.mockResolvedValue({
    success: true,
    content: "from cc_subprocess",
    input_tokens: 80,
    output_tokens: 40,
    model: "claude-sonnet-5",
  });
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
  vi.unstubAllGlobals();
});

describe("synthesize() — openrouter mechanical-tier leg", () => {
  it("serves an activated site from openrouter and emits a measured-cost LLM_CALL", async () => {
    stagePduOnOpenrouter();
    const content = passingPduContent();
    const fetchMock = vi.fn().mockResolvedValue(openrouterOk(content));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize("sys", "user", 8192, 10_000, undefined, true, "pdu", "prism");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe(content);
      expect(result.model).toBe("z-ai/glm-5.2");
      expect(result.transport).toBe("openai_compatible_chat");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://openrouter.ai/api/v1/chat/completions");
    // The caller's Anthropic thinking flag (true above) must NOT re-enable
    // GLM thinking — the request pins reasoning off (design §4.2).
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({ enabled: false });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockSubprocess).not.toHaveBeenCalled();

    const llmCalls = capturedLogs(stdoutSpy).filter((entry) => entry.msg === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      call_site: "synthesis_pdu",
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      transport: "openai_compatible_chat",
      success: true,
      input_tokens: 44,
      output_tokens: 21,
      token_source: "usage",
      est_cost_usd: 0.000123,
      cost_source: "provider_usage",
      fallback_used: false,
      fallback_reason: null,
      projectSlug: "prism",
    });
    expect(JSON.stringify(llmCalls)).not.toContain("openrouter-test-secret");
  });

  it("falls back to the Anthropic chain when the §4.5 quality gate fails, tagged validation_failed", async () => {
    stagePduOnOpenrouter();
    // Passes provider-level guards (stop + non-empty) but fails the PDU gate
    // (missing grammar sections, under the byte floor).
    const fetchMock = vi.fn().mockResolvedValue(openrouterOk("looks fine but is not a PDU"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize("sys", "user", 8192, 10_000, undefined, false, "pdu", "prism");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transport).toBe("messages_api");
      expect(result.model).toBe(SYNTHESIS_MODEL_ID);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);

    const logs = capturedLogs(stdoutSpy);
    const fallbackWarns = logs.filter((entry) =>
      String(entry.msg).startsWith("SYNTHESIS_PROVIDER_FALLBACK"),
    );
    expect(fallbackWarns).toHaveLength(1);
    expect(fallbackWarns[0]).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-5.2",
      fallback_reason: "validation_failed",
      projectSlug: "prism",
    });
    expect(String(fallbackWarns[0].validation_failure)).toContain("pdu-");

    const llmCalls = logs.filter((entry) => entry.msg === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      call_site: "synthesis_pdu",
      provider: "anthropic",
      model: SYNTHESIS_MODEL_ID,
      transport: "messages_api",
      success: true,
      fallback_used: true,
      fallback_reason: "validation_failed",
      // Anthropic served → measured openrouter cost must NOT leak through;
      // Opus 4.8 price-table estimate: 100/1M*$5 + 50/1M*$25 = $0.00175.
      est_cost_usd: 0.00175,
      cost_source: "price_table_estimate",
    });
  });

  it("tags the GLM length-starvation signature as validation_failed on the fallback path", async () => {
    stagePduOnOpenrouter();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 20, completion_tokens: 16 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize("sys", "user", 8192, 10_000, undefined, false, "pdu");

    expect(result.success).toBe(true);
    const logs = capturedLogs(stdoutSpy);
    const fallbackWarn = logs.find((entry) =>
      String(entry.msg).startsWith("SYNTHESIS_PROVIDER_FALLBACK"),
    );
    expect(fallbackWarn).toMatchObject({ fallback_reason: "validation_failed" });
    const llmCall = logs.find((entry) => entry.msg === "LLM_CALL");
    expect(llmCall).toMatchObject({
      fallback_used: true,
      fallback_reason: "validation_failed",
      provider: "anthropic",
    });
  });

  it("tags provider HTTP failures as provider_error", async () => {
    stagePduOnOpenrouter();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream sad" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize("sys", "user", 8192, 10_000, undefined, false, "pdu");

    expect(result.success).toBe(true);
    const logs = capturedLogs(stdoutSpy);
    expect(
      logs.find((entry) => String(entry.msg).startsWith("SYNTHESIS_PROVIDER_FALLBACK")),
    ).toMatchObject({ fallback_reason: "provider_error" });
    expect(logs.find((entry) => entry.msg === "LLM_CALL")).toMatchObject({
      fallback_used: true,
      fallback_reason: "provider_error",
    });
  });

  it("REGRESSION: key staged but SITES unset → openrouter never called, LLM_CALL shows the anthropic route", async () => {
    process.env.LLM_ROUTING_ENABLED = "true";
    process.env.LLM_ROUTING_DRY_RUN = "false";
    process.env.OPENROUTER_API_KEY = "openrouter-test-secret";
    // No LLM_ROUTING_OPENROUTER_SITES.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await synthesize("sys", "user", undefined, undefined, undefined, false, "pdu");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.transport).toBe("messages_api");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);

    const llmCalls = capturedLogs(stdoutSpy).filter((entry) => entry.msg === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      call_site: "synthesis_pdu",
      provider: "anthropic",
      transport: "messages_api",
      fallback_used: false,
      fallback_reason: null,
    });
  });

  it("emits an LLM_CALL line with chars/3.5-labeled estimates when every hop fails", async () => {
    stagePduOnOpenrouter();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "down" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockMessagesCreate.mockRejectedValue(new Error("anthropic also down"));

    const result = await synthesize("sys", "user content here", 8192, 10_000, 0, false, "pdu");

    expect(result.success).toBe(false);
    const llmCalls = capturedLogs(stdoutSpy).filter((entry) => entry.msg === "LLM_CALL");
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]).toMatchObject({
      call_site: "synthesis_pdu",
      success: false,
      token_source: "chars_estimate",
      fallback_used: true,
      fallback_reason: "provider_error",
    });
    // chars/3.5 estimate of "sys" + "user content here" = ceil(20/3.5) = 6.
    expect(llmCalls[0].input_tokens).toBe(6);
  });
});
