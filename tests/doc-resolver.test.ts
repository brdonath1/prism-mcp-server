// D-67: Tests for backward-compatible document path resolution
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fetchFile, fileExists } from "../src/github/client.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFileExists = vi.mocked(fileExists);

// Import after mocks are set up
import {
  resolveDocPath,
  resolveDocExists,
  resolveDocPushPath,
  resolveDocFiles,
} from "../src/utils/doc-resolver.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveDocPath", () => {
  it("returns .prism/ path when file exists there", async () => {
    mockFetchFile.mockResolvedValueOnce({
      content: "# Handoff",
      sha: "abc123",
      size: 10,
    });

    const result = await resolveDocPath("test-project", "handoff.md");
    expect(result.path).toBe(".prism/handoff.md");
    expect(result.content).toBe("# Handoff");
    expect(result.legacy).toBe(false);
    expect(mockFetchFile).toHaveBeenCalledWith("test-project", ".prism/handoff.md");
  });

  it("falls back to root path when .prism/ doesn't exist", async () => {
    mockFetchFile
      .mockRejectedValueOnce(new Error("Not found"))
      .mockResolvedValueOnce({
        content: "# Handoff (root)",
        sha: "def456",
        size: 16,
      });

    const result = await resolveDocPath("test-project", "handoff.md");
    expect(result.path).toBe("handoff.md");
    expect(result.content).toBe("# Handoff (root)");
    expect(result.legacy).toBe(true);
    expect(mockFetchFile).toHaveBeenCalledTimes(2);
    expect(mockFetchFile).toHaveBeenNthCalledWith(1, "test-project", ".prism/handoff.md");
    expect(mockFetchFile).toHaveBeenNthCalledWith(2, "test-project", "handoff.md");
  });

  it("throws when neither path exists", async () => {
    mockFetchFile
      .mockRejectedValueOnce(new Error("Not found: .prism/handoff.md"))
      .mockRejectedValueOnce(new Error("Not found: handoff.md"));

    await expect(resolveDocPath("test-project", "handoff.md")).rejects.toThrow("Not found");
  });

  it("handles decisions/_INDEX.md paths correctly", async () => {
    mockFetchFile.mockResolvedValueOnce({
      content: "| ID | Title |",
      sha: "idx123",
      size: 15,
    });

    const result = await resolveDocPath("test-project", "decisions/_INDEX.md");
    expect(result.path).toBe(".prism/decisions/_INDEX.md");
    expect(mockFetchFile).toHaveBeenCalledWith("test-project", ".prism/decisions/_INDEX.md");
  });
});

describe("resolveDocExists", () => {
  it("returns .prism/ path when file exists there", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await resolveDocExists("test-project", "handoff.md");
    expect(result.exists).toBe(true);
    expect(result.path).toBe(".prism/handoff.md");
    expect(result.legacy).toBe(false);
  });

  it("returns root path when only exists at root", async () => {
    mockFileExists
      .mockResolvedValueOnce(false)  // .prism/handoff.md
      .mockResolvedValueOnce(true);  // handoff.md

    const result = await resolveDocExists("test-project", "handoff.md");
    expect(result.exists).toBe(true);
    expect(result.path).toBe("handoff.md");
    expect(result.legacy).toBe(true);
  });

  it("returns not found when file doesn't exist anywhere", async () => {
    mockFileExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const result = await resolveDocExists("test-project", "handoff.md");
    expect(result.exists).toBe(false);
    expect(result.path).toBe(".prism/handoff.md");
    expect(result.legacy).toBe(false);
  });
});

describe("resolveDocPushPath", () => {
  it("returns .prism/ path when file exists there", async () => {
    mockFileExists.mockResolvedValueOnce(true);

    const result = await resolveDocPushPath("test-project", "handoff.md");
    expect(result).toBe(".prism/handoff.md");
  });

  it("returns legacy path for unmigrated repos", async () => {
    mockFileExists
      .mockResolvedValueOnce(false)  // .prism/handoff.md
      .mockResolvedValueOnce(true);  // handoff.md

    const result = await resolveDocPushPath("test-project", "handoff.md");
    expect(result).toBe("handoff.md");
  });

  it("returns .prism/ path for new files", async () => {
    mockFileExists
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const result = await resolveDocPushPath("test-project", "handoff.md");
    expect(result).toBe(".prism/handoff.md");
  });
});

describe("resolveDocFiles", () => {
  it("resolves multiple documents in parallel", async () => {
    mockFetchFile
      .mockResolvedValueOnce({ content: "# Handoff", sha: "a", size: 10 })
      .mockResolvedValueOnce({ content: "# Session Log", sha: "b", size: 14 });

    const result = await resolveDocFiles("test-project", ["handoff.md", "session-log.md"]);

    expect(result.size).toBe(2);
    expect(result.get("handoff.md")?.content).toBe("# Handoff");
    expect(result.get("session-log.md")?.content).toBe("# Session Log");
  });

  it("skips documents that don't exist at either location", async () => {
    mockFetchFile
      .mockResolvedValueOnce({ content: "# Handoff", sha: "a", size: 10 })
      .mockRejectedValueOnce(new Error("Not found: .prism/missing.md"))
      .mockRejectedValueOnce(new Error("Not found: missing.md"));

    const result = await resolveDocFiles("test-project", ["handoff.md", "missing.md"]);

    expect(result.size).toBe(1);
    expect(result.has("handoff.md")).toBe(true);
    expect(result.has("missing.md")).toBe(false);
  });

  it("keys results by docName (without DOC_ROOT prefix)", async () => {
    mockFetchFile.mockResolvedValueOnce({
      content: "| ID | Title |",
      sha: "idx",
      size: 15,
    });

    const result = await resolveDocFiles("test-project", ["decisions/_INDEX.md"]);
    expect(result.has("decisions/_INDEX.md")).toBe(true);
    expect(result.has(".prism/decisions/_INDEX.md")).toBe(false);
  });
});
