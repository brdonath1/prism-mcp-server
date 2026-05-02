/**
 * brief-419: project-slug tagging through synthesize().
 *
 * Verifies that when synthesize() is called with the new optional
 * `projectSlug` parameter, the resulting log emissions in src/ai/client.ts
 * carry the slug — both on the success path (`Synthesis API call complete`
 * info log) and on the SYNTHESIS_TRANSPORT_FALLBACK warn log.
 *
 * Legacy callers (no `projectSlug` argument) continue to emit logs without
 * the field — backwards-compat assertion.
 *
 * The cc_subprocess wrapper, the Anthropic SDK, and the logger emit calls
 * are all mocked at module level so the tests exercise the plumbing in
 * isolation.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/ai/cc-subprocess.js", () => ({
  synthesizeViaCcSubprocess: vi.fn(),
}));

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

const loggerInfoSpy = vi.fn();
const loggerWarnSpy = vi.fn();
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: (...args: unknown[]) => loggerInfoSpy(...args),
    warn: (...args: unknown[]) => loggerWarnSpy(...args),
    error: vi.fn(),
  },
}));

import { synthesize } from "../src/ai/client.js";
import { synthesizeViaCcSubprocess } from "../src/ai/cc-subprocess.js";

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
  loggerInfoSpy.mockClear();
  loggerWarnSpy.mockClear();
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];

  mockMessagesCreate.mockResolvedValue({
    content: [{ type: "text", text: "## architecture.md\n\nbody" }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  mockSubprocess.mockResolvedValue({
    success: true,
    content: "## architecture.md\n\nfrom subprocess",
    input_tokens: 80,
    output_tokens: 40,
    model: "claude-sonnet-4-6",
  });
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_RESET) delete process.env[key];
});

/** Find the first call to logger.info matching the given message. */
function findInfo(message: string): Record<string, unknown> | undefined {
  const call = loggerInfoSpy.mock.calls.find(([msg]) => msg === message);
  return call?.[1] as Record<string, unknown> | undefined;
}

/** Find the first call to logger.warn matching the given (prefix) message. */
function findWarn(prefix: string): Record<string, unknown> | undefined {
  const call = loggerWarnSpy.mock.calls.find(
    ([msg]) => typeof msg === "string" && msg.startsWith(prefix),
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("brief-419: synthesize() projectSlug plumbing", () => {
  it("includes projectSlug on the success-path info log when supplied", async () => {
    await synthesize(
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "prism",
    );
    const payload = findInfo("Synthesis API call complete");
    expect(payload).toBeDefined();
    expect(payload?.projectSlug).toBe("prism");
  });

  it("emits the success-path info log with projectSlug undefined when omitted (legacy)", async () => {
    await synthesize("sys", "user");
    const payload = findInfo("Synthesis API call complete");
    expect(payload).toBeDefined();
    // Backwards-compat: the field is present on the payload but undefined.
    // Existing log consumers see the same fields they did before; the new
    // optional field is only meaningful when set.
    expect(payload?.projectSlug).toBeUndefined();
  });

  it("includes projectSlug on the SYNTHESIS_TRANSPORT_FALLBACK warn log when subprocess fails", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    mockSubprocess.mockResolvedValueOnce({
      success: false,
      error: "subprocess crashed",
      error_code: "API_ERROR",
    });

    await synthesize(
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      true,
      "pdu",
      "platformforge-v2",
    );
    const fallbackPayload = findWarn("SYNTHESIS_TRANSPORT_FALLBACK");
    expect(fallbackPayload).toBeDefined();
    expect(fallbackPayload?.projectSlug).toBe("platformforge-v2");
  });

  it("includes projectSlug on the success info log when fallback succeeds via messages_api", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    mockSubprocess.mockResolvedValueOnce({
      success: false,
      error: "subprocess crashed",
      error_code: "API_ERROR",
    });

    await synthesize(
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      true,
      "pdu",
      "platformforge-v2",
    );
    const successPayload = findInfo("Synthesis API call complete");
    expect(successPayload).toBeDefined();
    expect(successPayload?.projectSlug).toBe("platformforge-v2");
  });

  it("does NOT mutate routing — subprocess receives the same args regardless of projectSlug", async () => {
    process.env.SYNTHESIS_PDU_TRANSPORT = "cc_subprocess";
    await synthesize(
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      true,
      "pdu",
      "snapquote-ai",
    );
    expect(mockSubprocess).toHaveBeenCalledTimes(1);
    // The subprocess wrapper signature is (system, user, model, maxTokens,
    // timeoutMs, thinking) — projectSlug is NOT plumbed into it because the
    // subprocess emits its own logs and the brief targets only the
    // ai/client.ts emissions.
    const args = mockSubprocess.mock.calls[0];
    expect(args.length).toBe(6);
  });

  it("plumbs projectSlug to the success-path info log on the messages_api branch when callSite is set", async () => {
    // callSite=pdu but no transport override → routes to messages_api
    // directly; the success log still carries the project slug.
    await synthesize(
      "sys",
      "user",
      undefined,
      undefined,
      undefined,
      true,
      "pdu",
      "prism-mcp-server",
    );
    const successPayload = findInfo("Synthesis API call complete");
    expect(successPayload).toBeDefined();
    expect(successPayload?.projectSlug).toBe("prism-mcp-server");
  });
});
