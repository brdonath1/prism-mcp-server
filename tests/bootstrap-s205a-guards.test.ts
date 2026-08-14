/**
 * brief-s205a — bootstrap-cluster guards from the S203 framework audit.
 *
 *  R29 (F-C1-13) — slug resolution must not guess-then-write. Bootstrap WRITES
 *      (boot-test, and the TRIGGER_AUTO_ENROLL marker), so a substring match
 *      that binds an arbitrary repo is a write into a repo the operator never
 *      named. Ambiguity errors; short stems do not bind.
 *  R9  (F-A1-8/F-D17) — KERNEL_SPLIT_DRIFT had H2-only resolution: Rule 9's
 *      whole body could be deleted from inside `## Session Lifecycle` with
 *      every manifest section still present. Rule-level anchors close it.
 *  R17 (F-A2-9) — `visualize:show_widget` is the single render channel for both
 *      banners and had zero presence in the tool-surface contract.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile, fileExists, listRepos } from "../src/github/client.js";
import {
  registerBootstrap,
  findMissingKernelAnchors,
  KERNEL_RULE_ANCHORS,
} from "../src/tools/bootstrap.js";
import { getExpectedToolSurface, RENDER_SURFACE_TOOLS } from "../src/tool-registry.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);
const mockListRepos = vi.mocked(listRepos);

const HANDOFF = `# Handoff

## Meta
- Handoff Version: 12
- Session Count: 7
- Template Version: 3.1.6
- Status: Active

## Critical Context
1. One fact.

## Where We Are
Mid-flight.

## Next Steps
1. Continue.

<!-- EOF: handoff.md -->`;

const DECISIONS =
  "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->";

/**
 * A kernel shaped like the live one (prism-framework v3.1.6): blockquote
 * manifest + the three rule-level anchors, copied verbatim from
 * `_templates/core-template-mcp.md` § Session Lifecycle.
 */
const KERNEL_COMPLETE = `# PRISM Core Template v3.1.6
> **Template Version:** 3.1.6
> **Kernel-Manifest:** Operating Posture | Interaction Rules | Session Lifecycle | Module Triggers

## Operating Posture
Be direct.

## Interaction Rules
Answer first.

## Session Lifecycle
⛔ **Rule 9 — Context awareness + Mandatory Response Closer (HARD RULE — no exceptions; D-85).**
Every response MUST end with the literal context status line:

\`[S{session} · Ex {N} · {emoji} ~{percent}%]\`

\`Ex\` counts from 1; 🟢 <50% · 🟡 50–70% · 🟠 70–85% · 🔴 85%+.

### SESSION END + RECOVERY

⛔ **Finalize banner render (D-85 sibling):** render it VERBATIM before any prose.

## Module Triggers
Load on demand.

<!-- EOF: core-template-mcp.md -->`;

/** The F-D17 deletion: Rule 9's body vanishes, every manifest section survives. */
const KERNEL_RULE9_STRIPPED = KERNEL_COMPLETE.replace(
  /⛔ \*\*Rule 9[\s\S]*?### SESSION END/,
  "### SESSION END",
);

/** A kernel whose manifest never claims the band the anchors belong to. */
const KERNEL_NO_LIFECYCLE_BAND = `# PRISM Core Template v3.0.0
Template Version: 3.0.0
Kernel-Manifest: ## Operating Posture, ## Module Triggers

## Operating Posture
Be direct.

## Module Triggers
Load on demand.

<!-- EOF: core-template-mcp.md -->`;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

let bootstrapHandler: Handler;
const mockServer = {
  tool: vi.fn((name: string, _d: string, _s: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") bootstrapHandler = handler as Handler;
  }),
} as unknown as McpServer;

