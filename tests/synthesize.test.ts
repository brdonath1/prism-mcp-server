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

describe("prism_synthesize — generate mode (brief-460 / INS-331 fire-and-forget)", () => {
  it("invokes BOTH generateIntelligenceBrief AND generatePendingDocUpdates exactly once each and responds with the started payload", async () => {
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
    expect(payload.status).toBe("started");
    expect(payload.synthesis_outcome).toBe("background");
    expect(payload.intelligence_brief.status).toBe("started");
    expect(payload.pending_doc_updates.status).toBe("started");
    expect(payload.status_hint).toContain("mode=status");
    expect(result.isError).toBeUndefined();
  });

  it("INS-331 pin: generate RETURNS IMMEDIATELY — the response does not wait for either synthesis leg to settle", async () => {
    // Both legs hang on a deferred we control — measured live (S172), the
    // pre-460 handler held the request open for the full synthesis duration
    // (brief 107s, PDU ~8 min) and the MCP client transport dropped. The
    // handler must resolve while both legs are still pending.
    let resolveBrief!: (v: { success: boolean; bytes_written: number }) => void;
    let resolvePending!: (v: { success: boolean; bytes_written: number }) => void;
    mockGenerateBrief.mockReturnValue(
      new Promise((res) => { resolveBrief = res; }) as any,
    );
    mockGeneratePending.mockReturnValue(
      new Promise((res) => { resolvePending = res; }) as any,
    );

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 72,
    });

    // The handler has already returned while both legs are unresolved.
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("started");
    expect(payload.synthesis_outcome).toBe("background");
    expect(result.isError).toBeUndefined();
    expect(mockGenerateBrief).toHaveBeenCalledTimes(1);
    expect(mockGeneratePending).toHaveBeenCalledTimes(1);

    // Release the background legs so nothing leaks into other tests.
    resolveBrief({ success: true, bytes_written: 1 });
    resolvePending({ success: true, bytes_written: 1 });
    await new Promise((res) => setImmediate(res));
  });

  it("a background leg failure does NOT affect the already-sent started response (failures land in logs, status is the observability path)", async () => {
    mockGenerateBrief.mockResolvedValue({ success: true, bytes_written: 1000 });
    mockGeneratePending.mockRejectedValue(new Error("network unreachable"));

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      mode: "generate",
      session_number: 70,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("started");
    expect(result.isError).toBeUndefined();
    // Let the rejected background promise settle inside the handler's
    // allSettled wrapper (it must not become an unhandled rejection).
    await new Promise((res) => setImmediate(res));
  });

  it("still validates session_number synchronously (missing → isError, nothing dispatched)", async () => {
    const handler = getHandler();
    const result = await handler({ project_slug: "prism", mode: "generate" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain("session_number");
    expect(mockGenerateBrief).not.toHaveBeenCalled();
    expect(mockGeneratePending).not.toHaveBeenCalled();
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
