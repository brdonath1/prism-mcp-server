// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks for the commit-handler dispatch smoke test. Declared before the
// imports they target — vitest hoists vi.mock automatically.
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  pushFiles: vi.fn(),
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
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  extractJSON,
  DRAFT_RELEVANT_DOCS,
  ARCHIVE_FILE_SUFFIX,
  registerFinalize,
} from "../src/tools/finalize.js";
import {
  fetchFile,
  pushFile,
  listDirectory,
  listCommits,
  createAtomicCommit,
} from "../src/github/client.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
} from "../src/ai/synthesize.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGenerateIntelligenceBrief = vi.mocked(generateIntelligenceBrief);
const mockGeneratePendingDocUpdates = vi.mocked(generatePendingDocUpdates);

describe("extractJSON (B.8 — robust AI output parsing)", () => {
  it("parses raw JSON directly", () => {
    const input = '{"handoff": "content", "session_log": "entries"}';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.handoff).toBe("content");
  });

  it("strips markdown code fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("strips code fences without language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("extracts JSON from surrounding text", () => {
    const input = 'Here is the output:\n\n{"drafts": [1, 2, 3]}\n\nLet me know if this looks good.';
    const result = extractJSON(input) as Record<string, number[]>;
    expect(result.drafts).toEqual([1, 2, 3]);
  });

  it("extracts JSON array from text", () => {
    const input = 'The results: [{"id": 1}, {"id": 2}]';
    const result = extractJSON(input) as Array<{ id: number }>;
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
  });

  it("handles whitespace around JSON", () => {
    const input = '  \n  {"key": "value"}  \n  ';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("throws on completely invalid input", () => {
    expect(() => extractJSON("This is just text with no JSON")).toThrow(
      "Failed to extract JSON from AI response"
    );
  });

  it("handles nested JSON objects", () => {
    const input = '```json\n{"handoff": {"version": 31}, "decisions": {"count": 48}}\n```';
    const result = extractJSON(input) as Record<string, Record<string, number>>;
    expect(result.handoff.version).toBe(31);
    expect(result.decisions.count).toBe(48);
  });
});

describe("extractJSON stress tests (S33b)", () => {
  it("handles JSON with 1000 keys", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) obj[`key_${i}`] = i;
    const input = JSON.stringify(obj);
    const result = extractJSON(input) as Record<string, number>;
    expect(result.key_0).toBe(0);
    expect(result.key_999).toBe(999);
  });

  it("handles markdown fences with extra whitespace", () => {
    const input = '  ```json  \n  {"key": "value"}  \n  ```  ';
    const result = extractJSON(input) as Record<string, string>;
    expect(result.key).toBe("value");
  });

  it("handles broken JSON gracefully", () => {
    expect(() => extractJSON('{"key": "value"')).toThrow();
    expect(() => extractJSON('{"key": undefined}')).toThrow();
  });
});

describe("DRAFT_RELEVANT_DOCS archive exclusion (S40 FINDING-14 C3)", () => {
  it("never contains a string ending in -archive.md", () => {
    for (const doc of DRAFT_RELEVANT_DOCS) {
      expect(doc.endsWith(ARCHIVE_FILE_SUFFIX)).toBe(false);
    }
  });

  it("excludes architecture.md, glossary.md, intelligence-brief.md (pre-existing behavior)", () => {
    expect(DRAFT_RELEVANT_DOCS).not.toContain("architecture.md");
    expect(DRAFT_RELEVANT_DOCS).not.toContain("glossary.md");
    expect(DRAFT_RELEVANT_DOCS).not.toContain("intelligence-brief.md");
  });

  it("retains core draft-relevant docs", () => {
    expect(DRAFT_RELEVANT_DOCS).toContain("handoff.md");
    expect(DRAFT_RELEVANT_DOCS).toContain("session-log.md");
    expect(DRAFT_RELEVANT_DOCS).toContain("task-queue.md");
    expect(DRAFT_RELEVANT_DOCS).toContain("insights.md");
  });
});

// ── Commit-handler synthesis dispatch (D-156 §3.6) ──────────────────────────────

