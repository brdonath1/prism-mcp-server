/**
 * brief-456 / W3-S2 (M-004, SRV-19) — finalize action=full draft bridge.
 *
 * The FINALIZATION_DRAFT_PROMPT contract emits section-shaped keys
 * (session_log_entry, task_queue_completed, task_queue_new, handoff_*) but
 * the fullPhase bridge previously accepted only file-shaped keys — the
 * entire draft was silently discarded and full finalization committed ONLY
 * handoff.md. The bridge must translate contract keys into real doc
 * mutations, and a generated draft must never be silently discarded on
 * downstream failure (draft_recovery + diagnostics).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

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

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
  resolveDocFiles: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  fetchFile,
  fetchFiles,
  fileExists,
  listDirectory,
  listCommits,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import {
  resolveDocPath,
  resolveDocPushPath,
  resolveDocFiles,
} from "../src/utils/doc-resolver.js";
import { synthesize } from "../src/ai/client.js";
import { registerFinalize, bridgeDraftSections } from "../src/tools/finalize.js";
import { detectSessionLogOrientation } from "../src/utils/archive.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockSynthesize = vi.mocked(synthesize);

const SESSION_LOG_NEWEST_LAST = `# Session Log — test

### Session 24 (2026-06-09)

**Focus:** earlier work

### Session 25 (2026-06-10)

**Focus:** more work

<!-- EOF: session-log.md -->
`;

const SESSION_LOG_NEWEST_FIRST = `# Session Log — test

### Session 25 (2026-06-10)

**Focus:** more work

### Session 24 (2026-06-09)

**Focus:** earlier work

<!-- EOF: session-log.md -->
`;

const TASK_QUEUE = `# Task Queue — test

## Up Next

- [ ] Fix push integrity
- [ ] Other thing

## Parking Lot

- [ ] Old idea

<!-- EOF: task-queue.md -->
`;

const NEW_ENTRY = `### Session 26 (2026-06-11)

**Focus:** Write-integrity fixes

**Key outcomes:**
- Landed the bridge`;

const CONTRACT_DRAFT = {
  session_log_entry: NEW_ENTRY,
  handoff_where_we_are: "We are mid-bridge.",
  handoff_next_steps: ["Step 1", "Step 2"],
  handoff_session_history: "S26: bridge work",
  task_queue_completed: ["Fix push integrity"],
  task_queue_new: ["[Up Next] Verify deploy", "[Parking Lot] Someday thing"],
};

const HANDOFF_FINALIZE = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Item

## Where We Are
Operator-authored state.

<!-- EOF: handoff.md -->`;

async function callFinalize(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);
  const tool = (server as any)._registeredTools["prism_finalize"];
  if (!tool) throw new Error("prism_finalize not registered");
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-full-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(args, mockExtra)) as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

/** Extract the files array handed to createAtomicCommit (any call).
 *  Signature: createAtomicCommit(repo, files, message, deletes). */
function atomicCommitFiles(): Array<{ path: string; content: string }> {
  const all: Array<{ path: string; content: string }> = [];
  for (const call of mockCreateAtomicCommit.mock.calls) {
    for (const arg of call) {
      if (
        Array.isArray(arg) &&
        arg.every(
          (f) =>
            f &&
            typeof f === "object" &&
            typeof (f as { path?: unknown }).path === "string" &&
            typeof (f as { content?: unknown }).content === "string",
        )
      ) {
        all.push(...(arg as Array<{ path: string; content: string }>));
      }
    }
  }
  return all;
}

