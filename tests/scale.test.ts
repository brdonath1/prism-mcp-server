// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the GitHub client
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

/**
 * Helper to find the content of a given path inside the atomic-commit files
 * array (the primary write path after S47 P2.2). Mirrors the pre-S47 pattern
 * of searching mockPushFile.mock.calls — the content lookup shape stays the
 * same so the assertions below read cleanly.
 */
function atomicContentOf(path: string): string | undefined {
  for (const call of mockCreateAtomicCommit.mock.calls) {
    const files = call[1] as Array<{ path: string; content: string }>;
    const match = files.find((f) => f.path === path);
    if (match) return match.content;
  }
  return undefined;
}

/** Convenience — default happy-path atomic commit mock. */
function setupAtomicHappyPath(): void {
  mockGetHeadSha.mockResolvedValue("head-sha");
  mockCreateAtomicCommit.mockResolvedValue({
    success: true,
    sha: "atomic-sha",
    files_committed: 10,
  });
}

/** Small handoff (<10KB) with scalable content for testing. */
const SMALL_HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item
2. Second critical item

## Session History
### Session 1
Did something early.
### Session 2
Did something else.
### Session 3
More work here.
### Session 4
Some work.
### Session 5
Latest work.

## Where We Are
Currently working on feature X.

## Open Questions
1. Something resolved
2. Still open question

<!-- EOF: handoff.md -->`;

/** Handoff with no scalable content. */
const CLEAN_HANDOFF = `## Meta
- Handoff Version: 5
- Session Count: 10
- Template Version: 2.0.0
- Status: active

## Critical Context
1. First critical item

## Where We Are
Working on X.

