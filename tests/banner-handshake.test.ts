// brief-439 (D-240 Phase B, R8): banner_spec_version handshake + unified
// banner integration tests.
//
// Covers:
//  - prism_bootstrap emits banner_spec_version and raises a BANNER_DRIFT
//    warn diagnostic when the behavioral-rules template declares a different
//    banner spec version (match + mismatch + undeclared).
//  - the Banner-Spec-Version declaration must NOT pollute template_version
//    parsing regardless of line ordering.
//  - banner_data is gone from the bootstrap response (single format — D-240).
//  - prism_finalize commit/full produce banner_text from the unified
//    generator, emit banner_spec_version, and populate finalization_banner_html
//    with the restored HTML widget (D-249; full surface wired in brief-448).
//  - prism_finalize audit compares the session-end rules template declaration
//    and raises BANNER_DRIFT on mismatch.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

// Template cache must miss on every call so per-test template content takes
// effect (the real singleton would leak the first test's template into later
// tests via its 5-minute TTL).
vi.mock("../src/utils/cache.js", () => ({
  templateCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesize.js", () => ({
  generateIntelligenceBrief: vi.fn(),
  generatePendingDocUpdates: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  fetchFile,
  fetchFiles,
  pushFile,
  fileExists,
  listDirectory,
  listCommits,
  createAtomicCommit,
  getHeadSha,
} from "../src/github/client.js";
import { synthesize } from "../src/ai/client.js";
import { generateIntelligenceBrief, generatePendingDocUpdates } from "../src/ai/synthesize.js";
import { registerBootstrap } from "../src/tools/bootstrap.js";
import { registerFinalize } from "../src/tools/finalize.js";
import {
  BANNER_SPEC_VERSION,
  parseTemplateBannerSpecVersion,
  renderBootMastheadSvg,
  renderFinalizationBannerHtml,
  type UnifiedBannerInput,
} from "../src/utils/banner.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockListDirectory = vi.mocked(listDirectory);
const mockListCommits = vi.mocked(listCommits);
const mockCreateAtomicCommit = vi.mocked(createAtomicCommit);
const mockGetHeadSha = vi.mocked(getHeadSha);
const mockSynthesize = vi.mocked(synthesize);
const mockGenerateIntelligenceBrief = vi.mocked(generateIntelligenceBrief);
const mockGeneratePendingDocUpdates = vi.mocked(generatePendingDocUpdates);

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

const handlers: Record<string, ToolHandler> = {};
const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    handlers[name] = handler as ToolHandler;
  }),
} as unknown as McpServer;

registerBootstrap(mockServer);
registerFinalize(mockServer);

