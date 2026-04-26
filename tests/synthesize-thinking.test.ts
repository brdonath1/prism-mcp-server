/**
 * S71 Phase 3a — adaptive-thinking flag on synthesize() and the two
 * fire-and-forget callers.
 *
 *   1. synthesize() called WITHOUT a thinking arg → request body MUST NOT
 *      include `thinking`. Preserves CS-1 (draft) behavior.
 *   2. synthesize() called WITH thinking:true → request body MUST include
 *      `thinking: { type: "adaptive" }`. (Opus 4.7 rejects the legacy
 *      "enabled" + budget_tokens form with HTTP 400.)
 *   3. A mock API response carrying both `thinking` and `text` content blocks
 *      collapses to text only — the `block.type === "text"` filter in
 *      src/ai/client.ts already discards thinking blocks; verify nothing
 *      leaks into result.content.
 *   4. generateIntelligenceBrief (CS-2) forwards thinking:true to synthesize().
 *   5. generatePendingDocUpdates (CS-3) forwards thinking:true to synthesize().
 *
 * Keep these tests at the unit boundary — they are not finalize-integration
 * tests; the draftPhase NOT-thinking assertion lives in finalize-integration
 * and finalize-draft-timeout.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface CapturedPayload {
  thinking?: { type: string };
  model?: string;
  max_tokens?: number;
  [k: string]: unknown;
}

describe("synthesize() — adaptive thinking parameter (Phase 3a)", () => {
  const savedEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv.ANTHROPIC_API_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
    }
    vi.resetModules();
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("omits the thinking field when called without the thinking flag (default)", async () => {
    const captured: CapturedPayload[] = [];
    const createSpy = vi.fn().mockImplementation((payload: CapturedPayload) => {
      captured.push(payload);
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });

    const { synthesize } = await import("../src/ai/client.js");

    const result = await synthesize("sys", "user");
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("thinking");
  });

  it("sets thinking: { type: 'adaptive' } when thinking flag is true", async () => {
    const captured: CapturedPayload[] = [];
    const createSpy = vi.fn().mockImplementation((payload: CapturedPayload) => {
      captured.push(payload);
      return Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });

    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });

    const { synthesize } = await import("../src/ai/client.js");

    const result = await synthesize("sys", "user", undefined, undefined, undefined, true);
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].thinking).toEqual({ type: "adaptive" });
  });

  it("strips thinking content blocks from the response — only text reaches result.content", async () => {
    const createSpy = vi.fn().mockResolvedValue({
      content: [
        // The Anthropic API may emit thinking blocks alongside text when
        // adaptive thinking is on. The extraction filter must drop them.
        { type: "thinking", thinking: "internal monologue should never leak" },
        { type: "text", text: "first text block" },
        { type: "thinking", thinking: "another internal block" },
        { type: "text", text: "second text block" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create: createSpy };
        constructor(_opts: unknown) {}
      }
      return { default: MockAnthropic };
    });

    const { synthesize } = await import("../src/ai/client.js");

    const result = await synthesize("sys", "user", undefined, undefined, undefined, true);
    if (!result.success) throw new Error("expected success");
    expect(result.content).toBe("first text block\nsecond text block");
    expect(result.content).not.toContain("internal monologue");
    expect(result.content).not.toContain("internal block");
  });
});

// ---------------------------------------------------------------------------
// CS-2 / CS-3 — fire-and-forget callers must forward thinking: true.
// ---------------------------------------------------------------------------

describe("generateIntelligenceBrief (CS-2) — forwards thinking: true to synthesize()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/ai/client.js");
    vi.doUnmock("../src/github/client.js");
    vi.doUnmock("../src/utils/doc-resolver.js");
    vi.doUnmock("../src/ai/synthesis-tracker.js");
    vi.doUnmock("../src/config.js");
  });

  it("passes thinking: true as the 6th positional arg to synthesize()", async () => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();

    const synthesizeSpy = vi.fn().mockResolvedValue({
      success: true,
      content:
        "## Project State\n\n## Standing Rules & Workflows\n\n## Active Operational Knowledge\n\n## Recent Trajectory\n\n## Risk Flags\n\n## Quality Audit\n\n<!-- EOF: intelligence-brief.md -->",
      input_tokens: 100,
      output_tokens: 50,
      model: "claude-opus-4-7",
    });

    vi.doMock("../src/ai/client.js", () => ({ synthesize: synthesizeSpy }));
    vi.doMock("../src/github/client.js", () => ({
      pushFile: vi.fn().mockResolvedValue({ commit_sha: "abc", path: ".prism/intelligence-brief.md", size: 1024 }),
      fetchFiles: vi.fn(),
    }));
    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: "stub", sha: "h", size: 4 }],
        ]),
      ),
      resolveDocPushPath: vi.fn().mockResolvedValue(".prism/intelligence-brief.md"),
    }));
    vi.doMock("../src/ai/synthesis-tracker.js", () => ({
      recordSynthesisEvent: vi.fn(),
    }));
    vi.doMock("../src/config.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, SYNTHESIS_ENABLED: true };
    });

    const { generateIntelligenceBrief } = await import("../src/ai/synthesize.js");

    const outcome = await generateIntelligenceBrief("test-project", 71);
    expect(outcome.success).toBe(true);
    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    const args = synthesizeSpy.mock.calls[0];
    // synthesize(systemPrompt, userContent, maxTokens, timeoutMs, maxRetries, thinking)
    expect(args[5]).toBe(true);
  });
});

describe("generatePendingDocUpdates (CS-3) — forwards thinking: true to synthesize()", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/ai/client.js");
    vi.doUnmock("../src/github/client.js");
    vi.doUnmock("../src/utils/doc-resolver.js");
    vi.doUnmock("../src/ai/synthesis-tracker.js");
    vi.doUnmock("../src/config.js");
  });

  it("passes thinking: true as the 6th positional arg to synthesize()", async () => {
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
    vi.resetModules();

    const synthesizeSpy = vi.fn().mockResolvedValue({
      success: true,
      content:
        "# Pending Doc Updates\n\n## architecture.md\n\n## glossary.md\n\n## insights.md\n\n## No Updates Needed\n\n<!-- EOF: pending-doc-updates.md -->",
      input_tokens: 100,
      output_tokens: 50,
      model: "claude-opus-4-7",
    });

    vi.doMock("../src/ai/client.js", () => ({ synthesize: synthesizeSpy }));
    vi.doMock("../src/github/client.js", () => ({
      pushFile: vi.fn().mockResolvedValue({ commit_sha: "abc", path: ".prism/pending-doc-updates.md", size: 1024 }),
      fetchFiles: vi.fn(),
    }));
    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: "stub", sha: "h", size: 4 }],
        ]),
      ),
      resolveDocPushPath: vi.fn().mockResolvedValue(".prism/pending-doc-updates.md"),
    }));
    vi.doMock("../src/ai/synthesis-tracker.js", () => ({
      recordSynthesisEvent: vi.fn(),
    }));
    vi.doMock("../src/config.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return { ...actual, SYNTHESIS_ENABLED: true };
    });

    const { generatePendingDocUpdates } = await import("../src/ai/synthesize.js");

    const outcome = await generatePendingDocUpdates("test-project", 71);
    expect(outcome.success).toBe(true);
    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    const args = synthesizeSpy.mock.calls[0];
    // synthesize(systemPrompt, userContent, maxTokens, timeoutMs, maxRetries, thinking)
    expect(args[5]).toBe(true);
  });
});