<!-- EOF: handoff.md -->`;

/**
 * Helper: invoke the scale_handoff tool via the McpServer's internal handler.
 * We register the tool and then directly call the registered handler via
 * the server's request handler mechanism.
 */
async function callScaleTool(
  args: Record<string, unknown>,
  meta?: { progressToken?: string | number },
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerScaleHandoff(server);

  // Access the registered tool handler through the internal _registeredTools object
  const registeredTools = (server as any)._registeredTools;
  const tool = registeredTools["prism_scale_handoff"];
  if (!tool) throw new Error("Tool not registered");

  // Build a mock extra object
  const mockExtra = {
    signal: new AbortController().signal,
    _meta: meta ? { progressToken: meta.progressToken } : undefined,
    requestId: "test-req-1",
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn().mockResolvedValue(undefined),
  };

  const result = await tool.handler(args, mockExtra);
  return result as any;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── analyze mode ─────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=analyze", () => {
  it("returns a valid plan without pushing anything", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));

    const result = await callScaleTool({ project_slug: "test-project", action: "analyze" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("analyze");
    expect(data.project).toBe("test-project");
    expect(data.before_size_bytes).toBeGreaterThan(0);
    expect(data.plan).toBeDefined();
    expect(data.plan.project_slug).toBe("test-project");
    expect(data.plan.actions).toBeInstanceOf(Array);
    expect(data.plan.actions.length).toBeGreaterThan(0);

    // Verify no writes were made (neither sequential push nor atomic commit).
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("returns empty actions for a clean handoff", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const result = await callScaleTool({ project_slug: "test-project", action: "analyze" });

    const data = parseResult(result);
    expect(data.action).toBe("analyze");
    expect(data.plan.actions).toHaveLength(0);
    expect(data.warnings).toContain("No scalable content identified. Handoff may already be optimally sized.");
  });
});

// ── execute mode ─────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=execute", () => {
  it("executes a plan and pushes files", async () => {
    const plan = {
      project_slug: "test-project",
      before_size_bytes: 500,
      actions: [
        {
          description: "Archive 2 old session entries to session-log.md",
          source_section: "Session History",
          destination_file: "session-log.md",
          bytes_moved: 100,
          content_to_move: "### Session 1\nDid something.\n### Session 2\nDid more.",
        },
      ],
    };

    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
    ]));
    setupAtomicHappyPath();

    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
      plan,
    });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("execute");
    expect(data.actions_executed).toBeGreaterThanOrEqual(1);

    // S47 P2.2: destination file + handoff pushed via a single atomic commit
    // (no more separate sequential pushes). Fallback to pushFile only on
    // atomic failure — the happy-path assertion is "no pushFile, one atomic".
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("rejects execute without a plan", async () => {
    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain("Missing 'plan' parameter");
  });

  it("rejects execute with mismatched project_slug", async () => {
    const plan = {
      project_slug: "other-project",
      before_size_bytes: 500,
      actions: [],
    };

    const result = await callScaleTool({
      project_slug: "test-project",
      action: "execute",
      plan,
    });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain("does not match");
  });
});

// ── full mode ────────────────────────────────────────────────────────────────

describe("prism_scale_handoff action=full", () => {
  it("works end-to-end for a small handoff", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));
    setupAtomicHappyPath();

    const result = await callScaleTool({ project_slug: "test-project", action: "full" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("full");
    expect(data.before_size_bytes).toBeGreaterThan(0);
    expect(data.after_size_bytes).toBeDefined();
    expect(data.elapsed_ms).toBeDefined();
    expect(data.timed_out).toBe(false);
  });

  it("defaults to full mode when action is not specified", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const result = await callScaleTool({ project_slug: "test-project" });

    const data = parseResult(result);
    expect(data.action).toBe("full");
    expect(data.warnings).toContain("No scalable content identified. Handoff may already be optimally sized.");
  });
});

// ── structured error output ──────────────────────────────────────────────────

describe("prism_scale_handoff structured errors", () => {
  it("returns structured error on GitHub API failure", async () => {
    mockFetchFile.mockRejectedValue(new Error("GitHub PAT is invalid or expired."));

    const result = await callScaleTool({ project_slug: "test-project", action: "full" });

    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBe("Scale operation failed");
    expect(data.stage).toBeDefined();
    expect(data.elapsed_ms).toBeDefined();
    expect(data.detail).toContain("PAT");
    expect(data.project).toBe("test-project");
    expect(data.action).toBe("full");
  });
});

// ── progress notifications ───────────────────────────────────────────────────

describe("prism_scale_handoff progress notifications", () => {
  it("sends progress notifications when progressToken is provided", async () => {
    mockFetchFile.mockResolvedValue({
      content: SMALL_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(SMALL_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map([
      ["session-log.md", { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 }],
      ["decisions/_INDEX.md", { content: "# Decisions\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 40 }],
      ["eliminated.md", { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 }],
      ["architecture.md", { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 }],
    ]));
    setupAtomicHappyPath();

    // We need to access the sendNotification mock — rebuild the tool invocation
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerScaleHandoff(server);

    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["prism_scale_handoff"];
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await tool!.handler(
      { project_slug: "test-project", action: "full" },
      {
        signal: new AbortController().signal,
        _meta: { progressToken: "test-token-42" },
        requestId: "test-req-1",
        sendNotification,
        sendRequest: vi.fn().mockResolvedValue(undefined),
      },
    );

    // Should have sent multiple progress notifications
    expect(sendNotification).toHaveBeenCalled();
    const calls = sendNotification.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Verify notification structure
    const firstCall = calls[0][0];
    expect(firstCall.method).toBe("notifications/progress");
    expect(firstCall.params.progressToken).toBe("test-token-42");
    expect(firstCall.params.progress).toBeGreaterThanOrEqual(1);
    expect(firstCall.params.total).toBe(6);
    expect(firstCall.params.message).toBeDefined();
  });

  it("does not send progress notifications when no progressToken", async () => {
    mockFetchFile.mockResolvedValue({
      content: CLEAN_HANDOFF,
      sha: "abc123",
      size: new TextEncoder().encode(CLEAN_HANDOFF).length,
    });
    mockFetchFiles.mockResolvedValue(new Map());

    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    registerScaleHandoff(server);

    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["prism_scale_handoff"];
    const sendNotification = vi.fn().mockResolvedValue(undefined);

    await tool!.handler(
      { project_slug: "test-project", action: "full" },
      {
        signal: new AbortController().signal,
        _meta: {},
        requestId: "test-req-1",
        sendNotification,
        sendRequest: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ── KI-11: Large handoff scaling ────────────────────────────────────────────

/**
 * Generate a realistic ~20KB handoff with inline decisions, session history,
 * artifacts table, verbose sections, and checked open questions.
 */
function generateLargeHandoff(numDecisions: number, numSessions: number): string {
  let content = `## Meta
- Handoff Version: 16
- Session Count: ${numSessions}
- Template Version: 2.0.0
- Status: active

## Critical Context
1. Database migrations must always be backward-compatible to avoid downtime
2. The Pexels API key is stored in Railway env vars — never commit to source
3. Git auto-push is disabled for safety — always push manually after review
4. Prisma version must stay at 5.x due to migration compatibility constraints
5. Feature flags are managed via LaunchDarkly — never hardcode toggles
6. The subscription billing integration uses Stripe test mode only in staging
7. Authenticated routes require the scoped JWT middleware, not the legacy session
8. Rate limiting on the public API is set to 100 req/min per IP address

