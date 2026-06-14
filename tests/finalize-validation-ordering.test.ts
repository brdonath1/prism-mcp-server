/**
 * SRV-48 / SRV-20 / SRV-59 (brief-461 Task B) — commit-phase validation
 * ordering, warning surfacing, and handoff-version cross-check.
 *
 * SRV-48: validation runs on the FINAL files[] AFTER all in-memory mutations,
 *         and NO repo write (backup, prune, or atomic commit) happens before
 *         validation passes. A validation-failed commit must never call
 *         createAtomicCommit.
 * SRV-20: validation WARNINGS (e.g. the handoff 15KB size warning) are carried
 *         through the commit response instead of being discarded.
 * SRV-59: the committed handoff's Meta version/session is cross-checked against
 *         the call params, surfacing a warning diagnostic on mismatch.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  getDefaultBranch: vi.fn(),
  getHeadSha: vi.fn(),
}));

// Synthesis disabled — keep the post-commit path simple; tests pass
// skip_synthesis anyway.
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, SYNTHESIS_ENABLED: false };
});

import {
  fetchFile,
  listDirectory,
  fileExists,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { registerFinalize } from "../src/tools/finalize.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);

function validHandoff(version: number, session: number, pad = 0): string {
  return [
    "## Meta",
    `- Handoff Version: ${version}`,
    `- Session Count: ${session}`,
    "- Template Version: v2.9.0",
    "- Status: Active",
    "",
    "## Critical Context",
    "1. First critical item",
    "2. Second critical item",
    "",
    "## Where We Are",
    "Mid-flight on the audit remediation work." + (pad ? "\n" + "x".repeat(pad) : ""),
    "",
    "<!-- EOF: handoff.md -->",
  ].join("\n");
}

function captureHandler(): (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  let handler: ((args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>) | null = null;
  const orig = server.tool.bind(server);
  vi.spyOn(server, "tool").mockImplementation((name: string, ...rest: unknown[]) => {
    const h = rest[rest.length - 1];
    if (name === "prism_finalize") handler = h as never;
    return (orig as never as (...a: unknown[]) => unknown)(name, ...rest) as never;
  });
  registerFinalize(server);
  if (!handler) throw new Error("prism_finalize not registered");
  return handler;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Backup read of the current handoff + no history to prune.
  mockFetchFile.mockResolvedValue({ content: validHandoff(4, 24), sha: "cur", size: 100 });
  mockListDirectory.mockResolvedValue([]);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
});

describe("SRV-48 — no repo write happens before validation passes", () => {
  it("a validation-failed commit never calls createAtomicCommit (backup, prune, or main)", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 25,
      handoff_version: 5,
      // Invalid handoff — no ## Meta / ## Where We Are — validation must reject.
      files: [{ path: "handoff.md", content: "# Handoff\nbroken\n<!-- EOF: handoff.md -->" }],
      skip_synthesis: true,
    });

    const data = parse(result);
    expect(data.all_succeeded).toBe(false);
    // The SRV-48 guarantee: NOTHING was committed before validation gated it.
    expect(mockCreateAtomicCommit).not.toHaveBeenCalled();
  });
});

describe("SRV-20 — validation warnings are surfaced in the commit response", () => {
  it("carries the handoff size warning instead of discarding it", async () => {
    const handler = captureHandler();
    // >15KB valid handoff trips validateHandoff's critical size warning.
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 25,
      handoff_version: 4,
      files: [{ path: "handoff.md", content: validHandoff(4, 25, 16_000) }],
      skip_synthesis: true,
    });

    const data = parse(result);
    expect(data.all_succeeded).toBe(true);
    const handoffResult = data.results.find((r: { path: string }) =>
      r.path.endsWith("handoff.md"),
    );
    expect(handoffResult).toBeDefined();
    expect(Array.isArray(handoffResult.validation_warnings)).toBe(true);
    expect(handoffResult.validation_warnings.length).toBeGreaterThan(0);
    expect(handoffResult.validation_warnings.join(" ")).toMatch(/KB|size|large/i);
  });
});

describe("SRV-59 — handoff Meta version/session cross-check", () => {
  it("emits a HANDOFF_VERSION_MISMATCH warning when Meta version != the param", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 25,
      handoff_version: 9, // param says 9
      files: [{ path: "handoff.md", content: validHandoff(5, 25) }], // Meta says 5
      skip_synthesis: true,
    });

    const data = parse(result);
    expect(data.all_succeeded).toBe(true);
    const codes = (data.diagnostics ?? []).map((d: { code: string }) => d.code);
    expect(codes).toContain("HANDOFF_VERSION_MISMATCH");
  });
});
