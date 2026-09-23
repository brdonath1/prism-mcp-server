import { describe, expect, it, vi } from "vitest";
import {
  PUBLISHED_CHECKPOINT_POINTER,
  parsePublishedHandoffPath,
  readPublishedCheckpoint,
  resolvePublishedCheckpoint,
} from "../src/utils/published-checkpoint.js";

vi.mock("../src/github/client.js", () => ({ getHeadSha: vi.fn(), fetchFile: vi.fn() }));
import { getHeadSha, fetchFile as githubFetchFile } from "../src/github/client.js";

const REF = "a".repeat(40);
const PATH = "docs/handoffs/handoff-2026-09-22-1200.md";
const POINTER = `handoff: ${PATH}\nagent: codex\nnext_action: Read ${PATH} and continue.`;
const HANDOFF = "# Published checkpoint\n\nRead this first.\n";

function file(content: string, sha: string) {
  return { content, sha, size: Buffer.byteLength(content, "utf8") };
}

describe("published checkpoint pointer parsing", () => {
  it("accepts the dated handoff path and the documented none fallback", () => {
    expect(parsePublishedHandoffPath(POINTER)).toEqual({ kind: "path", path: PATH });
    expect(parsePublishedHandoffPath("handoff: none\n")).toEqual({ kind: "none" });
  });

  it.each([
    "agent: codex\n",
    "handoff: \n",
    "handoff: ../handoff.md\n",
    "handoff: docs/handoffs/handoff-2026.md\nhandoff: docs/handoffs/handoff-2026-09-22-1200.md\n",
  ])("rejects an ambiguous or out-of-contract pointer: %j", (pointer) => {
    expect(parsePublishedHandoffPath(pointer).kind).toBe("invalid");
  });
});

describe("readPublishedCheckpoint", () => {
  it("pins pointer and target reads to the supplied immutable head", async () => {
    const fetchFile = vi.fn(async (_repo: string, path: string, ref: string) => {
      expect(ref).toBe(REF);
      if (path === PUBLISHED_CHECKPOINT_POINTER) return file(POINTER, "pointer-sha");
      if (path === PATH) return file(HANDOFF, "handoff-sha");
      throw new Error(`Not found: ${path}`);
    });

    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile })).resolves.toEqual({
      status: "published", authority: "docs/handoffs", ref: REF,
      latest_path: PUBLISHED_CHECKPOINT_POINTER, latest_sha: "pointer-sha",
      handoff_path: PATH, handoff_sha: "handoff-sha", handoff_content: HANDOFF, files_fetched: 2,
    });
    expect(fetchFile).toHaveBeenCalledTimes(2);
  });

  it("rejects a mutable branch ref before reading either path", async () => {
    const fetchFile = vi.fn();
    await expect(readPublishedCheckpoint({ repo: "project", ref: "main", fetchFile })).resolves.toMatchObject({ status: "unavailable", reason: "invalid_ref" });
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it("uses native fallback only for a missing pointer or explicit none", async () => {
    const missing = vi.fn(async () => { throw new Error("Not found: docs/handoffs/LATEST.md"); });
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile: missing })).resolves.toMatchObject({ status: "native_fallback", reason: "pointer_missing" });
    const none = vi.fn(async () => file("handoff: none\n", "pointer-sha"));
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile: none })).resolves.toMatchObject({ status: "native_fallback", reason: "pointer_none" });
  });

  it("blocks malformed pointers and never follows their target", async () => {
    const fetchFile = vi.fn(async () => file("handoff: https://example.test/handoff.md\n", "pointer-sha"));
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile })).resolves.toMatchObject({ status: "unavailable", reason: "invalid_pointer" });
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it("reports missing, empty, and oversized named targets without fallback", async () => {
    const missingTarget = vi.fn(async (_repo: string, path: string) => path === PUBLISHED_CHECKPOINT_POINTER ? file(POINTER, "pointer-sha") : Promise.reject(new Error("Not found: dated handoff")));
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile: missingTarget })).resolves.toMatchObject({ status: "unavailable", reason: "target_missing" });
    const emptyTarget = vi.fn(async (_repo: string, path: string) => path === PUBLISHED_CHECKPOINT_POINTER ? file(POINTER, "pointer-sha") : file(" \n", "handoff-sha"));
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile: emptyTarget })).resolves.toMatchObject({ status: "unavailable", reason: "target_empty" });
    const largeTarget = vi.fn(async (_repo: string, path: string) => path === PUBLISHED_CHECKPOINT_POINTER ? file(POINTER, "pointer-sha") : file("12345", "handoff-sha"));
    await expect(readPublishedCheckpoint({ repo: "project", ref: REF, fetchFile: largeTarget, maxBytes: 4 })).resolves.toMatchObject({ status: "unavailable", reason: "target_too_large" });
  });
});


describe("strict authority selectors", () => {
  it("does not treat ambiguous none or a following line as explicit fallback", () => {
    expect(parsePublishedHandoffPath('handoff: none — no dated handoff under this contract yet; the checkpoint is .prism/handoff.md until the first "Finalize session"').kind).toBe("none");
    expect(parsePublishedHandoffPath("handoff: none but read another source").kind).toBe("invalid");
    expect(parsePublishedHandoffPath("handoff:\nnone").kind).toBe("invalid");
  });
});


describe("production checkpoint wrapper", () => {
  it("requests main explicitly and pins both reads", async () => {
    vi.mocked(getHeadSha).mockResolvedValue(REF);
    vi.mocked(githubFetchFile).mockImplementation(async (_repo, path) => file(path === PUBLISHED_CHECKPOINT_POINTER ? POINTER : HANDOFF, "blob"));
    const result = await resolvePublishedCheckpoint("project");
    expect(result.status).toBe("published");
    expect(getHeadSha).toHaveBeenLastCalledWith("project", "main");
    expect(githubFetchFile).toHaveBeenCalledWith("project", PUBLISHED_CHECKPOINT_POINTER, REF);
    expect(githubFetchFile).toHaveBeenCalledWith("project", PATH, REF);
  });
  it("refuses an unavailable main HEAD without fetching a pointer", async () => {
    vi.mocked(getHeadSha).mockResolvedValue(undefined);
    vi.mocked(githubFetchFile).mockClear();
    await expect(resolvePublishedCheckpoint("project")).resolves.toMatchObject({status: "unavailable", reason: "head_unavailable"});
    expect(githubFetchFile).not.toHaveBeenCalled();
  });
});
