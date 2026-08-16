// S208 PR-S1 - finalize response surface.
//
// MCP-3 (no fabricated "Handoff v1" on the error exits), MCP-2 (the standalone
// audit response must not grow by file content), MCP-19 (render-failure
// diagnostics), OPS-2 (FINALIZE_BANNER kill switch).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, SYNTHESIS_ENABLED: false };
});

import {
  fetchFile,
  listDirectory,
  listCommits,
  getCommit,
  fileExists,
  createAtomicCommit,
  getHeadSha,
  pushFile,
} from "../src/github/client.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockGetCommit = vi.mocked(getCommit);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockPushFile = vi.mocked(pushFile);

const HANDOFF = [
  "## Meta",
  "- Handoff Version: 34",
  "- Session Count: 29",
  "- Template Version: v2.29.0",
  "- Status: Active",
  "",
  "## Critical Context",
  "1. First critical item",
  "",
  "## Where We Are",
  "Banner reliability work.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

// A deliberately fat living document: if any response path started spreading
// file CONTENT the byte assertion below would blow past its ceiling.
const FAT_DOC = `# Fat\n${"x".repeat(40_000)}\n<!-- EOF: fat.md -->\n`;

function captureHandler() {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  registerFinalize(server);
  const tool = (server as never as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools["prism_finalize"];
  return tool.handler as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FINALIZE_BANNER;
  mockFetchFile.mockResolvedValue({ content: HANDOFF, sha: "cur", size: HANDOFF.length });
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetCommit.mockResolvedValue({ sha: "c", message: "m", files: [] } as never);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
  mockPushFile.mockResolvedValue({ success: true, sha: "p", size: 1 });
});

afterEach(() => {
  delete process.env.FINALIZE_BANNER;
});

describe("MCP-3 - the finalize error exits stop fabricating 'Handoff v1'", () => {
  it("action=full without handoff_content renders 'Handoff v?'", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "full",
      session_number: 29,
    });
    const data = parse(result);
    expect(data.banner_text).toContain("Handoff v?");
    expect(data.banner_text).not.toContain("Handoff v1 ");
    expect(data.banner_spec_version).toBe("4.3");
  });

  it("a commit-phase hard error renders 'Handoff v?' when no version was supplied", async () => {
    mockFileExists.mockRejectedValue(new Error("boom: unexpected GitHub 500 during guard"));
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    const data = parse(result);
    expect(result.isError).toBe(true);
    expect(data.banner_text).toBe("PRISM | Session 29 | Handoff v? | ?/10 docs (unverified)");
    expect(data.banner_text).not.toContain("Handoff v1");
  });
});

describe("MCP-2 - the standalone audit response never grows by file content", () => {
  it("carries the decision count but not the 40KB documents it read", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) {
        return { content: HANDOFF, sha: "h", size: HANDOFF.length };
      }
      if (path.endsWith("decisions/_INDEX.md")) {
        const index = [
          "| ID | Title | Status | Session |",
          "|----|-------|--------|---------|",
          "| D-1 | One | Active | 1 |",
          "| D-2 | Two | Active | 2 |",
          "",
        ].join("\n");
        return { content: index, sha: "d", size: index.length };
      }
      if (path.includes("rules-session-end.md")) {
        return { content: "# Session End Rules\n", sha: "r", size: 22 };
      }
      return { content: FAT_DOC, sha: "f", size: FAT_DOC.length };
    });

    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "audit",
      session_number: 29,
    });
    const data = parse(result);

    expect(data.decision_count).toBe(2);
    // 8 fat living docs would put a content-spreading response past 300KB.
    const bytes = Buffer.byteLength(result.content[0].text, "utf8");
    expect(bytes).toBeLessThan(60_000);
    expect(result.content[0].text).not.toContain("x".repeat(2_000));
  });

  it("reports a null decision count when the decision index could not be read", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) {
        return { content: HANDOFF, sha: "h", size: HANDOFF.length };
      }
      if (path.endsWith("decisions/_INDEX.md")) throw new Error("Not found");
      if (path.includes("rules-session-end.md")) {
        return { content: "# Session End Rules\n", sha: "r", size: 22 };
      }
      return { content: "# Doc\n", sha: "f", size: 6 };
    });

    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "audit",
      session_number: 29,
    });
    expect(parse(result).decision_count).toBeNull();
  });
});

describe("OPS-2 - FINALIZE_BANNER=off", () => {
  it("nulls finalization_banner_html and leaves banner_text intact", async () => {
    process.env.FINALIZE_BANNER = "off";
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    const data = parse(result);
    expect(data.finalization_banner_html).toBeNull();
    expect(typeof data.banner_text).toBe("string");
    expect(data.banner_text).toContain("Session 29 finalized");
  });

  it("default (unset) still emits the widget", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    expect(typeof parse(result).finalization_banner_html).toBe("string");
  });

  it("FINALIZE_BANNER=html is the explicit default", async () => {
    process.env.FINALIZE_BANNER = "html";
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    expect(typeof parse(result).finalization_banner_html).toBe("string");
  });
});

describe("GAP-9 - a handoff committed without its session log is surfaced", () => {
  it("emits FINALIZE_MISSING_SESSION_LOG on the commit surface", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    const data = parse(result);
    expect(
      (data.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "FINALIZE_MISSING_SESSION_LOG",
      ),
    ).toBe(true);
    expect(data.banner_text).toContain("session-log.md was not committed");
  });
});
