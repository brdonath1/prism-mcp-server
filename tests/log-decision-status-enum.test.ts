// brief-s204c: prism_log_decision status validated against the canonical
// decision-status enum.
//
// The `_INDEX.md` full-file push validator has always rejected non-enum
// statuses, but the write path (`prism_log_decision`) accepted arbitrary
// strings — the divergence that let sessions mint legacy `DECIDED` rows the
// validator would refuse. These tests pin the write-time contract:
//   (a) a non-enum status such as `DECIDED` is rejected fail-fast, before
//       any GitHub I/O, with an error listing the valid values;
//   (b) every canonical value is accepted (case-insensitively, stored in
//       canonical uppercase form);
//   (c) the logger and the `_INDEX` validator enforce the SAME enum set —
//       single source of truth in src/validation/decisions.ts.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client + doc-resolver + doc-guard so the tool registration can
// be exercised without the network (same harness as log-decision-dedup).
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
import { resolveDocPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

import { registerLogDecision } from "../src/tools/log-decision.js";
import {
  VALID_DECISION_STATUSES,
  normalizeDecisionStatus,
  validateDecisionIndex,
} from "../src/validation/decisions.js";

/** Minimal McpServer stub that captures the registered tool handler. */
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

const BASE_INDEX = `# Decisions Index

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-115 | Something earlier | architecture | SETTLED | 142 |

<!-- EOF: _INDEX.md -->
`;

const OPERATIONS_DOMAIN = "# Decisions — operations\n\n<!-- EOF: operations.md -->\n";

/** Wire up doc-resolver + GitHub mocks: _INDEX.md and domain file exist. */
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

/** Invoke the registered prism_log_decision handler with the given args. */
async function invokeLogDecision(args: Record<string, unknown>) {
  const { server, handlers } = createServerStub();
  registerLogDecision(server as any);
  const handler = handlers.prism_log_decision;
  if (!handler) throw new Error("prism_log_decision not registered");
  return (await handler(args)) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

const baseArgs = {
  project_slug: "platformforge-v2",
  id: "D-117",
  title: "Status enum validation",
  domain: "operations",
  reasoning: "Write-time status validation contract.",
  session: 204,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prism_log_decision status enum rejection (brief-s204c)", () => {
  it("rejects the legacy DECIDED status with an error listing valid values", async () => {
    setupExistingDocs(BASE_INDEX, OPERATIONS_DOMAIN);

    const result = await invokeLogDecision({ ...baseArgs, status: "DECIDED" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain('Invalid decision status "DECIDED"');
    // The error must enumerate every canonical value for the caller.
    for (const status of VALID_DECISION_STATUSES) {
      expect(payload.error).toContain(status);
    }
    expect(payload.invalid_status).toBe("DECIDED");
    // The advertised valid set IS the validator's canonical enum.
    expect(payload.valid_statuses).toEqual([...VALID_DECISION_STATUSES]);
    expect(payload.index_updated).toBe(false);
    expect(payload.domain_file_updated).toBe(false);

    // Fail-fast: rejected before ANY GitHub I/O — not even path resolution.
    expect(mockResolveDocPath).not.toHaveBeenCalled();
    expect(mockFetchFile).not.toHaveBeenCalled();
    expect(mockGetHeadSha).not.toHaveBeenCalled();
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary non-enum status", async () => {
    setupExistingDocs(BASE_INDEX, OPERATIONS_DOMAIN);

    const result = await invokeLogDecision({ ...baseArgs, status: "WONTFIX" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.invalid_status).toBe("WONTFIX");
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });

  it("does not silently normalize an unknown status to a guess", async () => {
    setupExistingDocs(BASE_INDEX, OPERATIONS_DOMAIN);

    // "DECIDED" is a plausible near-miss of "SETTLED"/"ACCEPTED"; the
    // contract is rejection, never a substituted value.
    const result = await invokeLogDecision({ ...baseArgs, status: "Decided" });

    expect(result.isError).toBe(true);
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
    expect(mockPushFile).not.toHaveBeenCalled();
  });
});

describe("prism_log_decision canonical status acceptance (brief-s204c)", () => {
  it.each([...VALID_DECISION_STATUSES])(
    "accepts canonical status %s and writes it verbatim",
    async (status) => {
      setupExistingDocs(BASE_INDEX, OPERATIONS_DOMAIN);
      mockGetHeadSha.mockResolvedValue("head-before");
      mockCreateAtomicCommit.mockResolvedValue({
        success: true,
        sha: "atomic-sha",
        files_committed: 2,
      });

      const result = await invokeLogDecision({ ...baseArgs, status });

      expect(result.isError).toBeUndefined();
      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe(status);
      expect(payload.index_updated).toBe(true);
      expect(payload.domain_file_updated).toBe(true);

      const files = mockCreateAtomicCommit.mock.calls[0][1] as Array<{
        path: string;
        content: string;
      }>;
      const indexFile = files.find((f) => f.path === ".prism/decisions/_INDEX.md");
      const domainFile = files.find((f) => f.path === ".prism/decisions/operations.md");
      expect(indexFile?.content).toContain(`| D-117 | Status enum validation | operations | ${status} | 204 |`);
      expect(domainFile?.content).toContain(`- Status: ${status}`);
    },
  );

  it("accepts a canonical value case-insensitively and stores the uppercase form", async () => {
    setupExistingDocs(BASE_INDEX, OPERATIONS_DOMAIN);
    mockGetHeadSha.mockResolvedValue("head-before");
    mockCreateAtomicCommit.mockResolvedValue({
      success: true,
      sha: "atomic-sha",
      files_committed: 2,
    });

    const result = await invokeLogDecision({ ...baseArgs, status: "settled" });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("SETTLED");

    const files = mockCreateAtomicCommit.mock.calls[0][1] as Array<{
      path: string;
      content: string;
    }>;
    const indexFile = files.find((f) => f.path === ".prism/decisions/_INDEX.md");
    const domainFile = files.find((f) => f.path === ".prism/decisions/operations.md");
    expect(indexFile?.content).toContain("| SETTLED |");
    expect(indexFile?.content).not.toContain("| settled |");
    expect(domainFile?.content).toContain("- Status: SETTLED");
  });
});

describe("logger/validator enum agreement — single source of truth (brief-s204c)", () => {
  const indexRowWith = (status: string) =>
    `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | Test decision | architecture | ${status} | 204 |
<!-- EOF: _INDEX.md -->`;

  it("every status the _INDEX validator accepts is accepted by the normalizer the logger uses", () => {
    for (const status of VALID_DECISION_STATUSES) {
      // Validator path: a row with this status produces no errors.
      expect(validateDecisionIndex(indexRowWith(status)).errors).toHaveLength(0);
      // Logger path: normalizeDecisionStatus (the logger's gate) accepts it.
      expect(normalizeDecisionStatus(status)).toBe(status);
    }
  });

  it("a status the _INDEX validator rejects is rejected by the normalizer the logger uses", () => {
    const validatorResult = validateDecisionIndex(indexRowWith("DECIDED"));
    expect(validatorResult.errors.some((e) => e.includes("invalid"))).toBe(true);
    expect(normalizeDecisionStatus("DECIDED")).toBeNull();
  });

  it("normalizeDecisionStatus canonicalizes case/whitespace but never guesses", () => {
    expect(normalizeDecisionStatus("SETTLED")).toBe("SETTLED");
    expect(normalizeDecisionStatus("settled")).toBe("SETTLED");
    expect(normalizeDecisionStatus("  Open  ")).toBe("OPEN");
    expect(normalizeDecisionStatus("DECIDED")).toBeNull();
    expect(normalizeDecisionStatus("")).toBeNull();
  });

  it("the canonical enum is exactly the six documented values", () => {
    expect([...VALID_DECISION_STATUSES]).toEqual([
      "SETTLED",
      "PENDING",
      "SUPERSEDED",
      "REVISITED",
      "ACCEPTED",
      "OPEN",
    ]);
  });
});
