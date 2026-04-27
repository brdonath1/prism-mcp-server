// brief-105: Auto-enroll Trigger marker drop in prism_bootstrap.
//
// Each test re-imports the bootstrap module via vi.resetModules() so the
// TRIGGER_AUTO_ENROLL constant in src/config.ts can be evaluated against
// per-test process.env state. The github/client mock factory is hoisted
// by vi.mock and re-applied on each fresh import; mock function references
// are captured after every reset.

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

const originalAutoEnroll = process.env.TRIGGER_AUTO_ENROLL;

interface CapturedHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

interface SetupResult {
  bootstrapHandler: CapturedHandler;
  mockFetchFile: ReturnType<typeof vi.fn>;
  mockPushFile: ReturnType<typeof vi.fn>;
}

const HANDOFF_CONTENT = `# Handoff

## Meta
- Handoff Version: 1
- Session Count: 1
- Template Version: 2.10.0
- Status: Active

## Critical Context
1. Item one

## Where We Are
Current state.

## Resumption Point
Resume here.

## Next Steps
1. Do thing A

<!-- EOF: handoff.md -->`;

const DECISIONS_CONTENT =
  "| ID | Title | Domain | Status | Session |\n" +
  "|---|---|---|---|---|\n" +
  "| D-1 | Test | arch | SETTLED | 1 |\n\n" +
  "<!-- EOF: _INDEX.md -->";

const TEMPLATE_CONTENT =
  "# Template v2.10.0\nRules.\n<!-- EOF: core-template-mcp.md -->";

/** Standard fetch mock — returns Not found for the trigger marker, success for everything else. */
function fetchFileMarkerAbsent(_repo: string, path: string) {
  if (path === ".prism/trigger.yaml") {
    return Promise.reject(new Error(`Not found: fetchFile slug/${path}`));
  }
  if (path.endsWith("handoff.md")) {
    return Promise.resolve({
      content: HANDOFF_CONTENT,
      sha: "h1",
      size: HANDOFF_CONTENT.length,
    });
  }
  if (path.endsWith("decisions/_INDEX.md")) {
    return Promise.resolve({
      content: DECISIONS_CONTENT,
      sha: "d1",
      size: DECISIONS_CONTENT.length,
    });
  }
  if (path.includes("core-template-mcp.md")) {
    return Promise.resolve({
      content: TEMPLATE_CONTENT,
      sha: "t1",
      size: TEMPLATE_CONTENT.length,
    });
  }
  return Promise.reject(new Error(`Not found: fetchFile slug/${path}`));
}

/** Fetch mock that returns the trigger marker as already present. */
function fetchFileMarkerPresent(repo: string, path: string) {
  if (path === ".prism/trigger.yaml") {
    return Promise.resolve({
      content:
        "enabled: true\nbrief_dir: .prism/briefs/\nbrief_pattern: \"brief-*.md\"\nbranch_strategy: main-only\n",
      sha: "marker-sha",
      size: 100,
    });
  }
  return fetchFileMarkerAbsent(repo, path);
}

/**
 * Reset module cache, re-import bootstrap, capture the registered handler and
 * fresh mock-fn references. Call after mutating process.env so the new
 * config-module evaluation picks up env changes.
 */
async function setupBootstrap(): Promise<SetupResult> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  const mockFetchFile = vi.mocked(ghClient.fetchFile);
  const mockPushFile = vi.mocked(ghClient.pushFile);
  const mockFetchFiles = vi.mocked(ghClient.fetchFiles);
  const mockFileExists = vi.mocked(ghClient.fileExists);
  const mockListRepos = vi.mocked(ghClient.listRepos);

  // Default mock state — most tests override these as needed.
  mockFetchFile.mockImplementation(fetchFileMarkerAbsent);
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed", size: 100 });
  mockFetchFiles.mockResolvedValue({
    files: new Map(),
    failed: [],
    incomplete: false,
  });
  mockFileExists.mockResolvedValue(false);
  mockListRepos.mockResolvedValue([]);

  let captured: CapturedHandler | null = null;
  const mockServer = {
    tool: vi.fn(
      (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        if (name === "prism_bootstrap") {
          captured = handler as CapturedHandler;
        }
      },
    ),
  } as unknown as McpServer;

  const { registerBootstrap } = await import("../src/tools/bootstrap.js");
  registerBootstrap(mockServer);

  if (!captured) {
    throw new Error("prism_bootstrap handler was not registered");
  }
  return { bootstrapHandler: captured, mockFetchFile, mockPushFile };
}

beforeEach(() => {
  delete process.env.TRIGGER_AUTO_ENROLL;
});

afterEach(() => {
  if (originalAutoEnroll === undefined) {
    delete process.env.TRIGGER_AUTO_ENROLL;
  } else {
    process.env.TRIGGER_AUTO_ENROLL = originalAutoEnroll;
  }
});