/** Every doc resolves; template content is the caller's choice. */
function setupMocks(template: string = KERNEL_COMPLETE): void {
  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "sha-h", size: HANDOFF.length };
    if (path.endsWith("_INDEX.md")) return { content: DECISIONS, sha: "sha-d", size: DECISIONS.length };
    if (path.includes("core-template-mcp.md")) return { content: template, sha: "sha-t", size: template.length };
    throw new Error(`Not found: ${path}`);
  });
  mockFetchFiles.mockResolvedValue([]);
  mockFileExists.mockResolvedValue(false);
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed", size: 10 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  registerBootstrap(mockServer);
  setupMocks();
});

async function boot(args: Record<string, unknown>): Promise<{ parsed: Record<string, any>; raw: ToolResult }> {
  const raw = await bootstrapHandler(args);
  return { parsed: JSON.parse(raw.content[0].text), raw };
}

// ─── R29: slug resolution must not guess-then-write ──────────────────────────

describe("brief-s205a R29 — slug resolution must not guess-then-write", () => {
  it("two repos both substring-match → error naming both, and NO write is attempted", async () => {
    mockListRepos.mockResolvedValue(["acme-platform-core-api", "acme-platform-core-web"]);

    const { parsed, raw } = await boot({ project_slug: "acme-platform-core" });

    expect(raw.isError).toBe(true);
    expect(parsed.error).toContain("acme-platform-core-api");
    expect(parsed.error).toContain("acme-platform-core-web");
    expect(parsed.candidates).toEqual(["acme-platform-core-api", "acme-platform-core-web"]);
    expect(parsed.writes_performed).toBe(false);
    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).toContain("SLUG_AMBIGUOUS");
    // The load-bearing assertion: the boot-test / enrollment write path never ran.
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("a normalized overlap under 6 chars does not bind a repo", async () => {
    mockListRepos.mockResolvedValue(["core-platform-alpha"]);

    const { parsed } = await boot({ project_slug: "core" });

    expect(parsed.project).toBe("core");
    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).not.toContain("SLUG_RESOLVED_DYNAMICALLY");
    // Whatever this boot wrote, it wrote to the named slug — never the guess.
    for (const call of mockPushFile.mock.calls) expect(call[0]).toBe("core");
  });

  it("an unambiguous long partial match still resolves (D-68 behavior preserved)", async () => {
    mockListRepos.mockResolvedValue(["metaswarm-autonomous-coding-stack", "unrelated-repo"]);

    const { parsed } = await boot({ project_slug: "Metaswarm Autonomous" });

    expect(parsed.project).toBe("metaswarm-autonomous-coding-stack");
    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).toContain("SLUG_RESOLVED_DYNAMICALLY");
  });
});

// ─── R9: rule-aware KERNEL_SPLIT_DRIFT ───────────────────────────────────────