function parse(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

const HANDOFF_BOOT = `# Handoff

## Meta
- Handoff Version: 33
- Session Count: 28
- Template Version: 2.10.0
- Status: Active

## Critical Context
1. Item one

## Where We Are
Current state.

## Resumption Point
Resume here.

## Next Steps
1. Do thing A

<!-- EOF: handoff.md -->`;

const DECISIONS_INDEX = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | First | arch | SETTLED | 1 |
| D-2 | Second | arch | SETTLED | 2 |

<!-- EOF: _INDEX.md -->`;

/** Template content factory — optionally declares a banner spec version. */
function templateContent(bannerSpecLine: string | null): string {
  return [
    "# PRISM Core Template v2.20.0 (MCP Mode)",
    "",
    // Deliberately place the banner-spec declaration BEFORE the template
    // version line: template_version parsing must not be polluted by it.
    ...(bannerSpecLine ? [bannerSpecLine] : []),
    "> **Template Version:** 2.20.0",
    "",
    "Rules here.",
    "",
    "<!-- EOF: core-template-mcp.md -->",
  ].join("\n");
}

function setupBootstrapMocks(template: string): void {
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return { content: HANDOFF_BOOT, sha: "h1", size: HANDOFF_BOOT.length };
    }
    if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
      return { content: DECISIONS_INDEX, sha: "d1", size: DECISIONS_INDEX.length };
    }
    if (path.includes("core-template-mcp.md")) {
      return { content: template, sha: "t1", size: template.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFileExists.mockResolvedValue(false);
  mockPushFile.mockResolvedValue({ success: true, sha: "p1", size: 50 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Bootstrap handshake ──────────────────────────────────────────────────────

describe("prism_bootstrap banner_spec_version handshake", () => {
  it("emits banner_spec_version on every response", async () => {
    setupBootstrapMocks(templateContent(null));
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    expect(data.banner_spec_version).toBe(BANNER_SPEC_VERSION);
  });

  it("raises BANNER_DRIFT (warn) when the template declares a different version", async () => {
    setupBootstrapMocks(templateContent("> **Banner-Spec-Version:** 9.9"));
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    const drift = data.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT");
    expect(drift).toHaveLength(1);
    expect(drift[0].level).toBe("warn");
    expect(drift[0].context.template_declared).toBe("9.9");
    expect(drift[0].context.server_emitted).toBe(BANNER_SPEC_VERSION);
    expect(data.template_banner_spec_version).toBe("9.9");
    // Visibility only — the boot still succeeds with a banner.
    expect(data.banner_text).toBeTruthy();
  });

  it("does NOT raise BANNER_DRIFT when the declared version matches", async () => {
    setupBootstrapMocks(
      templateContent(`> **Banner-Spec-Version:** ${BANNER_SPEC_VERSION}`),
    );
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    expect(data.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT")).toHaveLength(0);
    expect(data.template_banner_spec_version).toBe(BANNER_SPEC_VERSION);
  });

  it("does NOT raise BANNER_DRIFT when the template declares nothing (pre-handshake template)", async () => {
    setupBootstrapMocks(templateContent(null));
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    expect(data.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT")).toHaveLength(0);
    expect(data.template_banner_spec_version).toBeNull();
  });

  it("Banner-Spec-Version declaration does not pollute template_version parsing", async () => {
    setupBootstrapMocks(
      templateContent(`> **Banner-Spec-Version:** ${BANNER_SPEC_VERSION}`),
    );
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    // The declaration precedes the Template Version line in the fixture; a
    // naive first-"version"-match parse would report the spec version here.
    expect(data.template_version).toBe("2.20.0");
  });

  it("banner_data is gone from the response — banner_text is the only format", async () => {
    setupBootstrapMocks(templateContent(null));
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    expect(data.banner_text).toBeTruthy();
    expect(data.banner_data).toBeUndefined();
  });

  it("boot_masthead_svg includes the exact server-composed session_name_line", async () => {
    setupBootstrapMocks(templateContent(null));
    const data = parse(await handlers.prism_bootstrap({ project_slug: "prism" }));
    expect(data.session_name_line).toBeTruthy();
    expect(data.boot_masthead_svg).toContain(data.session_name_line);
  });
});

// ── Finalize: unified banner_text + handshake ────────────────────────────────

const HANDOFF_FINALIZE = `## Meta
- Handoff Version: 31
- Session Count: 26
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. Core infrastructure

## Where We Are
Working on audit remediation.

## Next Steps
1. Ship feature X

<!-- EOF: handoff.md -->`;

function setupFinalizeMocks(): void {
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return { content: HANDOFF_FINALIZE, sha: "h1", size: HANDOFF_FINALIZE.length };
    }
    if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
      return { content: DECISIONS_INDEX, sha: "d1", size: DECISIONS_INDEX.length };
    }
    throw new Error(`Not found: ${path}`);
  });
  mockFetchFiles.mockResolvedValue(new Map());
  mockFileExists.mockResolvedValue(false);
  mockPushFile.mockResolvedValue({ success: true, sha: "p1", size: 50 });
  mockListDirectory.mockResolvedValue([]);
  mockListCommits.mockResolvedValue([]);
  mockGetHeadSha.mockResolvedValue("HEAD");
  mockCreateAtomicCommit.mockResolvedValue({ success: true, sha: "atomic", files_committed: 1 });
  mockGenerateIntelligenceBrief.mockResolvedValue({ success: true } as any);
  mockGeneratePendingDocUpdates.mockResolvedValue({ success: true } as any);
  mockSynthesize.mockResolvedValue({
    success: false,
    error: "mocked off",
    error_code: "MOCK",
  } as any);
}

describe("prism_finalize unified banner", () => {
  beforeEach(() => {
    setupFinalizeMocks();
  });

  it("commit returns banner_text from the unified generator (finalize surface)", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF_FINALIZE }],
    });
    const data = parse(result);
    expect(data.banner_text).toBeTruthy();
    const lines = data.banner_text.split("\n");
    expect(lines[0]).toMatch(
      /^PRISM v2\.9\.0 \| Session 26 finalized \| \d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} CST$/,
    );
    expect(lines[1]).toBe("Handoff v31 (pushed) | 2 decisions | 1/10 docs updated");
    expect(lines[2]).toBe("✓ audit | ✓ draft | ✓ commit | ✓ verified");
    expect(lines[3]).toMatch(/^Suggested: /);
    expect(data.banner_text).toContain("Resumption: Working on audit remediation.");
    expect(data.banner_text).toContain("Deliverables:");
    expect(data.banner_text).toContain("▸ 1 file pushed");
  });

  it("commit emits banner_spec_version and populates finalization_banner_html (HTML widget restored — brief-447 / D-249)", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF_FINALIZE }],
    });
    const data = parse(result);
    expect(data.banner_spec_version).toBe(BANNER_SPEC_VERSION);
    // D-249 restored the finalization HTML widget (it was always null at spec
    // 3.0). banner_text remains the genuine fallback alongside it.
    expect(data.finalization_banner_html).toBeTruthy();
    expect(data.finalization_banner_html).toContain("<style>");
    expect(data.finalization_banner_html).toContain("PRISM");
    expect(data.finalization_banner_html).toContain("Session 26 finalized");
    expect(data.finalization_banner_html).toContain("Handoff v30 → v31 · pushed");
    expect(data.finalization_banner_html).toContain("Next chat: Test Project — Session 27:");
    expect(data.banner_text).toBeTruthy();
  });

  it("commit honors banner_data step_statuses and deliverables overrides", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [{ path: "handoff.md", content: HANDOFF_FINALIZE }],
      banner_data: {
        deliverables: [
          { text: "PR #58 merged", status: "ok" },
          { text: "Docs updated", status: "ok" },
        ],
        decisions_note: "2 new",
        step_statuses: { draft: "warn" },
      },
    });
    const data = parse(result);
    const lines = data.banner_text.split("\n");
    expect(lines[1]).toBe("Handoff v31 (pushed) | 2 decisions (2 new) | 1/10 docs updated");
    expect(lines[2]).toBe("✓ audit | ⚠ draft | ✓ commit | ✓ verified");
    expect(data.banner_text).toContain("▸ PR #58 merged");
    expect(data.banner_text).toContain("▸ Docs updated");
  });

  it("commit counts multiple legacy-layout living docs; domain decision files do NOT count (R8 doc-count fix)", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "commit",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      files: [
        { path: "handoff.md", content: HANDOFF_FINALIZE },
        { path: "glossary.md", content: "# Glossary\nTerms\n<!-- EOF: glossary.md -->" },
        { path: "session-log.md", content: "# Session Log\nS26\n<!-- EOF: session-log.md -->" },
        { path: "decisions/_INDEX.md", content: DECISIONS_INDEX },
        // Domain decision file — NOT one of the 10 living documents. Pre-fix
        // this inflated the banner count past the total ("5/10" here, and
        // "14/10" was reachable with more domain files).
        { path: "decisions/architecture.md", content: "# Architecture Decisions\nD-1 detail.\n<!-- EOF: architecture.md -->" },
      ],
    });
    const data = parse(result);
    // 4 living docs committed in the LEGACY root layout — the pre-R8 banner
    // reported 0/10 for unmigrated repos. The domain file is excluded.
    expect(data.banner_text.split("\n")[1]).toContain("4/10 docs updated");
    // Banner and confirmation sentence agree by construction (shared counter)
    // and the count can never exceed the total.
    expect(data.living_documents_updated).toBe(4);
    expect(data.confirmation).toContain("4/10 living documents updated");
  });

  it("full action honors banner_data step_statuses overrides over derived audit/draft outcomes", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
      banner_data: { step_statuses: { audit: "ok", draft: "ok" } },
    });
    const data = parse(result);
    const stepRow = data.banner_text.split("\n")[2];
    // Derived outcomes in this fixture are audit=warn (all docs missing) and
    // draft=warn (synthesize mock fails) — the operator override must win.
    expect(stepRow).toBe("✓ audit | ✓ draft | ✓ commit | ✓ verified");
  });

  it("full action also returns banner_text + banner_spec_version (previously had no banner)", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
    });
    const data = parse(result);
    expect(data.banner_text).toBeTruthy();
    expect(data.banner_text.split("\n")[0]).toContain(" | Session 26 finalized | ");
    expect(data.banner_spec_version).toBe(BANNER_SPEC_VERSION);
    // brief-448: the full surface now emits the HTML widget too (no longer null).
    expect(data.finalization_banner_html).toBeTruthy();
    // fullPhase passes its real audit/draft outcomes into the step row: all
    // living docs are absent in this fixture (audit warn) and the draft mock
    // fails (draft warn).
    const stepRow = data.banner_text.split("\n")[2];
    expect(stepRow).toBe("⚠ audit | ⚠ draft | ✓ commit | ✓ verified");
  });

  it("full action populates finalization_banner_html (HTML widget — brief-448 / D-249 follow-up to brief-447)", async () => {
    const result = await handlers.prism_finalize({
      project_slug: "test-project",
      action: "full",
      session_number: 26,
      handoff_version: 31,
      skip_synthesis: true,
      handoff_content: HANDOFF_FINALIZE,
    });
    const data = parse(result);
    // brief-448 closed the gap: the single-call `full` surface now emits the
    // graphical widget too — built from the same finalize data the commit
    // surface uses, so the widget and banner_text agree by construction.
    expect(data.finalization_banner_html).toBeTruthy();
    expect(data.finalization_banner_html).toContain("<style>");
    expect(data.finalization_banner_html).toContain("PRISM");
    expect(data.finalization_banner_html).toContain("finalized");
    expect(data.finalization_banner_html).toContain("Session 26 finalized");
    expect(data.finalization_banner_html).toContain("Handoff v30 → v31 · pushed");
    expect(data.finalization_banner_html).toContain("Next chat: Test Project — Session 27:");
    // banner_text stays the genuine fallback alongside the widget.
    expect(data.banner_text).toBeTruthy();
  });
});

// ── Finalize audit: session-end rules template handshake ────────────────────

describe("prism_finalize audit banner_spec_version handshake", () => {
  function setupAuditMocks(rulesContent: string | null): void {
    setupFinalizeMocks();
    const base = mockFetchFile.getMockImplementation()!;
    mockFetchFile.mockImplementation(async (repo: string, path: string, ...rest: any[]) => {
      if (path === "_templates/rules-session-end.md") {
        if (rulesContent === null) throw new Error("Not found: rules");
        return { content: rulesContent, sha: "r1", size: rulesContent.length };
      }
      return base(repo, path, ...rest);
    });
  }

  it("raises BANNER_DRIFT when rules-session-end.md declares a different version", async () => {
    setupAuditMocks("### SESSION END\n\nBanner-Spec-Version: 9.9\n\nRule 11...\n");
    const data = parse(
      await handlers.prism_finalize({
        project_slug: "test-project",
        action: "audit",
        session_number: 26,
      }),
    );
    const drift = data.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT");
    expect(drift).toHaveLength(1);
    expect(drift[0].level).toBe("warn");
    expect(data.banner_spec_version).toBe(BANNER_SPEC_VERSION);
  });

  it("does NOT raise BANNER_DRIFT on declared match or no declaration", async () => {
    setupAuditMocks(`### SESSION END\n\nBanner-Spec-Version: ${BANNER_SPEC_VERSION}\n`);
    const match = parse(
      await handlers.prism_finalize({
        project_slug: "test-project",
        action: "audit",
        session_number: 26,
      }),
    );
    expect(match.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT")).toHaveLength(0);

    setupAuditMocks("### SESSION END\n\nRule 11...\n");
    const undeclared = parse(
      await handlers.prism_finalize({
        project_slug: "test-project",
        action: "audit",
        session_number: 26,
      }),
    );
    expect(undeclared.diagnostics.filter((d: any) => d.code === "BANNER_DRIFT")).toHaveLength(0);
  });
});

