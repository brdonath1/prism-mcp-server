/**
 * Unit tests for src/dispatch-store.ts (D-123 memory-first, GitHub-backed).
 *
 * The store holds a module-level Map. `vi.resetModules()` between tests gives
 * each case a fresh, empty store so in-memory state from one test cannot leak
 * into another. `vi.waitFor` is used to observe the fire-and-forget GitHub
 * write without racing — writeDispatchRecord intentionally returns before the
 * pushFile promise resolves.
 */
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  listDirectory: vi.fn(),
}));

import type { DispatchRecord } from "../src/dispatch-store.js";

const SAMPLE_RECORD: DispatchRecord = {
  dispatch_id: "cc-1712834400-abc123",
  repo: "platformforge-v2",
  branch: "main",
  mode: "query",
  prompt: "Find all TODO markers in src/",
  status: "running",
  started_at: "2026-04-11T12:00:00.000Z",
  agent: "claude-code",
  server_version: "4.0.0",
};

/**
 * Reset the dispatch-store module so each test gets a fresh Map. Returns
 * the freshly-imported module along with the github-client mocks that are
 * now bound to it.
 */
async function loadFreshStore() {
  vi.resetModules();
  const githubClient = await import("../src/github/client.js");
  const store = await import("../src/dispatch-store.js");
  return {
    store,
    mockFetchFile: vi.mocked(githubClient.fetchFile),
    mockPushFile: vi.mocked(githubClient.pushFile),
    mockListDirectory: vi.mocked(githubClient.listDirectory),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readDispatchRecord", () => {
  it("fetches from the dispatch-state repo on a cold memory cache", async () => {
    const { store, mockFetchFile } = await loadFreshStore();
    mockFetchFile.mockResolvedValueOnce({
      content: JSON.stringify(SAMPLE_RECORD),
      sha: "a",
      size: 100,
    });

    const record = await store.readDispatchRecord(SAMPLE_RECORD.dispatch_id);
    expect(record).not.toBeNull();
    expect(record?.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
    expect(mockFetchFile).toHaveBeenCalledWith(
      "prism-dispatch-state",
      `.dispatch/${SAMPLE_RECORD.dispatch_id}.json`,
    );
  });

  it("caches the GitHub result in memory so a second read skips GitHub", async () => {
    const { store, mockFetchFile } = await loadFreshStore();
    mockFetchFile.mockResolvedValueOnce({
      content: JSON.stringify(SAMPLE_RECORD),
      sha: "a",
      size: 100,
    });

    await store.readDispatchRecord(SAMPLE_RECORD.dispatch_id);
    await store.readDispatchRecord(SAMPLE_RECORD.dispatch_id);

    expect(mockFetchFile).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing record (404)", async () => {
    const { store, mockFetchFile } = await loadFreshStore();
    mockFetchFile.mockRejectedValueOnce(new Error("Not found: x"));

    const record = await store.readDispatchRecord("does-not-exist");
    expect(record).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    const { store, mockFetchFile } = await loadFreshStore();
    mockFetchFile.mockRejectedValueOnce(new Error("Rate limited"));

    await expect(store.readDispatchRecord("x")).rejects.toThrow("Rate limited");
  });
});

describe("writeDispatchRecord", () => {
  it("persists a new record to the dispatch-state repo via pushFile", async () => {
    const { store, mockPushFile } = await loadFreshStore();
    mockPushFile.mockResolvedValue({ success: true, size: 120, sha: "new" });

    await store.writeDispatchRecord(SAMPLE_RECORD);
    // Fire-and-forget — await the background push resolving.
    await vi.waitFor(() => expect(mockPushFile).toHaveBeenCalledTimes(1));

    const [repo, path, body, commitMsg] = mockPushFile.mock.calls[0];
    expect(repo).toBe("prism-dispatch-state");
    expect(path).toBe(`.dispatch/${SAMPLE_RECORD.dispatch_id}.json`);
    expect(commitMsg).toContain("cc_dispatch");
    expect(commitMsg).toContain("running");

    const parsed = JSON.parse(body as string);
    expect(parsed.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
  });

  it("preserves the original started_at when updating an existing in-memory record", async () => {
    const { store, mockPushFile } = await loadFreshStore();
    mockPushFile.mockResolvedValue({ success: true, size: 120, sha: "new" });

    const originalStart = "2026-04-11T11:00:00.000Z";
    await store.writeDispatchRecord({ ...SAMPLE_RECORD, started_at: originalStart });
    await vi.waitFor(() => expect(mockPushFile).toHaveBeenCalledTimes(1));

    // Second write with a fresh started_at — the helper should overwrite
    // it with the value already in memory.
    await store.writeDispatchRecord({
      ...SAMPLE_RECORD,
      status: "completed",
      started_at: "2026-04-11T12:15:00.000Z",
      completed_at: "2026-04-11T12:20:00.000Z",
    });
    await vi.waitFor(() => expect(mockPushFile).toHaveBeenCalledTimes(2));

    const body = mockPushFile.mock.calls[1][2] as string;
    const parsed = JSON.parse(body);
    expect(parsed.started_at).toBe(originalStart);
    expect(parsed.status).toBe("completed");
    expect(parsed.completed_at).toBe("2026-04-11T12:20:00.000Z");
  });

  it("does NOT throw when pushFile reports failure (fire-and-forget)", async () => {
    const { store, mockPushFile } = await loadFreshStore();
    mockPushFile.mockResolvedValue({
      success: false,
      size: 0,
      sha: "",
      error: "403 Forbidden",
    });

    // writeDispatchRecord returns without awaiting GitHub — must not reject.
    await expect(store.writeDispatchRecord(SAMPLE_RECORD)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mockPushFile).toHaveBeenCalledTimes(1));

    // The record is still in memory and readable regardless of GitHub state.
    const record = await store.readDispatchRecord(SAMPLE_RECORD.dispatch_id);
    expect(record?.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
  });

  it("updates the in-memory cache immediately so readDispatchRecord does not hit GitHub", async () => {
    const { store, mockPushFile, mockFetchFile } = await loadFreshStore();
    mockPushFile.mockResolvedValue({ success: true, size: 120, sha: "new" });

    await store.writeDispatchRecord(SAMPLE_RECORD);
    const record = await store.readDispatchRecord(SAMPLE_RECORD.dispatch_id);

    expect(record?.dispatch_id).toBe(SAMPLE_RECORD.dispatch_id);
    expect(mockFetchFile).not.toHaveBeenCalled();
  });
});

describe("listDispatchIds", () => {
  it("returns in-memory ids sorted reverse-lexically after hydration", async () => {
    const { store, mockPushFile, mockListDirectory } = await loadFreshStore();
    mockListDirectory.mockResolvedValue([]);
    mockPushFile.mockResolvedValue({ success: true, size: 120, sha: "new" });

    // Hydrate with an empty state so subsequent listDispatchIds calls trust memory.
    await store.hydrateStore();
    await store.writeDispatchRecord({ ...SAMPLE_RECORD, dispatch_id: "cc-1712834400-a" });
    await store.writeDispatchRecord({ ...SAMPLE_RECORD, dispatch_id: "cc-1712834500-b" });

    const ids = await store.listDispatchIds(10);
    expect(ids).toEqual(["cc-1712834500-b", "cc-1712834400-a"]);
  });

  it("merges memory + GitHub entries before hydration", async () => {
    const { store, mockPushFile, mockListDirectory } = await loadFreshStore();
    mockPushFile.mockResolvedValue({ success: true, size: 120, sha: "new" });
    mockListDirectory.mockResolvedValue([
      {
        name: "cc-1712834500-b.json",
        path: ".dispatch/cc-1712834500-b.json",
        size: 100,
        sha: "b",
        type: "file",
      },
    ]);

    // Pre-hydration write — memory contains 'a', GitHub contains 'b'.
    await store.writeDispatchRecord({ ...SAMPLE_RECORD, dispatch_id: "cc-1712834400-a" });
    const ids = await store.listDispatchIds(10);

    expect(ids).toContain("cc-1712834400-a");
    expect(ids).toContain("cc-1712834500-b");
    // Reverse-lexical order.
    expect(ids[0]).toBe("cc-1712834500-b");
  });
});