describe("brief-s205a R9 — KERNEL_SPLIT_DRIFT is rule-aware", () => {
  const MANIFEST = ["Operating Posture", "Interaction Rules", "Session Lifecycle", "Module Triggers"];

  it("findMissingKernelAnchors: complete kernel → none missing", () => {
    expect(findMissingKernelAnchors(KERNEL_COMPLETE, MANIFEST)).toEqual([]);
  });

  it("findMissingKernelAnchors: Rule-9-stripped kernel → the Rule 9 anchors, not the finalize one", () => {
    const missing = findMissingKernelAnchors(KERNEL_RULE9_STRIPPED, MANIFEST);
    expect(missing).toEqual(["Rule 9 status-line shape", "Rule 9 tier table"]);
  });

  it("anchors are scoped to their declared band — a manifest without it stays silent", () => {
    expect(findMissingKernelAnchors(KERNEL_NO_LIFECYCLE_BAND, ["Operating Posture", "Module Triggers"])).toEqual([]);
  });

  it("every anchor names a band and at least one literal", () => {
    expect(KERNEL_RULE_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of KERNEL_RULE_ANCHORS) {
      expect(anchor.band.length).toBeGreaterThan(0);
      expect(anchor.literals.length).toBeGreaterThan(0);
    }
  });

  // The template cache is path-keyed with a 5-minute TTL, so each integration
  // boot runs through freshly-reset modules to control the delivered kernel.
  async function bootWithTemplate(template: string): Promise<Record<string, any>> {
    vi.resetModules();
    const { registerBootstrap: freshRegister } = await import("../src/tools/bootstrap.js");
    let handler: Handler | null = null;
    const freshServer = {
      tool: vi.fn((name: string, _d: string, _s: unknown, h: unknown) => {
        if (name === "prism_bootstrap") handler = h as Handler;
      }),
    } as unknown as McpServer;
    const github = await import("../src/github/client.js");
    vi.mocked(github.pushFile).mockResolvedValue({ success: true, sha: "p", size: 1 } as never);
    vi.mocked(github.fileExists).mockResolvedValue(false);
    vi.mocked(github.listRepos).mockResolvedValue([]);
    vi.mocked(github.fetchFile).mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith("handoff.md")) return { content: HANDOFF, sha: "sha-h", size: HANDOFF.length };
      if (path.endsWith("_INDEX.md")) return { content: DECISIONS, sha: "sha-d", size: DECISIONS.length };
      if (path.includes("core-template-mcp.md")) return { content: template, sha: "sha-t", size: template.length };
      throw new Error(`Not found: ${path}`);
    });
    freshRegister(freshServer);
    const result = await handler!({ project_slug: "prism" });
    return JSON.parse(result.content[0].text);
  }

  it("boot: a Rule-9-stripped kernel fires KERNEL_SPLIT_DRIFT naming the lost anchors", async () => {
    const parsed = await bootWithTemplate(KERNEL_RULE9_STRIPPED);
    const diag = (parsed.diagnostics as Array<{ code: string; level: string; message: string; context?: Record<string, unknown> }>)
      .find(d => d.code === "KERNEL_SPLIT_DRIFT");
    expect(diag).toBeDefined();
    expect(diag!.level).toBe("warn"); // warn-only: never a rejection
    expect(diag!.context!.missing_rule_anchors).toEqual([
      "Rule 9 status-line shape",
      "Rule 9 tier table",
    ]);
    expect(diag!.context!.missing_sections).toEqual([]); // every H2 still present — the F-D17 blind spot
    expect(diag!.message).toContain("rule anchor(s)");
    expect(parsed.error).toBeUndefined();
  });

  it("boot: the complete kernel does NOT fire KERNEL_SPLIT_DRIFT", async () => {
    const parsed = await bootWithTemplate(KERNEL_COMPLETE);
    const diag = (parsed.diagnostics as Array<{ code: string }>).find(d => d.code === "KERNEL_SPLIT_DRIFT");
    expect(diag).toBeUndefined();
  });
});

// ─── R17: render surface expectation ─────────────────────────────────────────

describe("brief-s205a R17 — visualize:show_widget is a declared render surface", () => {
  it("getExpectedToolSurface returns 5 categories, the fifth being render", () => {
    const surface = getExpectedToolSurface(true, true, true);
    expect(Object.keys(surface).sort()).toEqual(
      ["claude_code", "github", "prism_core", "railway", "render"],
    );
    expect(surface.render).toEqual(["visualize:show_widget"]);
    expect(surface.render).toEqual([...RENDER_SURFACE_TOOLS]);
  });

  it("render is not feature-flag gated — it is client-side, so no server flag can observe it", () => {
    expect(getExpectedToolSurface(false, false, false).render).toEqual(["visualize:show_widget"]);
  });

  it("the boot payload carries the render category alongside core/railway/cc/gh", async () => {
    mockListRepos.mockResolvedValue([]);
    const { parsed } = await boot({ project_slug: "prism" });
    expect(parsed.expected_tool_surface.render).toContain("visualize:show_widget");
    expect(parsed.expected_tool_surface.prism_core).toContain("prism_bootstrap");
  });

  it("a healthy boot emits no deadline diagnostic (R23 fires only on a real hang)", async () => {
    mockListRepos.mockResolvedValue([]);
    const { parsed } = await boot({ project_slug: "prism" });
    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).not.toContain("BOOTSTRAP_DEADLINE_EXCEEDED");
  });
});