describe("commit handler dispatches both synthesis functions in parallel", () => {
  const HANDOFF_CONTENT = `## Meta
- Handoff Version: 30
- Session Count: 25
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. PRISM MCP Server runs the show.

## Where We Are
Working on the dispatch test.

<!-- EOF: handoff.md -->`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchFile.mockResolvedValue({
      content: HANDOFF_CONTENT,
      sha: "head_sha",
      size: HANDOFF_CONTENT.length,
    });
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 100, output_tokens: 50 });
    mockGeneratePendingDocUpdates.mockResolvedValue({ success: true, input_tokens: 100, output_tokens: 50 });
  });

  it("invokes both generateIntelligenceBrief and generatePendingDocUpdates on a successful commit", async () => {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];

    const mockExtra = {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "test-dispatch-1",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    };

    const result = await tool.handler(
      {
        project_slug: "test-project",
        action: "commit",
        session_number: 26,
        handoff_version: 31,
        files: [
          { path: "glossary.md", content: "# Glossary\n<!-- EOF: glossary.md -->" },
        ],
      },
      mockExtra,
    );

    const data = JSON.parse(result.content[0].text);
    expect(data.all_succeeded).toBe(true);
    expect(data.synthesis_outcome).toBe("background");

    // The dispatch is fire-and-forget via Promise.allSettled. The .then callback
    // may have queued microtasks after the response is built — flush before
    // asserting both mocks were called.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockGenerateIntelligenceBrief).toHaveBeenCalledOnce();
    expect(mockGeneratePendingDocUpdates).toHaveBeenCalledOnce();
  });
});

// ── brief-411 / D-193 Piece 1 — persisted recommendation injection ─────────────

