/**
 * brief-417 Phase 3c-A: per-call-site routing tests for synthesize().
 *
 * The cc_subprocess wrapper and the underlying Anthropic client are both
 * mocked at module level so the tests exercise the routing logic in isolation
 * (no network, no SDK subprocess). The tests assert which transport was
 * selected and which model was passed, plus the automatic fallback path.
 */

// Set required env BEFORE imports — config.ts reads at module load time.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the cc_subprocess wrapper so we can assert call arguments + force
// success/failure outcomes deterministically.
vi.mock("../cc-subprocess.js", () => ({
  synthesizeViaCcSubprocess: vi.fn(),
}));

// Mock the Anthropic SDK so the messages_api branch never makes a real
// network call. The mock returns a fixed text payload so success cases assert
// content/tokens/model passthrough.
const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockMessagesCreate },
    })),
  };
});

import { synthesize, resolveCallSiteRouting } from "../client.js";
import { synthesizeViaCcSubprocess } from "../cc-subprocess.js";

const mockSubprocess = vi.mocked(synthesizeViaCcSubprocess);

const ENV_KEYS_TO_RESET = [
  "SYNTHESIS_PDU_TRANSPORT",
  "SYNTHESIS_PDU_MODEL",
  "SYNTHESIS_DRAFT_TRANSPORT",
  "SYNTHESIS_DRAFT_MODEL",
  "SYNTHESIS_BRIEF_TRANSPORT",
  "SYNTHESIS_BRIEF_MODEL",
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];

  // Default Messages API mock: success with deterministic payload.
  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text: "## architecture.md\n\nbody" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  // Default subprocess mock: success — individual tests override.
  mockSubprocess.mockResolvedValue({
    success: true,
    content: "## architecture.md\n\nfrom cc_subprocess",
    input_tokens: 80,
    output_tokens: 40,
    model: "claude-sonnet-4-6",
  });
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
});

describe("resolveCallSiteRouting — env var resolution", () => {
  it("defaults to messages_api + SYNTHESIS_MODEL when no env set", () => {
    const r = resolveCallSiteRouting("pdu");
    expect(r.transport).toBe("messages_api");
    expect(r.model).toBe("claude-opus-4-7"); // SYNTHESIS_MODEL default
    expect(r.modelOverridden).toBe(false);
  });

  it("reads SYNTHESIS_PDU_TRANSPORT=cc_subprocess", () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    const r = resolveCallSiteRouting("pdu");
    expect(r.transport).toBe("cc_subprocess");
  });

  it("reads SYNTHESIS_PDU_MODEL override", () => {
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";
    const r = resolveCallSiteRouting("pdu");
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(r.modelOverridden).toBe(true);
  });

  it("ignores unknown SYNTHESIS_PDU_TRANSPORT values, falling back to messages_api", () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "carrier-pigeon";
    const r = resolveCallSiteRouting("pdu");
    expect(r.transport).toBe("messages_api");
  });

  it("uses per-call-site env namespace (DRAFT vs PDU vs BRIEF)", () => {
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";
    process.env.SYNTHESIS_BRIEF_MODEL = "claude-haiku-4-5";
    expect(resolveCallSiteRouting("pdu").model).toBe("claude-sonnet-4-6");
    expect(resolveCallSiteRouting("brief").model).toBe("claude-haiku-4-5");
    expect(resolveCallSiteRouting("draft").model).toBe("claude-opus-4-7");
  });
});

describe("synthesize() — per-call-site routing", () => {
  it("test 1: callSite=pdu with no env → routes to messages_api with default model", async () => {
    const result = await synthesize("sys", "user", undefined, undefined, undefined, false, "pdu");

    expect(result.success).toBe(true);
    expect(mockSubprocess).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const passedBody = mockMessagesCreate.mock.calls[0][0];
    expect(passedBody.model).toBe("claude-opus-4-7"); // SYNTHESIS_MODEL default
    if (result.success) {
      expect(result.transport).toBe("messages_api");
    }
  });

  it("test 2: callSite=pdu + cc_subprocess transport → routes to subprocess wrapper", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";

    const result = await synthesize("sys", "user", undefined, undefined, undefined, true, "pdu");

    expect(result.success).toBe(true);
    expect(mockSubprocess).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    if (result.success) {
      expect(result.transport).toBe("cc_subprocess");
    }
  });

  it("test 3: cc_subprocess transport with model override → subprocess called with sonnet-4-6", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";

    await synthesize("sys", "user", undefined, undefined, undefined, true, "pdu");

    expect(mockSubprocess).toHaveBeenCalledTimes(1);
    const args = mockSubprocess.mock.calls[0];
    expect(args[2]).toBe("claude-sonnet-4-6"); // model is the 3rd positional arg
  });

  it("test 4: messages_api transport with model override → Messages API called with override", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "messages_api";
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";

    await synthesize("sys", "user", undefined, undefined, undefined, true, "pdu");

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const passedBody = mockMessagesCreate.mock.calls[0][0];
    expect(passedBody.model).toBe("claude-sonnet-4-6");
  });

  it("test 5: cc_subprocess failure → automatic fallback to messages_api with DEFAULT model", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";
    mockSubprocess.mockResolvedValueOnce({
      success: false,
      error: "subprocess crashed",
      error_code: "API_ERROR",
    });

    const result = await synthesize("sys", "user", undefined, undefined, undefined, true, "pdu");

    expect(result.success).toBe(true);
    expect(mockSubprocess).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);

    // The retry path MUST NOT use the override that just failed.
    const passedBody = mockMessagesCreate.mock.calls[0][0];
    expect(passedBody.model).toBe("claude-opus-4-7");

    if (result.success) {
      expect(result.transport).toBe("messages_api_fallback");
    }
  });

  it("test 6: synthesize() with NO callSite → legacy behavior, no env-var reads", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess"; // would normally route
    process.env.SYNTHESIS_PDU_MODEL = "claude-sonnet-4-6";

    const result = await synthesize("sys", "user");

    expect(result.success).toBe(true);
    // No call-site = no subprocess routing, no transport label set.
    expect(mockSubprocess).not.toHaveBeenCalled();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const passedBody = mockMessagesCreate.mock.calls[0][0];
    expect(passedBody.model).toBe("claude-opus-4-7");
    if (result.success) {
      expect(result.transport).toBeUndefined();
    }
  });

  it("test 7: invalid callSite values are rejected at type level", () => {
    // This is a compile-time test — the assertion below would not compile if
    // synthesize accepted arbitrary strings for callSite. We use @ts-expect-error
    // so the test build fails if the type ever loosens.
    // @ts-expect-error — "frontend" is not a SynthesisCallSite
    void synthesize("sys", "user", undefined, undefined, undefined, false, "frontend");
    expect(true).toBe(true);
  });
});
