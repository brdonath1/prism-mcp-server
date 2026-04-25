// A-4: server-side dedup for prism_log_insight
//
// Unit tests for parseExistingInsightIds() and the dedup rejection flow.
// Mirrors the log-decision-dedup.test.ts pattern.
//
// S62 Phase 1 Brief 1 update: dedup runs INSIDE safeMutation's
// computeMutation, so the check is fed by fetchFile (the safeMutation
// primitive's read mechanism). The bare `pushFile` write path has been
// replaced by createAtomicCommit. Tests below mock fetchFile +
// createAtomicCommit + getHeadSha accordingly.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn(),
}));

import {
  fetchFile,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

import {
  parseExistingInsightIds,
  registerLogInsight,
} from "../src/tools/log-insight.js";

function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: Function,
    ) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

const INSIGHTS_WITH_9999 = `# Insights — test-project

> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).

## Active

### INS-9998: Earlier insight
- Category: pattern
- Discovered: Session 42
- Description: Something useful.

### INS-9999: Existing insight
- Category: gotcha
- Discovered: Session 43
- Description: Already logged.

### INS-10001: Standing rule example — STANDING RULE
- Category: preference — **STANDING RULE**
- Discovered: Session 44
- Description: A standing rule.
- **Standing procedure:** Always do X, then Y.

## Formalized

<!-- EOF: insights.md -->
`;

const EMPTY_INSIGHTS = `# Insights — test-project

## Active

## Formalized

<!-- EOF: insights.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseExistingInsightIds", () => {
  it("returns INS-N IDs with titles from an existing insights.md", () => {
    const ids = parseExistingInsightIds(INSIGHTS_WITH_9999);
    // 3 INS-N entries in the fixture: 9998, 9999, 10001.
    expect(ids.size).toBe(3);
    expect(ids.get("INS-9998")).toBe("Earlier insight");
    expect(ids.get("INS-9999")).toBe("Existing insight");
    // Standing-rule suffix must be stripped from the title.
    expect(ids.get("INS-10001")).toBe("Standing rule example");
  });

  it("returns empty for a fresh file with no entries", () => {
    const ids = parseExistingInsightIds(EMPTY_INSIGHTS);
    expect(ids.size).toBe(0);
  });

  it("ignores ## headers that are not INS-N entries", () => {
    const content = "# Insights\n\n## Active\n\n## Formalized\n\n";
    const ids = parseExistingInsightIds(content);
    expect(ids.size).toBe(0);
  });
});

/** Wire up resolveDocPath + fetchFile for an existing insights.md fixture. */
function setupExistingInsights(content: string) {
  mockResolveDocPath.mockResolvedValue({
    path: ".prism/insights.md",
    content,
    sha: "ins-sha",
    legacy: false,
  });
  mockFetchFile.mockImplementation(async (_repo, path) => {
    if (path === ".prism/insights.md") {
      return { content, sha: "ins-sha", size: content.length };
    }
    throw new Error(`Unexpected fetchFile: ${path}`);
  });
}

describe("prism_log_insight dedup guard (A-4)", () => {
  it("rejects the write when INS-N already exists", async () => {
    setupExistingInsights(INSIGHTS_WITH_9999);
    mockGetHeadSha.mockResolvedValue("head-before");

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);
    const handler = handlers.prism_log_insight;
    expect(handler).toBeDefined();

    const result = await handler({
      project_slug: "test-project",
      id: "INS-9999",
      title: "Attempted duplicate",
      category: "gotcha",
      description: "Should be rejected before any push.",
      session: 50,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.id).toBe("INS-9999");
    expect(payload.existing_title).toBe("Existing insight");
    expect(payload.error).toContain("INS-9999 already exists");
    // Guard must fire BEFORE any GitHub write.
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("accepts a fresh ID that doesn't clash", async () => {
    setupExistingInsights(INSIGHTS_WITH_9999);
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);

    const handler = handlers.prism_log_insight;
    const result = await handler({
      project_slug: "test-project",
      id: "INS-10000",
      title: "Brand new insight",
      category: "pattern",
      description: "Unique ID should be accepted.",
      session: 50,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("INS-10000");
    expect(payload.success).toBe(true);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    // No pushFile fallback path — atomic-only.
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("skips dedup when insights.md does not exist yet (fresh file)", async () => {
    // resolveDocPath throws → file does not exist → fresh file path.
    mockResolveDocPath.mockRejectedValueOnce(new Error("Not found"));
    mockResolveDocPushPath.mockResolvedValue(".prism/insights.md");
    mockGuardPushPath.mockResolvedValue({
      path: ".prism/insights.md",
      redirected: false,
    });
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);

    const handler = handlers.prism_log_insight;
    const result = await handler({
      project_slug: "test-project",
      id: "INS-1",
      title: "First-ever insight",
      category: "pattern",
      description: "Fresh file has no dedup set to check against.",
      session: 1,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("INS-1");
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    // For fresh-file path, safeMutation's readPaths is [] — no fetch needed.
    expect(mockFetchFile).not.toHaveBeenCalled();
  });
});

describe("prism_log_insight concurrent-write recovery (S62 Phase 1 Brief 1)", () => {
  it("retries on 409 against fresh content and lands the write", async () => {
    // Concurrent writer added INS-12345 between attempts. Retry must fetch
    // the fresh content and append our INS against THAT, not the stale snapshot.
    const concurrentInsights = INSIGHTS_WITH_9999.replace(
      "## Formalized",
      "### INS-12345: Concurrent insight\n- Category: pattern\n- Discovered: Session 50\n- Description: Landed during the race.\n\n## Formalized",
    );
    let fetches = 0;
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/insights.md",
      content: INSIGHTS_WITH_9999,
      sha: "ins-1",
      legacy: false,
    });
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/insights.md") {
        fetches += 1;
        const content = fetches === 1 ? INSIGHTS_WITH_9999 : concurrentInsights;
        return { content, sha: `ins-${fetches}`, size: content.length };
      }
      throw new Error(`Unexpected fetchFile: ${path}`);
    });
    mockGetHeadSha
      .mockResolvedValueOnce("head-1")
      .mockResolvedValueOnce("head-2") // post-failure; HEAD moved
      .mockResolvedValueOnce("head-2");
    mockCreateAtomicCommit
      .mockResolvedValueOnce({
        success: false,
        sha: "",
        files_committed: 0,
        error: "409 conflict",
      })
      .mockResolvedValueOnce({
        success: true,
        sha: "atomic-2",
        files_committed: 1,
      });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);
    const handler = handlers.prism_log_insight;

    const result = await handler({
      project_slug: "test-project",
      id: "INS-12346",
      title: "Retry survivor",
      category: "pattern",
      description: "Should land after a 409 retry against fresh content.",
      session: 50,
    });

    expect(result.isError).toBeUndefined();
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    // Critical: second attempt's payload includes both INS-12345 (concurrent)
    // and INS-12346 (us) — proving fresh-content recompute.
    const secondCall = mockCreateAtomicCommit.mock.calls[1];
    const insightsFile = (secondCall[1] as Array<{ path: string; content: string }>).find(
      (f) => f.path === ".prism/insights.md",
    );
    expect(insightsFile?.content).toContain("INS-12345: Concurrent insight");
    expect(insightsFile?.content).toContain("INS-12346: Retry survivor");
    // No pushFile fallback path.
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});
