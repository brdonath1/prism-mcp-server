// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the GitHub client
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile } from "../src/github/client.js";
import { registerScaleHandoff } from "../src/tools/scale.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);

/** Small handoff (<10KB) with scalable content for testing. */
const SMALL_HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item
2. Second critical item

## Session History
### Session 1
Did something early.
### Session 2
Did something else.
### Session 3
More work here.
### Session 4
Some work.
### Session 5
Latest work.

## Where We Are
Currently working on feature X.

## Open Questions
1. Something resolved
2. Still open question

<!-- EOF: handoff.md -->`;

/** Handoff with no scalable content. */
const CLEAN_HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item

## Where We Are
Working on X.

<!-- EOF: handoff.md -->`;

/**
 * Helper: invoke the scale_handoff tool via the McpServer's internal handler.
 * We register the tool and then directly call the registered handler via
 * the server's request handler mechanism.
 */
async function callScaleTool(
  args: Record<string, unknown>,
  meta?: { progressToken?: string | number },
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerScaleHandoff(server);

  // Access the registered tool handler through the internal _registeredTools object
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_scale_handoff"];
  if (!tool) throw new Error("Tool not registered");

  // Build a mock extra object
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: meta ? { progressToken: meta.progressToken } : undefined,
    requestId: "test-req-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };

  const result = await tool.handler(args, mockExtra);
  return result as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── analyze mode ─────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=analyze", () => {
  it("returns a valid plan without pushing anything", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));

    const result = await callScaleTool({ project_slug: "test-project", action: "analyze" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("analyze");
    expect(data.project).toBe("test-project");
    expect(data.before_size_bytes).toBeGreaterThan(0);
    expect(data.plan).toBeDefined();
    expect(data.plan.project_slug).toBe("test-project");
    expect(data.plan.actions).toBeInstanceOf(Array);
    expect(data.plan.actions.length).toBeGreaterThan(0);

    // Verify no pushes were made
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("returns empty actions for a clean handoff", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const result = await callScaleTool({ project_slug: "test-project", action: "analyze" });

    const data = parseResult(result);
    expect(data.action).toBe("analyze");
    expect(data.plan.actions).toHaveLength(0);
    expect(data.warnings).toContain("No scalable content identified. Handoff may already be optimally sized.");
  });
});

// ── execute mode ─────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=execute", () => {
  it("executes a plan and pushes files", async () => {
    const plan = {
      project_slug: "test-project",
      before_size_bytes: 500,
      actions: [
        {
          description: "Archive 2 old session entries to session-log.md",
          source_section: "Session History",
          destination_file: "session-log.md",
          bytes_moved: 100,
          content_to_move: "### Session 1\nDid something.\n### Session 2\nDid more.",
        },
      ],
    };

    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
    ]));
    mockPushFile.mockResolvedValue({ success: true, size: 200, sha: "new-sha" });

    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
      plan,
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("execute");
    expect(data.actions_executed).toBeGreaterThanOrEqual(1);

    // Should have pushed the destination file + handoff
    expect(mockPushFile).toHaveBeenCalled();
  });

  it("rejects execute without a plan", async () => {
    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain("Missing 'plan' parameter");
  });

  it("rejects execute with mismatched project_slug", async () => {
    const plan = {
      project_slug: "other-project",
      before_size_bytes: 500,
      actions: [],
    };

    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
      plan,
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain("does not match");
  });
});

// ── full mode ────────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=full", () => {
  it("works end-to-end for a small handoff", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));
    mockPushFile.mockResolvedValue({ success: true, size: 200, sha: "new-sha" });

    const result = await callScaleTool({ project_slug: "test-project", action: "full" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("full");
    expect(data.before_size_bytes).toBeGreaterThan(0);
    expect(data.after_size_bytes).toBeDefined();
    expect(data.elapsed_ms).toBeDefined();
    expect(data.timed_out).toBe(false);
  });

  it("defaults to full mode when action is not specified", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const result = await callScaleTool({ project_slug: "test-project" });

    const data = parseResult(result);
    expect(data.action).toBe("full");
    expect(data.warnings).toContain("No scalable content identified. Handoff may already be optimally sized.");
  });
});

// ── structured error output ──────────────────────────────────────────────────

describe("prism_scale_handoff structured errors", () => {
  it("returns structured error on GitHub API failure", async () => {
    mockFetchFile.mockRejectedValue(new Error("GitHub PAT is invalid or expired."));

    const result = await callScaleTool({ project_slug: "test-project", action: "full" });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("Scale operation failed");
    expect(data.stage).toBeDefined();
    expect(data.elapsed_ms).toBeDefined();
    expect(data.detail).toContain("PAT");
    expect(data.project).toBe("test-project");
    expect(data.action).toBe("full");
  });
});

// ── progress notifications ───────────────────────────────────────────────────

describe("prism_scale_handoff progress notifications", () => {
  it("sends progress notifications when progressToken is provided", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));
    mockPushFile.mockResolvedValue({ success: true, size: 200, sha: "new-sha" });

    // We need to access the sendNotification mock — rebuild the tool invocation
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerScaleHandoff(server);

    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["prism_scale_handoff"];
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await tool!.handler(
      { project_slug: "test-project", action: "full" },
      {
        signal: new AbortController().signal,
        _meta: { progressToken: "test-token-42" },
        requestId: "test-req-1",
        sendNotification,
        sendRequest: vi.fn().mockResolvedValue(undefined),
      },
    );

    // Should have sent multiple progress notifications
    expect(sendNotification).toHaveBeenCalled();
    const calls = sendNotification.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Verify notification structure
    const firstCall = calls[0][0];
    expect(firstCall.method).toBe("notifications/progress");
    expect(firstCall.params.progressToken).toBe("test-token-42");
    expect(firstCall.params.progress).toBeGreaterThanOrEqual(1);
    expect(firstCall.params.total).toBe(6);
    expect(firstCall.params.message).toBeDefined();
  });

  it("does not send progress notifications when no progressToken", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerScaleHandoff(server);

    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["prism_scale_handoff"];
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await tool!.handler(
      { project_slug: "test-project", action: "full" },
      {
        signal: new AbortController().signal,
        _meta: {},
        requestId: "test-req-1",
        sendNotification,
        sendRequest: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
