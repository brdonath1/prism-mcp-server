/**
 * brief-456 / W3-S2 (M-004, SRV-07) — messages_api response guards.
 *
 * callMessagesApi previously built a success result from the text blocks
 * without reading stop_reason or checking for empty text — a refusal or
 * max_tokens-truncated response flowed downstream as a "successful"
 * synthesis. These guards mirror the cc_subprocess path's empty-text /
 * zero-token guards (cc-subprocess.ts).
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockMessagesCreate },
    })),
  };
});

import { synthesize } from "../client.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SRV-07 — callMessagesApi output guards", () => {
  it("stop_reason 'refusal' → failure (API_ERROR), never a success result", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [],
      stop_reason: "refusal",
      usage: { input_tokens: 1000, output_tokens: 0 },
    });

    const outcome = await synthesize("system", "user");

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error_code).toBe("API_ERROR");
      expect(outcome.error).toMatch(/refusal/i);
    }
  });

  it("empty text content (thinking-only blocks) → failure mentioning the stop_reason", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "thinking", thinking: "hmm" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1000, output_tokens: 4096 },
    });

    const outcome = await synthesize("system", "user");

    expect(outcome.success).toBe(false);
    if (!outcome.success) {
      expect(outcome.error_code).toBe("API_ERROR");
      expect(outcome.error).toMatch(/empty/i);
      expect(outcome.error).toMatch(/max_tokens/);
    }
  });

  it("whitespace-only text → failure", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "   \n  " }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    const outcome = await synthesize("system", "user");

    expect(outcome.success).toBe(false);
  });

  it("stop_reason 'max_tokens' with text → success, stop_reason propagated for downstream guards", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "truncated but present output" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1000, output_tokens: 4096 },
    });

    const outcome = await synthesize("system", "user");

    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.stop_reason).toBe("max_tokens");
      expect(outcome.content).toBe("truncated but present output");
    }
  });

  it("normal end_turn response → success with stop_reason propagated", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "full output" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 800 },
    });

    const outcome = await synthesize("system", "user");

    expect(outcome.success).toBe(true);
    if (outcome.success) {
      expect(outcome.stop_reason).toBe("end_turn");
    }
  });
});
