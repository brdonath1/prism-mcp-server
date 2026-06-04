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
//
// R2-B (D-240 Phase B): standing rules (`standing_rule: true`) now land in
// `.prism/standing-rules.md` instead of insights.md, and dedup scans BOTH
// files — INS-N is one shared sequence. The mock layer is path-aware so
// each test declares which source files exist.
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

const STANDING_RULES_WITH_30000 = `# Standing Rules — test-project

> Standing-rule registry (D-240 R2-B).

## Active

### INS-30000: Registry rule — STANDING RULE
- Category: operations — **STANDING RULE**
- Discovered: Session 60
- Description: Lives in the registry.
- **Standing procedure:** Do the registry thing.

## Formalized

<!-- EOF: standing-rules.md -->
`;

const EMPTY_STANDING_RULES = `# Standing Rules — test-project

## Active

## Formalized

<!-- EOF: standing-rules.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Wire up path-aware resolveDocPath + fetchFile mocks (R2-B). A `null`/
 * omitted entry rejects like a 404 — the file does not exist. Push-path
 * resolution for files that don't exist yet resolves to `.prism/{doc}`.
 */
function setupDocs(opts: {
  insights?: string | null;
  standingRules?: string | null;
}) {
  mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
    if (docName === "insights.md" && opts.insights != null) {
      return {
        path: ".prism/insights.md",
        content: opts.insights,
        sha: "ins-sha",
        legacy: false,
      };
    }
    if (docName === "standing-rules.md" && opts.standingRules != null) {
      return {
        path: ".prism/standing-rules.md",
        content: opts.standingRules,
        sha: "sr-sha",
        legacy: false,
      };
    }
    throw new Error(`Not found: ${docName}`);
  });
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/insights.md" && opts.insights != null) {
      return { content: opts.insights, sha: "ins-sha", size: opts.insights.length };
    }
    if (path === ".prism/standing-rules.md" && opts.standingRules != null) {
      return { content: opts.standingRules, sha: "sr-sha", size: opts.standingRules.length };
    }
    throw new Error(`Unexpected fetchFile: ${path}`);
  });
  mockResolveDocPushPath.mockImplementation(async (_slug: string, docName: string) => `.prism/${docName}`);
  mockGuardPushPath.mockImplementation(async (_slug: string, path: string) => ({
    path,
    redirected: false,
  }));
}

/** Extract the committed file list from the n-th createAtomicCommit call. */
function committedFiles(callIndex = 0): Array<{ path: string; content: string }> {
  const call = mockCreateAtomicCommit.mock.calls[callIndex];
  return call[1] as Array<{ path: string; content: string }>;
}

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

describe("prism_log_insight dedup guard (A-4)", () => {
  it("rejects the write when INS-N already exists", async () => {
    setupDocs({ insights: INSIGHTS_WITH_9999 });
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
    setupDocs({ insights: INSIGHTS_WITH_9999 });
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
    // Neither insights.md nor standing-rules.md exists → fresh file path.
    setupDocs({});
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
    mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "insights.md") {
        return {
          path: ".prism/insights.md",
          content: INSIGHTS_WITH_9999,
          sha: "ins-1",
          legacy: false,
        };
      }
      throw new Error(`Not found: ${docName}`);
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
    const insightsFile = committedFiles(1).find(
      (f) => f.path === ".prism/insights.md",
    );
    expect(insightsFile?.content).toContain("INS-12345: Concurrent insight");
    expect(insightsFile?.content).toContain("INS-12346: Retry survivor");
    // No pushFile fallback path.
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

describe("prism_log_insight — R2-B standing-rule registry write path (D-240 Phase B)", () => {
  function getHandler() {
    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);
    return handlers.prism_log_insight;
  }

  it("standing_rule:true lands in standing-rules.md ## Active, not insights.md", async () => {
    setupDocs({
      insights: INSIGHTS_WITH_9999,
      standingRules: STANDING_RULES_WITH_30000,
    });
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-30001",
      title: "New registry rule",
      category: "operations",
      description: "Must land in the registry.",
      session: 61,
      standing_rule: true,
      procedure: "1. Do A. 2. Do B.",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.standing_rule).toBe(true);

    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    const writes = committedFiles();
    expect(writes.map((w) => w.path)).toEqual([".prism/standing-rules.md"]);

    const registry = writes[0].content;
    expect(registry).toContain("### INS-30001: New registry rule — STANDING RULE");
    expect(registry).toContain("- **Standing procedure:** 1. Do A. 2. Do B.");
    // Inserted into ## Active — i.e. before the ## Formalized marker.
    expect(registry.indexOf("INS-30001")).toBeLessThan(registry.indexOf("## Formalized"));
    // The pre-existing registry entry is preserved.
    expect(registry).toContain("INS-30000: Registry rule");
  });

  it("creates standing-rules.md from the fresh starter when absent", async () => {
    setupDocs({ insights: INSIGHTS_WITH_9999 }); // registry does not exist yet
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-10002",
      title: "First registry rule",
      category: "operations",
      description: "Creates the registry file.",
      session: 61,
      standing_rule: true,
      procedure: "Do the thing.",
    });

    expect(result.isError).toBeUndefined();
    const writes = committedFiles();
    expect(writes.map((w) => w.path)).toEqual([".prism/standing-rules.md"]);

    const registry = writes[0].content;
    // Fresh-starter skeleton per the brief: ## Active, ## Formalized, EOF sentinel.
    expect(registry).toContain("## Active");
    expect(registry).toContain("## Formalized");
    expect(registry).toContain("<!-- EOF: standing-rules.md -->");
    expect(registry).toContain("### INS-10002: First registry rule — STANDING RULE");
    expect(registry.indexOf("INS-10002")).toBeLessThan(registry.indexOf("## Formalized"));
  });

  it("dedup rejects a standing rule whose INS-N already exists in insights.md", async () => {
    setupDocs({
      insights: INSIGHTS_WITH_9999,
      standingRules: EMPTY_STANDING_RULES,
    });
    mockGetHeadSha.mockResolvedValue("head-before");

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-9999", // exists in insights.md
      title: "Cross-file duplicate",
      category: "operations",
      description: "INS-N is one shared sequence across both files.",
      session: 61,
      standing_rule: true,
      procedure: "Never lands.",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.error).toContain("INS-9999 already exists in insights.md");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("dedup rejects a non-standing insight whose INS-N already exists in standing-rules.md", async () => {
    setupDocs({
      insights: INSIGHTS_WITH_9999,
      standingRules: STANDING_RULES_WITH_30000,
    });
    mockGetHeadSha.mockResolvedValue("head-before");

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-30000", // exists in standing-rules.md
      title: "Cross-file duplicate (other direction)",
      category: "pattern",
      description: "Dedup must scan the registry too.",
      session: 61,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.error).toContain("INS-30000 already exists in standing-rules.md");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("re-runs the dual-file dedup against FRESH content on 409 retry", async () => {
    // First attempt: no duplicate anywhere → atomic commit hits a 409.
    // Between attempts a concurrent writer lands INS-30001 in the registry.
    // The retry must re-read BOTH files and reject — proving the cross-file
    // dedup repeats against fresh content, not the stale snapshot.
    const registryWithConcurrent = STANDING_RULES_WITH_30000.replace(
      "## Formalized",
      "### INS-30001: Concurrent registry rule — STANDING RULE\n- Category: operations — **STANDING RULE**\n- Discovered: Session 61\n- Description: Landed during the race.\n- **Standing procedure:** Concurrent thing.\n\n## Formalized",
    );
    let registryFetches = 0;
    let insightsFetches = 0;
    mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "insights.md") {
        return { path: ".prism/insights.md", content: INSIGHTS_WITH_9999, sha: "ins-sha", legacy: false };
      }
      if (docName === "standing-rules.md") {
        return { path: ".prism/standing-rules.md", content: STANDING_RULES_WITH_30000, sha: "sr-sha", legacy: false };
      }
      throw new Error(`Not found: ${docName}`);
    });
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === ".prism/insights.md") {
        insightsFetches += 1;
        return { content: INSIGHTS_WITH_9999, sha: `ins-${insightsFetches}`, size: 1 };
      }
      if (path === ".prism/standing-rules.md") {
        registryFetches += 1;
        const content = registryFetches === 1 ? STANDING_RULES_WITH_30000 : registryWithConcurrent;
        return { content, sha: `sr-${registryFetches}`, size: content.length };
      }
      throw new Error(`Unexpected fetchFile: ${path}`);
    });
    mockGetHeadSha
      .mockResolvedValueOnce("head-1")
      .mockResolvedValueOnce("head-2") // post-failure; HEAD moved
      .mockResolvedValueOnce("head-2");
    mockCreateAtomicCommit.mockResolvedValueOnce({
      success: false,
      sha: "",
      files_committed: 0,
      error: "409 conflict",
    });

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-30001",
      title: "Retry loser",
      category: "operations",
      description: "Concurrent writer claimed this ID between attempts.",
      session: 61,
      standing_rule: true,
      procedure: "Never lands.",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.error).toContain("INS-30001 already exists in standing-rules.md");
    // Exactly one commit attempt (the 409) — the retry was stopped by dedup.
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    // BOTH files were re-read on the retry attempt.
    expect(insightsFetches).toBe(2);
    expect(registryFetches).toBe(2);
  });

  it("non-standing insights still land in insights.md when the registry exists", async () => {
    setupDocs({
      insights: INSIGHTS_WITH_9999,
      standingRules: STANDING_RULES_WITH_30000,
    });
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 1,
    });

    const handler = getHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-10003",
      title: "Ordinary insight",
      category: "pattern",
      description: "Not a standing rule — stays in insights.md.",
      session: 61,
    });

    expect(result.isError).toBeUndefined();
    const writes = committedFiles();
    expect(writes.map((w) => w.path)).toEqual([".prism/insights.md"]);
    expect(writes[0].content).toContain("### INS-10003: Ordinary insight");
    // The registry file is read for dedup but never written for non-rules.
    expect(writes[0].content).not.toContain("INS-30000");
  });
});
