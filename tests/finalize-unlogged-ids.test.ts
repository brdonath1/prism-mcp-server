/**
 * brief-444 (optional sub-change) — finalize unlogged-ID warning.
 *
 * At finalize, session text that references a D-N / INS-N ID absent from
 * every registry source surfaces a NON-BLOCKING `UNLOGGED_ID_REFERENCED`
 * warn diagnostic. Pure-function tests run without mocks; the integration
 * tests drive the real commit action over a mocked GitHub client.
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
  getHeadSha: vi.fn(),
  getDefaultBranch: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

import {
  createAtomicCommit,
  fetchFile,
  fileExists,
  getHeadSha,
  listDirectory,
  pushFile,
} from "../src/github/client.js";
import { registerFinalize } from "../src/tools/finalize.js";
import { extractReferencedIds, findUnloggedIds } from "../src/utils/unlogged-ids.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("extractReferencedIds — pure", () => {
  it("extracts and dedups D-N and INS-N references", () => {
    const refs = extractReferencedIds(
      "Settled D-241 and D-241 again; INS-69 governs concurrency. See D-9.",
    );
    expect([...refs.decisions].sort()).toEqual(["D-241", "D-9"].sort());
    expect([...refs.insights]).toEqual(["INS-69"]);
  });

  it("respects word boundaries — no matches inside larger tokens", () => {
    const refs = extractReferencedIds("ID-241 PRD-12 WIND-3 COLLINS-7 D-X");
    expect(refs.decisions.size).toBe(0);
    expect(refs.insights.size).toBe(0);
  });
});

describe("findUnloggedIds — pure", () => {
  const files = [
    { path: "session-log.md", content: "Did D-99 work and noted INS-77; revisited D-1 and INS-1." },
  ];

  it("reports referenced IDs missing from the registries, numerically sorted", () => {
    const report = findUnloggedIds(
      [
        { path: "a.md", content: "refs D-100 and D-9 plus INS-20" },
      ],
      { decisionIds: new Set<string>(), insightIds: new Set<string>() },
    );
    expect(report.decisions).toEqual(["D-9", "D-100"]);
    expect(report.insights).toEqual(["INS-20"]);
  });

  it("does not report IDs present in the registries", () => {
    const report = findUnloggedIds(files, {
      decisionIds: new Set(["D-1", "D-99"]),
      insightIds: new Set(["INS-1", "INS-77"]),
    });
    expect(report.decisions).toEqual([]);
    expect(report.insights).toEqual([]);
  });

  it("skips a family entirely when its registry state is unknown (null)", () => {
    const report = findUnloggedIds(files, {
      decisionIds: null,
      insightIds: new Set(["INS-1"]),
    });
    expect(report.decisions).toEqual([]);
    expect(report.insights).toEqual(["INS-77"]);
  });
});

// ---------------------------------------------------------------------------
// Integration through the real commit action
// ---------------------------------------------------------------------------

const CURRENT_HANDOFF = `## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. test

## Where We Are
here
<!-- EOF: handoff.md -->`;

const INDEX_WITH_D1 = `# Decisions

| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | First decision | architecture | SETTLED | 1 |

<!-- EOF: _INDEX.md -->`;

const INSIGHTS_WITH_INS1 = `# Insights — test-project

## Active

### INS-1: First insight
- Category: pattern
- Discovered: Session 1
- Description: Something.

## Formalized

<!-- EOF: insights.md -->`;

async function callFinalizeCommit(
  files: Array<{ path: string; content: string }>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_finalize"];
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: undefined,
    requestId: "test-unlogged-ids",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };
  return (await tool.handler(
    {
      project_slug: "test-project",
      action: "commit",
      session_number: 2,
      handoff_version: 2,
      files,
      skip_synthesis: true,
    },
    mockExtra,
  )) as never;
}

function diagnosticsOf(result: { content: Array<{ type: string; text: string }> }): any[] {
  return JSON.parse(result.content[0].text).diagnostics ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md") {
      return { content: CURRENT_HANDOFF, sha: "h1", size: CURRENT_HANDOFF.length };
    }
    if (path === ".prism/decisions/_INDEX.md") {
      return { content: INDEX_WITH_D1, sha: "d1", size: INDEX_WITH_D1.length };
    }
    if (path === ".prism/insights.md") {
      return { content: INSIGHTS_WITH_INS1, sha: "i1", size: INSIGHTS_WITH_INS1.length };
    }
    throw new Error(`Not found: fetchFile test-project/${path}`);
  });
  mockFileExists.mockResolvedValue(false);
  mockListDirectory.mockResolvedValue([]);
  mockPushFile.mockResolvedValue({ success: true, sha: "p1", size: 10 });
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "commit1", files_committed: 1 });
  mockGetHeadSha.mockResolvedValue("HEAD_1");
});

describe("brief-444 — finalize UNLOGGED_ID_REFERENCED diagnostic", () => {
  it("warns when committed session text references IDs never logged (non-blocking)", async () => {
    const result = await callFinalizeCommit([
      {
        path: "session-log.md",
        content:
          "# Session Log\n\n### Session 2 (2026-06-04)\nSettled D-99 and captured INS-77. Revisited D-1 / INS-1.\n\n<!-- EOF: session-log.md -->",
      },
    ]);

    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.all_succeeded).toBe(true); // never blocks the commit

    const diag = diagnosticsOf(result).find((d) => d.code === "UNLOGGED_ID_REFERENCED");
    expect(diag).toBeDefined();
    expect(diag.level).toBe("warn");
    expect(diag.context.decisions).toEqual(["D-99"]);
    expect(diag.context.insights).toEqual(["INS-77"]);
    expect(diag.message).toContain("D-99");
    expect(diag.message).toContain("INS-77");
  });

  it("stays silent when every referenced ID is present in a registry source", async () => {
    const result = await callFinalizeCommit([
      {
        path: "session-log.md",
        content:
          "# Session Log\n\n### Session 2 (2026-06-04)\nRevisited D-1 and INS-1 only.\n\n<!-- EOF: session-log.md -->",
      },
    ]);

    expect(result.isError).not.toBe(true);
    const diag = diagnosticsOf(result).find((d) => d.code === "UNLOGGED_ID_REFERENCED");
    expect(diag).toBeUndefined();
  });

  it("treats committed registry versions as authoritative — a commit that adds the D-N row is logged", async () => {
    const indexWithD99 = `# Decisions

| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | First decision | architecture | SETTLED | 1 |
| D-99 | New decision | operations | SETTLED | 2 |

<!-- EOF: _INDEX.md -->`;

    const result = await callFinalizeCommit([
      {
        path: "session-log.md",
        content:
          "# Session Log\n\n### Session 2 (2026-06-04)\nSettled D-99 this session.\n\n<!-- EOF: session-log.md -->",
      },
      { path: "decisions/_INDEX.md", content: indexWithD99 },
    ]);

    expect(result.isError).not.toBe(true);
    const diag = diagnosticsOf(result).find((d) => d.code === "UNLOGGED_ID_REFERENCED");
    expect(diag).toBeUndefined();
  });

  it("skips the insight family on an operational registry fetch error (fail-open, decisions still checked)", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/handoff.md") {
        return { content: CURRENT_HANDOFF, sha: "h1", size: CURRENT_HANDOFF.length };
      }
      if (path === ".prism/decisions/_INDEX.md") {
        return { content: INDEX_WITH_D1, sha: "d1", size: INDEX_WITH_D1.length };
      }
      // Operational failure on BOTH resolver paths (.prism/ AND legacy root) —
      // resolveDocPath's root fallback otherwise masks a .prism/ error with
      // the root path's "Not found".
      if (path === ".prism/insights.md" || path === "insights.md") {
        throw new Error("GitHub API 502: upstream unavailable (fetchFile)");
      }
      throw new Error(`Not found: fetchFile test-project/${path}`);
    });

    const result = await callFinalizeCommit([
      {
        path: "session-log.md",
        content:
          "# Session Log\n\n### Session 2 (2026-06-04)\nSettled D-99 and captured INS-77.\n\n<!-- EOF: session-log.md -->",
      },
    ]);

    const diag = diagnosticsOf(result).find((d) => d.code === "UNLOGGED_ID_REFERENCED");
    expect(diag).toBeDefined();
    expect(diag.context.decisions).toEqual(["D-99"]);
    // Insight registry state unknown → family skipped, no false positive.
    expect(diag.context.insights).toEqual([]);
  });
});
