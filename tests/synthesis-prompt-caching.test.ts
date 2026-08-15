/**
 * Direct-Anthropic synthesis routing + prompt caching (speed change; no intended
 * quality change). Three concerns:
 *
 *   (a) claude-haiku-4-5 (the mechanical-draft tier) and claude-sonnet-5 (the
 *       brief / PDU tier) resolve cleanly as synthesis models via the model
 *       registry — a DOCUMENTED context window on the API surface synthesis
 *       uses, NOT the undocumented 200K floor.
 *   (b) the messages_api synthesis transport carries `cache_control` on the
 *       large, stable input block for a representative large input, and leaves
 *       small/volatile inputs as a plain string (no cache_control).
 *   (c) a call site routed to a non-messages_api transport (cc_subprocess) is
 *       unaffected by the caching change — the Messages API is never touched, so
 *       no cache_control is applied there.
 *
 * Keep these at the unit boundary — the SDK and the cc_subprocess wrapper are
 * mocked; nothing hits the network.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CONTEXT_WINDOW_FLOOR_TOKENS,
  MODEL_CAPABILITIES,
  resolveContextWindow,
} from "../src/models.js";

// Fixed clock so nothing in these assertions drifts with wall time.
const AT_SEED = new Date("2026-07-31T00:00:00Z");

// ---------------------------------------------------------------------------
// (a) Model-registry resolution — Haiku 4.5 + Sonnet 5 as synthesis models.
// ---------------------------------------------------------------------------

describe("synthesis model resolution — Haiku 4.5 and Sonnet 5 (registry, non-floor)", () => {
  it("claude-haiku-4-5 resolves to a DOCUMENTED api window, not the undocumented floor", () => {
    const r = resolveContextWindow("claude-haiku-4-5", "api", AT_SEED);
    expect(r.matched).toBe("haiku-4-5");
    expect(r.source).toBe("documented");
    // The 200K window is Haiku 4.5's real ceiling — numerically equal to the
    // floor, so the meaningful assertion is that it resolved via the registry
    // (documented, no fallback), not via the disclosed-floor degradation path.
    expect(r.tokens).toBe(200_000);
    expect(r.fallback_reason).toBeUndefined();
  });

  it("does NOT fall back to the disclosed floor for Haiku 4.5 on any surface", () => {
    for (const surface of ["chat", "claude_code", "api"] as const) {
      const r = resolveContextWindow("claude-haiku-4-5", surface, AT_SEED);
      expect(r.source, `${surface}.source`).not.toBe("undocumented_floor");
      expect(r.fallback_reason, `${surface}.fallback_reason`).toBeUndefined();
    }
  });

  it("resolves the full dated Haiku alias to the same registry cell", () => {
    const r = resolveContextWindow("claude-haiku-4-5-20251001", "api", AT_SEED);
    expect(r.matched).toBe("haiku-4-5");
    expect(r.source).toBe("documented");
  });

  it("Haiku 4.5 is surface-complete, consistent with claude-sonnet-5 / claude-opus-4-8", () => {
    const haiku = MODEL_CAPABILITIES["haiku-4-5"];
    expect(haiku).toBeTruthy();
    for (const surface of ["chat", "claude_code", "api"] as const) {
      expect(haiku[surface], `haiku-4-5.${surface}`).toBeTruthy();
    }
    // The two reference synthesis models carry all three surfaces too.
    expect(MODEL_CAPABILITIES["sonnet-5"].api).toBeTruthy();
    expect(MODEL_CAPABILITIES["opus-4-8"].api).toBeTruthy();
  });

  it("claude-sonnet-5 resolves to a documented 1M api window", () => {
    const r = resolveContextWindow("claude-sonnet-5", "api", AT_SEED);
    expect(r.matched).toBe("sonnet-5");
    expect(r.source).toBe("documented");
    expect(r.tokens).toBe(1_000_000);
    expect(r.fallback_reason).toBeUndefined();
    // Sanity: a genuinely unknown model DOES hit the floor — proves the
    // assertions above are meaningful.
    const unknown = resolveContextWindow("some-unregistered-model", "api", AT_SEED);
    expect(unknown.tokens).toBe(CONTEXT_WINDOW_FLOOR_TOKENS);
    expect(unknown.source).toBe("undocumented_floor");
  });
});

// ---------------------------------------------------------------------------
// (b) messages_api transport — cache_control on the large stable input block.
// ---------------------------------------------------------------------------

interface CapturedContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
}
interface CapturedMessage {
  role: string;
  content: string | CapturedContentBlock[];
}
interface CapturedPayload {
  system?: string;
  messages: CapturedMessage[];
  [k: string]: unknown;
}

/** Comfortably above SYNTHESIS_CACHE_MIN_INPUT_CHARS (16K) — a realistic bundle. */
const LARGE_INPUT = `LIVING DOCUMENTS bundle\n${"the quick brown fox jumps over the lazy dog. ".repeat(600)}`;

