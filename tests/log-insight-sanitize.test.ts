/**
 * brief-444 R5-c — write-time U+200B sanitization on prism_log_insight.
 *
 * The user-supplied fields (title / description / procedure) are passed
 * through sanitizeContentField() before being written into insights.md /
 * standing-rules.md, matching the KI-26 protection already live in
 * prism_log_decision and prism_patch. Without it, a description containing
 * a line that starts with `## ` becomes a real section header on the next
 * parse and silently breaks the section tree.
 *
 * Harness mirrors tests/log-insight-dedup.test.ts: github client +
 * doc-resolver + doc-guard mocked; safeMutation runs for real on top of the
 * mocked client so the test asserts the exact committed content.
 */

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

import { createAtomicCommit, fetchFile, getHeadSha } from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";
import { registerLogInsight } from "../src/tools/log-insight.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

const ZWS = "​";

const EMPTY_INSIGHTS = `# Insights — test-project

## Active

## Formalized

<!-- EOF: insights.md -->
`;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureHandler(): Handler {
  let captured: Handler | null = null;
  const stub = {
    tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === "prism_log_insight") captured = handler as Handler;
    },
  };
  registerLogInsight(stub as never);
  if (!captured) throw new Error("prism_log_insight handler was not registered");
  return captured;
}

/** Committed content of the single write in the last atomic commit. */
function committedContent(): string {
  expect(mockCreateAtomicCommit).toHaveBeenCalledTimes(1);
  const writes = mockCreateAtomicCommit.mock.calls[0][1] as Array<{ path: string; content: string }>;
  expect(writes).toHaveLength(1);
  return writes[0].content;
}

beforeEach(() => {
  vi.clearAllMocks();

  // insights.md exists; standing-rules.md does not (created from starter on demand).
  mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
    if (docName === "insights.md") {
      return { path: ".prism/insights.md", content: EMPTY_INSIGHTS, sha: "i1", legacy: false };
    }
    throw new Error(`Not found: fetchFile test-project/${docName}`);
  });
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/insights.md") {
      return { content: EMPTY_INSIGHTS, sha: "i1", size: EMPTY_INSIGHTS.length };
    }
    throw new Error(`Not found: fetchFile test-project/${path}`);
  });
  mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
  mockGuardPushPath.mockImplementation(async (_slug: string, path: string) => ({
    path,
    redirected: false,
  }));
  mockGetHeadSha.mockResolvedValue("HEAD_1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "c1", files_committed: 1 });
});

describe("brief-444 — prism_log_insight U+200B sanitization (KI-26)", () => {
  it("brief-460 / SRV-77: title's FIRST line stays raw (embedded mid-line — cannot parse as a header); embedded newline headers in the description are neutralized", async () => {
    // Pre-460 pin expected `### INS-500: ##${ZWS} Evil Title` — a false
    // positive: the title lands mid-line in the server-built template, where
    // line-start header injection is impossible, so the ZWS only corrupted
    // the stored text.
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-500",
      title: "## Evil Title",
      category: "gotcha",
      description: "intro\n## Injected\nbody",
      session: 99,
    });

    expect(result.isError).not.toBe(true);
    const content = committedContent();

    // Title rides mid-line UNmangled — and is not a line-start header.
    expect(content).toContain("### INS-500: ## Evil Title");
    expect(content).not.toMatch(/^## Evil Title$/m);
    // The description's embedded newline header still carries the ZWS.
    expect(content).toContain(`intro\n##${ZWS} Injected\nbody`);
    // The raw injected header must not survive at line start.
    expect(content).not.toMatch(/\n## Injected/);

    // The mutation is visible, never silent (brief-460).
    const data = JSON.parse(result.content[0].text);
    const sanitizedDiag = (data.diagnostics ?? []).find(
      (d: { code: string }) => d.code === "CONTENT_SANITIZED",
    );
    expect(sanitizedDiag).toBeDefined();
    expect(sanitizedDiag.message).toContain("description");
  });

  it("brief-460 / SRV-77: embedded `\\n#### detail` sub-structure SURVIVES (deeper than the ### entry level)", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-504",
      title: "Detail-rich insight",
      category: "pattern",
      description: "summary\n#### detail block\nfine print",
      session: 99,
    });

    expect(result.isError).not.toBe(true);
    const content = committedContent();
    expect(content).toContain("summary\n#### detail block\nfine print");
    expect(content.includes(ZWS)).toBe(false);
  });

  it("keeps the RAW title in the commit message (non-markdown channel)", async () => {
    const handler = captureHandler();
    await handler({
      project_slug: "test-project",
      id: "INS-501",
      title: "## Raw Title",
      category: "pattern",
      description: "plain",
      session: 99,
    });

    const message = mockCreateAtomicCommit.mock.calls[0][2] as string;
    expect(message).toBe("prism: INS-501 ## Raw Title");
    expect(message.includes(ZWS)).toBe(false);
  });

  it("neutralizes embedded headers in the standing-rule procedure field", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      id: "INS-502",
      title: "Registry rule",
      category: "operations",
      description: "desc",
      session: 99,
      standing_rule: true,
      procedure: "1. step one\n### Fake Header\n2. step two",
    });

    expect(result.isError).not.toBe(true);
    const content = committedContent();
    expect(content).toContain(`###${ZWS} Fake Header`);
    expect(content).not.toMatch(/\n### Fake Header/);
  });

  it("leaves clean fields byte-identical (no spurious ZWS)", async () => {
    const handler = captureHandler();
    await handler({
      project_slug: "test-project",
      id: "INS-503",
      title: "Plain title",
      category: "pattern",
      description: "No headers here. A #hashtag is not a header.",
      session: 99,
    });

    const content = committedContent();
    expect(content).toContain("### INS-503: Plain title");
    expect(content).toContain("No headers here. A #hashtag is not a header.");
    expect(content.includes(ZWS)).toBe(false);
  });
});
