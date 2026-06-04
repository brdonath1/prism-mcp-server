/**
 * brief-444 — prism_fetch default per-file content cap.
 *
 * Large full-content bodies are truncated at a line boundary (default
 * FETCH_CONTENT_CAP_BYTES = 50KB) with an explicit truncation notice so a
 * single oversize file cannot blow the ~25K-token MCP response ceiling.
 * `full_content: true` is the per-call opt-out; summary mode is unaffected.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
}));

import { fetchFile } from "../src/github/client.js";
import { registerFetch, capContent } from "../src/tools/fetch.js";
import { FETCH_CONTENT_CAP_BYTES } from "../src/config.js";

const mockFetchFile = vi.mocked(fetchFile);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureFetchHandler(): Handler {
  let captured: Handler | null = null;
  const stub = {
    tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === "prism_fetch") captured = handler as Handler;
    },
  } as unknown as McpServer;
  registerFetch(stub);
  if (!captured) throw new Error("prism_fetch handler was not registered");
  return captured;
}

function parseResult(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

/** Build a multi-line body larger than the default cap. */
function bigBody(): string {
  const line = "x".repeat(99) + "\n"; // 100 bytes per line
  return line.repeat(Math.ceil((FETCH_CONTENT_CAP_BYTES + 20_000) / 100));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("capContent — pure", () => {
  it("returns content under the cap unchanged", () => {
    const content = "small body\nwith two lines\n";
    expect(capContent(content, 1_000)).toBe(content);
  });

  it("cuts oversize content at the last complete line within the cap", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const capped = capContent(content, 200);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(200);
    expect(capped.endsWith("\n")).toBe(true);
    // No torn line: every delivered line is a complete `line-N`.
    for (const line of capped.trimEnd().split("\n")) {
      expect(line).toMatch(/^line-\d+$/);
    }
  });

  it("falls back to a raw byte cut for single-line bodies (no newline)", () => {
    const content = "y".repeat(10_000);
    const capped = capContent(content, 1_000);
    expect(new TextEncoder().encode(capped).length).toBeLessThanOrEqual(1_000);
    expect(capped.length).toBeGreaterThan(0);
  });

  it("never delivers a replacement character from a mid-code-point cut", () => {
    // 'é' is 2 bytes in UTF-8; an odd byte cap lands mid-code-point.
    const content = "é".repeat(5_000);
    const capped = capContent(content, 1_001);
    expect(capped.includes("�")).toBe(false);
  });
});

describe("prism_fetch — default content cap", () => {
  it("truncates files exceeding the cap and appends an explicit notice", async () => {
    const body = bigBody();
    const trueSize = new TextEncoder().encode(body).length;
    mockFetchFile.mockResolvedValue({ content: body, sha: "s", size: trueSize });
    const handler = captureFetchHandler();

    const result = await handler({ project_slug: "test-project", files: ["notes/big.md"] });

    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    const file = data.files[0];
    expect(file.is_truncated).toBe(true);
    expect(file.is_summarized).toBe(false);
    // size_bytes always carries the TRUE size so the caller can see what was withheld.
    expect(file.size_bytes).toBe(trueSize);
    expect(file.content.length).toBeLessThan(body.length);
    expect(file.content).toContain("[prism_fetch: content capped");
    expect(file.content).toContain("full_content: true");
    // Aggregate diagnostic surfaces the cap.
    const diag = data.diagnostics.find((d: any) => d.code === "FETCH_CONTENT_CAPPED");
    expect(diag).toBeDefined();
    expect(diag.level).toBe("info");
    expect(diag.context.paths).toContain("notes/big.md");
  });

  it("delivers the complete body when full_content: true is passed (opt-out)", async () => {
    const body = bigBody();
    const trueSize = new TextEncoder().encode(body).length;
    mockFetchFile.mockResolvedValue({ content: body, sha: "s", size: trueSize });
    const handler = captureFetchHandler();

    const result = await handler({
      project_slug: "test-project",
      files: ["notes/big.md"],
      full_content: true,
    });

    const data = parseResult(result);
    const file = data.files[0];
    expect(file.is_truncated).toBe(false);
    expect(file.content).toBe(body);
    expect(data.diagnostics.find((d: any) => d.code === "FETCH_CONTENT_CAPPED")).toBeUndefined();
  });

  it("leaves files under the cap untouched", async () => {
    const body = "# Small doc\n\ncontent\n\n<!-- EOF: small.md -->\n";
    mockFetchFile.mockResolvedValue({
      content: body,
      sha: "s",
      size: new TextEncoder().encode(body).length,
    });
    const handler = captureFetchHandler();

    const result = await handler({ project_slug: "test-project", files: ["notes/small.md"] });

    const data = parseResult(result);
    expect(data.files[0].is_truncated).toBe(false);
    expect(data.files[0].content).toBe(body);
  });

  it("summary mode takes precedence — summarized files are not also capped", async () => {
    const body = bigBody();
    mockFetchFile.mockResolvedValue({
      content: body,
      sha: "s",
      size: new TextEncoder().encode(body).length,
    });
    const handler = captureFetchHandler();

    const result = await handler({
      project_slug: "test-project",
      files: ["notes/big.md"],
      summary_mode: true,
    });

    const data = parseResult(result);
    const file = data.files[0];
    expect(file.is_summarized).toBe(true);
    expect(file.is_truncated).toBe(false);
    expect(file.content).toBeNull();
    expect(file.summary).toBeTruthy();
  });
});