describe("commit phase injects persisted recommendation into handoff.md", () => {
  /**
   * Build a handoff body with the given Next Steps content. The classifier
   * keys off Next Steps (and only Next Steps) per brief-411 — varying that
   * section is enough to exercise each category branch.
   */
  function buildHandoff(nextSteps: string[]): string {
    const stepLines = nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    return `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.16.0
- Status: Active

## Critical Context
1. Past-tense executional language: deployed, executed, reconnect.

## Where We Are
Holding pattern.

## Next Steps
${stepLines}

<!-- EOF: handoff.md -->
`;
  }

  /**
   * Helper — invoke the prism_finalize commit handler with the given handoff
   * content and return the writes captured by the mocked atomic commit.
   */
  async function runCommit(handoffContent: string): Promise<Array<{ path: string; content: string }>> {
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];

    const mockExtra = {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "test-recommendation",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    };

    const result = await tool.handler(
      {
        project_slug: "test-project",
        action: "commit",
        session_number: 26,
        handoff_version: 31,
        files: [
          { path: "handoff.md", content: handoffContent },
        ],
      },
      mockExtra,
    );

    const data = JSON.parse(result.content[0].text);
    expect(data.all_succeeded).toBe(true);

    // The atomic commit receives the post-mutation writes. First call
    // (resolved by the auto-backup) is the handoff backup; the commit-phase
    // call has writes that contain our handoff. Find the call that includes
    // a path matching handoff.md.
    const callsWithHandoff = mockCreateAtomicCommit.mock.calls.filter((args: unknown[]) => {
      const writes = args[1] as Array<{ path: string; content: string }>;
      return writes.some(w => w.path === "handoff.md" || w.path.endsWith("/handoff.md"));
    });
    expect(callsWithHandoff.length).toBeGreaterThan(0);
    return callsWithHandoff[0][1] as Array<{ path: string; content: string }>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The auto-backup path reads the existing handoff via fetchFile — return
    // a minimal valid response so it doesn't throw and abort the commit.
    mockFetchFile.mockResolvedValue({
      content: "## Meta\n- Handoff Version: 30\n<!-- EOF: handoff.md -->",
      sha: "head_sha",
      size: 60,
    });
    mockListDirectory.mockResolvedValue([]);
    mockListCommits.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new_sha" });
    mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
    mockGenerateIntelligenceBrief.mockResolvedValue({ success: true, input_tokens: 100, output_tokens: 50 });
    mockGeneratePendingDocUpdates.mockResolvedValue({ success: true, input_tokens: 100, output_tokens: 50 });
  });

  it("writes a reasoning_heavy block when next_steps are design / investigation work", async () => {
    const writes = await runCommit(buildHandoff([
      "Design the orchestration layer",
      "Architect the new module",
      "Brainstorm tradeoffs and compare strategy options",
    ]));
    const handoffWrite = writes.find(w => w.path === "handoff.md")!;
    expect(handoffWrite.content).toContain("<!-- prism:recommended_session_settings -->");
    expect(handoffWrite.content).toContain("- Category: reasoning_heavy");
    expect(handoffWrite.content).toContain("- Model: Opus 4.7");
    expect(handoffWrite.content).toContain("- Thinking: Adaptive on");
  });

  it("writes an executional block when next_steps are mechanical cleanup", async () => {
    const writes = await runCommit(buildHandoff([
      "Cleanup INS-223 dead-config references",
      "Patch task-queue to demote stale items",
      "Push the updated boot-test fixture",
    ]));
    const handoffWrite = writes.find(w => w.path === "handoff.md")!;
    expect(handoffWrite.content).toContain("- Category: executional");
    expect(handoffWrite.content).toContain("- Model: Sonnet 4.6");
    expect(handoffWrite.content).toContain("- Thinking: Adaptive off");
  });

  it("writes a mixed block when next_steps balance reasoning and execution", async () => {
    const writes = await runCommit(buildHandoff([
      "Debug the regression",
      "Verify the fix",
    ]));
    const handoffWrite = writes.find(w => w.path === "handoff.md")!;
    expect(handoffWrite.content).toContain("- Category: mixed");
    expect(handoffWrite.content).toContain("- Model: Opus 4.7");
    expect(handoffWrite.content).toContain("- Thinking: Adaptive off");
  });

  it("places the block immediately after ## Meta and before ## Critical Context", async () => {
    const writes = await runCommit(buildHandoff([
      "Design the orchestrator",
    ]));
    const handoffWrite = writes.find(w => w.path === "handoff.md")!;
    const metaIdx = handoffWrite.content.indexOf("## Meta");
    const blockIdx = handoffWrite.content.indexOf("## Recommended Session Settings");
    const criticalIdx = handoffWrite.content.indexOf("## Critical Context");
    expect(metaIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThan(metaIdx);
    expect(criticalIdx).toBeGreaterThan(blockIdx);
    // EOF sentinel preserved.
    expect(handoffWrite.content.trimEnd().endsWith("<!-- EOF: handoff.md -->")).toBe(true);
  });

  it("replaces an existing block in place rather than producing duplicates", async () => {
    // Pre-populate the inbound handoff with a stale (executional) block.
    const handoffWithStaleBlock = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.16.0
- Status: Active

## Recommended Session Settings

<!-- prism:recommended_session_settings -->
- Model: Sonnet 4.6
- Thinking: Adaptive off
- Category: executional
- Rationale: stale rationale
<!-- /prism:recommended_session_settings -->

## Critical Context
1. Some context.

## Where We Are
Working.

## Next Steps
1. Design the orchestrator
2. Architect the new pipeline
3. Investigate prior art

<!-- EOF: handoff.md -->
`;

    const writes = await runCommit(handoffWithStaleBlock);
    const handoffWrite = writes.find(w => w.path === "handoff.md")!;

    // Exactly one delimiter pair.
    const opens = (handoffWrite.content.match(/<!-- prism:recommended_session_settings -->/g) ?? []).length;
    expect(opens).toBe(1);

    // New verdict (reasoning_heavy from the design-heavy next_steps), stale verdict gone.
    expect(handoffWrite.content).toContain("- Category: reasoning_heavy");
    expect(handoffWrite.content).not.toContain("- Category: executional");
    expect(handoffWrite.content).not.toContain("stale rationale");
  });

  it("logs a warn and skips injection when handoff has no ## Meta section", async () => {
    const loggerModule = await import("../src/utils/logger.js");
    const loggerWarnSpy = vi.spyOn(loggerModule.logger, "warn");

    // No ## Meta header at all — legacy/malformed handoff. Validation will
    // reject this handoff downstream (## Meta is mandatory), but the
    // injection skip path must still log a warn rather than throw — that
    // is the brief-411 A.1 contract.
    const handoffWithoutMeta = `# Handoff

## Critical Context
1. Some context.

## Where We Are
Working.

## Next Steps
1. Cleanup the dead code.

<!-- EOF: handoff.md -->
`;

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];

    const mockExtra = {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "test-no-meta",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    };

    // The handler returns without throwing even though validation will fail.
    await tool.handler(
      {
        project_slug: "test-project",
        action: "commit",
        session_number: 26,
        handoff_version: 31,
        files: [
          { path: "handoff.md", content: handoffWithoutMeta },
        ],
      },
      mockExtra,
    );

    const warnCalls = loggerWarnSpy.mock.calls.map(c => String(c[0]));
    expect(warnCalls.some(msg => msg.includes("no ## Meta section"))).toBe(true);

    loggerWarnSpy.mockRestore();
  });
});
