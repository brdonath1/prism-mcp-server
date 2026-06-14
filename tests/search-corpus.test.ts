/**
 * brief-453 / INS-312 — prism_search corpus includes .prism/standing-rules.md.
 *
 * Before this brief, standing-rules.md was in neither prism_search fetch list,
 * so rule BODIES were unreachable by search (the registry is Tier-indexed at
 * bootstrap, but mid-session keyword search came up empty). The file now joins
 * the Step-2 fetch fan-out via the doc resolver (.prism/-first, root fallback)
 * with the same try/catch-null graceful-absence pattern as the living docs.
 * Archives stay excluded from the corpus.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  listRepos: vi.fn(),
}));

import { fetchFile, fileExists, listDirectory } from "../src/github/client.js";
import { registerSearch } from "../src/tools/search.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Capture a tool handler off a stub server. */
function captureHandler(
  register: (server: McpServer) => void,
  toolName: string,
): Handler {
  let captured: Handler | null = null;
  const stub = {
    tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === toolName) captured = handler as Handler;
    },
  } as unknown as McpServer;
  register(stub);
  if (!captured) throw new Error(`${toolName} handler was not registered`);
  return captured;
}

function parseResult(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

interface Snippet {
  file: string;
  section: string;
  score: number;
  snippet: string;
}

const HANDOFF_CONTENT = `# Handoff

## Where We Are
Working on the gateway rollout.

<!-- EOF: handoff.md -->`;

const STANDING_RULES_CONTENT = `# Standing Rules — prism

## Registry

### INS-310: end-anchored tier tags
Rule body: tier tags must be end-anchored on the title line; title-suffix qualification applies to insights.

<!-- EOF: standing-rules.md -->`;

beforeEach(() => {
  vi.clearAllMocks();
  // No decision domain files exist in any of these scenarios.
  mockFileExists.mockResolvedValue(false);
  // SRV-82: decision-domain discovery now lists the decisions dir — empty here.
  mockListDirectory.mockResolvedValue([]);
});

describe("brief-453 — prism_search corpus includes standing-rules.md", () => {
  it("returns standing-rules.md snippets when .prism/standing-rules.md exists, files_searched rises by 1", async () => {
    mockFetchFile.mockImplementation(async (_slug: string, path: string) => {
      if (path === ".prism/handoff.md") {
        return { content: HANDOFF_CONTENT, sha: "h1", size: HANDOFF_CONTENT.length };
      }
      if (path === ".prism/standing-rules.md") {
        return { content: STANDING_RULES_CONTENT, sha: "r1", size: STANDING_RULES_CONTENT.length };
      }
      throw new Error(`Not found: ${path}`);
    });
    const handler = captureHandler(registerSearch, "prism_search");

    const result = await handler({
      project_slug: "test-project",
      query: "end-anchored tier tags",
    });

    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    // handoff.md + standing-rules.md — one more than the absence case below.
    expect(data.files_searched).toBe(2);

    const results = data.results as Snippet[];
    const srHit = results.find(r => r.file === "standing-rules.md");
    expect(srHit).toBeDefined();
    // The rule BODY (not just the title) is reachable.
    expect(srHit!.snippet).toContain("end-anchored");
    expect(srHit!.section).toContain("INS-310");

    // Archives stay excluded from the corpus — no *-archive.md fetch attempted.
    const fetchedPaths = mockFetchFile.mock.calls.map(c => c[1]);
    expect(fetchedPaths.some(p => p.includes("-archive"))).toBe(false);
  });

  it("resolves standing-rules.md at the legacy root path when .prism/ is absent (resolver fallback)", async () => {
    mockFetchFile.mockImplementation(async (_slug: string, path: string) => {
      if (path === ".prism/handoff.md") {
        return { content: HANDOFF_CONTENT, sha: "h1", size: HANDOFF_CONTENT.length };
      }
      if (path === "standing-rules.md") {
        return { content: STANDING_RULES_CONTENT, sha: "r2", size: STANDING_RULES_CONTENT.length };
      }
      throw new Error(`Not found: ${path}`);
    });
    const handler = captureHandler(registerSearch, "prism_search");

    const result = await handler({
      project_slug: "test-project",
      query: "end-anchored tier tags",
    });

    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    expect(data.files_searched).toBe(2);
    const results = data.results as Snippet[];
    expect(results.some(r => r.file === "standing-rules.md")).toBe(true);
  });

  it("degrades gracefully when standing-rules.md is absent everywhere", async () => {
    mockFetchFile.mockImplementation(async (_slug: string, path: string) => {
      if (path === ".prism/handoff.md") {
        return { content: HANDOFF_CONTENT, sha: "h1", size: HANDOFF_CONTENT.length };
      }
      throw new Error(`Not found: ${path}`);
    });
    const handler = captureHandler(registerSearch, "prism_search");

    const result = await handler({
      project_slug: "test-project",
      query: "end-anchored tier tags",
    });

    // Absence is NOT an error — the corpus simply shrinks by one file.
    expect(result.isError).not.toBe(true);
    const data = parseResult(result);
    expect(data.files_searched).toBe(1);
    const results = data.results as Snippet[];
    expect(results.every(r => r.file !== "standing-rules.md")).toBe(true);
  });
});

// SRV-82: decision-domain discovery LISTS the decisions dir rather than probing
// a hardcoded 7-name list, so a non-canonical domain file is now searchable.
describe("SRV-82 — prism_search discovers non-canonical decision-domain files via listing", () => {
  it("includes a custom-named domain file the old hardcoded probe would have missed", async () => {
    const CUSTOM_DOMAIN = "# Custom Domain\n\n## D-99: bespoke-keyword decision\nRationale body here.\n\n<!-- EOF: custom-domain.md -->";
    mockListDirectory.mockImplementation(async (_slug: string, path: string) => {
      if (path === ".prism/decisions") {
        return [
          { name: "_INDEX.md", path: ".prism/decisions/_INDEX.md", size: 10, sha: "i", type: "file" },
          { name: "custom-domain.md", path: ".prism/decisions/custom-domain.md", size: CUSTOM_DOMAIN.length, sha: "c", type: "file" },
        ];
      }
      return [];
    });
    mockFetchFile.mockImplementation(async (_slug: string, path: string) => {
      if (path === ".prism/handoff.md") return { content: HANDOFF_CONTENT, sha: "h1", size: HANDOFF_CONTENT.length };
      if (path === ".prism/decisions/custom-domain.md") return { content: CUSTOM_DOMAIN, sha: "c1", size: CUSTOM_DOMAIN.length };
      throw new Error(`Not found: ${path}`);
    });
    const handler = captureHandler(registerSearch, "prism_search");

    const result = await handler({ project_slug: "test-project", query: "bespoke-keyword" });
    const data = parseResult(result);

    // The custom-named domain file — which the old hardcoded 7-name probe did
    // not list — is now in the search corpus.
    const hit = (data.results as Snippet[]).find(r => r.file.includes("custom-domain"));
    expect(hit).toBeDefined();
    // It was fetched exactly once as a discovered domain file.
    const fetchedPaths = mockFetchFile.mock.calls.map(c => c[1] as string);
    expect(fetchedPaths.filter(p => p.includes("custom-domain")).length).toBe(1);
  });
});
