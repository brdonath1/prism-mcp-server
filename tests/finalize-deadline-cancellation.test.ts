/**
 * SRV-42 / SRV-49 / SRV-58 (brief-461 Task B) — finalize commit deadline
 * cancellation + errored-turn response fidelity.
 *
 * SRV-42: prism_finalize's commit deadline must CANCEL the in-flight commit
 *         (AbortSignal threaded into commitPhase -> safeMutation ->
 *         createAtomicCommit), not just abandon it.
 * SRV-49: a deadline / mid-turn error response must carry diagnostics + a
 *         partial-state warning that describes the real (atomic) surface.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  fileExists: vi.fn(),
  createAtomicCommit: vi.fn(),
  getDefaultBranch: vi.fn(),
  getHeadSha: vi.fn(),
}));

// Tiny commit deadline so the deadline path runs in ms; synthesis off.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, SYNTHESIS_ENABLED: false, FINALIZE_COMMIT_DEADLINE_MS: 150 };
});

import {
  fetchFile,
  listDirectory,
  fileExists,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

const VALID_HANDOFF = [
  "## Meta",
  "- Handoff Version: 5",
  "- Session Count: 25",
  "- Template Version: v2.9.0",
  "- Status: Active",
  "",
  "## Critical Context",
  "1. Item one",
  "",
  "## Where We Are",
  "Working.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

function captureHandler() {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  let handler: ((a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>) | null = null;
  const orig = server.tool.bind(server);
  vi.spyOn(server, "tool").mockImplementation((name: string, ...rest: unknown[]) => {
    if (name === "prism_finalize") handler = rest[rest.length - 1] as never;
    return (orig as never as (...a: unknown[]) => unknown)(name, ...rest) as never;
  });
  registerFinalize(server);
  if (!handler) throw new Error("prism_finalize not registered");
  return handler;
}

const parse = (r: { content: Array<{ type: string; text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFile.mockResolvedValue({ content: VALID_HANDOFF, sha: "cur", size: 100 });
  mockListDirectory.mockResolvedValue([]);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
});

describe("SRV-42/49 — commit deadline cancels the in-flight commit and reports a faithful partial state", () => {
  it("aborts the threaded signal and returns a structured deadline response with diagnostics", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockCreateAtomicCommit.mockImplementation(
      async (_repo, _files, _msg, _deletes, signal) => {
        capturedSignal = signal;
        // Hang until the finalize deadline aborts the signal.
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ success: false, sha: "", files_committed: 0, error: "aborted" }),
          );
        });
      },
    );

    const handler = captureHandler();
    const t0 = Date.now();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 25,
      handoff_version: 5,
      files: [{ path: "handoff.md", content: VALID_HANDOFF }],
      skip_synthesis: true,
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3_000);
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toMatch(/deadline exceeded/i);
    // SRV-49: faithful partial-state description + diagnostics present.
    expect(data.partial_state_warning).toMatch(/atomic|verify the repo HEAD/i);
    expect(Array.isArray(data.diagnostics)).toBe(true);
    // SRV-42: the in-flight commit was actually signaled to abort.
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("SRV-58 — action=full commit step is bounded by the same deadline", () => {
  it("returns a commit-deadline error from fullPhase when the commit hangs (was unbounded)", async () => {
    let capturedSignal: AbortSignal | undefined;
    mockCreateAtomicCommit.mockImplementation(
      async (_repo, _files, _msg, _deletes, signal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () =>
            resolve({ success: false, sha: "", files_committed: 0, error: "aborted" }),
          );
        });
      },
    );

    const handler = captureHandler();
    const t0 = Date.now();
    const result = await handler({
      project_slug: "test-project",
      action: "full",
      session_number: 25,
      handoff_version: 5,
      handoff_content: VALID_HANDOFF,
      skip_synthesis: true,
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(5_000);
    const data = parse(result);
    expect(data.action).toBe("full");
    expect(data.all_succeeded).toBe(false);
    expect(data.error).toMatch(/deadline exceeded/i);
    expect(data.partial_state_warning).toBeTruthy();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("SRV-49 — a mid-turn error still surfaces diagnostics", () => {
  it("includes diagnostics + partial_state_warning when the commit throws mid-flight", async () => {
    // guardPushPath -> fileExists throws a non-timeout error mid-commit.
    mockFileExists.mockRejectedValue(new Error("boom: unexpected GitHub 500 during guard"));
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "s", files_committed: 1 });

    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 25,
      handoff_version: 5,
      files: [{ path: "handoff.md", content: VALID_HANDOFF }],
      skip_synthesis: true,
    });

    const data = parse(result);
    expect(result.isError).toBe(true);
    expect(data.error).toBeTruthy();
    // SRV-49: outer catch no longer drops diagnostics / partial state.
    expect(data).toHaveProperty("diagnostics");
    expect(data).toHaveProperty("partial_state_warning");
  });
});
