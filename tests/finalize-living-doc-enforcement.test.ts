/**
 * Tests for brief-422 Pieces 3 & 4: pruneRecentlyCompleted (task-queue cap)
 * and updateArchitectureMetadata (architecture.md timestamp + version refresh).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  createAtomicCommit: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
  resolveDocFiles: vi.fn(),
  resolveDocFilesOptimized: vi.fn(),
}));

import {
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
} from "../src/tools/finalize.js";
import { fetchFile, pushFile } from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDocPushPath.mockImplementation(async (_slug, doc) => `.prism/${doc}`);
  mockPushFile.mockResolvedValue({ success: true, sha: "new", size: 100 });
});

// ---- pruneRecentlyCompleted ----

function buildTaskQueue(headerVariant: string, entryCount: number): string {
  const entries = Array.from({ length: entryCount }, (_, i) => {
    const n = entryCount - i; // newest at top, descending
    return `### Task ${n}\nDescription for task ${n}.`;
  }).join("\n\n");
  return `# Task Queue

## In Progress

- Active item

${headerVariant}

${entries}

## Parking Lot

- Future ideas

<!-- EOF: task-queue.md -->
`;
}

describe("pruneRecentlyCompleted", () => {
  it("returns null when entry count is below cap", () => {
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 5);
    expect(pruneRecentlyCompleted(content, 15)).toBeNull();
  });

  it("returns null when entry count equals cap exactly", () => {
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 15);
    expect(pruneRecentlyCompleted(content, 15)).toBeNull();
  });

  it("prunes oldest entries (bottom of section) when count exceeds cap", () => {
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 20);
    const result = pruneRecentlyCompleted(content, 15);
    expect(result).not.toBeNull();
    // 20 entries → keep top 15 (entries 20..6), drop bottom 5 (entries 5..1).
    // Use trailing-newline anchors so "### Task 1" doesn't substring-match "### Task 10".
    expect(result).toContain("### Task 20\n");
    expect(result).toContain("### Task 6\n");
    expect(result).not.toContain("### Task 5\n");
    expect(result).not.toContain("### Task 1\n");
  });

  it("rewrites `(last 10 sessions)` to `(last 15 sessions)` when first pruning", () => {
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 20);
    const result = pruneRecentlyCompleted(content, 15)!;
    expect(result).toContain("## Recently Completed (last 15 sessions)");
    expect(result).not.toContain("## Recently Completed (last 10 sessions)");
  });

  it("preserves an already-correct `(last 15 sessions)` header on subsequent prunes", () => {
    const content = buildTaskQueue("## Recently Completed (last 15 sessions)", 20);
    const result = pruneRecentlyCompleted(content, 15)!;
    expect(result).toContain("## Recently Completed (last 15 sessions)");
    // Only one occurrence of the header (no duplicates).
    expect(result.match(/## Recently Completed/g) ?? []).toHaveLength(1);
  });

  it("leaves un-decorated headers untouched (no count to rewrite)", () => {
    const content = buildTaskQueue("## Recently Completed", 20);
    const result = pruneRecentlyCompleted(content, 15)!;
    expect(result).toContain("## Recently Completed");
  });

  it("preserves surrounding sections (## In Progress, ## Parking Lot, EOF sentinel)", () => {
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 20);
    const result = pruneRecentlyCompleted(content, 15)!;
    expect(result).toContain("## In Progress");
    expect(result).toContain("- Active item");
    expect(result).toContain("## Parking Lot");
    expect(result).toContain("- Future ideas");
    expect(result).toContain("<!-- EOF: task-queue.md -->");
  });

  it("returns null when the section is missing entirely", () => {
    const content = `# Task Queue\n\n## In Progress\n\n- thing\n\n<!-- EOF: task-queue.md -->\n`;
    expect(pruneRecentlyCompleted(content, 15)).toBeNull();
  });

  it("uses TASK_QUEUE_RECENTLY_COMPLETED_CAP as default when no maxEntries arg supplied", () => {
    expect(TASK_QUEUE_RECENTLY_COMPLETED_CAP).toBe(15);
    const content = buildTaskQueue("## Recently Completed (last 10 sessions)", 20);
    const result = pruneRecentlyCompleted(content)!;
    expect(result).toContain("### Task 6\n");
    expect(result).not.toContain("### Task 5\n");
  });
});

// ---- updateArchitectureMetadata ----

const ARCH_WITH_PREAMBLE = `# Architecture — test

> Updated: S98 (2026-04-25)

## Stack

- **MCP server:** Node.js/TypeScript on Railway (v4.6.0)
- **Other:** stuff

<!-- EOF: architecture.md -->
`;

const ARCH_NO_PREAMBLE = `# Architecture — test

## Stack

- **MCP server:** Node.js/TypeScript on Railway (v4.6.0)

<!-- EOF: architecture.md -->
`;

describe("updateArchitectureMetadata", () => {
  function setupConfig(enabled: boolean): void {
    mockFetchFile.mockImplementation(async (repo, path) => {
      if (repo === "test" && path === ".prism/config.yaml") {
        return enabled
          ? { content: "auto_update_architecture: true\n", sha: "cfg", size: 30 }
          : { content: "auto_update_architecture: false\n", sha: "cfg", size: 31 };
      }
      if (repo === "prism-mcp-server" && path === "package.json") {
        return { content: '{ "version": "4.7.0" }', sha: "pkg", size: 22 };
      }
      throw new Error(`Not found: fetchFile ${repo}/${path}`);
    });
  }

  it("skips silently when auto_update_architecture is not enabled", async () => {
    setupConfig(false);
    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/not enabled/);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("skips silently when the .prism/config.yaml file is absent", async () => {
    mockFetchFile.mockRejectedValue(new Error("Not found: fetchFile test/.prism/config.yaml"));
    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/not enabled/);
  });

  it("updates `> Updated:` preamble line when config is enabled and pattern is present", async () => {
    setupConfig(true);
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: ARCH_WITH_PREAMBLE,
      sha: "arch",
      legacy: false,
    });

    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(true);
    expect(result.version).toBe("4.7.0");

    const pushed = mockPushFile.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(pushed).toBeDefined();
    expect(pushed?.[2]).toContain("> Updated: S100 (2026-05-02)");
    expect(pushed?.[2]).not.toContain("S98");
  });

  it("refreshes the Stack version bullet when version differs", async () => {
    setupConfig(true);
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: ARCH_WITH_PREAMBLE,
      sha: "arch",
      legacy: false,
    });

    await updateArchitectureMetadata("test", 100, "2026-05-02");
    const pushed = mockPushFile.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(pushed?.[2]).toContain("(v4.7.0)");
    expect(pushed?.[2]).not.toContain("(v4.6.0)");
  });

  it("leaves the Stack bullet untouched when version is already current (no change beyond preamble)", async () => {
    setupConfig(true);
    const archCurrentVersion = ARCH_WITH_PREAMBLE.replace("(v4.6.0)", "(v4.7.0)");
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: archCurrentVersion,
      sha: "arch",
      legacy: false,
    });

    await updateArchitectureMetadata("test", 100, "2026-05-02");
    const pushed = mockPushFile.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(pushed?.[2]).toContain("(v4.7.0)");
    // Only one occurrence — no accidental duplication.
    expect((pushed?.[2] as string).match(/\(v4\.7\.0\)/g)?.length).toBe(1);
  });

  it("skips silently when architecture.md does not contain the `> Updated:` preamble pattern", async () => {
    setupConfig(true);
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: ARCH_NO_PREAMBLE,
      sha: "arch",
      legacy: false,
    });

    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/preamble pattern not found/);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("returns no-change result when both preamble and version are already current", async () => {
    setupConfig(true);
    const archAlreadyCurrent = ARCH_WITH_PREAMBLE
      .replace("> Updated: S98 (2026-04-25)", "> Updated: S100 (2026-05-02)")
      .replace("(v4.6.0)", "(v4.7.0)");
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: archAlreadyCurrent,
      sha: "arch",
      legacy: false,
    });

    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/no change required/);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("returns push-failed reason when the architecture.md push errors", async () => {
    setupConfig(true);
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/architecture.md",
      content: ARCH_WITH_PREAMBLE,
      sha: "arch",
      legacy: false,
    });
    mockPushFile.mockRejectedValue(new Error("github 502 bad gateway"));

    const result = await updateArchitectureMetadata("test", 100, "2026-05-02");
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/push failed/i);
    expect(result.reason).toContain("github 502");
  });
});