function setupFullActionMocks(): void {
  mockResolveDocFiles.mockResolvedValue(
    new Map([
      ["handoff.md", { content: HANDOFF_FINALIZE, sha: "h", size: 200 }],
      ["session-log.md", { content: SESSION_LOG_NEWEST_LAST, sha: "s", size: 200 }],
      ["task-queue.md", { content: TASK_QUEUE, sha: "t", size: 150 }],
    ]) as never,
  );
  mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
    if (doc === "handoff.md") {
      return { content: HANDOFF_FINALIZE.replace("Version: 31", "Version: 30"), sha: "h30", path: ".prism/handoff.md" } as never;
    }
    if (doc === "session-log.md") {
      return { content: SESSION_LOG_NEWEST_LAST, sha: "s", path: ".prism/session-log.md" } as never;
    }
    if (doc === "task-queue.md") {
      return { content: TASK_QUEUE, sha: "t", path: ".prism/task-queue.md" } as never;
    }
    throw new Error(`Not found: ${doc}`);
  });
  mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
  mockFetchFile.mockRejectedValue(new Error("Not found: x"));
  mockFetchFiles.mockResolvedValue({ files: new Map(), failed: [], incomplete: false });
  mockFileExists.mockResolvedValue(false);
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetHeadSha.mockResolvedValue("head-sha" as never);
  mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "p" } as never);
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic", files_committed: 3 } as never);
  mockSynthesize.mockResolvedValue({
    success: true,
    content: JSON.stringify(CONTRACT_DRAFT),
    input_tokens: 2000,
    output_tokens: 700,
    model: "test-model",
    transport: "messages_api",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SRV-19 — action=full bridges contract-shaped draft keys into real doc mutations", () => {
  it("commits an updated session-log.md (new entry present) and task-queue.md, not just handoff.md", async () => {
    setupFullActionMocks();

    const result = await callFinalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);

    const files = atomicCommitFiles();
    const paths = files.map((f) => f.path);

    const sessionLog = files.find((f) => f.path.endsWith("session-log.md"));
    expect(sessionLog, `session-log.md missing from committed set: ${paths.join(", ")}`).toBeDefined();
    expect(sessionLog!.content).toContain("### Session 26 (2026-06-11)");
    expect(sessionLog!.content).toContain("### Session 25 (2026-06-10)");
    // Newest-last layout: the new entry lands after S25 and before the EOF sentinel.
    expect(sessionLog!.content.indexOf("### Session 26")).toBeGreaterThan(
      sessionLog!.content.indexOf("### Session 25"),
    );
    expect(sessionLog!.content.indexOf("### Session 26")).toBeLessThan(
      sessionLog!.content.indexOf("<!-- EOF: session-log.md -->"),
    );

    const taskQueue = files.find((f) => f.path.endsWith("task-queue.md"));
    expect(taskQueue, `task-queue.md missing from committed set: ${paths.join(", ")}`).toBeDefined();
    expect(taskQueue!.content).toContain("- [x] Fix push integrity");
    expect(taskQueue!.content).toContain("- [ ] Verify deploy");
    expect(taskQueue!.content).toContain("- [ ] Someday thing");
    // [Up Next] item lands in Up Next (before Parking Lot); [Parking Lot] item after it.
    expect(taskQueue!.content.indexOf("Verify deploy")).toBeLessThan(
      taskQueue!.content.indexOf("## Parking Lot"),
    );
    expect(taskQueue!.content.indexOf("Someday thing")).toBeGreaterThan(
      taskQueue!.content.indexOf("## Parking Lot"),
    );

    const handoff = files.find((f) => f.path.endsWith("handoff.md"));
    expect(handoff).toBeDefined();
    expect(handoff!.content).toContain("Operator-authored state.");

    // Bridge visibility: bridged + skipped keys are reported.
    expect(data.draft_bridge).toBeDefined();
    expect(data.draft_bridge.bridged).toEqual(
      expect.arrayContaining(["session_log_entry", "task_queue_completed", "task_queue_new"]),
    );
    const skippedKeys = (data.draft_bridge.skipped as Array<{ key: string }>).map((s) => s.key);
    expect(skippedKeys).toEqual(
      expect.arrayContaining(["handoff_where_we_are", "handoff_next_steps", "handoff_session_history"]),
    );
    const handoffSkip = (data.draft_bridge.skipped as Array<{ key: string; reason: string }>).find(
      (s) => s.key === "handoff_where_we_are",
    );
    expect(handoffSkip?.reason).toMatch(/operator/i);
  });

  it("downstream commit failure → draft is NOT discarded: draft_recovery + DRAFT_NOT_COMMITTED diagnostic", async () => {
    setupFullActionMocks();
    mockCreateAtomicCommit.mockResolvedValue({ success: false, error: "boom", files_committed: 0 } as never);

    const result = await callFinalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(false);
    expect(data.draft_recovery).toBeDefined();
    expect(data.draft_recovery.session_log_entry).toContain("### Session 26");
    const diagCodes = (data.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(diagCodes).toContain("DRAFT_NOT_COMMITTED");
  });

  it("session-log/task-queue fetch failure → bridge skips those keys with visible reasons, finalize still commits", async () => {
    setupFullActionMocks();
    mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
      if (doc === "handoff.md") {
        return { content: HANDOFF_FINALIZE.replace("Version: 31", "Version: 30"), sha: "h30", path: ".prism/handoff.md" } as never;
      }
      throw new Error("GitHub API 500: boom");
    });

    const result = await callFinalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
    });

    const data = parseResult(result);
    expect(data.all_succeeded).toBe(true);
    const skippedKeys = (data.draft_bridge.skipped as Array<{ key: string }>).map((s) => s.key);
    expect(skippedKeys).toEqual(expect.arrayContaining(["session_log_entry"]));
  });
});

