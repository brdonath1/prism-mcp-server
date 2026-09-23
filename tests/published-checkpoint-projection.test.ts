import { describe, expect, it, vi } from "vitest";
import { validateHandoff } from "../src/validation/handoff.js";
import {
  preparePublishedCheckpointProjection,
  type ExpectedPublishedHandoff,
} from "../src/utils/published-checkpoint-projection.js";

const REF = "a".repeat(40);
const BLOB = "b".repeat(40);
const PATH = "docs/handoffs/handoff-2026-09-23-0900.md";
const expected: ExpectedPublishedHandoff = { ref: REF, path: PATH, sha: BLOB };
const pointer = `handoff: ${PATH}\nagent: codex\n`;
const native = `## Meta
- Template Version: 2.0.0
- Handoff Version: 4
- Session Count: 5
- Status: active

## Critical Context
1. Existing context.

## Where We Are
Existing state.

<!-- EOF: handoff.md -->
`;

function file(content: string, sha = "c".repeat(40)) {
  return { content, sha, size: Buffer.byteLength(content, "utf8") };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const fetchFile = vi.fn(async (_repo: string, path: string, ref: string) => {
    expect(ref).toBe(REF);
    if (path === "docs/handoffs/LATEST.md") return file(pointer, "d".repeat(40));
    if (path === PATH) return file("# Canonical checkpoint\n", BLOB);
    if (path === ".prism/handoff.md") return file(native);
    throw new Error(`Not found: ${path}`);
  });
  const getHeadSha = vi.fn(async () => REF);
  return { fetchFile, getHeadSha, ...overrides } as any;
}

describe("preparePublishedCheckpointProjection", () => {
  it("prepares a deterministic valid native compatibility handoff from the pinned published source", async () => {
    const deps = dependencies();
    const first = await preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps);
    const second = await preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps);

    expect(first).toEqual(second);
    expect(first.path).toBe(".prism/handoff.md");
    expect(first.native_template_version).toBe("2.0.0");
    expect(first.content).toContain(`\`${PATH}\``);
    expect(first.content).toContain(`\`${REF}\``);
    expect(first.content).toContain(`\`${BLOB}\``);
    expect(first.content).toContain("compatibility projection");
    expect(validateHandoff(first.content).errors).toEqual([]);
    expect(deps.getHeadSha).toHaveBeenCalledWith("project", "main");
  });

  it("rejects a stale expected main ref before any file read", async () => {
    const deps = dependencies({ getHeadSha: vi.fn(async () => "e".repeat(40)) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps))
      .rejects.toThrow("not current main HEAD");
    expect(deps.fetchFile).not.toHaveBeenCalled();
  });

  it("rejects a changed main branch after pinned reads", async () => {
    const deps = dependencies({ getHeadSha: vi.fn().mockResolvedValueOnce(REF).mockResolvedValueOnce("e".repeat(40)) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps))
      .rejects.toThrow("changed while preparing");
  });

  it("rejects a pointer target or blob different from the caller's expected source", async () => {
    const deps = dependencies({ fetchFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") return file(pointer);
      if (path === PATH) return file("# Canonical checkpoint\n", "e".repeat(40));
      if (path === ".prism/handoff.md") return file(native);
      throw new Error(`Not found: ${path}`);
    }) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps))
      .rejects.toThrow("does not match");
  });

  it("preserves a legacy root-native handoff path instead of migrating it", async () => {
    const deps = dependencies({ fetchFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") return file(pointer);
      if (path === PATH) return file("# Canonical checkpoint\n", BLOB);
      if (path === ".prism/handoff.md") throw new Error("Not found: .prism/handoff.md");
      if (path === "handoff.md") return file(native);
      throw new Error(`Not found: ${path}`);
    }) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, deps))
      .resolves.toMatchObject({ path: "handoff.md" });
  });

  it("does not fall back to the root path after an operational native-read failure", async () => {
    const fetchFile = vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") return file(pointer);
      if (path === PATH) return file("# Canonical checkpoint\n", BLOB);
      if (path === ".prism/handoff.md") throw new Error("Forbidden: native handoff");
      if (path === "handoff.md") return file(native);
      throw new Error(`Not found: ${path}`);
    });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, { fetchFile, getHeadSha: async () => REF }))
      .rejects.toThrow("Forbidden: native handoff");
    expect(fetchFile).not.toHaveBeenCalledWith("project", "handoff.md", REF);
  });

  it("fails closed for unavailable published or native handoffs", async () => {
    const missingPublished = dependencies({ fetchFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") throw new Error("Not found: docs/handoffs/LATEST.md");
      if (path === ".prism/handoff.md") return file(native);
      throw new Error(`Not found: ${path}`);
    }) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, missingPublished))
      .rejects.toThrow("published checkpoint is unavailable");

    const missingNative = dependencies({ fetchFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") return file(pointer);
      if (path === PATH) return file("# Canonical checkpoint\n", BLOB);
      throw new Error(`Not found: ${path}`);
    }) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, missingNative))
      .rejects.toThrow("Not found");

    const nativeWithoutMetadata = dependencies({ fetchFile: vi.fn(async (_repo: string, path: string) => {
      if (path === "docs/handoffs/LATEST.md") return file(pointer);
      if (path === PATH) return file("# Canonical checkpoint\n", BLOB);
      if (path === ".prism/handoff.md") return file("## Meta\n- Status: active\n");
      throw new Error(`Not found: ${path}`);
    }) });
    await expect(preparePublishedCheckpointProjection("project", expected, { sessionNumber: 6, handoffVersion: 5 }, nativeWithoutMetadata))
      .rejects.toThrow("template version is missing");
  });

  it.each([
    [{ ...expected, ref: "main" }, { sessionNumber: 6, handoffVersion: 5 }],
    [{ ...expected, sha: "not-a-blob" }, { sessionNumber: 6, handoffVersion: 5 }],
    [expected, { sessionNumber: 0, handoffVersion: 5 }],
    [expected, { sessionNumber: 6, handoffVersion: 1.5 }],
  ])("rejects invalid constrained metadata", async (source, metadata) => {
    await expect(preparePublishedCheckpointProjection("project", source as ExpectedPublishedHandoff, metadata, dependencies()))
      .rejects.toThrow();
  });
});
