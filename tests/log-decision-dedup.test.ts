// brief-104 A.1: server-side dedup for prism_log_decision
//
// Unit tests for parseExistingDecisionIds() and the dedup rejection flow. The
// full tool registration wires up GitHub pushes which are harder to mock, so
// these tests focus on the duplicate-detection contract that the tool relies
// on before it issues any write.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client + doc-resolver + doc-guard so we can exercise the tool
// registration without hitting the network. Each test sets up fresh mocks.
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn(),
}));

import { pushFile } from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";

const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
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
});

describe("prism_log_decision dedup guard (A.1)", () => {
  it("rejects a write when the requested D-N ID already exists", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/decisions/_INDEX.md",
      content: INDEX_WITH_D116,
      sha: "idx-sha",
      legacy: false,
    });

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
  });

  it("proceeds with the write when the ID is unique", async () => {
    mockResolveDocPath
      .mockResolvedValueOnce({
        path: ".prism/decisions/_INDEX.md",
        content: INDEX_WITH_D116,
        sha: "idx-sha",
        legacy: false,
      })
      .mockResolvedValueOnce({
        path: ".prism/decisions/operations.md",
        content: "# Operations\n\n<!-- EOF: operations.md -->\n",
        sha: "domain-sha",
        legacy: false,
      });
    mockGuardPushPath.mockResolvedValue({
      path: ".prism/decisions/operations.md",
      redirected: false,
    });
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

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
    // _INDEX.md and domain file are both pushed.
    expect(mockPushFile).toHaveBeenCalledTimes(2);
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
