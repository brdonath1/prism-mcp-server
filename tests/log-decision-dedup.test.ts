// brief-104 A.1: server-side dedup for prism_log_decision
//
// Unit tests for parseExistingDecisionIds() and the dedup rejection flow. The
// full tool registration wires up GitHub pushes which are harder to mock, so
// these tests focus on the duplicate-detection contract that the tool relies
// on before it issues any write.
//
// S62 Phase 1 Brief 1 update: dedup now runs INSIDE safeMutation's
// computeMutation callback, so the dedup check is fed by fetchFile (the
// safeMutation primitive's read mechanism) rather than from resolveDocPath
// content directly. The tests below mock both resolveDocPath (for path
// resolution) and fetchFile (for safeMutation's read).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client + doc-resolver + doc-guard so we can exercise the tool
// registration without hitting the network. Each test sets up fresh mocks.
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
  parseExistingDecisionIds,
  registerLogDecision,
} from "../src/tools/log-decision.js";

/**
 * Minimal McpServer stub that captures the registered tool handler so the
 * tests can invoke it directly without booting the full transport.
 */
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

const INDEX_WITH_D116 = `# Decisions Index

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-115 | Something earlier | architecture | SETTLED | 142 |
| D-116 | Existing decision | operations | SETTLED | 143 |

<!-- EOF: _INDEX.md -->
`;

const EMPTY_INDEX = `# Decisions Index

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|

<!-- EOF: _INDEX.md -->
`;

/**
 * Multi-table fixture that mirrors a real production `_INDEX.md`: a
 * Domain Files reference table leads the file, and the Decision
 * Summary table follows it. This shape is what exposed the brief-105
 * dedup bug — the previous implementation read pipe lines from the
 * entire file as a single table, so it parsed the wrong columns.
 */
const MULTI_TABLE_INDEX = `# Decisions Index

## Domain Files

| File | Decisions | Scope |
|------|-----------|-------|
| architecture.md | D-1..D-50 | Stack, system design |
| operations.md   | D-51..D-120 | Runtime, deploys, incidents |
| optimization.md | D-121..D-140 | Perf, budgets, caching |

## Decision Summary

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-115 | Something earlier | architecture | SETTLED | 142 |
| D-116 | Existing decision | operations | SETTLED | 143 |

<!-- EOF: _INDEX.md -->
`;

const OPERATIONS_DOMAIN = "# Decisions — operations\n\n<!-- EOF: operations.md -->\n";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseExistingDecisionIds", () => {
  it("returns D-N IDs with titles from an existing index", () => {
    const ids = parseExistingDecisionIds(INDEX_WITH_D116);
    expect(ids.size).toBe(2);
    expect(ids.get("D-115")).toBe("Something earlier");
    expect(ids.get("D-116")).toBe("Existing decision");
  });

  it("returns an empty map for a table with no rows", () => {
    const ids = parseExistingDecisionIds(EMPTY_INDEX);
    expect(ids.size).toBe(0);
  });

  it("ignores rows whose ID column does not match the D-N format", () => {
    const junk = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| x | Not a decision | x | x | 1 |
| D-9 | Real one | core | SETTLED | 12 |
`;
    const ids = parseExistingDecisionIds(junk);
    expect(ids.has("D-9")).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("finds D-N IDs in the Decision Summary table of a multi-table index (brief 105)", () => {
    const ids = parseExistingDecisionIds(MULTI_TABLE_INDEX);
    // Must NOT be fooled by the leading Domain Files table. The rows
    // there ("architecture.md", "operations.md", …) have no D-N prefix
    // so they should be ignored, and the real decision rows must land
    // in the map with their real titles intact.
    expect(ids.size).toBe(2);
    expect(ids.get("D-115")).toBe("Something earlier");
    expect(ids.get("D-116")).toBe("Existing decision");
  });

  it("normalizes legacy hyphenless D-N IDs so dedup still matches", () => {
    const legacy = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D116 | Legacy hyphenless | operations | SETTLED | 143 |
`;
    const ids = parseExistingDecisionIds(legacy);
    // The Zod schema enforces the hyphenated form on incoming requests,
    // so the stored key must also be hyphenated for `has()` to hit.
    expect(ids.has("D-116")).toBe(true);
  });
});

