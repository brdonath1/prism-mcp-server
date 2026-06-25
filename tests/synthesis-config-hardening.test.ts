// M-005 — synthesis transport/model/budget config hardening (brief-465 Task D).
// SRV-50 ([1m]/bare-alias guard), SRV-60 (widened gate), SRV-61 (single-source
// timeout), SRV-62 (model-aware chars/token).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveCallSiteRouting, resolveCallSiteTimeout } from "../src/ai/client.js";
import {
  computeSynthesisEnabled,
  synthesisCharsPerToken,
  SYNTHESIS_MODEL,
  SYNTHESIS_TIMEOUT_MS,
  CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS,
} from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SRV-50 — a Claude-Code-only model override is dropped on the messages_api path", () => {
  it("drops a [1m]-suffixed PDU model when transport is unset (defaults to messages_api)", () => {
    // The audit's missing_test: SYNTHESIS_PDU_MODEL='claude-sonnet-4-6[1m]' with
    // transport typo'd/unset must NOT reach callMessagesApi as the [1m] id.
    vi.stubEnv("SYNTHESIS_PDU_MODEL", "claude-sonnet-4-6[1m]");
    vi.stubEnv("SYNTHESIS_PDU_TRANSPORT", "");
    const routing = resolveCallSiteRouting("pdu");
    expect(routing.transport).toBe("messages_api");
    expect(routing.model).not.toContain("[1m]");
    expect(routing.model).toBe(SYNTHESIS_MODEL);
    expect(routing.modelOverridden).toBe(false);
  });

  it("drops a bare alias (no claude- prefix) on the messages_api path", () => {
    vi.stubEnv("SYNTHESIS_BRIEF_MODEL", "opus");
    const routing = resolveCallSiteRouting("brief");
    expect(routing.model).toBe(SYNTHESIS_MODEL);
    expect(routing.modelOverridden).toBe(false);
  });

  it("KEEPS the [1m] model when transport IS cc_subprocess (valid CC routing)", () => {
    vi.stubEnv("SYNTHESIS_PDU_MODEL", "claude-sonnet-4-6[1m]");
    vi.stubEnv("SYNTHESIS_PDU_TRANSPORT", "cc_subprocess");
    const routing = resolveCallSiteRouting("pdu");
    expect(routing.transport).toBe("cc_subprocess");
    expect(routing.model).toBe("claude-sonnet-4-6[1m]");
    expect(routing.modelOverridden).toBe(true);
  });

  it("keeps a valid claude- API model override on the messages_api path", () => {
    vi.stubEnv("SYNTHESIS_BRIEF_MODEL", "claude-opus-4-8");
    const routing = resolveCallSiteRouting("brief");
    expect(routing.model).toBe("claude-opus-4-8");
    expect(routing.modelOverridden).toBe(true);
  });
});

describe("SRV-61 — single-source per-call-site timeout", () => {
  it("returns the CC ceiling for cc_subprocess, the baseline otherwise", () => {
    vi.stubEnv("SYNTHESIS_DRAFT_TRANSPORT", "cc_subprocess");
    expect(resolveCallSiteTimeout("draft")).toBe(CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS);
    vi.stubEnv("SYNTHESIS_DRAFT_TRANSPORT", "");
    expect(resolveCallSiteTimeout("draft")).toBe(SYNTHESIS_TIMEOUT_MS);
  });
});

describe("SRV-60 — SYNTHESIS_ENABLED widened to the OAuth + cc_subprocess deployment", () => {
  it("enabled when ANTHROPIC_API_KEY is present", () => {
    expect(computeSynthesisEnabled({ ANTHROPIC_API_KEY: "k" })).toBe(true);
  });
  it("enabled when an OAuth token is present AND a call-site routes to cc_subprocess", () => {
    expect(
      computeSynthesisEnabled({ CLAUDE_CODE_OAUTH_TOKEN: "t", SYNTHESIS_PDU_TRANSPORT: "cc_subprocess" }),
    ).toBe(true);
  });
  it("DISABLED when only the OAuth token is present but no call-site routes to cc_subprocess", () => {
    expect(computeSynthesisEnabled({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(false);
  });
  it("DISABLED when nothing is configured", () => {
    expect(computeSynthesisEnabled({})).toBe(false);
  });
});

describe("SRV-62 — model-aware chars-per-token", () => {
  it("keeps explicit Fable overrides on the conservative historical ratio", () => {
    expect(synthesisCharsPerToken("claude-fable-5")).toBe(2.7);
    expect(synthesisCharsPerToken("claude-opus-4-8")).toBe(3.5);
    expect(synthesisCharsPerToken("claude-sonnet-4-6")).toBe(3.5);
  });
  it("the resolved default synthesis model maps to its calibrated ratio", () => {
    expect(synthesisCharsPerToken(SYNTHESIS_MODEL)).toBe(3.5);
  });
});
