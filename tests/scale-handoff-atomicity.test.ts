// S47 P2.2 — prism_scale_handoff must atomically commit destination files
// AND the reduced handoff. Partial-state risk (extracted content written
// before destinations) is the whole motivation of the A-6 fix.
//
// Exercises the atomic-commit + HEAD-SHA guard + sequential fallback contract,
// mirrored from push.ts.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

import {
  fetchFile,
  fetchFiles,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { registerScaleHandoff } from "../src/tools/scale.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

// A handoff large enough to trigger scaling with known destination sections.
const HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item
2. Second critical item
3. Third critical item

## Session History
### Session 1
Content.
### Session 2
Content.
### Session 3
Content.
### Session 4
Content.
### Session 5
Content.
### Session 6
Content.

## Active Decisions
### D-1: First decision
- Domain: architecture
- Status: SETTLED
- Session: 1
- Reasoning: Body text.

### D-2: Second decision
- Domain: operations
- Status: SETTLED
- Session: 2
- Reasoning: Body text.

## Where We Are
Currently working on feature X.

<!-- EOF: handoff.md -->`;

async function runScaleFull() {
  mockFetchFile.mockResolvedValue({
    content: HANDOFF,
    sha: "sha0",
    size: HANDOFF.length,
  });
  mockFetchFiles.mockResolvedValue(
    new Map([
      [
        "session-log.md",
        { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 },
      ],
      [
        "decisions/_INDEX.md",
        { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 },
      ],
      [
        "eliminated.md",
        { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 },
      ],
      [
        "architecture.md",
        { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 },
      ],
    ]),
  );

  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerScaleHandoff(server);
  const tool = (server as any)._registeredTools["prism_scale_handoff"];
  return tool.handler(
    { project_slug: "test-project", action: "full" },
    {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "r",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("S47 P2.2 — happy path atomic commit bundles destinations + handoff", () => {
  it("calls createAtomicCommit once with all files including the reduced handoff", async () => {
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 5,
    });

    const result = await runScaleFull();
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();

    // Atomic call gets the full file list.
    const atomicFiles = mockCreateAtomicCommit.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    const paths = atomicFiles.map((f) => f.path);

    // Must include the reduced handoff as the last entry (A-6 contract —
    // "destinations + handoff together").
    expect(paths).toContain(".prism/handoff.md");
    // And at least one destination (at least session-log or decisions).
    expect(paths.length).toBeGreaterThanOrEqual(2);

    // Response push_results reflects one entry per atomically-committed file.
    expect(payload.push_results.length).toBe(paths.length);
    for (const r of payload.push_results) {
      expect(r.success).toBe(true);
    }
  });
});

describe("S47 P2.2 — HEAD-moved branch surfaces partial-state warning (no fallback)", () => {
  it("reports partial_state in warnings AND does NOT call pushFile fallback", async () => {
    mockGetHeadSha.mockResolvedValueOnce("head-before");
    mockCreateAtomicCommit.mockResolvedValueOnce({
      success: false,
      sha: "",
      files_committed: 0,
      error: "Not found: updateRef test-project",
    });
    mockGetHeadSha.mockResolvedValueOnce("head-after-moved");

    const result = await runScaleFull();
    const payload = JSON.parse(result.content[0].text);

    // Critical: fallback MUST NOT run when HEAD moved — repo is in an
    // indeterminate state and a retry could double-write.
    expect(mockPushFile).not.toHaveBeenCalled();

    // Warnings surface the partial-state signal so operators can investigate.
    expect(payload.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Partial atomic commit"),
      ]),
    );
    // All push_results must report failure (nothing was actually persisted).
    for (const r of payload.push_results) {
      expect(r.success).toBe(false);
    }
  });
});

describe("S47 P2.2 — HEAD-unchanged branch falls back to sequential pushFile", () => {
  it("calls pushFile once per file when atomic fails but HEAD is stable", async () => {
    mockGetHeadSha.mockResolvedValueOnce("head-same");
    mockCreateAtomicCommit.mockResolvedValueOnce({
      success: false,
      sha: "",
      files_committed: 0,
      error: "Not found: updateRef test-project",
    });
    // HEAD unchanged — safe to retry sequentially.
    mockGetHeadSha.mockResolvedValueOnce("head-same");
    mockPushFile.mockResolvedValue({
      success: true,
      size: 100,
      sha: "seq-sha",
    });

    const result = await runScaleFull();
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();

    // Sequential pushFile called at least once per atomic-committed file.
    const atomicFiles = mockCreateAtomicCommit.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    expect(mockPushFile).toHaveBeenCalledTimes(atomicFiles.length);

    // All succeeded — no partial-state warning.
    expect(payload.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("Partial atomic commit")]),
    );

    // Handoff push uses the "prism: scale handoff" commit message; destinations
    // use "prism: extract <filename>". Verify at least one of each.
    const handoffCall = mockPushFile.mock.calls.find((c) => c[1] === ".prism/handoff.md");
    expect(handoffCall).toBeDefined();
    expect(handoffCall![3]).toBe("prism: scale handoff");

    const extractCall = mockPushFile.mock.calls.find(
      (c) => typeof c[3] === "string" && (c[3] as string).startsWith("prism: extract"),
    );
    expect(extractCall).toBeDefined();
  });
});
