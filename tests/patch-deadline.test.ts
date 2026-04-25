/**
 * S63 Phase 1 Brief 3 — patch.ts wall-clock deadline.
 *
 * Two test surfaces:
 *   1. Config-parse semantics for PATCH_WALL_CLOCK_DEADLINE_MS (mirrors
 *      cc-dispatch-sync-timeout-config.test.ts — vi.resetModules() +
 *      dynamic import per case so config.ts re-reads process.env).
 *   2. End-to-end behavior: when safeMutation's underlying primitives stall
 *      past the deadline, the tool returns DEADLINE_EXCEEDED and
 *      safeMutation emits the matching diagnostic.
 *
 * Kept in a dedicated file so the env-var manipulation doesn't leak into
 * patch-integration.test.ts (which expects the default 60s budget).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL_DEADLINE_ENV = process.env.PATCH_WALL_CLOCK_DEADLINE_MS;
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

afterEach(() => {
  if (ORIGINAL_DEADLINE_ENV === undefined) {
    delete process.env.PATCH_WALL_CLOCK_DEADLINE_MS;
  } else {
    process.env.PATCH_WALL_CLOCK_DEADLINE_MS = ORIGINAL_DEADLINE_ENV;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("PATCH_WALL_CLOCK_DEADLINE_MS — env-var parsing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to 60_000 when env var is unset", async () => {
    delete process.env.PATCH_WALL_CLOCK_DEADLINE_MS;
    const config = await import("../src/config.js");
    expect(config.PATCH_WALL_CLOCK_DEADLINE_MS).toBe(60_000);
  });

  it("honors an explicit numeric value", async () => {
    process.env.PATCH_WALL_CLOCK_DEADLINE_MS = "12345";
    const config = await import("../src/config.js");
    expect(config.PATCH_WALL_CLOCK_DEADLINE_MS).toBe(12_345);
  });
});

describe("prism_patch surfaces DEADLINE_EXCEEDED when safeMutation exceeds the budget", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns DEADLINE_EXCEEDED with the diagnostic when the read stalls past the deadline", async () => {
    // Force a tiny deadline so the test completes quickly — the github
    // primitives will be mocked to never settle within that window.
    process.env.PATCH_WALL_CLOCK_DEADLINE_MS = "20";

    const NEVER = new Promise<never>(() => {
      /* never resolves — safeMutation's deadline timer must win the race */
    });

    vi.doMock("../src/github/client.js", () => ({
      // getHeadSha resolves immediately; fetchFile hangs forever, so the
      // deadline timer fires first and DEADLINE_EXCEEDED is returned.
      getHeadSha: vi.fn().mockResolvedValue("HEAD_X"),
      fetchFile: vi.fn().mockReturnValue(NEVER),
      pushFile: vi.fn(),
      createAtomicCommit: vi.fn(),
    }));
    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocPath: vi.fn().mockResolvedValue({
        path: ".prism/task-queue.md",
        content: "# placeholder\n<!-- EOF: task-queue.md -->\n",
        sha: "tq-sha",
        legacy: false,
      }),
    }));

    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerPatch } = await import("../src/tools/patch.js");

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerPatch(server);
    const tool = (server as any)._registeredTools["prism_patch"];
    const mockExtra = {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "test-patch-deadline",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    };

    const result = await tool.handler(
      {
        project_slug: "test-project",
        file: "task-queue.md",
        patches: [
          { operation: "append", section: "## In Progress", content: "- item" },
        ],
      },
      mockExtra,
    );

    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(data.success).toBe(false);
    expect(data.code).toBe("DEADLINE_EXCEEDED");

    const codes = (data.diagnostics as Array<{ code: string }>).map(
      (d) => d.code,
    );
    expect(codes).toContain("DEADLINE_EXCEEDED");
  });
});
