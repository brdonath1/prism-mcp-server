// S203 audit R19 (F-A2-12) + R18 (F-A2-11) — banner input caps.
//
// R19: `banner_data.deliverables` was the ONE unbounded operator-controlled
// input on the banner path (llm_usage has been capped at 8 since brief-447),
// uncapped in both schema and renderer. Rows are now capped at 12 and each
// text at 160 chars, and the cut is always reported.
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
  pushFile,
} from "../src/github/client.js";
import { registerFinalize } from "../src/tools/finalize.js";
import {
  BANNER_DELIVERABLES_MAX_ROWS,
  BANNER_DELIVERABLE_TEXT_MAX_CHARS,
  assembleFinalizeErrorBannerFields,
  normalizeBannerDeliverables,
} from "../src/tools/finalize/banner.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockListDirectory = vi.mocked(listDirectory);
const mockFileExists = vi.mocked(fileExists);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockPushFile = vi.mocked(pushFile);

const HANDOFF = [
  "## Meta",
  "- Handoff Version: 34",
  "- Session Count: 29",
  "- Template Version: v2.29.0",
  "- Status: Active",
  "",
  "## Critical Context",
  "1. First critical item",
  "",
  "## Where We Are",
  "Capping the banner inputs.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

function captureHandler() {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  registerFinalize(server);
  const tool = (server as never as { _registeredTools: Record<string, { handler: unknown }> })
    ._registeredTools["prism_finalize"];
  return tool.handler as (
    args: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function parse(r: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchFile.mockResolvedValue({ content: HANDOFF, sha: "cur", size: HANDOFF.length });
  mockListDirectory.mockResolvedValue([]);
  mockFileExists.mockResolvedValue(true);
  mockGetHeadSha.mockResolvedValue("head-1");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic_sha", files_committed: 1 });
  mockPushFile.mockResolvedValue({ success: true, sha: "p", size: 1 });
});

describe("R19 — normalizeBannerDeliverables (pure)", () => {
  it("caps the array at 12 rows and reports the drop", () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ text: `Deliverable ${i + 1}`, status: "ok" as const }));
    const out = normalizeBannerDeliverables(entries);

    expect(out.items).toHaveLength(BANNER_DELIVERABLES_MAX_ROWS);
    expect(out.items).toHaveLength(12);
    expect(out.dropped_rows).toBe(28);
    expect(out.clamped_texts).toBe(0);
    // Request order is preserved — the first 12, not an arbitrary subset.
    expect(out.items[0]).toBe("Deliverable 1");
    expect(out.items[11]).toBe("Deliverable 12");
  });

  it("caps each text at 160 chars and reports the clamp", () => {
    const out = normalizeBannerDeliverables([
      { text: "x".repeat(500), status: "ok" },
      { text: "short one", status: "ok" },
    ]);

    expect(out.items[0]).toHaveLength(BANNER_DELIVERABLE_TEXT_MAX_CHARS);
    expect(out.items[1]).toBe("short one");
    expect(out.clamped_texts).toBe(1);
    expect(out.dropped_rows).toBe(0);
  });

  it("strips markdown and collapses whitespace without counting it as truncation", () => {
    const out = normalizeBannerDeliverables([{ text: "**bold**   thing\nwrapped", status: "ok" }]);
    expect(out.items[0]).toBe("bold thing wrapped");
    expect(out.clamped_texts).toBe(0);
  });

  it("undefined input yields no rows and no truncation", () => {
    expect(normalizeBannerDeliverables(undefined)).toEqual({
      items: [],
      dropped_rows: 0,
      clamped_texts: 0,
    });
  });
});

describe("R19 — the cap bites on a live commit and is never silent", () => {
  it("40 deliverables → ≤12 rendered rows + BANNER_DELIVERABLES_TRUNCATED", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
      banner_data: {
        deliverables: Array.from({ length: 40 }, (_, i) => ({
          text: `Deliverable ${i + 1}`,
          status: "ok" as const,
        })),
      },
    });
    const data = parse(result);

    const truncated = (
      data.diagnostics as Array<{
        code: string;
        level: string;
        context?: { supplied_rows?: number; rendered_rows?: number; dropped_rows?: number };
      }>
    ).find(d => d.code === "BANNER_DELIVERABLES_TRUNCATED");

    expect(truncated).toBeDefined();
    expect(truncated!.level).toBe("warn");
    expect(truncated!.context!.supplied_rows).toBe(40);
    expect(truncated!.context!.rendered_rows).toBe(12);
    expect(truncated!.context!.dropped_rows).toBe(28);

    // The rendered banner carries the first 12 and nothing past the cap.
    expect(data.banner_text).toContain("Deliverable 12");
    expect(data.banner_text).not.toContain("Deliverable 13");
    expect(data.banner_text).not.toContain("Deliverable 40");
    expect(data.finalization_banner_html).toContain("Deliverable 12");
    expect(data.finalization_banner_html).not.toContain("Deliverable 13");
  });

  it("an over-long deliverable text is cut to 160 chars and reported", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
      banner_data: {
        deliverables: [{ text: `START${"y".repeat(400)}END`, status: "ok" as const }],
      },
    });
    const data = parse(result);

    const truncated = (
      data.diagnostics as Array<{ code: string; context?: { clamped_texts?: number; dropped_rows?: number } }>
    ).find(d => d.code === "BANNER_DELIVERABLES_TRUNCATED");
    expect(truncated).toBeDefined();
    expect(truncated!.context!.clamped_texts).toBe(1);
    expect(truncated!.context!.dropped_rows).toBe(0);
    expect(data.banner_text).toContain("START");
    expect(data.banner_text).not.toContain("END");
  });

  it("12 or fewer in-budget rows fire NO diagnostic (the cap only speaks when it bites)", async () => {
    const handler = captureHandler();
    const result = await handler({
      project_slug: "test-project",
      action: "commit",
      session_number: 29,
      handoff_version: 34,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF }],
      banner_data: {
        deliverables: Array.from({ length: 12 }, (_, i) => ({
          text: `Deliverable ${i + 1}`,
          status: "ok" as const,
        })),
      },
    });
    const data = parse(result);

    expect(
      (data.diagnostics as Array<{ code: string }>).some(d => d.code === "BANNER_DELIVERABLES_TRUNCATED"),
    ).toBe(false);
    expect(data.banner_text).toContain("Deliverable 12");
  });
});

describe("R18 — the error-banner fallback never asserts a doc count it did not verify", () => {
  it("assembleFinalizeErrorBannerFields renders ?/10 (unverified), not 0/10", () => {
    const fields = assembleFinalizeErrorBannerFields(25, 5);
    expect(fields.banner_text).toBe("PRISM | Session 25 | Handoff v5 | ?/10 docs (unverified)");
    expect(fields.banner_text).not.toContain("0/10");
    expect(fields.finalization_banner_html).toBeNull();
  });
});
