/**
 * brief-456 / W3-S2 (M-002) — push-failure propagation at the finalize and
 * bootstrap consumer surfaces.
 *
 * SRV-18: a handoff-backup push that resolves `{ success: false }` must not
 *         report a backup path; the failure must be visible in the commit
 *         response (warnings).
 * SRV-18 (corroborated site): updateArchitectureMetadata must not report
 *         `updated: true` when its pushFile resolves `{ success: false }`.
 * SRV-16: pushBootTest must propagate the real push result — bootstrap must
 *         report boot_test_verified:false + BOOT_TEST_FAILED diagnostic when
 *         the boot-test push fails with an HTTP-failure result shape.
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
  listRepos: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

vi.mock("../src/railway/client.js", () => ({
  getEnvironmentLogs: vi.fn(),
}));

import {
  fetchFile,
  fetchFiles,
  pushFile,
  listDirectory,
  listCommits,
  fileExists,
  createAtomicCommit,
  getHeadSha,
  listRepos,
} from "../src/github/client.js";
import { generateIntelligenceBrief, generatePendingDocUpdates } from "../src/ai/synthesize.js";
import { registerFinalize, updateArchitectureMetadata } from "../src/tools/finalize.js";
import { registerBootstrap } from "../src/tools/bootstrap.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockListRepos = vi.mocked(listRepos);

const PUSH_FAILURE = {
  success: false as const,
  size: 0,
  sha: "",
  error: "GitHub API forbidden — check PAT scopes. (pushFile test-project/x)",
};

const PUSH_SUCCESS = { success: true as const, size: 100, sha: "pushed-sha" };

const EXISTING_HANDOFF = `## Meta
- Handoff Version: 30
- Session Count: 25
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Item

## Where We Are
Working.

<!-- EOF: handoff.md -->`;

const NEW_HANDOFF = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Item

## Where We Are
Still working.

<!-- EOF: handoff.md -->`;

async function callTool(
  register: (s: McpServer) => void,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  register(server);
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(args, mockExtra)) as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateIntelligenceBrief).mockResolvedValue({ success: true } as never);
  vi.mocked(generatePendingDocUpdates).mockResolvedValue({ success: true } as never);
});

describe("SRV-18 — handoff backup push failure is visible, backup_created is empty", () => {
  it("backup commit failure → backup_created '' + warning in the commit response (brief-460: backup rides a safeMutation commit, not pushFile)", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) {
        return { content: EXISTING_HANDOFF, sha: "h-sha", size: 300 };
      }
      throw new Error(`Not found: ${path}`);
    });
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);
    mockFileExists.mockResolvedValue(false);
    mockGetHeadSha.mockResolvedValue("head-sha");
    // brief-460 / S170 post-mortem: the backup write rides a safeMutation
    // atomic commit (shared with the prune). Fail exactly that commit; the
    // main finalize commit succeeds.
    mockCreateAtomicCommit.mockImplementation(async (_repo, files) => {
      const carriesBackup = (files as Array<{ path: string }>).some((f) =>
        f.path.includes("handoff-history/"),
      );
      if (carriesBackup) {
        return { success: false, sha: "", files_committed: 0, error: "GitHub API forbidden — check PAT scopes." } as never;
      }
      return { success: true, sha: "atomic_sha", files_committed: 1 } as never;
    });
    mockFetchFiles.mockResolvedValue({ files: new Map(), failed: [], incomplete: false });
    mockPushFile.mockResolvedValue(PUSH_SUCCESS as never);

    const result = await callTool(registerFinalize, "prism_finalize", {
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: NEW_HANDOFF }],
    });

    const data = parseResult(result);
    expect(data.backup_created).toBe("");
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.warnings.join(" ")).toMatch(/backup/i);
  });
});

describe("SRV-18 corroborated — updateArchitectureMetadata push failure", () => {
  it("pushFile {success:false} → { updated: false, reason } instead of a false 'updated: true'", async () => {
    mockFetchFile.mockImplementation(async (repo: string, path: string) => {
      if (path === ".prism/config.yaml") {
        return { content: "auto_update_architecture: true\n", sha: "c", size: 30 };
      }
      if (repo === "prism-mcp-server" && path === "package.json") {
        return { content: '{"version": "9.9.9"}', sha: "p", size: 22 };
      }
      if (path.endsWith("architecture.md")) {
        return {
          content: "# Architecture\n\n> Updated: S25 (2026-06-01)\n\nBody.\n\n<!-- EOF: architecture.md -->\n",
          sha: "a",
          size: 90,
        };
      }
      throw new Error(`Not found: ${path}`);
    });
    mockFileExists.mockResolvedValue(false);
    mockPushFile.mockResolvedValue(PUSH_FAILURE as never);

    const result = await updateArchitectureMetadata("test-project", 26, "2026-06-11");

    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/push failed/i);
    expect(result.reason).toMatch(/forbidden/i);
  });
});

describe("SRV-16 — boot-test write-path verification reports the real push result", () => {
  it("boot-test pushFile {success:false} → boot_test_verified false + BOOT_TEST_FAILED diagnostic", async () => {
    const HANDOFF = `# Handoff

## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: 2.16.0
- Status: Active

## Critical Context
1. Item one

## Where We Are
Working.

## Resumption Point
Pick up.

<!-- EOF: handoff.md -->`;
    const DECISIONS =
      "| ID | Title | Domain | Status | Session |\n" +
      "|---|---|---|---|---|\n" +
      "| D-1 | Test | arch | SETTLED | 1 |\n\n" +
      "<!-- EOF: _INDEX.md -->";
    const TEMPLATE = "# Template v2.16.0\nRules.\n<!-- EOF: core-template-mcp.md -->";

    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "h", size: 200 };
      if (path.endsWith("_INDEX.md")) return { content: DECISIONS, sha: "d", size: 120 };
      if (path.includes("core-template")) return { content: TEMPLATE, sha: "t", size: 60 };
      throw new Error(`Not found: ${path}`);
    });
    mockFetchFiles.mockResolvedValue({ files: new Map(), failed: [], incomplete: false });
    mockFileExists.mockResolvedValue(true); // trigger marker exists — no marker push
    mockListRepos.mockResolvedValue([]);
    mockPushFile.mockResolvedValue(PUSH_FAILURE as never);

    const result = await callTool(registerBootstrap, "prism_bootstrap", {
      project_slug: "test-project",
    });

    const data = parseResult(result);
    expect(data.boot_test_verified).toBe(false);
    const warningsText = JSON.stringify(data.warnings ?? []);
    expect(warningsText).toMatch(/Boot-test push failed/i);
    const diagnostics = JSON.stringify(data.diagnostics ?? []);
    expect(diagnostics).toContain("BOOT_TEST_FAILED");
  });
});
