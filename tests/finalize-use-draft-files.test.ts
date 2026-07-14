// brief-s202b T8 (D-275 F-1) — commit-side use_draft_files: the persisted
// compose draft is recovered, merged with per-path overrides, and committed
// through the FULL standard pipeline; stale/missing drafts error loudly and
// touch nothing.
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

// Synthesis disabled — commit tests pass skip_synthesis anyway.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, SYNTHESIS_ENABLED: false };
});

import {
  fetchFile,
  listDirectory,
  fileExists,
  createAtomicCommit,
  getHeadSha,
  pushFile,
} from "../src/github/client.js";
import { FINALIZE_DRAFT_STATE_PATH } from "../src/config.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockPushFile = vi.mocked(pushFile);

function validHandoff(version: number, session: number): string {
  return [
    "## Meta",
    `- Handoff Version: ${version}`,
    `- Session Count: ${session}`,
    "- Template Version: v2.29.0",
    "- Status: Active",
    "",
    "## Critical Context",
    "1. First critical item",
    "",
    "## Where We Are",
    "Mid-flight on compose offload.",
    "",
    "<!-- EOF: handoff.md -->",
  ].join("\n");
}

const DRAFT_STATE = {
  version: 1,
  project: "test-project",
  session_number: 29,
  handoff_version: 34,
  created_at: "2026-07-14T00:00:00Z",
  files: [
    { path: "handoff.md", content: validHandoff(34, 29) },
    {
      path: "session-log.md",
      content: "# Session Log\n\n### Session 29\n**Focus:** offload.\n\n<!-- EOF: session-log.md -->",
    },
  ],
  draft_summary: "digest",
};

function captureHandler() {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  let handler:
    | ((args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>)
    | null = null;
  const orig = server.tool.bind(server);
  vi.spyOn(server, "tool").mockImplementation((name: string, ...rest: unknown[]) => {
    const h = rest[rest.length - 1];
    if (name === "prism_finalize") handler = h as never;
    return (orig as never as (...a: unknown[]) => unknown)(name, ...rest) as never;
  });
  registerFinalize(server);
  if (!handler) throw new Error("prism_finalize not registered");
  return handler;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === FINALIZE_DRAFT_STATE_PATH) {
      const content = JSON.stringify(DRAFT_STATE);
      return { content, sha: "draft-sha", size: content.length };
    }
    // Current handoff (backup plan + INS-360 doc-exists checks) and any
    // living-doc reads resolve to the outgoing handoff-ish content.
    const content = validHandoff(33, 28);
    return { content, sha: "cur", size: content.length };
  });
  mockListDirectory.mockResolvedValue([]);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 2 });
  mockPushFile.mockResolvedValue({ success: true, sha: "p", size: 1 });
});

describe("brief-s202b T8 — action=commit use_draft_files", () => {
  it("happy path: commits the persisted draft files with NO files[] content from chat", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      use_draft_files: true,
      skip_synthesis: true,
    });
    const data = parse(result);

    expect(data.all_succeeded).toBe(true);
    // guardPushPath redirects the bare draft names to the .prism/ layout.
    expect(data.results.map((r: { path: string }) => r.path).sort()).toEqual([
      ".prism/handoff.md",
      ".prism/session-log.md",
    ]);
    // handoff_version defaults from the persisted draft state (34).
    expect(data.handoff_version).toBe(34);
    const used = (data.diagnostics as Array<{ code: string }>).find(d => d.code === "FINALIZE_DRAFT_FILES_USED");
    expect(used).toBeDefined();
    expect(mockCreateAtomicCommit).toHaveBeenCalled();
  });

  it("per-file override: a files[] entry replaces the draft file with the same (normalized) path", async () => {
    const handler = captureHandler();
    const overrideHandoff = validHandoff(34, 29).replace(
      "Mid-flight on compose offload.",
      "Operator-corrected resumption state.",
    );
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      use_draft_files: true,
      files: [{ path: ".prism/handoff.md", content: overrideHandoff }],
      skip_synthesis: true,
    });
    const data = parse(result);
    expect(data.all_succeeded).toBe(true);

    const used = (data.diagnostics as Array<{ code: string; context?: { overridden?: string[] } }>).find(
      d => d.code === "FINALIZE_DRAFT_FILES_USED",
    );
    expect(used!.context!.overridden).toEqual(["handoff.md"]);
    // The atomic commit received the OVERRIDDEN content.
    // createAtomicCommit(repo, files, message, deletes?, signal?)
    const commitCall = mockCreateAtomicCommit.mock.calls.find(c =>
      (c[1] as Array<{ path: string; content: string }>).some(f => f.content.includes("Operator-corrected")),
    );
    expect(commitCall).toBeDefined();
  });

  it("stale draft (session mismatch) → loud error, nothing committed", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 30, // draft is for 29
      use_draft_files: true,
      skip_synthesis: true,
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toContain("session 29");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("missing persisted draft → loud error pointing at action=draft, nothing committed", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === FINALIZE_DRAFT_STATE_PATH) throw new Error(`Not found: ${path}`);
      const content = validHandoff(33, 28);
      return { content, sha: "cur", size: content.length };
    });
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      use_draft_files: true,
      skip_synthesis: true,
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toContain("no usable persisted draft");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("without use_draft_files, an empty files[] still errors (unchanged contract)", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      skip_synthesis: true,
    });
    expect(result.isError).toBe(true);
    const data = parse(result);
    expect(data.error).toContain("requires files array");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });
});