/**
 * Wire up the doc-resolver + GitHub mocks for a happy-path resolve where
 * both _INDEX.md and the domain file already exist. Returns the index +
 * domain content from `fetchFile` so safeMutation's internal read sees
 * the same content the dedup check would.
 */
function setupExistingDocs(indexContent: string, domainContent: string) {
  mockResolveDocPath.mockImplementation(async (_repo, doc) => {
    if (doc === "decisions/_INDEX.md") {
      return {
        path: ".prism/decisions/_INDEX.md",
        content: indexContent,
        sha: "idx-sha",
        legacy: false,
      };
    }
    if (doc === "decisions/operations.md") {
      return {
        path: ".prism/decisions/operations.md",
        content: domainContent,
        sha: "dom-sha",
        legacy: false,
      };
    }
    throw new Error(`Unexpected resolveDocPath: ${doc}`);
  });
  mockFetchFile.mockImplementation(async (_repo, path) => {
    if (path === ".prism/decisions/_INDEX.md") {
      return { content: indexContent, sha: "idx-sha", size: indexContent.length };
    }
    if (path === ".prism/decisions/operations.md") {
      return { content: domainContent, sha: "dom-sha", size: domainContent.length };
    }
    throw new Error(`Unexpected fetchFile: ${path}`);
  });
  mockGuardPushPath.mockResolvedValue({
    path: ".prism/decisions/operations.md",
    redirected: false,
  });
}

