/**
 * Tests for R2-B (D-240 Phase B): prism_bootstrap resolves standing rules
 * from a UNION of `.prism/standing-rules.md` (the registry) and
 * `insights.md` (legacy location), dedup'd by INS-N with the registry
 * winning on conflict.
 *
 * Reuses the per-test re-import pattern from bootstrap-stale-pdu.test.ts so
 * each scenario can vary which rule-source files exist without leaking
 * mocks between tests.
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

interface CapturedHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const HANDOFF_CONTENT = `# Handoff

## Meta
- Handoff Version: 1
- Session Count: 99
- Template Version: 2.16.0
- Status: Active

## Critical Context
1. Item one

## Where We Are
Working.

## Resumption Point
Pick up.

## Next Steps
1. Do thing A

<!-- EOF: handoff.md -->`;

const DECISIONS_CONTENT =
  "| ID | Title | Domain | Status | Session |\n" +
  "|---|---|---|---|---|\n" +
  "| D-1 | Test | arch | SETTLED | 1 |\n\n" +
  "<!-- EOF: _INDEX.md -->";

const TEMPLATE_CONTENT =
  "# Template v2.16.0\nRules.\n<!-- EOF: core-template-mcp.md -->";

/** Tier A rule living in insights.md (pre-migration location). */
const INSIGHTS_WITH_RULE = `# Insights — prism

## Active

### INS-1: Insights-side rule — STANDING RULE [TIER:A]
- Category: operations — **STANDING RULE**
- Discovered: Session 10
- Description: Lives in insights.md.
- **Standing procedure:** Insights procedure.

## Formalized

<!-- EOF: insights.md -->
`;

/** Tier A rule living in the standing-rules.md registry (post-R2-B location). */
const REGISTRY_WITH_RULE = `# Standing Rules — prism

## Active

### INS-2: Registry-side rule — STANDING RULE [TIER:A]
- Category: operations — **STANDING RULE**
- Discovered: Session 20
- Description: Lives in standing-rules.md.
- **Standing procedure:** Registry procedure.

## Formalized

<!-- EOF: standing-rules.md -->
`;

/** Registry redefining INS-1 — must WIN over the insights.md version. */
const REGISTRY_CONFLICTING = `# Standing Rules — prism

## Active

### INS-1: Registry override — STANDING RULE [TIER:A]
- Category: operations — **STANDING RULE**
- Discovered: Session 20
- Description: Migrated copy of INS-1.
- **Standing procedure:** Registry procedure wins.

## Formalized

<!-- EOF: standing-rules.md -->
`;

