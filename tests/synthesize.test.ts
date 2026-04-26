/**
 * Tests for the prism_synthesize tool — D-156 §3.6 / Phase 2 PR 4 §5.
 *
 * Mirrors the dispatch-test mock pattern from tests/finalize.test.ts so
 * that `generateIntelligenceBrief` and `generatePendingDocUpdates` are
 * mockable. PR 4 widened the tool to fire BOTH synthesis functions in
 * parallel via `Promise.allSettled`; these tests pin that behavior.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import { registerSynthesize } from "../src/tools/synthesize.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
} from "../src/ai/synthesize.js";

const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockGenerateBrief = vi.mocked(generateIntelligenceBrief);
const mockGeneratePending = vi.mocked(generatePendingDocUpdates);

function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: Function,
    ) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

function getHandler() {
  const { server, handlers } = createServerStub();
  registerSynthesize(server as any);
  const handler = handlers.prism_synthesize;
  if (!handler) throw new Error("prism_synthesize handler was not registered");
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prism_synthesize — generate mode (parallel dispatch)", () => {
  it("invokes BOTH generateIntelligenceBrief AND generatePendingDocUpdates exactly once each", async () => {
    mockGenerateBrief.mockResolvedValue({ success: true, bytes_written: 1000 });
    mockGeneratePending.mockResolvedValue({ success: true, bytes_written: 500 });

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 70,
    });

    expect(mockGenerateBrief).toHaveBeenCalledTimes(1);
    expect(mockGenerateBrief).toHaveBeenCalledWith("prism", 70);
    expect(mockGeneratePending).toHaveBeenCalledTimes(1);
    expect(mockGeneratePending).toHaveBeenCalledWith("prism", 70);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.intelligence_brief.success).toBe(true);
    expect(payload.pending_doc_updates.success).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("partial success — brief succeeds, pending fails — returns both outcomes, not isError", async () => {
    mockGenerateBrief.mockResolvedValue({ success: true, bytes_written: 1000 });
    mockGeneratePending.mockResolvedValue({ success: false, error: "model returned malformed JSON" });

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 70,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.intelligence_brief.success).toBe(true);
    expect(payload.pending_doc_updates.success).toBe(false);
    expect(payload.pending_doc_updates.error).toBe("model returned malformed JSON");
    // Partial success is not isError — caller asked for two, one happened.
    expect(result.isError).toBeUndefined();

    // Diagnostics emit a failure entry for the failed kind.
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("SYNTHESIS_RETRY");
    const retryDiag = payload.diagnostics.find((d: any) => d.code === "SYNTHESIS_RETRY");
    expect(retryDiag.context.synthesis_kind).toBe("pending_doc_updates");
  });

  it("total failure — both fail — surfaces both errors and sets isError: true", async () => {
    mockGenerateBrief.mockResolvedValue({ success: false, error: "request timed out after 60000ms" });
    mockGeneratePending.mockResolvedValue({ success: false, error: "API returned 500" });

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 70,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.intelligence_brief.success).toBe(false);
    expect(payload.pending_doc_updates.success).toBe(false);
    expect(result.isError).toBe(true);

    // Both diagnostics fire; the brief's was a timeout, the pending's was retry.
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("SYNTHESIS_TIMEOUT");
    expect(codes).toContain("SYNTHESIS_RETRY");
    const timeoutDiag = payload.diagnostics.find((d: any) => d.code === "SYNTHESIS_TIMEOUT");
    expect(timeoutDiag.context.synthesis_kind).toBe("intelligence_brief");
    const retryDiag = payload.diagnostics.find((d: any) => d.code === "SYNTHESIS_RETRY");
    expect(retryDiag.context.synthesis_kind).toBe("pending_doc_updates");
  });

  it("rejected promise from generatePendingDocUpdates is captured as a failure outcome", async () => {
    mockGenerateBrief.mockResolvedValue({ success: true, bytes_written: 1000 });
    mockGeneratePending.mockRejectedValue(new Error("network unreachable"));

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 70,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.intelligence_brief.success).toBe(true);
    expect(payload.pending_doc_updates.success).toBe(false);
    expect(payload.pending_doc_updates.error).toContain("network unreachable");
  });
});

describe("prism_synthesize — status mode parity", () => {
  it("returns shape with both intelligence_brief AND pending_doc_updates fields", async () => {
    mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
      if (doc === "intelligence-brief.md") {
        return {
          path: ".prism/intelligence-brief.md",
          content: "# Brief\n\nLast synthesized: S70 (04-25-26)\n\nBody.",
          sha: "sha1",
        } as any;
      }
      if (doc === "pending-doc-updates.md") {
        return {
          path: ".prism/pending-doc-updates.md",
          content: "# Pending\n\nLast synthesized: S70 (04-25-26)\n\nBody.",
          sha: "sha2",
        } as any;
      }
      throw new Error("not found");
    });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", mode: "status" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.intelligence_brief.exists).toBe(true);
    expect(payload.intelligence_brief.last_synthesized).toBe("S70 (04-25-26)");
    expect(payload.pending_doc_updates.exists).toBe(true);
    expect(payload.pending_doc_updates.last_synthesized).toBe("S70 (04-25-26)");
    expect(payload.synthesis_enabled).toBe(true);
  });

  it("status mode reports exists:false when an artifact has not been generated yet", async () => {
    // Brief exists, pending does not.
    mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
      if (doc === "intelligence-brief.md") {
        return {
          path: ".prism/intelligence-brief.md",
          content: "# Brief\n\nLast synthesized: S70 (04-25-26)\n\nBody.",
          sha: "sha1",
        } as any;
      }
      throw new Error("404 not found");
    });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", mode: "status" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.intelligence_brief.exists).toBe(true);
    expect(payload.pending_doc_updates.exists).toBe(false);
    expect(payload.pending_doc_updates.size_bytes).toBeUndefined();
    // Missing artifact must not surface as a tool error.
    expect(result.isError).toBeUndefined();
  });
});