describe("messages_api synthesis transport — prompt caching on the stable input", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    vi.resetModules();
    vi.doUnmock("@anthropic-ai/sdk");
  });

  function mockSdk(): CapturedPayload[] {
    const captured: CapturedPayload[] = [];
    const createSpy = vi.fn().mockImplementation((payload: CapturedPayload) => {
      captured.push(payload);
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });
    });
    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });
    return captured;
  }

  it("places cache_control on the stable user content block for a large input", async () => {
    const captured = mockSdk();
    const { synthesize } = await import("../src/ai/client.js");

    const result = await synthesize("system instructions", LARGE_INPUT);
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);

    const content = captured[0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as CapturedContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    // The stable living-doc/context bundle is the cached block.
    expect(blocks[0].text).toBe(LARGE_INPUT);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    // The per-call-varying instruction stays in `system` (the uncached tail),
    // never given a breakpoint.
    expect(captured[0].system).toBe("system instructions");
  });

  it("leaves a small/volatile input as a plain string with no cache_control", async () => {
    const captured = mockSdk();
    const { synthesize } = await import("../src/ai/client.js");

    const result = await synthesize("system instructions", "tiny volatile input");
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);

    const content = captured[0].messages[0].content;
    expect(typeof content).toBe("string");
    expect(content).toBe("tiny volatile input");
  });

  it("caching does not alter the text the model receives (byte-identical bundle)", async () => {
    const captured = mockSdk();
    const { synthesize } = await import("../src/ai/client.js");

    await synthesize("system instructions", LARGE_INPUT);
    const blocks = captured[0].messages[0].content as CapturedContentBlock[];
    // The only difference vs the pre-caching request is the marker — the text is
    // untouched, so there is no intended quality change.
    expect(blocks.map((b) => b.text).join("")).toBe(LARGE_INPUT);
  });
});

// ---------------------------------------------------------------------------
// (c) cc_subprocess transport — unaffected by the caching change.
// ---------------------------------------------------------------------------

describe("cc_subprocess transport — caching change is a no-op", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedTransport = process.env.SYNTHESIS_BRIEF_TRANSPORT;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    process.env.SYNTHESIS_BRIEF_TRANSPORT = "cc_subprocess";
    vi.resetModules();
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedTransport === undefined) delete process.env.SYNTHESIS_BRIEF_TRANSPORT;
    else process.env.SYNTHESIS_BRIEF_TRANSPORT = savedTransport;
    vi.resetModules();
    vi.doUnmock("@anthropic-ai/sdk");
    vi.doUnmock("../src/ai/cc-subprocess.js");
  });

  it("routes to cc_subprocess and never touches the Messages API (no cache_control applied)", async () => {
    const createSpy = vi.fn();
    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });

    const ccSpy = vi.fn().mockResolvedValue({
      success: true,
      content: "cc_subprocess result",
      input_tokens: 100,
      output_tokens: 50,
      model: "claude-sonnet-5",
    });
    vi.doMock("../src/ai/cc-subprocess.js", () => ({
      synthesizeViaCcSubprocess: ccSpy,
    }));

    const { synthesize } = await import("../src/ai/client.js");

    // Large input that WOULD be cached on the messages_api path — proving the
    // caching branch is bypassed entirely, not just skipped for size.
    const result = await synthesize(
      "system instructions",
      LARGE_INPUT,
      undefined,
      undefined,
      undefined,
      false,
      "brief",
    );

    expect(result.success).toBe(true);
    expect(ccSpy).toHaveBeenCalledTimes(1);
    // The Messages API (where caching lives) was never invoked.
    expect(createSpy).not.toHaveBeenCalled();
    if (result.success) {
      expect(result.transport).toBe("cc_subprocess");
      expect(result.content).toBe("cc_subprocess result");
    }
  });
});