function makeFetchFileMock(opts: {
  insights: string | null;
  standingRules: string | null;
}): (repo: string, path: string, ref?: string) => Promise<unknown> {
  return (repo: string, path: string) => {
    if (path.endsWith("standing-rules.md")) {
      if (opts.standingRules === null) {
        return Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`));
      }
      return Promise.resolve({
        content: opts.standingRules,
        sha: "sr-sha",
        size: opts.standingRules.length,
      });
    }
    if (path.endsWith("insights.md")) {
      if (opts.insights === null) {
        return Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`));
      }
      return Promise.resolve({
        content: opts.insights,
        sha: "ins-sha",
        size: opts.insights.length,
      });
    }
    if (path.endsWith("handoff.md")) {
      return Promise.resolve({
        content: HANDOFF_CONTENT,
        sha: "h1",
        size: HANDOFF_CONTENT.length,
      });
    }
    if (path.endsWith("decisions/_INDEX.md")) {
      return Promise.resolve({
        content: DECISIONS_CONTENT,
        sha: "d1",
        size: DECISIONS_CONTENT.length,
      });
    }
    if (path.includes("core-template-mcp.md")) {
      return Promise.resolve({
        content: TEMPLATE_CONTENT,
        sha: "t1",
        size: TEMPLATE_CONTENT.length,
      });
    }
    return Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`));
  };
}

async function setupBootstrap(opts: {
  insights: string | null;
  standingRules: string | null;
}): Promise<CapturedHandler> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  vi.mocked(ghClient.fetchFile).mockImplementation(
    makeFetchFileMock(opts) as never,
  );
  vi.mocked(ghClient.pushFile).mockResolvedValue({
    success: true,
    sha: "pushed",
    size: 100,
  });
  vi.mocked(ghClient.fetchFiles).mockResolvedValue({
    files: new Map(),
    failed: [],
    incomplete: false,
  });
  vi.mocked(ghClient.fileExists).mockResolvedValue(false);
  vi.mocked(ghClient.listRepos).mockResolvedValue([]);

  let captured: CapturedHandler | null = null;
  const mockServer = {
    tool: vi.fn(
      (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        if (name === "prism_bootstrap") {
          captured = handler as CapturedHandler;
        }
      },
    ),
  } as unknown as McpServer;

  const { registerBootstrap } = await import("../src/tools/bootstrap.js");
  registerBootstrap(mockServer);
  if (!captured) throw new Error("prism_bootstrap handler was not registered");
  return captured;
}

beforeEach(() => {
  process.env.TRIGGER_AUTO_ENROLL = "false";
});

describe("R2-B: bootstrap standing-rules union read", () => {
  it("(a) delivers rules from insights.md alone when standing-rules.md is absent", async () => {
    const handler = await setupBootstrap({
      insights: INSIGHTS_WITH_RULE,
      standingRules: null,
    });

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const rules = parsed.standing_rules as Array<{ id: string; title: string }>;
    expect(rules.map(r => r.id)).toEqual(["INS-1"]);
    expect(rules[0].title).toBe("Insights-side rule");
  });

  it("(b) delivers rules from standing-rules.md when insights.md has none", async () => {
    const handler = await setupBootstrap({
      insights: "# Insights — prism\n\n## Active\n\n## Formalized\n\n<!-- EOF: insights.md -->\n",
      standingRules: REGISTRY_WITH_RULE,
    });

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const rules = parsed.standing_rules as Array<{ id: string; title: string }>;
    expect(rules.map(r => r.id)).toEqual(["INS-2"]);
    expect(rules[0].title).toBe("Registry-side rule");
  });

  it("(c) delivers the union when both files have rules", async () => {
    const handler = await setupBootstrap({
      insights: INSIGHTS_WITH_RULE,
      standingRules: REGISTRY_WITH_RULE,
    });

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const rules = parsed.standing_rules as Array<{ id: string }>;
    expect(rules.map(r => r.id).sort()).toEqual(["INS-1", "INS-2"]);
  });

  it("(c) prefers the standing-rules.md version on INS-N conflict and surfaces the conflict", async () => {
    const handler = await setupBootstrap({
      insights: INSIGHTS_WITH_RULE,
      standingRules: REGISTRY_CONFLICTING,
    });

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const rules = parsed.standing_rules as Array<{
      id: string;
      title: string;
      procedure: string;
    }>;
    const ins1 = rules.filter(r => r.id === "INS-1");
    expect(ins1).toHaveLength(1); // dedup'd — never delivered twice
    expect(ins1[0].title).toBe("Registry override");
    // toContain (not toBe): the format-driven parser folds trailing
    // section-less lines (## Formalized / EOF sentinel) into the LAST rule's
    // procedure — pre-existing behavior, untouched by R2-B.
    expect(ins1[0].procedure).toContain("Registry procedure wins.");
    expect(ins1[0].procedure).not.toContain("Insights procedure."); // insights version lost

    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).toContain("STANDING_RULE_SOURCE_CONFLICT");
  });

  it("keeps a clean bootstrap unchanged when neither source exists", async () => {
    const handler = await setupBootstrap({ insights: null, standingRules: null });

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.standing_rules).toEqual([]);
    const codes = (parsed.diagnostics as Array<{ code: string }>).map(d => d.code);
    expect(codes).not.toContain("STANDING_RULE_SOURCE_CONFLICT");
  });
});