describe("brief-105: Trigger enrollment marker drop", () => {
  it("creates the marker when absent and pushes canonical content", async () => {
    const { bootstrapHandler, mockPushFile } = await setupBootstrap();

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger_enrollment).toEqual({ status: "marker_created" });

    const markerPushCall = mockPushFile.mock.calls.find(
      ([, path]) => path === ".prism/trigger.yaml",
    );
    expect(markerPushCall).toBeDefined();
    const [repoArg, , contentArg, messageArg] = markerPushCall!;
    expect(repoArg).toBe("prism");
    expect(contentArg).toContain("enabled: true");
    expect(contentArg).toContain("brief_dir: .prism/briefs/queue/");
    expect(contentArg).toContain('brief_pattern: "brief-*.md"');
    expect(contentArg).toContain("branch_strategy: main-only");
    expect(contentArg).toContain("intra_project_parallel: false");
    expect(contentArg).toContain("max_parallel_briefs: 1");
    expect(contentArg).toContain("post_merge:");
    expect(contentArg).toContain("- notify");
    expect(contentArg).toContain("- archive");
    expect(messageArg).toMatch(/^prism: enroll prism in Trigger via marker file/);
  });

  it("skips the push when the marker is already present", async () => {
    const { bootstrapHandler, mockFetchFile, mockPushFile } = await setupBootstrap();
    mockFetchFile.mockImplementation(fetchFileMarkerPresent);

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger_enrollment).toEqual({ status: "marker_present" });

    const markerPushCall = mockPushFile.mock.calls.find(
      ([, path]) => path === ".prism/trigger.yaml",
    );
    expect(markerPushCall).toBeUndefined();
  });

  it("skips entirely when TRIGGER_AUTO_ENROLL=false", async () => {
    process.env.TRIGGER_AUTO_ENROLL = "false";
    const { bootstrapHandler, mockFetchFile, mockPushFile } = await setupBootstrap();

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger_enrollment.status).toBe("skipped");
    expect(parsed.trigger_enrollment.reason).toContain("TRIGGER_AUTO_ENROLL=false");

    const markerFetchCall = mockFetchFile.mock.calls.find(
      ([, path]) => path === ".prism/trigger.yaml",
    );
    expect(markerFetchCall).toBeUndefined();
    const markerPushCall = mockPushFile.mock.calls.find(
      ([, path]) => path === ".prism/trigger.yaml",
    );
    expect(markerPushCall).toBeUndefined();
  });

  it("returns error status when fetchFile throws non-404 (bootstrap still succeeds)", async () => {
    const { bootstrapHandler, mockFetchFile } = await setupBootstrap();
    mockFetchFile.mockImplementation((repo: string, path: string) => {
      if (path === ".prism/trigger.yaml") {
        return Promise.reject(
          new Error("GitHub API forbidden — check PAT scopes."),
        );
      }
      return fetchFileMarkerAbsent(repo, path);
    });

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger_enrollment.status).toBe("error");
    expect(parsed.trigger_enrollment.reason).toContain("forbidden");
  });

  it("pushes the queue/archive marker layout end-to-end (S77 regression guard)", async () => {
    const { bootstrapHandler, mockPushFile } = await setupBootstrap();

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();

    const markerPushCall = mockPushFile.mock.calls.find(
      ([, path]) => path === ".prism/trigger.yaml",
    );
    expect(markerPushCall).toBeDefined();
    const contentArg = markerPushCall![2] as string;

    // Body block — schema fields. Asserts the queue/archive defaults exactly.
    const expectedBody =
      "enabled: true\n" +
      "brief_dir: .prism/briefs/queue/\n" +
      'brief_pattern: "brief-*.md"\n' +
      "branch_strategy: main-only\n" +
      "intra_project_parallel: false\n" +
      "max_parallel_briefs: 1\n" +
      "post_merge:\n" +
      "  - notify\n" +
      "  - archive\n";
    expect(contentArg).toContain(expectedBody);

    // Order of post_merge actions matters — notify must precede archive so
    // operators are paged before the brief is auto-moved out of the queue.
    const notifyIdx = contentArg.indexOf("- notify");
    const archiveIdx = contentArg.indexOf("- archive");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeGreaterThan(notifyIdx);

    // Comment header references the new layout.
    expect(contentArg).toContain("# Layout:");
    expect(contentArg).toContain("archive/");
  });

  it("returns error status when pushFile throws (bootstrap still succeeds)", async () => {
    const { bootstrapHandler, mockPushFile } = await setupBootstrap();
    mockPushFile.mockImplementation((_repo: string, path: string) => {
      if (path === ".prism/trigger.yaml") {
        return Promise.reject(new Error("GitHub API 422: write blocked"));
      }
      return Promise.resolve({ success: true, sha: "pushed", size: 50 });
    });

    const result = await bootstrapHandler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.trigger_enrollment.status).toBe("error");
    expect(parsed.trigger_enrollment.reason).toContain("422");
  });
});
