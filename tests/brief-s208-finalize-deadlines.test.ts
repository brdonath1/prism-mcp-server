// S208 PR-S1 MCP-1 v4 - the two audit bounds.
//
// (c) the STANDALONE action=audit handler is bounded at MCP_SAFE_TIMEOUT and
//     returns collected diagnostics + error-banner fields with a NULL handoff
//     version plus FINALIZE_AUDIT_DEADLINE_EXCEEDED.
// (d) fullPhase's INTERNAL audit step carries a 120s anti-hang bound and
//     degrades FAIL-CLOSED: every living doc counts unverified, so the INS-360
//     recreate guard drops file-shaped draft keys while the brief-456 BRIDGED
//     keys (session_log_entry, task_queue_*) still commit.
//
// Deadlines are mocked small so both paths run in milliseconds (the
// tests/read-tool-deadlines.test.ts pattern).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // fullPhase's draft step must actually produce drafts for the fail-closed
    // assertion below, so synthesis stays "enabled" and the client is mocked.
    SYNTHESIS_ENABLED: true,
    FINALIZE_AUDIT_ACTION_DEADLINE_MS: 300,
    FINALIZE_FULL_AUDIT_DEADLINE_MS: 300,
  };
});

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

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  assembleSynthesisBundle: vi.fn().mockResolvedValue({}),
  generateIntelligenceBrief: vi.fn().mockResolvedValue({ success: true }),
  generatePendingDocUpdates: vi.fn().mockResolvedValue({ success: true }),
}));

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
  "Audit deadline work.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

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
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetCommit.mockResolvedValue({ sha: "c", message: "m", files: [] } as never);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 2 });
  mockPushFile.mockResolvedValue({ success: true, sha: "p", size: 1 });
});

describe("MCP-1c - the standalone action=audit handler is bounded", () => {
  it("a hung audit fan-out returns a structured deadline response", async () => {
    mockFetchFile.mockImplementation(() => new Promise(() => {}));
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "audit",
      session_number: 29,
    });
    const data = parse(result);

    expect(result.isError).toBe(true);
    expect(String(data.error)).toContain("audit deadline exceeded");
    const codes = (data.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).toContain("FINALIZE_AUDIT_DEADLINE_EXCEEDED");
    // Error-banner fields with a NULL handoff version - action=audit never
    // receives one, and the pre-MCP-3 default fabricated "Handoff v1".
    expect(data.banner_text).toBe("PRISM | Session 29 | Handoff v? | ?/10 docs (unverified)");
    expect(data.banner_spec_version).toBe("4.3");
    expect(data.finalization_banner_html).toBeNull();
  }, 10_000);

  it("a healthy audit is untouched by the bound", async () => {
    mockFetchFile.mockResolvedValue({ content: HANDOFF, sha: "h", size: HANDOFF.length });
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "audit",
      session_number: 29,
    });
    const data = parse(result);
    expect(result.isError).toBeUndefined();
    expect(data.audit).toBeDefined();
    expect(
      (data.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "FINALIZE_AUDIT_DEADLINE_EXCEEDED",
      ),
    ).toBe(false);
  });
});

describe("MCP-1d - fullPhase's internal audit degrades fail-closed", () => {
  it("drops file-shaped draft keys but still commits the bridged keys", async () => {
    // glossary.md hangs forever. The audit fans out ALL ten living documents,
    // so its Promise.allSettled never settles and the 300ms bound fires;
    // DRAFT_RELEVANT_DOCS deliberately excludes glossary.md, so the draft and
    // commit steps are untouched and run at full speed.
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("glossary.md")) {
        return await new Promise(() => {}) as never;
      }
      if (path.endsWith("session-log.md")) {
        return { content: "# Session Log\n\n<!-- EOF: session-log.md -->\n", sha: "s", size: 40 };
      }
      if (path.endsWith("task-queue.md")) {
        return { content: "# Task Queue\n\n## Pending\n\n<!-- EOF: task-queue.md -->\n", sha: "t", size: 50 };
      }
      return { content: HANDOFF, sha: "h", size: HANDOFF.length };
    });

    const { synthesize } = await import("../src/ai/client.js");
    vi.mocked(synthesize).mockResolvedValue({
      success: true,
      content: JSON.stringify({
        session_log_entry: "### Session 29\n\nDid the work.",
        task_queue_completed: [],
        task_queue_new: [],
        "known-issues.md": "# Known Issues\n\nrewritten\n\n<!-- EOF: known-issues.md -->\n",
      }),
      input_tokens: 10,
      output_tokens: 10,
    } as never);

    const handler = captureHandler();
    const data = parse(
      await handler({
        project_slug: "test-project",
        action: "full",
        session_number: 29,
        handoff_version: 34,
        skip_synthesis: true,
        handoff_content: HANDOFF,
      }),
    );

    const codes = (data.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).toContain("FINALIZE_AUDIT_DEADLINE_EXCEEDED");
    // Fail-closed: every doc is unverified, so the file-shaped key is blocked.
    expect(codes).toContain("FINALIZE_RECREATE_BLOCKED");

    const committed = mockCreateAtomicCommit.mock.calls
      .flatMap((call) => call[1] as Array<{ path: string }>)
      .map((f) => f.path);
    expect(committed.some((p) => p.endsWith("known-issues.md"))).toBe(false);
    // The bridged keys do NOT consult unverifiedDocs and still commit.
    expect(committed.some((p) => p.endsWith("session-log.md"))).toBe(true);
  }, 20_000);
});
