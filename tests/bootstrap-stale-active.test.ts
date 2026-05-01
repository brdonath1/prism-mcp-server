// brief-416 / D-196 Piece 3 — boot-time stale-active surfacing in
// prism_bootstrap. The bootstrap fetches `brdonath1/trigger:state/<slug>.json`
// in parallel with the marker drop and boot-test push, and surfaces a
// warning + STALE_ACTIVE_DETECTED diagnostic when the active slot is stuck.
//
// The mock factory mirrors bootstrap-trigger-enrollment.test.ts: re-import
// per test via vi.resetModules() so per-test fetch implementations can vary
// the state-file response without mutating the others.

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
- Session Count: 1
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

/**
 * Build a fetchFile mock that returns:
 *   - the standard happy-path responses for handoff / decisions / template /
 *     trigger marker
 *   - the supplied stateBehavior for `trigger:state/<slug>.json` (allows
 *     each test to specify 404 / valid stale / valid healthy / null active /
 *     5xx independently)
 */
function makeFetchFileMock(
  stateBehavior: (repo: string, path: string, ref?: string) => Promise<unknown>,
): (repo: string, path: string, ref?: string) => Promise<unknown> {
  return (repo: string, path: string, ref?: string) => {
    if (repo === "trigger" && path.startsWith("state/") && path.endsWith(".json")) {
      return stateBehavior(repo, path, ref);
    }
    if (path === ".prism/trigger.yaml") {
      return Promise.resolve({
        content: "enabled: true\n",
        sha: "marker-sha",
        size: 20,
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

async function setupBootstrap(
  stateBehavior: (repo: string, path: string, ref?: string) => Promise<unknown>,
): Promise<{
  handler: CapturedHandler;
  fetchSpy: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  const mockFetchFile = vi.mocked(ghClient.fetchFile);
  const mockPushFile = vi.mocked(ghClient.pushFile);
  const mockFetchFiles = vi.mocked(ghClient.fetchFiles);
  const mockFileExists = vi.mocked(ghClient.fileExists);
  const mockListRepos = vi.mocked(ghClient.listRepos);

  mockFetchFile.mockImplementation(makeFetchFileMock(stateBehavior) as never);
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
  return { handler: captured, fetchSpy: mockFetchFile };
}

beforeEach(() => {
  // The marker is present in the standard mock above, so auto-enroll has
  // nothing to push. Force-disable anyway for belt-and-suspenders.
  process.env.TRIGGER_AUTO_ENROLL = "false";
});

describe("brief-416: bootstrap stale-active surfacing", () => {
  it("surfaces no warning when state file is 404 (project not enrolled / no state yet)", async () => {
    const { handler, fetchSpy } = await setupBootstrap((repo, path) =>
      Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`)),
    );

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    // The warnings array contains no stale-active line.
    expect(
      (parsed.warnings as string[]).some((w) => w.includes("Trigger active slot stuck")),
    ).toBe(false);
    // No STALE_ACTIVE_DETECTED diagnostic.
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "STALE_ACTIVE_DETECTED",
      ),
    ).toBe(false);

    // The state file fetch was attempted with the `state` ref.
    const stateFetch = fetchSpy.mock.calls.find(
      ([repoArg, pathArg]) => repoArg === "trigger" && pathArg === "state/prism.json",
    );
    expect(stateFetch).toBeDefined();
    expect(stateFetch?.[2]).toBe("state");
  });

  it("surfaces a warning + STALE_ACTIVE_DETECTED diagnostic when the active slot is stale", async () => {
    const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    const { handler } = await setupBootstrap(() =>
      Promise.resolve({
        content: JSON.stringify({
          active: {
            brief_id: "brief-416",
            timeline: {
              execution_started_at: startedAt,
              pr_created_at: null,
            },
          },
        }),
        sha: "state-sha",
        size: 200,
      }),
    );

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    const staleWarning = (parsed.warnings as string[]).find((w) =>
      w.includes("Trigger active slot stuck"),
    );
    expect(staleWarning).toBeDefined();
    expect(staleWarning).toContain("brief-416");
    expect(staleWarning).toContain("INS-236");
    // The minute count rounds down; 45 ± 1 captures clock-jitter near the
    // boundary without forcing the test to freeze the clock.
    expect(staleWarning).toMatch(/4[45]m elapsed/);

    const diag = (parsed.diagnostics as Array<{ code: string; level: string; context?: Record<string, unknown> }>).find(
      (d) => d.code === "STALE_ACTIVE_DETECTED",
    );
    expect(diag).toBeDefined();
    expect(diag?.level).toBe("info");
    expect(diag?.context?.brief_id).toBe("brief-416");
    expect(diag?.context?.threshold_minutes).toBe(30);
    expect(diag?.context?.recovery_procedure).toBe("INS-236");
    expect(typeof diag?.context?.elapsed_minutes).toBe("number");
    expect(diag?.context?.execution_started_at).toBe(startedAt);

    // Banner text includes the warning line (rendered through the existing ⚠ channel).
    expect(parsed.banner_text).toContain("Trigger active slot stuck");
  });

  it("surfaces no warning for a healthy in-flight dispatch (5 min ago, no PR)", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const { handler } = await setupBootstrap(() =>
      Promise.resolve({
        content: JSON.stringify({
          active: {
            brief_id: "brief-active",
            timeline: { execution_started_at: startedAt, pr_created_at: null },
          },
        }),
        sha: "state-sha",
        size: 200,
      }),
    );

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      (parsed.warnings as string[]).some((w) => w.includes("Trigger active slot stuck")),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "STALE_ACTIVE_DETECTED",
      ),
    ).toBe(false);
  });

  it("surfaces no warning when state.active is null (slot empty, nominal)", async () => {
    const { handler } = await setupBootstrap(() =>
      Promise.resolve({
        content: JSON.stringify({ active: null }),
        sha: "state-sha",
        size: 50,
      }),
    );

    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      (parsed.warnings as string[]).some((w) => w.includes("Trigger active slot stuck")),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "STALE_ACTIVE_DETECTED",
      ),
    ).toBe(false);
  });

  it("does not fail bootstrap when the state-file fetch throws a 5xx (defensive contract)", async () => {
    const { handler } = await setupBootstrap(() =>
      Promise.reject(new Error("GitHub API 502: Bad Gateway")),
    );

    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    // Bootstrap completed successfully — handoff data is present.
    expect(parsed.project).toBe("prism");
    expect(parsed.handoff_version).toBe(1);
    // No stale-active surfacing because the read failed; visibility hint
    // accepts the false negative per the brief.
    expect(
      (parsed.warnings as string[]).some((w) => w.includes("Trigger active slot stuck")),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "STALE_ACTIVE_DETECTED",
      ),
    ).toBe(false);
  });
});