## Where We Are
Currently working on the integration layer between the frontend and backend services. The primary focus is on implementing the real-time notification system using WebSocket connections. We have completed the basic infrastructure setup including the message queue, event dispatcher, and client-side subscription manager. The notification preferences UI has been designed but not yet implemented. We need to wire up the preference toggles to the backend API endpoints that were created in the previous session. There is also ongoing work to optimize the database queries for the notification history feature, which currently has performance issues with large datasets exceeding 10,000 records.

## Active Decisions
`;

  // Generate inline decisions
  const domains = ["Architecture", "Frontend", "Backend", "DevOps", "Testing"];
  for (let i = 1; i <= numDecisions; i++) {
    content += `### D-${i}: Decision ${i} about ${domains[i % domains.length].toLowerCase()} design
**Status:** SETTLED
**Domain:** ${domains[i % domains.length]}
**Session:** ${Math.ceil(i / 3)}
**Reasoning:** This decision was made after evaluating multiple alternatives including several open-source solutions and custom implementations. The chosen approach balances performance, maintainability, and team familiarity.

`;
  }

  // Generate session history
  content += `## Session History\n`;
  for (let i = 1; i <= numSessions; i++) {
    const month = String(Math.ceil(i / 28)).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    content += `### Session ${i}
Date: 2026-${month}-${day}
Worked on feature implementation and bug fixes. Made progress on core functionality and resolved several blocking issues identified in the previous session review.

`;
  }

  // Artifacts registry (>2KB)
  content += `## Artifacts Registry\n\n`;
  content += `| File | Type | Status | Session | Description |\n`;
  content += `|------|------|--------|---------|-------------|\n`;
  for (let i = 1; i <= 25; i++) {
    content += `| src/components/Component${i}.tsx | code | active | ${Math.ceil(i / 2)} | React component for feature ${i} with state management and API integration |\n`;
  }

  // Open questions (mix of open and resolved)
  content += `\n## Open Questions\n`;
  for (let i = 1; i <= 5; i++) {
    content += `- [ ] Open question ${i} about the project direction and next steps\n`;
  }
  for (let i = 1; i <= 3; i++) {
    content += `- [x] Resolved question ${i} that has been answered and closed\n`;
  }

  // Strategic direction (verbose, >500 bytes)
  content += `\n## Strategic Direction
The project is focused on building a scalable and maintainable platform that can handle high traffic loads. We are prioritizing performance optimization and user experience improvements. The long-term vision includes expanding the platform to support multiple regions and languages, with a focus on accessibility and internationalization.

Additional strategic considerations include the need to migrate from the legacy authentication system to a modern OAuth2-based solution, which will require coordination with the security team. The migration is planned for Q2 2026 and will affect all user-facing services.

`;

  content += `<!-- EOF: handoff.md -->`;
  return content;
}

const LARGE_HANDOFF = generateLargeHandoff(46, 16);
const LARGE_HANDOFF_SIZE = new TextEncoder().encode(LARGE_HANDOFF).length;

/** Living doc content map for KI-11 tests (mirrors what mockFetchFiles provided pre-D-67). */
const KI11_LIVING_DOCS: Record<string, { content: string; sha: string; size: number }> = {
  "session-log.md": { content: "# Session Log\n\n<!-- EOF: session-log.md -->", sha: "s1", size: 50 },
  "decisions/_INDEX.md": { content: "# Decisions\n\n| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|---------|\n\n<!-- EOF: _INDEX.md -->", sha: "d1", size: 100 },
  "eliminated.md": { content: "# Eliminated\n<!-- EOF: eliminated.md -->", sha: "e1", size: 40 },
  "architecture.md": { content: "# Architecture\n<!-- EOF: architecture.md -->", sha: "a1", size: 40 },
};

/**
 * Setup mockFetchFile for KI-11 tests (D-67): .prism/ paths first.
 * The handoff returns LARGE_HANDOFF; living docs return their specific small content.
 */
function setupKI11Mocks(): void {
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    const docName = path.startsWith(".prism/") ? path.slice(".prism/".length) : path;
    if (docName === "handoff.md") {
      return { content: LARGE_HANDOFF, sha: "abc123", size: LARGE_HANDOFF_SIZE };
    }
    const entry = KI11_LIVING_DOCS[docName];
    if (entry) {
      return { content: entry.content, sha: entry.sha, size: entry.size };
    }
    throw new Error(`Not found: ${path}`);
  });
}

