// brief-439 (D-240 Phase B, R8): null-banner_text fallback integration.
//
// When the unified banner renderer fails, the server must NOT return a null
// banner_text + structured banner_data object (the pre-R8 contradiction with
// the template's Rule 2 fallback). Instead banner_text carries the Rule 2
// single-line fallback: `PRISM | Session {N} | Handoff v{V} | {C}/{T} docs`.
//
// renderUnifiedBanner is mocked to throw for every test in this file; the
// real renderBannerFallback is preserved via importOriginal.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  createAtomicCommit: vi.fn(),
  getDefaultBranch: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn().mockResolvedValue({ success: false, error: "off", error_code: "MOCK" }),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn().mockResolvedValue({ success: true }),
  generatePendingDocUpdates: vi.fn().mockResolvedValue({ success: true }),
}));

// Force the unified renderer to throw; everything else (including the
// fallback renderer) stays real.
vi.mock("../src/utils/banner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    renderUnifiedBanner: vi.fn(() => {
      throw new Error("forced render failure");
    }),
  };
});

import {
  fetchFile,
  fetchFiles,
  pushFile,
  fileExists,
  listDirectory,
  listCommits,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { registerBootstrap } from "../src/tools/bootstrap.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const handlers: Record<string, ToolHandler> = {};
const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    handlers[name] = handler as ToolHandler;
  }),
} as unknown as McpServer;

registerBootstrap(mockServer);
registerFinalize(mockServer);

const HANDOFF = `# Handoff

## Meta
- Handoff Version: 33
- Session Count: 28
- Template Version: 2.10.0
- Status: Active

## Critical Context
1. Item one

## Where We Are
Current state.

<!-- EOF: handoff.md -->`;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return { content: HANDOFF, sha: "h1", size: HANDOFF.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFetchFiles.mockResolvedValue(new Map());
  mockFileExists.mockResolvedValue(false);
  mockPushFile.mockResolvedValue({ success: true, sha: "p1", size: 50 });
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetHeadSha.mockResolvedValue("HEAD");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic", files_committed: 1 });
});

describe("null-banner_text fallback matches the Rule 2 single-line spec", () => {
  it("bootstrap: render failure produces the single-line fallback, not banner_data", async () => {
    const result = await handlers.prism_bootstrap({ project_slug: "prism" });
    const data = JSON.parse(result.content[0].text);
    // Session 29 = Session Count 28 + 1; handoff v33.
    // S208 MCP-13: the doc count is MEASURED from the boot fan-out, which
    // probes a handful of the ten living documents — not all ten — so the
    // honest render is `?/10 (unverified)`. The pre-MCP-13 `10/10` was a
    // hardcoded constant asserting a health check boot never performed.
    expect(data.banner_text).toBe("PRISM | Session 29 | Handoff v33 | ?/10 docs (unverified)");
    expect(data.banner_data).toBeUndefined();
  });

  it("finalize commit: render failure produces the same single-line fallback shape", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.banner_text).toBe("PRISM | Session 26 | Handoff v31 | 1/10 docs");
    expect(data.finalization_banner_html).toBeNull();
  });
});

// S203 audit R18 (F-A2-11): the shapes above DID observe the commit, so their
// counts are facts. The deadline / hard-error shapes did not — they used to
// hardcode `docCount: 0` and assert "0/10 docs" even when the atomic commit
// landed. Those render `?/10 docs (unverified)`.
describe("R18 — deadline / hard-error banners report an unverified doc count, not zero", () => {
  it("commit that throws mid-flight → ?/10 (unverified), never 0/10", async () => {
    mockFileExists.mockRejectedValue(new Error("boom: unexpected GitHub 500 during guard"));

    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.banner_text).toBe("PRISM | Session 26 | Handoff v31 | ?/10 docs (unverified)");
    expect(data.banner_text).not.toContain("0/10");
    expect(data.finalization_banner_html).toBeNull();
  });

  it("full that throws mid-flight → ?/10 (unverified), never 0/10", async () => {
    mockFileExists.mockRejectedValue(new Error("boom: unexpected GitHub 500 during full guard"));

    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.banner_text).toBe("PRISM | Session 26 | Handoff v31 | ?/10 docs (unverified)");
    expect(data.banner_text).not.toContain("0/10");
  });

  it("the missing-draft pre-flight rejection carries the same unverified fallback (R12)", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      throw new Error(`Not found: ${path}`);
    });

    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      use_draft_files: true,
      skip_synthesis: true,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.banner_text).toBe("PRISM | Session 26 | Handoff v31 | ?/10 docs (unverified)");
    expect(data.banner_text).not.toContain("0/10");
    expect(data.finalize_render_contract).toContain("RENDER");
  });
});
