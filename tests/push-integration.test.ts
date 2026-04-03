/**
 * Integration tests for prism_push tool.
 * Tests the complete push flow with mocked GitHub API:
 * validate-all-or-push-none, SHA fetch → push → verify, conflict retry.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the GitHub client
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fetchFile, pushFile } from "../src/github/client.js";
import { registerPush } from "../src/tools/push.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);

/** Helper: invoke prism_push via McpServer internal handler. */
async function callPushTool(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerPush(server);

  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_push"];
  if (!tool) throw new Error("Tool not registered");

  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-push-1",
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

// ── Validate-all-or-push-none ──────────────────────────────────────────────────

describe("prism_push validate-all-or-push-none", () => {
  it("pushes nothing if ANY file fails validation", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "# Handoff\nValid content\n<!-- EOF: handoff.md -->",
          message: "prism: update handoff",
        },
        {
          path: "session-log.md",
          content: "# Session Log\nValid content\n<!-- EOF: wrong-filename.md -->",
          message: "prism: update session log",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(data.files_failed).toBe(2);
    // pushFile should NEVER have been called
    expect(mockPushFile).not.toHaveBeenCalled();
    // The second file should have a validation error about EOF sentinel
    expect(data.results[1].validation_errors.length).toBeGreaterThan(0);
    expect(data.results[1].validation_errors[0]).toContain("EOF");
  });

  it("pushes nothing if a commit message has invalid prefix", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "# Glossary\nTerms here\n<!-- EOF: glossary.md -->",
          message: "feat: this prefix is not allowed",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.files_pushed).toBe(0);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("pushes nothing if content is empty", async () => {
    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "handoff.md",
          content: "",
          message: "prism: empty push",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

// ── Successful push flow ────────────────────────────────────────────────────────

describe("prism_push successful flow", () => {
  it("pushes all files when validation passes", async () => {
    const testSha = "abc123def456";
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: testSha });
    mockFetchFile.mockResolvedValue({ content: "content", sha: testSha, size: 100 });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms here\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(1);
    expect(data.files_failed).toBe(0);
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].verified).toBe(true);
    expect(data.results[0].sha).toBe(testSha);
    expect(mockPushFile).toHaveBeenCalledTimes(1);
  });

  it("pushes multiple files in parallel and verifies each", async () => {
    const sha1 = "sha_glossary_123";
    const sha2 = "sha_eliminated_456";

    mockPushFile
      .mockResolvedValueOnce({ success: true, size: 100, sha: sha1 })
      .mockResolvedValueOnce({ success: true, size: 200, sha: sha2 });

    mockFetchFile
      .mockResolvedValueOnce({ content: "glossary content", sha: sha1, size: 100 })
      .mockResolvedValueOnce({ content: "eliminated content", sha: sha2, size: 200 });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nEntries\n<!-- EOF: eliminated.md -->",
          message: "prism: update eliminated",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(2);
    expect(data.total_bytes).toBe(300);
    expect(mockPushFile).toHaveBeenCalledTimes(2);
  });

  it("reports verification failure when SHA mismatch", async () => {
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "push_sha_abc" });
    mockFetchFile.mockResolvedValue({ content: "content", sha: "different_sha_xyz", size: 100 });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].verified).toBe(false);
  });
});

// ── Push failure handling ───────────────────────────────────────────────────────

describe("prism_push failure handling", () => {
  it("reports push failure for individual files without failing others", async () => {
    mockPushFile
      .mockResolvedValueOnce({ success: true, size: 100, sha: "sha_ok" })
      .mockResolvedValueOnce({ success: false, size: 0, sha: "", error: "409 Conflict" });

    mockFetchFile.mockResolvedValue({ content: "ok", sha: "sha_ok", size: 100 });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nOK content\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
        {
          path: "eliminated.md",
          content: "# Eliminated\nContent\n<!-- EOF: eliminated.md -->",
          message: "prism: update eliminated",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    const succeeded = data.results.filter((r: any) => r.success);
    const failed = data.results.filter((r: any) => !r.success);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  it("handles thrown errors during push gracefully", async () => {
    mockPushFile.mockRejectedValue(new Error("Network timeout"));

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->",
          message: "prism: update glossary",
        },
      ],
      skip_validation: false,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.results[0].success).toBe(false);
    expect(typeof data.results[0].error).toBe("string");
  });
});

// ── skip_validation ─────────────────────────────────────────────────────────────

describe("prism_push skip_validation", () => {
  it("pushes without validation when skip_validation is true", async () => {
    mockPushFile.mockResolvedValue({ success: true, size: 50, sha: "abc" });
    mockFetchFile.mockResolvedValue({ content: "x", sha: "abc", size: 50 });

    const result = await callPushTool({
      project_slug: "test-project",
      files: [
        {
          path: "glossary.md",
          content: "no EOF sentinel, invalid content",
          message: "invalid prefix: this would normally fail",
        },
      ],
      skip_validation: true,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    expect(data.files_pushed).toBe(1);
    expect(mockPushFile).toHaveBeenCalledTimes(1);
  });
});