// ── Graphical banners: boot SVG masthead + finalization HTML widget (D-249) ──

const MASTHEAD_INPUT: UnifiedBannerInput = {
  surface: "boot",
  templateVersion: "2.19.1",
  sessionNumber: 156,
  timestamp: "06-07-26 14:21:51",
  sessionNameLine: "PRISM Framework — Session 156: 06-07-26 14:21:51 CST",
  handoffVersion: 163,
  handoffNote: "7.3KB",
  decisionCount: 201,
  decisionNote: "20 guardrails",
  docCount: 10,
  docTotal: 10,
  statusRow: [
    { label: "bootstrap", status: "ok" },
    { label: "push verified", status: "ok" },
    { label: "template loaded", status: "ok" },
    { label: "no scaling needed", status: "ok" },
  ],
  suggested: { display: "Opus 4.8 · Adaptive off", rationale: "mixed queue" },
  resumption: "Resume here.",
  listItems: ["Do thing A"],
  warnings: [],
};

describe("renderBootMastheadSvg (brief-447 / D-249)", () => {
  it("returns a non-empty <svg masthead with the session number and all four status glyph labels", () => {
    const svg = renderBootMastheadSvg(MASTHEAD_INPUT);
    expect(svg.length).toBeGreaterThan(0);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Session 156");
    for (const label of ["bootstrap", "push verified", "template loaded", "no scaling needed"]) {
      expect(svg).toContain(label);
    }
    // Suggested line rendered when provided.
    expect(svg).toContain("Suggested: Opus 4.8 · Adaptive off — mixed queue");
    // Server-owned chips interpolate from the same boot data.
    expect(svg).toContain("Handoff v163 · 7.3KB");
    expect(svg).toContain("201 decisions · 20 guardrails");
    expect(svg).toContain("10/10 docs healthy");
    expect(svg).toContain("Chat: PRISM Framework — Session 156: 06-07-26 14:21:51 CST");
  });

  it("omits the Suggested line (and tightens the viewBox) when suggested is null", () => {
    const svg = renderBootMastheadSvg({ ...MASTHEAD_INPUT, suggested: null });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("Suggested:");
    // Panel/viewBox tighten when the suggested block is dropped.
    expect(svg).toContain('viewBox="0 0 680 232"');
    expect(svg).not.toContain('viewBox="0 0 680 256"');
  });

  it("renders the boot pill in green — the session-start designation (brief-452 / D-256) — with no teal left", () => {
    const svg = renderBootMastheadSvg(MASTHEAD_INPUT);
    expect(svg).toContain(
      '<g class="c-green"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>',
    );
    expect(svg).not.toContain("c-teal");
  });
});

