// S208 PR-S1 - boot banner reliability.
//
// MCP-3: the three bare bootstrap exits (ambiguous slug, hard error, deadline)
//        ship banner fields instead of nothing at all.
// MCP-13: the docs count is MEASURED from the boot fan-out - boot never probes
//        all ten living documents, so the hardcoded "10/10 docs healthy" was an
//        assertion the server had no evidence for.
// MCP-19: masthead render failures raise MASTHEAD_RENDER_FAILED instead of
//        being log-only.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, BOOTSTRAP_WALL_CLOCK_DEADLINE_MS: 400 };
});

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
  deleteFile: vi.fn(),
  createAtomicCommit: vi.fn(),
  getDefaultBranch: vi.fn(),
  getHeadSha: vi.fn(),
}));

vi.mock("../src/utils/banner.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    renderBootMastheadSvg: vi.fn((...args: unknown[]) =>
      (actual.renderBootMastheadSvg as (...a: unknown[]) => string)(...args),
    ),
    renderBootMastheadHtml: vi.fn((...args: unknown[]) =>
      (actual.renderBootMastheadHtml as (...a: unknown[]) => string)(...args),
    ),
  };
});

import {
  fetchFile,
  fetchFiles,
  pushFile,
  fileExists,
  listRepos,
  listDirectory,
  listCommits,
  getHeadSha,
} from "../src/github/client.js";
import { renderBootMastheadSvg, renderBootMastheadHtml } from "../src/utils/banner.js";
import { registerBootstrap } from "../src/tools/bootstrap.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockListRepos = vi.mocked(listRepos);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockMastheadSvg = vi.mocked(renderBootMastheadSvg);
const mockMastheadHtml = vi.mocked(renderBootMastheadHtml);

const HANDOFF = [
  "# Handoff",
  "",
  "## Meta",
  "- Handoff Version: 33",
  "- Session Count: 28",
  "- Template Version: 3.2.0",
  "- Status: Active",
  "",
  "## Critical Context",
  "1. Item one",
  "",
  "## Where We Are",
  "Current state.",
  "",
  "## Next Steps",
  "1. Continue.",
  "",
  "<!-- EOF: handoff.md -->",
].join("\n");

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

let bootstrapHandler: ToolHandler;
const mockServer = {
  tool: vi.fn((name: string, _d: string, _s: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") bootstrapHandler = handler as ToolHandler;
  }),
} as unknown as McpServer;

/** S208 MCP-6: run `fn` with BOOT_MASTHEAD pinned to `mode`, always restoring
 *  the ambient value so one test can never leak a mode into the next. */
async function withMasthead(mode: "html" | "svg" | "off", fn: () => Promise<void>): Promise<void> {
  const saved = process.env.BOOT_MASTHEAD;
  process.env.BOOT_MASTHEAD = mode;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.BOOT_MASTHEAD;
    else process.env.BOOT_MASTHEAD = saved;
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Mock implementations persist across tests, so restore the real renderers
  // explicitly - otherwise a forced-failure test leaks into the next one.
  const actualBanner = await vi.importActual<typeof import("../src/utils/banner.js")>(
    "../src/utils/banner.js",
  );
  mockMastheadSvg.mockImplementation(actualBanner.renderBootMastheadSvg);
  mockMastheadHtml.mockImplementation(actualBanner.renderBootMastheadHtml);
  registerBootstrap(mockServer);
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "h", size: HANDOFF.length };
    if (path.includes("core-template-mcp.md")) {
      const t = "# Template\nTemplate Version: 3.2.0\n";
      return { content: t, sha: "t", size: t.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFetchFiles.mockResolvedValue([] as never);
  mockFileExists.mockResolvedValue(false);
  mockPushFile.mockResolvedValue({ success: true, sha: "p", size: 10 } as never);
  mockListRepos.mockResolvedValue(["prism"]);
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetHeadSha.mockResolvedValue("HEAD");
});

async function boot(args: Record<string, unknown>) {
  const raw = await bootstrapHandler(args);
  return { parsed: JSON.parse(raw.content[0].text) as Record<string, unknown>, raw };
}

