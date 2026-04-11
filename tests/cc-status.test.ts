// brief-104 B.5: cc_status tests
//
// Verifies the persistence helpers and the tool handler surface. GitHub
// client calls are mocked so the tests run hermetically.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  listDirectory: vi.fn(),
}));

import { fetchFile, pushFile, listDirectory } from "../src/github/client.js";
const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockListDirectory = vi.mocked(listDirectory);

import {
  readDispatchRecord,
  writeDispatchRecord,
  registerCCStatus,
  type DispatchRecord,
} from "../src/tools/cc-status.js";

function createServerStub() {
  const handlers: Record<string, Function> = {};
  return {
    server: {
      tool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: Function,
      ) {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const SAMPLE_RECORD: DispatchRecord = {
  dispatch_id: "cc-1712834400-abc123",
  repo: "platformforge-v2",
  branch: "main",
  mode: "query",
  prompt: "Find all TODO markers in src/",
  status: "running",
  started_at: "2026-04-11T12:00:00.000Z",
  agent: "claude-code",
  server_version: "4.0.0",
};

describe("readDispatchRecord", () => {
  it("parses a JSON file from the state repo", async () => {
    mockFetchFile.mockResolvedValueOnce({
      content: JSON.stringify(SAMPLE_RECORD),
      sha: "a",
      size: 100,
    });

    const record = await readDispatchRecord(SAMPLE_RECORD.dispatch_id);
    expect(record).not.toBeNull();
    expect(record?.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
    expect(mockFetchFile).toHaveBeenCalledWith(
      "prism-mcp-server",
      `.dispatch/${SAMPLE_RECORD.dispatch_id}.json`,
    );
  });

  it("returns null for a missing record (404)", async () => {
    mockFetchFile.mockRejectedValueOnce(new Error("Not found: x"));
    const record = await readDispatchRecord("does-not-exist");
    expect(record).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    mockFetchFile.mockRejectedValueOnce(new Error("Rate limited"));
    await expect(readDispatchRecord("x")).rejects.toThrow("Rate limited");
  });
});

describe("writeDispatchRecord", () => {
  it("persists a new record via pushFile", async () => {
    mockFetchFile.mockRejectedValueOnce(new Error("Not found: x"));
    mockPushFile.mockResolvedValueOnce({
      success: true,
      size: 120,
      sha: "new",
    });

    await writeDispatchRecord(SAMPLE_RECORD);

    expect(mockPushFile).toHaveBeenCalledTimes(1);
    const [repo, path, body, commitMsg] = mockPushFile.mock.calls[0];
    expect(repo).toBe("prism-mcp-server");
    expect(path).toBe(`.dispatch/${SAMPLE_RECORD.dispatch_id}.json`);
    expect(commitMsg).toContain("cc_dispatch");
    expect(commitMsg).toContain("running");

    const parsed = JSON.parse(body);
    expect(parsed.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
  });

  it("preserves the original started_at when updating an existing record", async () => {
    const originalStart = "2026-04-11T11:00:00.000Z";
    mockFetchFile.mockResolvedValueOnce({
      content: JSON.stringify({
        ...SAMPLE_RECORD,
        started_at: originalStart,
      }),
      sha: "a",
      size: 100,
    });
    mockPushFile.mockResolvedValueOnce({
      success: true,
      size: 120,
      sha: "new",
    });

    await writeDispatchRecord({
      ...SAMPLE_RECORD,
      status: "completed",
      // New record has a fresh started_at — the helper should overwrite it
      // with the existing value so "started_at" reflects the real start.
      started_at: "2026-04-11T12:15:00.000Z",
      completed_at: "2026-04-11T12:20:00.000Z",
    });

    const body = mockPushFile.mock.calls[0][2] as string;
    const parsed = JSON.parse(body);
    expect(parsed.started_at).toBe(originalStart);
    expect(parsed.status).toBe("completed");
    expect(parsed.completed_at).toBe("2026-04-11T12:20:00.000Z");
  });

  it("throws when pushFile reports failure", async () => {
    mockFetchFile.mockRejectedValueOnce(new Error("Not found: x"));
    mockPushFile.mockResolvedValueOnce({
      success: false,
      size: 0,
      sha: "",
      error: "403 Forbidden",
    });
    await expect(writeDispatchRecord(SAMPLE_RECORD)).rejects.toThrow(
      /403 Forbidden/,
    );
  });
});

describe("cc_status tool handler", () => {
  it("returns the record for a known dispatch_id", async () => {
    mockFetchFile.mockResolvedValueOnce({
      content: JSON.stringify(SAMPLE_RECORD),
      sha: "a",
      size: 100,
    });

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({
      dispatch_id: SAMPLE_RECORD.dispatch_id,
      limit: 10,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
  });

  it("returns an error for an unknown dispatch_id", async () => {
    mockFetchFile.mockRejectedValueOnce(new Error("Not found: x"));

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({
      dispatch_id: "nope",
      limit: 10,
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("No dispatch found");
  });

  it("lists recent dispatches when dispatch_id is omitted", async () => {
    mockListDirectory.mockResolvedValueOnce([
      {
        name: "cc-1712834400-a.json",
        path: ".dispatch/cc-1712834400-a.json",
        size: 100,
        sha: "a",
        type: "file",
      },
      {
        name: "cc-1712834500-b.json",
        path: ".dispatch/cc-1712834500-b.json",
        size: 100,
        sha: "b",
        type: "file",
      },
    ]);
    mockFetchFile
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ...SAMPLE_RECORD,
          dispatch_id: "cc-1712834500-b",
        }),
        sha: "b",
        size: 100,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          ...SAMPLE_RECORD,
          dispatch_id: "cc-1712834400-a",
        }),
        sha: "a",
        size: 100,
      });

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({ limit: 10 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    // Newer dispatch sorts first due to reverse-lexical order.
    expect(parsed.dispatches[0].dispatch_id).toBe("cc-1712834500-b");
  });
});