describe("renderFinalizationBannerHtml (brief-447 / D-249)", () => {
  it("returns non-empty HTML containing each supplied deliverable string", () => {
    const deliverables = [
      "Graphical banners restored — boot masthead (SVG) + finalization widget (HTML)",
      "banner-spec.md raised to v4.0; finalization-banner-spec.md restored to widget-primary",
      "prism-mcp-server: HTML/SVG renders re-added, BANNER_SPEC_VERSION 3.0 to 4.0",
    ];
    const html = renderFinalizationBannerHtml({
      templateVersion: "2.19.1",
      sessionNumber: 156,
      timestamp: "06-07-26 15:40:02",
      handoffFromVersion: 163,
      handoffToVersion: 164,
      handoffStatus: "pushed",
      decisionCount: 203,
      decisionDelta: 2,
      docCount: 10,
      docTotal: 10,
      statusRow: [
        { label: "docs updated", status: "ok" },
        { label: "index synced", status: "ok" },
        { label: "pushed", status: "ok" },
        { label: "verified", status: "ok" },
      ],
      deliverables,
      next: "D-249 follow-through → PAT rotation Phase 2",
      nextSessionNameLine: "PRISM Framework — Session 157: 06-07-26 15:40:02 CST",
    });
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("<style>");
    expect(html).toContain("Session 156 finalized");
    expect(html).toContain("Handoff v163 → v164 · pushed");
    expect(html).toContain("203 decisions (+2)");
    for (const deliverable of deliverables) {
      expect(html).toContain(deliverable);
    }
    expect(html).toContain("Next: D-249 follow-through → PAT rotation Phase 2");
    expect(html).toContain("Next chat: PRISM Framework — Session 157: 06-07-26 15:40:02 CST");
  });

  it("omits the Next line when next is null", () => {
    const html = renderFinalizationBannerHtml({
      templateVersion: "2.19.1",
      sessionNumber: 156,
      timestamp: "06-07-26 15:40:02",
      handoffFromVersion: 163,
      handoffToVersion: 164,
      handoffStatus: "pushed",
      decisionCount: 203,
      decisionDelta: null,
      docCount: 9,
      docTotal: 10,
      statusRow: [{ label: "verified", status: "ok" }],
      deliverables: ["Only deliverable"],
      next: null,
    });
    expect(html).not.toContain("Next:");
    // No delta → the "(+N)" segment is dropped.
    expect(html).toContain("203 decisions");
    expect(html).not.toContain("203 decisions (+");
  });

  it("renders the red session-end designation (brief-452 / D-256): danger pill + top accent strip, ok glyphs stay green", () => {
    const html = renderFinalizationBannerHtml({
      templateVersion: "2.19.1",
      sessionNumber: 164,
      timestamp: "06-10-26 10:00:00",
      handoffFromVersion: 171,
      handoffToVersion: 172,
      handoffStatus: "pushed",
      decisionCount: 210,
      decisionDelta: 1,
      docCount: 10,
      docTotal: 10,
      statusRow: [
        { label: "docs updated", status: "ok" },
        { label: "verified", status: "ok" },
      ],
      deliverables: ["Banner Spec 4.1 — session-state colors"],
      next: null,
    });
    // The "finalized" pill carries the danger (red) palette.
    expect(html).toContain(
      '<span style="font-size:12px;font-weight:500;color:var(--color-text-danger);background:var(--color-background-danger);padding:4px 12px;border-radius:var(--border-radius-md);">finalized</span>',
    );
    // Card div clips via overflow:hidden; its first child is the 3px danger strip.
    expect(html).toContain(
      '<div style="background:var(--color-background-secondary);border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);overflow:hidden;">\n' +
        '<div style="height:3px;background:var(--color-text-danger);"></div>',
    );
    // ok phase glyphs keep success-green — red there would read as failure.
    expect(html).toContain('color:var(--color-text-success);font-weight:500;">✓</span>');
  });
});

describe("banner spec version (brief-452 / D-256)", () => {
  it("BANNER_SPEC_VERSION is bumped to 4.2", () => {
    expect(BANNER_SPEC_VERSION).toBe("4.2");
  });

  it("parseTemplateBannerSpecVersion: a 3.x template declaration drifts from the 4.2 server spec", () => {
    // A template still declaring spec 3.x parses to "3.0" and mismatches the
    // server's current 4.2 — exactly the BANNER_DRIFT condition (expected and
    // transient until the companion framework brief-602 templates declare
    // 4.2). A 4.2 declaration matches and does not drift.
    expect(parseTemplateBannerSpecVersion("> **Banner-Spec-Version:** 3.0")).toBe("3.0");
    expect(parseTemplateBannerSpecVersion("> **Banner-Spec-Version:** 3.0")).not.toBe(
      BANNER_SPEC_VERSION,
    );
    expect(
      parseTemplateBannerSpecVersion(`> **Banner-Spec-Version:** ${BANNER_SPEC_VERSION}`),
    ).toBe("4.2");
  });
});
