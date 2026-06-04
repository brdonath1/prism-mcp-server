/**
 * brief-444 R5-c — B.11 slug/path guards wired into the GitHub client.
 *
 * validateProjectSlug / validateFilePath (src/validation/slug.ts) shipped in
 * S28 but were never called from production code. They are now wired at the
 * URL-construction choke points in src/github/client.ts. These tests assert
 * the guards fire BEFORE any network request (global fetch is stubbed and
 * must remain uncalled on the rejection paths) and that legitimate traffic
 * passes through unchanged.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAtomicCommit,
  deleteFile,
  deleteRef,
  fetchFile,
  getCommit,
  listCommits,
  listDirectory,
  pushFile,
} from "../src/github/client.js";

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    body: undefined,
    headers: { get: () => null },
  } as unknown as Response;
}

describe("B.11 guards — invalid repo slugs are rejected before any network call", () => {
  it.each([
    ["path traversal", "../evil"],
    ["embedded slash", "owner/other-repo"],
    ["embedded space", "my repo"],
    ["null byte", "repo\x00evil"],
    ["leading hyphen", "-repo"],
    ["empty", ""],
  ])("fetchFile rejects repo with %s", async (_label, repo) => {
    await expect(fetchFile(repo, "handoff.md")).rejects.toThrow(/Invalid repo slug/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("listCommits rejects an invalid repo before any network call", async () => {
    await expect(listCommits("../evil")).rejects.toThrow(/Invalid repo slug/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("getCommit rejects an invalid repo before any network call", async () => {
    await expect(getCommit("../evil", "abc123")).rejects.toThrow(/Invalid repo slug/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deleteRef surfaces an invalid repo as a result-shaped failure (no throw, no network)", async () => {
    const result = await deleteRef("bad repo", "heads/feature");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid repo slug/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createAtomicCommit surfaces an invalid repo as a result-shaped failure (no throw, no network)", async () => {
    const result = await createAtomicCommit("bad/repo", [{ path: "a.md", content: "x" }], "prism: test");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid repo slug/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("B.11 guards — invalid file paths are rejected before any network call", () => {
  it.each([
    ["dot-dot traversal", "../../etc/passwd"],
    ["encoded traversal", "%2e%2e/secret.md"],
    ["double-encoded traversal", "%252e%252e/%252f"],
    ["absolute path", "/etc/passwd"],
    ["encoded absolute path", "%2fetc/passwd"],
    ["null byte", "foo\x00bar.md"],
  ])("fetchFile rejects path with %s", async (_label, path) => {
    await expect(fetchFile("test-repo", path)).rejects.toThrow(/Invalid file path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pushFile rejects a traversal path before any network call", async () => {
    await expect(
      pushFile("test-repo", "../escape.md", "content", "prism: test"),
    ).rejects.toThrow(/Invalid file path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deleteFile surfaces a traversal path as a result-shaped failure (no throw, no network)", async () => {
    const result = await deleteFile("test-repo", "../escape.md", "chore: cleanup");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid file path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createAtomicCommit validates every write path (tree paths bypass contentsUrl)", async () => {
    const result = await createAtomicCommit(
      "test-repo",
      [
        { path: "ok.md", content: "fine" },
        { path: "../../escape.md", content: "evil" },
      ],
      "prism: test",
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid file path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createAtomicCommit validates delete paths too", async () => {
    const result = await createAtomicCommit(
      "test-repo",
      [{ path: "ok.md", content: "fine" }],
      "prism: test",
      ["..%2fescape.md"],
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid file path/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("B.11 guards — legitimate traffic passes through", () => {
  it("fetchFile proceeds for a valid repo + .prism/ path", async () => {
    fetchSpy.mockResolvedValue(
      okJson({
        content: Buffer.from("# Handoff\n", "utf-8").toString("base64"),
        sha: "abc",
        size: 10,
      }),
    );

    const result = await fetchFile("test-repo", ".prism/handoff.md");
    expect(result.content).toBe("# Handoff\n");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/repos/test-owner/test-repo/contents/.prism/handoff.md");
  });

  it("fetchFile allows nested doc paths (decisions/_INDEX.md) and underscore prefixes", async () => {
    fetchSpy.mockResolvedValue(
      okJson({
        content: Buffer.from("| D-1 |", "utf-8").toString("base64"),
        sha: "abc",
        size: 7,
      }),
    );
    await expect(fetchFile("test-repo", ".prism/decisions/_INDEX.md")).resolves.toBeDefined();
    await expect(fetchFile("prism-framework", "_templates/core-template-mcp.md")).resolves.toBeDefined();
  });

  it("listDirectory allows the empty path (repo-root listing)", async () => {
    fetchSpy.mockResolvedValue(okJson([]));
    const entries = await listDirectory("test-repo", "");
    expect(entries).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