describe("bridgeDraftSections (pure)", () => {
  it("inserts the session-log entry before the EOF sentinel on a newest-last log", () => {
    const out = bridgeDraftSections(
      { session_log_entry: NEW_ENTRY },
      { sessionLog: SESSION_LOG_NEWEST_LAST },
    );
    const file = out.files.find((f) => f.path === "session-log.md");
    expect(file).toBeDefined();
    expect(file!.content.indexOf("### Session 26")).toBeGreaterThan(
      file!.content.indexOf("### Session 25"),
    );
    expect(file!.content.indexOf("### Session 26")).toBeLessThan(
      file!.content.indexOf("<!-- EOF: session-log.md -->"),
    );
    expect(out.bridged).toContain("session_log_entry");
  });

  it("inserts the session-log entry before the first entry on a newest-first log", () => {
    const out = bridgeDraftSections(
      { session_log_entry: NEW_ENTRY },
      { sessionLog: SESSION_LOG_NEWEST_FIRST },
    );
    const file = out.files.find((f) => f.path === "session-log.md");
    expect(file).toBeDefined();
    expect(file!.content.indexOf("### Session 26")).toBeLessThan(
      file!.content.indexOf("### Session 25"),
    );
    // Preamble (H1 title) stays above the new entry.
    expect(file!.content.indexOf("# Session Log — test")).toBeLessThan(
      file!.content.indexOf("### Session 26"),
    );
  });

  it("marks completed tasks and appends new tasks to their target sections", () => {
    const out = bridgeDraftSections(
      {
        task_queue_completed: ["Fix push integrity"],
        task_queue_new: ["[Up Next] Verify deploy", "[Parking Lot] Someday thing"],
      },
      { taskQueue: TASK_QUEUE },
    );
    const file = out.files.find((f) => f.path === "task-queue.md");
    expect(file).toBeDefined();
    expect(file!.content).toContain("- [x] Fix push integrity");
    expect(file!.content).toContain("- [ ] Other thing");
    expect(file!.content).toContain("- [ ] Verify deploy");
    expect(file!.content).toContain("- [ ] Someday thing");
  });

  it("unmatched completed task → skipped with a visible reason (file still written for other mutations)", () => {
    const out = bridgeDraftSections(
      { task_queue_completed: ["No such task anywhere"] },
      { taskQueue: TASK_QUEUE },
    );
    expect(out.files.find((f) => f.path === "task-queue.md")).toBeUndefined();
    const skip = out.skipped.find((s) => s.key === "task_queue_completed");
    expect(skip).toBeDefined();
    expect(skip!.reason).toContain("No such task anywhere");
  });

  it("new task with an unknown/missing section target → skipped with reason", () => {
    const out = bridgeDraftSections(
      { task_queue_new: ["[Someday] No such section"] },
      { taskQueue: TASK_QUEUE },
    );
    expect(out.files.find((f) => f.path === "task-queue.md")).toBeUndefined();
    const skip = out.skipped.find((s) => s.key === "task_queue_new");
    expect(skip).toBeDefined();
  });

  it("handoff_* keys are skipped — operator-supplied handoff content takes precedence", () => {
    const out = bridgeDraftSections(
      {
        handoff_where_we_are: "x",
        handoff_next_steps: ["y"],
        handoff_session_history: "z",
      },
      {},
    );
    expect(out.files).toEqual([]);
    expect(out.skipped.map((s) => s.key)).toEqual(
      expect.arrayContaining(["handoff_where_we_are", "handoff_next_steps", "handoff_session_history"]),
    );
    for (const s of out.skipped) {
      expect(s.reason).toMatch(/operator/i);
    }
  });

  it("session_log_entry with no fetched session-log → skipped with a fetch-shaped reason", () => {
    const out = bridgeDraftSections({ session_log_entry: NEW_ENTRY }, {});
    expect(out.files).toEqual([]);
    const skip = out.skipped.find((s) => s.key === "session_log_entry");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/session-log/i);
  });
});

describe("detectSessionLogOrientation (SRV-19 helper)", () => {
  it("ascending session numbers → bottom (newest last)", () => {
    expect(detectSessionLogOrientation(SESSION_LOG_NEWEST_LAST)).toBe("bottom");
  });

  it("descending session numbers → top (newest first)", () => {
    expect(detectSessionLogOrientation(SESSION_LOG_NEWEST_FIRST)).toBe("top");
  });

  it("no session entries → bottom (safe default)", () => {
    expect(detectSessionLogOrientation("# Empty\n\n<!-- EOF: session-log.md -->\n")).toBe("bottom");
  });
});
