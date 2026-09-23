import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/utils/published-checkpoint-projection.js", () => ({
  preparePublishedCheckpointProjection: vi.fn(),
}));
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(), fetchFiles: vi.fn(), pushFile: vi.fn(),
  listDirectory: vi.fn(), listCommits: vi.fn(), getCommit: vi.fn(),
  deleteFile: vi.fn(), fileExists: vi.fn(), createAtomicCommit: vi.fn(),
  getDefaultBranch: vi.fn(), getHeadSha: vi.fn(),
}));
import * as github from "../src/github/client.js";
import { preparePublishedCheckpointProjection } from "../src/utils/published-checkpoint-projection.js";
import { registerFinalize } from "../src/tools/finalize.js";

const expected = { ref: "a".repeat(40), path: "docs/handoffs/handoff-2026-09-23.md", sha: "b".repeat(40) };
const args = { project_slug: "example", action: "prepare_checkpoint", session_number: 4, handoff_version: 8, expected_published_handoff: expected };
const prepare = vi.mocked(preparePublishedCheckpointProjection);
let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

beforeEach(() => {
  vi.clearAllMocks();
  const server = new McpServer({ name: "test", version: "0" });
  vi.spyOn(server, "tool").mockImplementation(((_name: string, ...rest: unknown[]) => {
    handler = rest[rest.length - 1] as typeof handler;
    return {};
  }) as never);
  registerFinalize(server);
});

function expectNoGithubCalls() {
  for (const fn of Object.values(github)) expect(fn).not.toHaveBeenCalled();
}

describe("finalize read-only checkpoint preparation", () => {
  it("returns a candidate without entering any finalize write, audit or draft path", async () => {
    const candidate = { path: ".prism/handoff.md", content: "candidate", source: expected, native_template_version: "2.0.0" };
    prepare.mockResolvedValue(candidate as Awaited<ReturnType<typeof preparePublishedCheckpointProjection>>);
    const response = await handler(args);
    const result = JSON.parse(response.content[0].text);
    expect(response.isError).not.toBe(true);
    expect(prepare).toHaveBeenCalledWith("example", expected, { sessionNumber: 4, handoffVersion: 8 });
    expect(result).toMatchObject({ ...candidate, writes_performed: false, finalized: false, publication_required: true });
    expectNoGithubCalls();
  });

  it.each([
    { expected_published_handoff: undefined },
    { handoff_version: undefined },
    { files: [] },
    { use_draft_files: true },
    { handoff_content: "independent summary" },
  ])("rejects incomplete or conflicting preparation inputs %j", async (override) => {
    const response = await handler({ ...args, ...override });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({ writes_performed: false, finalized: false });
    expect(prepare).not.toHaveBeenCalled();
    expectNoGithubCalls();
  });

  it.each(["commit", "full", "draft", "audit"])("refuses source input on %s rather than implying a guarded mutation", async (action) => {
    const response = await handler({ ...args, action });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toContain("only by read-only prepare_checkpoint");
    expect(prepare).not.toHaveBeenCalled();
    expectNoGithubCalls();
  });

  it("reports source verification failure without claiming partial publication", async () => {
    prepare.mockRejectedValue(new Error("main changed"));
    const response = await handler(args);
    const result = JSON.parse(response.content[0].text);
    expect(response.isError).toBe(true);
    expect(result).toMatchObject({ error: "main changed", writes_performed: false, finalized: false });
    expect(result.partial_state_warning).toBeUndefined();
    expectNoGithubCalls();
  });
});
