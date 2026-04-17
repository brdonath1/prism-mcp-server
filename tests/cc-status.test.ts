/**
 * Tool-handler tests for cc_status. The dispatch-store module is the unit
 * tested separately (see tests/dispatch-store.test.ts); here we only assert
 * the tool's framing — schema-backed routing, record shaping, list summary,
 * and error paths — so the store internals are mocked.
 */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dispatch-store.js", () => ({
  readDispatchRecord: vi.fn(),
  listDispatchIds: vi.fn(),
  writeDispatchRecord: vi.fn(),
  hydrateStore: vi.fn().mockResolvedValue(undefined),
}));

import {
  readDispatchRecord,
  listDispatchIds,
  type DispatchRecord,
} from "../src/dispatch-store.js";
import { registerCCStatus } from "../src/tools/cc-status.js";

const mockRead = vi.mocked(readDispatchRecord);
const mockList = vi.mocked(listDispatchIds);

function createServerStub() {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>> = {};
  return {
    server: {
      tool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>,
      ) {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cc_status tool handler", () => {
  it("returns the record for a known dispatch_id", async () => {
    mockRead.mockResolvedValueOnce(SAMPLE_RECORD);

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({
      dispatch_id: SAMPLE_RECORD.dispatch_id,
      limit: 10,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
    expect(mockRead).toHaveBeenCalledWith(SAMPLE_RECORD.dispatch_id);
  });

  it("returns an error for an unknown dispatch_id", async () => {
    mockRead.mockResolvedValueOnce(null);

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({ dispatch_id: "nope", limit: 10 });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("No dispatch found");
  });

  it("lists recent dispatches when dispatch_id is omitted", async () => {
    mockList.mockResolvedValueOnce([
      "cc-1712834500-b",
      "cc-1712834400-a",
    ]);
    mockRead
      .mockResolvedValueOnce({ ...SAMPLE_RECORD, dispatch_id: "cc-1712834500-b" })
      .mockResolvedValueOnce({ ...SAMPLE_RECORD, dispatch_id: "cc-1712834400-a" });

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({ limit: 10 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(2);
    expect(parsed.dispatches[0].dispatch_id).toBe("cc-1712834500-b");
    expect(parsed.state_repo).toBe("test-owner/prism-dispatch-state");
  });

  it("surfaces dispatch-store errors as tool errors", async () => {
    mockRead.mockRejectedValueOnce(new Error("Rate limited"));

    const { server, handlers } = createServerStub();
    registerCCStatus(server as any);
    const result = await handlers.cc_status({ dispatch_id: "x", limit: 10 });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Rate limited");
  });
});
