/**
 * Tests for brief-422 Piece 2: bootstrap-side stale-PDU safety net.
 *
 * Reuses the per-test re-import pattern from bootstrap-stale-active.test.ts
 * so each scenario can vary the PDU file content without leaking mocks
 * between tests.
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

const STRUCTURED_PDU = `# Pending Doc Updates — prism

> Auto-generated proposals.
> Last synthesized: S97 (04-26-26 12:00:00)

## architecture.md

### Proposed: Add safeMutation primitive section

**Apply via \`prism_patch append\` on \`## Mutation Primitives\`:**
\`\`\`
The safeMutation primitive wraps atomic Git Trees commits.
\`\`\`

## glossary.md

## insights.md

## No Updates Needed

<!-- EOF: pending-doc-updates.md -->
`;

const CURRENT_PDU = STRUCTURED_PDU.replace(
  "Last synthesized: S97",
  "Last synthesized: S100",
);

const EMPTY_PDU = `# Pending Doc Updates — prism

> Last synthesized: S97 (04-26-26 12:00:00)

## No Updates Needed

<!-- EOF: pending-doc-updates.md -->
`;

const ARCH_CONTENT = `# Architecture — prism

> Updated: S97 (2026-04-26)

## Mutation Primitives

Existing.

<!-- EOF: architecture.md -->
`;

function makeFetchFileMock(pduContent: string | null): (
  repo: string,
  path: string,
  ref?: string,
) => Promise<unknown> {
  return (repo: string, path: string) => {
    if (path.endsWith("pending-doc-updates.md")) {
      if (pduContent === null) {
        return Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`));
      }
      return Promise.resolve({
        content: pduContent,
        sha: "pdu-sha",
        size: pduContent.length,
      });
    }
    if (path.endsWith("architecture.md")) {
      return Promise.resolve({
        content: ARCH_CONTENT,
        sha: "arch-sha",
        size: ARCH_CONTENT.length,
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

async function setupBootstrap(pduContent: string | null): Promise<{
  handler: CapturedHandler;
  pushSpy: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  const mockFetchFile = vi.mocked(ghClient.fetchFile);
  const mockPushFile = vi.mocked(ghClient.pushFile);
  const mockFetchFiles = vi.mocked(ghClient.fetchFiles);
  const mockFileExists = vi.mocked(ghClient.fileExists);
  const mockListRepos = vi.mocked(ghClient.listRepos);

  mockFetchFile.mockImplementation(makeFetchFileMock(pduContent) as never);
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed", size: 100 });
  mockFetchFiles.mockResolvedValue({
    files: new Map(),
    failed: [],
    incomplete: false,
  });
  mockFileExists.mockResolvedValue(false);
  mockListRepos.mockResolvedValue([]);

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
  return { handler: captured, pushSpy: mockPushFile };
}

beforeEach(() => {
  process.env.TRIGGER_AUTO_ENROLL = "false";
});

describe("brief-422: bootstrap stale-PDU safety net", () => {
  it("auto-applies a stale PDU (synthesized 3 sessions ago) and surfaces a warning", async () => {
    const { handler, pushSpy } = await setupBootstrap(STRUCTURED_PDU);

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    // The stale-PDU warning must appear (3 sessions = 100 - 97).
    const staleWarning = (parsed.warnings as string[]).find(w =>
      w.includes("PDU stale"),
    );
    expect(staleWarning).toBeDefined();
    expect(staleWarning).toContain("3 sessions old");
    expect(staleWarning).toContain("auto-applied at boot");

    // Diagnostic is surfaced at info level.
    const diag = (parsed.diagnostics as Array<{ code: string; level: string; context?: Record<string, unknown> }>)
      .find(d => d.code === "PDU_AUTO_APPLIED_AT_BOOT");
    expect(diag).toBeDefined();
    expect(diag?.context?.synth_session).toBe(97);
    expect(diag?.context?.age_sessions).toBe(3);

    // pdu_applied_at_boot field is populated in the response.
    expect(parsed.pdu_applied_at_boot).toBeDefined();
    expect((parsed.pdu_applied_at_boot.applied as string[]).length).toBeGreaterThan(0);

    // Architecture.md was pushed (the apply landed).
    const archPush = pushSpy.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush).toBeDefined();
  });

  it("does NOT auto-apply when PDU is current (synthesized this session)", async () => {
    const { handler, pushSpy } = await setupBootstrap(CURRENT_PDU);

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    expect((parsed.warnings as string[]).some(w => w.includes("PDU stale"))).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(d => d.code === "PDU_AUTO_APPLIED_AT_BOOT"),
    ).toBe(false);
    expect(parsed.pdu_applied_at_boot).toBeNull();
    // No architecture.md push occurred.
    const archPush = pushSpy.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush).toBeUndefined();
  });

  it("does NOT auto-apply when the PDU file is the cleared/empty template", async () => {
    const { handler, pushSpy } = await setupBootstrap(EMPTY_PDU);

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    expect((parsed.warnings as string[]).some(w => w.includes("PDU stale"))).toBe(false);
    expect(parsed.pdu_applied_at_boot).toBeNull();
    const archPush = pushSpy.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush).toBeUndefined();
  });

  it("does NOT auto-apply when the PDU file is missing entirely", async () => {
    const { handler, pushSpy } = await setupBootstrap(null);

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    expect((parsed.warnings as string[]).some(w => w.includes("PDU stale"))).toBe(false);
    expect(parsed.pdu_applied_at_boot).toBeNull();
    const archPush = pushSpy.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush).toBeUndefined();
  });

  it("does NOT auto-apply when PDU is exactly 1 session behind (boundary case — not stale)", async () => {
    // S99 PDU vs current S100 = M = N+1, NOT stale per the brief contract.
    const oneSessionOld = STRUCTURED_PDU.replace(
      "Last synthesized: S97",
      "Last synthesized: S99",
    );
    const { handler, pushSpy } = await setupBootstrap(oneSessionOld);

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    expect((parsed.warnings as string[]).some(w => w.includes("PDU stale"))).toBe(false);
    expect(parsed.pdu_applied_at_boot).toBeNull();
    const archPush = pushSpy.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush).toBeUndefined();
  });
});