describe("MCP-3 - every bootstrap exit carries banner fields", () => {
  it("the ambiguous-slug exit ships a banner with no fabricated numbers", async () => {
    mockListRepos.mockResolvedValue(["acme-platform-core-api", "acme-platform-core-web"]);
    const { parsed, raw } = await boot({ project_slug: "acme-platform-core" });

    expect(raw.isError).toBe(true);
    expect(parsed.banner_text).toBe("PRISM | Session ? | Handoff v? | ?/10 docs (unverified)");
    expect(parsed.banner_spec_version).toBe("4.3");
    expect(parsed.boot_masthead_svg).toBeNull();
    expect(parsed.boot_masthead_html).toBeNull();
    // Pre-resolution exits name no chat session (better silent than wrong).
    expect(parsed.session_name_line).toBeUndefined();
  });

  it("the hard-error exit ships a banner", async () => {
    mockFetchFile.mockRejectedValue(new Error("GitHub 500"));
    const { parsed, raw } = await boot({ project_slug: "prism" });

    expect(raw.isError).toBe(true);
    expect(parsed.banner_text).toBe("PRISM | Session ? | Handoff v? | ?/10 docs (unverified)");
    expect(parsed.banner_spec_version).toBe("4.3");
  });

  it("the deadline exit ships a banner carrying whatever the boot DID resolve", async () => {
    // handoff resolves (so session/handoff numbers are known), then the rest
    // of the boot hangs past the 400ms mocked deadline.
    mockListDirectory.mockImplementation(() => new Promise(() => {}));
    mockPushFile.mockImplementation(() => new Promise(() => {}) as never);
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "h", size: HANDOFF.length };
      return await new Promise(() => {}) as never;
    });

    const { parsed, raw } = await boot({ project_slug: "prism" });

    expect(raw.isError).toBe(true);
    expect(String(parsed.error)).toContain("deadline exceeded");
    expect(typeof parsed.banner_text).toBe("string");
    expect(String(parsed.banner_text)).toContain("?/10 docs (unverified)");
    expect(parsed.banner_spec_version).toBe("4.3");
  }, 15_000);
});

describe("MCP-13 - the boot docs count is measured, never asserted", () => {
  it("reports ?/10 when the boot fan-out did not verify all ten living documents", async () => {
    const { parsed } = await boot({ project_slug: "prism" });
    expect(String(parsed.banner_text)).toContain("?/10 docs (unverified)");
    expect(String(parsed.banner_text)).not.toContain("10/10 docs healthy");
  });

  // S208 MCP-6: one masthead per boot. Both renderers are still checked - the
  // agreement contract belongs to whichever one the deployment selects.
  it("the masthead agrees with the text banner, in both modes", async () => {
    const { parsed } = await boot({ project_slug: "prism" });
    expect(String(parsed.boot_masthead_html)).toContain("?/10 docs (unverified)");
    expect(parsed.boot_masthead_svg).toBeNull();

    await withMasthead("svg", async () => {
      const { parsed: svgBoot } = await boot({ project_slug: "prism" });
      expect(String(svgBoot.boot_masthead_svg)).toContain("?/10 docs (unverified)");
      expect(svgBoot.boot_masthead_html).toBeNull();
    });
  });
});

describe("MCP-19 - render failures are diagnostics, not just log lines", () => {
  it("a masthead SVG render failure raises MASTHEAD_RENDER_FAILED", async () => {
    mockMastheadSvg.mockImplementation(() => {
      throw new Error("forced svg failure");
    });
    // S208 MCP-6: the SVG renderer only runs when it is the selected mode.
    await withMasthead("svg", async () => {
      const { parsed } = await boot({ project_slug: "prism" });

      const entries = parsed.diagnostics as Array<{ code: string; context?: { surface?: string } }>;
      const hit = entries.find((d) => d.code === "MASTHEAD_RENDER_FAILED");
      expect(hit).toBeDefined();
      expect(hit!.context!.surface).toBe("boot_masthead_svg");
      expect(parsed.boot_masthead_svg).toBeNull();
      // banner_text is unaffected - it is the genuine fallback.
      expect(typeof parsed.banner_text).toBe("string");
    });
  });

  it("a masthead HTML render failure raises MASTHEAD_RENDER_FAILED for its own surface", async () => {
    mockMastheadHtml.mockImplementation(() => {
      throw new Error("forced html failure");
    });
    const { parsed } = await boot({ project_slug: "prism" });

    const entries = parsed.diagnostics as Array<{ code: string; context?: { surface?: string } }>;
    const hit = entries.find(
      (d) => d.code === "MASTHEAD_RENDER_FAILED" && d.context?.surface === "boot_masthead_html",
    );
    expect(hit).toBeDefined();
    expect(parsed.boot_masthead_html).toBeNull();
    // S208 MCP-6: the unselected masthead is null by design, not by failure -
    // banner_text is what carries the boot when the selected one dies.
    expect(parsed.boot_masthead_svg).toBeNull();
    expect(typeof parsed.banner_text).toBe("string");
  });

  it("the mode that did NOT fail still renders (failures are per-surface)", async () => {
    mockMastheadHtml.mockImplementation(() => {
      throw new Error("forced html failure");
    });
    await withMasthead("svg", async () => {
      const { parsed } = await boot({ project_slug: "prism" });
      expect(typeof parsed.boot_masthead_svg).toBe("string");
      const codes = (parsed.diagnostics as Array<{ code: string }>).map((d) => d.code);
      expect(codes).not.toContain("MASTHEAD_RENDER_FAILED");
    });
  });

  it("a clean boot raises no render diagnostics", async () => {
    const { parsed } = await boot({ project_slug: "prism" });
    const codes = (parsed.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).not.toContain("MASTHEAD_RENDER_FAILED");
    expect(codes).not.toContain("BANNER_RENDER_FAILED");
  });
});
