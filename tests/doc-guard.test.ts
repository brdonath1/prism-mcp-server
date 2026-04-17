// D-67 Addendum: Tests for anti-duplication guard
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fileExists } from "../src/github/client.js";

const mockFileExists = vi.mocked(fileExists);

import { guardPushPath } from "../src/utils/doc-guard.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guardPushPath", () => {
  it("redirects root-level living doc when .prism/ version exists", async () => {
    mockFileExists.mockResolvedValueOnce(true); // .prism/task-queue.md exists

    const result = await guardPushPath("test-project", "task-queue.md");
    expect(result.path).toBe(".prism/task-queue.md");
    expect(result.redirected).toBe(true);
    expect(mockFileExists).toHaveBeenCalledWith("test-project", ".prism/task-queue.md");
  });

  it("allows root-level living doc when no .prism/ version exists (unmigrated)", async () => {
    mockFileExists.mockResolvedValueOnce(false); // .prism/task-queue.md doesn't exist

    const result = await guardPushPath("test-project", "task-queue.md");
    expect(result.path).toBe("task-queue.md");
    expect(result.redirected).toBe(false);
  });

  it("allows .prism/-prefixed path as-is (no redirect)", async () => {
    const result = await guardPushPath("test-project", ".prism/task-queue.md");
    expect(result.path).toBe(".prism/task-queue.md");
    expect(result.redirected).toBe(false);
    // Should NOT call fileExists — already .prism/ prefixed
    expect(mockFileExists).not.toHaveBeenCalled();
  });

  it("allows non-living-doc path as-is", async () => {
    const result = await guardPushPath("test-project", "src/index.ts");
    expect(result.path).toBe("src/index.ts");
    expect(result.redirected).toBe(false);
    expect(mockFileExists).not.toHaveBeenCalled();
  });

  it("redirects root-level decisions subdirectory path when .prism/ exists", async () => {
    mockFileExists.mockResolvedValueOnce(true); // .prism/decisions/architecture.md exists

    const result = await guardPushPath("test-project", "decisions/architecture.md");
    expect(result.path).toBe(".prism/decisions/architecture.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects root-level handoff-history path when .prism/ exists", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "handoff-history/handoff_v5_2026-04-05.md");
    expect(result.path).toBe(".prism/handoff-history/handoff_v5_2026-04-05.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects archive files following same rules", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "session-log-archive.md");
    expect(result.path).toBe(".prism/session-log-archive.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects insights-archive.md to .prism/ (S40 FINDING-14 C3)", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "insights-archive.md");
    expect(result.path).toBe(".prism/insights-archive.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects decisions/_INDEX.md correctly", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "decisions/_INDEX.md");
    expect(result.path).toBe(".prism/decisions/_INDEX.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects handoff.md correctly", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "handoff.md");
    expect(result.path).toBe(".prism/handoff.md");
    expect(result.redirected).toBe(true);
  });

  it("redirects all 10 mandatory living docs when migrated", async () => {
    const mandatoryDocs = [
      "handoff.md",
      "decisions/_INDEX.md",
      "session-log.md",
      "task-queue.md",
      "eliminated.md",
      "architecture.md",
      "glossary.md",
      "known-issues.md",
      "insights.md",
      "intelligence-brief.md",
    ];

    for (const doc of mandatoryDocs) {
      vi.clearAllMocks();
      mockFileExists.mockResolvedValueOnce(true);
      const result = await guardPushPath("test-project", doc);
      expect(result.redirected).toBe(true);
      expect(result.path).toBe(`.prism/${doc}`);
    }
  });

  it("allows briefs/ directory path when .prism/ version doesn't exist", async () => {
    mockFileExists.mockResolvedValueOnce(false);

    const result = await guardPushPath("test-project", "briefs/brief-s31.md");
    expect(result.path).toBe("briefs/brief-s31.md");
    expect(result.redirected).toBe(false);
  });

  it("allows boot-test.md as a known support file", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "boot-test.md");
    expect(result.path).toBe(".prism/boot-test.md");
    expect(result.redirected).toBe(true);
  });

  it("allows artifacts/ directory path redirect when .prism/ exists", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "artifacts/diagram.svg");
    expect(result.path).toBe(".prism/artifacts/diagram.svg");
    expect(result.redirected).toBe(true);
  });

  it("allows _scratch/ directory path redirect when .prism/ exists", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await guardPushPath("test-project", "_scratch/notes.md");
    expect(result.path).toBe(".prism/_scratch/notes.md");
    expect(result.redirected).toBe(true);
  });
});