describe("prism_log_decision dedup guard (A.1)", () => {
  it("rejects a write when the requested D-N ID already exists", async () => {
    setupExistingDocs(INDEX_WITH_D116, OPERATIONS_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const handler = handlers.prism_log_decision;
    expect(handler).toBeDefined();

    const result = await handler({
      project_slug: "platformforge-v2",
      id: "D-116",
      title: "Attempted duplicate",
      domain: "operations",
      status: "SETTLED",
      reasoning: "Should be rejected before any push happens.",
      session: 144,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.id).toBe("D-116");
    expect(payload.existing_title).toBe("Existing decision");
    expect(payload.error).toContain("D-116 already exists");
    // Guard must fire BEFORE any GitHub write happens.
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("rejects a duplicate ID from the second table of a multi-table index (brief 105)", async () => {
    // Regression: before brief 105 the dedup parser read the Domain
    // Files table and never reached the real Decision Summary table,
    // so duplicate IDs slipped past the guard.
    setupExistingDocs(MULTI_TABLE_INDEX, OPERATIONS_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);
    const handler = handlers.prism_log_decision;

    const result = await handler({
      project_slug: "platformforge-v2",
      id: "D-116",
      title: "Attempted duplicate in multi-table doc",
      domain: "operations",
      status: "SETTLED",
      reasoning: "Should still be rejected even with a leading table.",
      session: 145,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.id).toBe("D-116");
    expect(payload.existing_title).toBe("Existing decision");
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("accepts a new ID against a multi-table index (brief 105)", async () => {
    setupExistingDocs(MULTI_TABLE_INDEX, OPERATIONS_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 2,
    });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);

    const result = await handler_ok(handlers, {
      project_slug: "platformforge-v2",
      id: "D-117",
      title: "Brand new decision in a multi-table index",
      domain: "operations",
      status: "SETTLED",
      reasoning: "Unique ID even against a file with a leading reference table.",
      session: 145,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("D-117");
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);
    // safeMutation issues a single createAtomicCommit (no sequential fallback).
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("proceeds with the write when the ID is unique", async () => {
    setupExistingDocs(INDEX_WITH_D116, OPERATIONS_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 2,
    });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);

    const result = await handler_ok(handlers, {
      project_slug: "platformforge-v2",
      id: "D-117",
      title: "Brand new decision",
      domain: "operations",
      status: "SETTLED",
      reasoning: "Unique ID → should write both files.",
      session: 144,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("D-117");
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);
    // Single atomic commit covers both files (no more sequential pushFile pair).
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

describe("prism_log_decision concurrent-write recovery (S62 Phase 1 Brief 1)", () => {
  // Ensures the migration to safeMutation actually re-reads + recomputes on
  // 409, which is the bug fix the brief is shipping. Pairs with the unit
  // tests in safe-mutation.test.ts; this test exercises the full tool path.
  it("retries on 409 with fresh content and lands the write", async () => {
    const initialIndex = INDEX_WITH_D116;
    // Concurrent write landed a different decision (D-200). Our retry must
    // fetch the fresh index and append D-117 against THAT content, not
    // against the stale snapshot.
    const concurrentIndex = INDEX_WITH_D116.replace(
      "<!-- EOF: _INDEX.md -->",
      "| D-200 | Concurrent decision | architecture | SETTLED | 144 |\n<!-- EOF: _INDEX.md -->",
    );

    let indexFetches = 0;
    mockFetchFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/decisions/_INDEX.md") {
        indexFetches += 1;
        const content = indexFetches === 1 ? initialIndex : concurrentIndex;
        return { content, sha: `idx-${indexFetches}`, size: content.length };
      }
      if (path === ".prism/decisions/operations.md") {
        return {
          content: OPERATIONS_DOMAIN,
          sha: "dom-sha",
          size: OPERATIONS_DOMAIN.length,
        };
      }
      throw new Error(`Unexpected fetchFile: ${path}`);
    });
    mockResolveDocPath.mockImplementation(async (_repo, doc) => {
      if (doc === "decisions/_INDEX.md") {
        return {
          path: ".prism/decisions/_INDEX.md",
          content: initialIndex,
          sha: "idx-1",
          legacy: false,
        };
      }
      return {
        path: ".prism/decisions/operations.md",
        content: OPERATIONS_DOMAIN,
        sha: "dom-sha",
        legacy: false,
      };
    });
    mockGuardPushPath.mockResolvedValue({
      path: ".prism/decisions/operations.md",
      redirected: false,
    });
    // First atomic 409s; second succeeds against fresh content.
    mockGetHeadSha
      .mockResolvedValueOnce("head-1")
      .mockResolvedValueOnce("head-2") // post-failure HEAD changed
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
        files_committed: 2,
      });

    const { server, handlers } = createServerStub();
    registerLogDecision(server as any);

    const result = await handler_ok(handlers, {
      project_slug: "platformforge-v2",
      id: "D-117",
      title: "Retry survivor",
      domain: "operations",
      status: "SETTLED",
      reasoning: "Should land after a 409 retry against fresh content.",
      session: 145,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.index_updated).toBe(true);
    expect(payload.domain_file_updated).toBe(true);
    expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(2);
    // Critical: the SECOND atomic commit's index payload includes the
    // concurrent D-200 row plus our D-117 — proving fresh-data recompute.
    const secondAtomicCall = mockCreateAtomicCommit.mock.calls[1];
    const indexFile = (secondAtomicCall[1] as Array<{ path: string; content: string }>).find(
      (f) => f.path === ".prism/decisions/_INDEX.md",
    );
    expect(indexFile?.content).toContain("| D-200 |");
    expect(indexFile?.content).toContain("| D-117 |");
  });
});

/** Small helper that fetches the registered prism_log_decision handler. */
async function handler_ok(
  handlers: Record<string, Function>,
  args: Record<string, unknown>,
) {
  const handler = handlers.prism_log_decision;
  if (!handler) throw new Error("prism_log_decision not registered");
  return (await handler(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}