describe("KI-11: Large handoff scaling (20KB+ with 46 decisions)", () => {
  it("generates a test handoff of appropriate size", () => {
    // Sanity check: handoff should be ~15-25KB
    expect(LARGE_HANDOFF_SIZE).toBeGreaterThan(15000);
    expect(LARGE_HANDOFF_SIZE).toBeLessThan(30000);
    // Should contain 46 decisions
    const decisionMatches = LARGE_HANDOFF.match(/### D-\d+/g) || [];
    expect(decisionMatches.length).toBe(46);
    // Should contain 16 sessions
    const sessionMatches = LARGE_HANDOFF.match(/### Session \d+/g) || [];
    expect(sessionMatches.length).toBe(16);
  });

  it("analyze identifies all redistributable sections", async () => {
    setupKI11Mocks();

    const result = await callScaleTool({ project_slug: "test-project", action: "analyze" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("analyze");
    expect(data.before_size_bytes).toBe(LARGE_HANDOFF.length);

    // Should identify multiple action types
    const actionDescriptions = data.plan.actions.map((a: any) => a.source_section);
    expect(actionDescriptions).toContain("Active Decisions");
    expect(actionDescriptions).toContain("Session History");
    expect(actionDescriptions).toContain("Artifacts Registry");
    expect(actionDescriptions).toContain("Open Questions");
    expect(actionDescriptions).toContain("Critical Context");

    // Estimated reduction should be >50%
    expect(data.reduction_percent).toBeGreaterThan(50);
  });

  it("full mode reduces a 20KB handoff to under 8KB", async () => {
    setupKI11Mocks();
    setupAtomicHappyPath();

    const result = await callScaleTool({ project_slug: "test-project", action: "full" });

    expect(result.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.action).toBe("full");
    expect(data.before_size_bytes).toBe(LARGE_HANDOFF.length);
    expect(data.after_size_bytes).toBeLessThan(8192);
    expect(data.reduction_percent).toBeGreaterThan(50);
    expect(data.timed_out).toBe(false);
    expect(data.actions_executed).toBeGreaterThanOrEqual(5);
  });

  it("decision extraction produces valid _INDEX.md table rows", async () => {
    setupKI11Mocks();
    setupAtomicHappyPath();

    await callScaleTool({ project_slug: "test-project", action: "full" });

    // S47 P2.2: files now go through createAtomicCommit. Look up by path.
    const indexContent = atomicContentOf(".prism/decisions/_INDEX.md");
    expect(indexContent).toBeDefined();

    // Should contain table header
    expect(indexContent).toContain("| ID |");
    expect(indexContent).toContain("|----|");
    // Should contain decision rows with D-N IDs
    expect(indexContent).toContain("| D-1 |");
    expect(indexContent).toContain("| D-46 |");
    // Should preserve EOF sentinel
    expect(indexContent).toContain("<!-- EOF: _INDEX.md -->");
  });

  it("session extraction produces valid session-log.md content", async () => {
    setupKI11Mocks();
    setupAtomicHappyPath();

    await callScaleTool({ project_slug: "test-project", action: "full" });

    const sessionContent = atomicContentOf(".prism/session-log.md");
    expect(sessionContent).toBeDefined();

    // Should contain archived sessions (older ones, not the last 3)
    expect(sessionContent).toContain("### Session 1");
    expect(sessionContent).toContain("### Session 13");
    // Should NOT contain the last 3 sessions (14, 15, 16)
    expect(sessionContent).not.toContain("### Session 14");
    expect(sessionContent).not.toContain("### Session 15");
    expect(sessionContent).not.toContain("### Session 16");
    // Should preserve EOF sentinel
    expect(sessionContent).toContain("<!-- EOF: session-log.md -->");
  });

  it("handoff retains summary pointers after scaling", async () => {
    setupKI11Mocks();
    setupAtomicHappyPath();

    await callScaleTool({ project_slug: "test-project", action: "full" });

    const handoffContent = atomicContentOf(".prism/handoff.md");
    expect(handoffContent).toBeDefined();
    const h = handoffContent!;
    // Should contain decision summary pointer
    expect(h).toContain("decisions/_INDEX.md");
    expect(h).toContain("46 total decisions");
    // Should contain session summary pointer
    expect(h).toContain("session-log.md");
    expect(h).toContain("16 total sessions");
    // Should contain artifacts pointer
    expect(h).toContain("architecture.md");
    // Should have exactly one EOF sentinel
    const eofCount = (h.match(/<!-- EOF: handoff\.md -->/g) || []).length;
    expect(eofCount).toBe(1);
    // Should still have Meta section
    expect(h).toContain("## Meta");
    // Critical Context should be condensed to 5 items max
    const criticalSection = h.split("## Critical Context")[1]?.split("##")[0] || "";
    const critItems = criticalSection.split("\n").filter((l) => /^\d+\.\s+/.test(l));
    expect(critItems.length).toBeLessThanOrEqual(5);
    // Open Questions should NOT have [x] checked items
    expect(h).not.toMatch(/- \[x\]/i);
  });
});
