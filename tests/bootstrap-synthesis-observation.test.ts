/**
 * brief-419 / Phase 3c-A — boot-time synthesis observation surfacing in
 * prism_bootstrap. The bootstrap fetches Railway environment logs in parallel
 * with the marker drop / boot-test push / stale-active check, and surfaces
 * warnings + a SYNTHESIS_OBSERVATION_DETECTED diagnostic when matching events
 * appear within the lookback window.
 *
 * The mock factory mirrors bootstrap-stale-active.test.ts: re-import per test
 * via vi.resetModules() so per-test getEnvironmentLogs implementations and
 * env-var state can vary independently. Each test sets process.env before
 * resetting modules to ensure config.ts picks up the value.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("../src/railway/client.js", () => ({
  getEnvironmentLogs: vi.fn(),
}));

interface CapturedHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

interface MockLog {
  message: string;
  timestamp: string;
  severity: string;
  attributes?: Array<{ key: string; value: string }>;
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

const PROJECT_TAG = { key: "projectSlug", value: "prism" };

const originalRailwayToken = process.env.RAILWAY_API_TOKEN;
const originalEnvId = process.env.RAILWAY_ENVIRONMENT_ID;
const originalAutoEnroll = process.env.TRIGGER_AUTO_ENROLL;

function fetchFileImpl(repo: string, path: string, _ref?: string) {
  if (repo === "trigger" && path.startsWith("state/") && path.endsWith(".json")) {
    return Promise.reject(new Error(`Not found: fetchFile ${repo}/${path}`));
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
}

async function setupBootstrap(
  envLogsBehavior:
    | { kind: "throws"; error: Error }
    | { kind: "returns"; logs: MockLog[] },
): Promise<{
  handler: CapturedHandler;
  envLogsSpy: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  vi.mocked(ghClient.fetchFile).mockImplementation(fetchFileImpl as never);
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

  const railwayClient = await import("../src/railway/client.js");
  const envLogsMock = vi.mocked(railwayClient.getEnvironmentLogs);
  if (envLogsBehavior.kind === "throws") {
    envLogsMock.mockRejectedValue(envLogsBehavior.error);
  } else {
    envLogsMock.mockResolvedValue(envLogsBehavior.logs as never);
  }

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
  return { handler: captured, envLogsSpy: envLogsMock };
}

beforeEach(() => {
  // Marker is already present in the standard mock; force-disable to keep
  // tests deterministic regardless of marker-write outcome.
  process.env.TRIGGER_AUTO_ENROLL = "false";
  // Default: Railway is configured. Individual tests override.
  process.env.RAILWAY_API_TOKEN = "test-railway-token";
  process.env.RAILWAY_ENVIRONMENT_ID = "env-uuid-test";
});

afterEach(() => {
  if (originalRailwayToken === undefined) delete process.env.RAILWAY_API_TOKEN;
  else process.env.RAILWAY_API_TOKEN = originalRailwayToken;
  if (originalEnvId === undefined) delete process.env.RAILWAY_ENVIRONMENT_ID;
  else process.env.RAILWAY_ENVIRONMENT_ID = originalEnvId;
  if (originalAutoEnroll === undefined) delete process.env.TRIGGER_AUTO_ENROLL;
  else process.env.TRIGGER_AUTO_ENROLL = originalAutoEnroll;
});

describe("brief-419: bootstrap synthesis observation surfacing", () => {
  it("surfaces no warning when RAILWAY_API_TOKEN is unset (Railway disabled)", async () => {
    delete process.env.RAILWAY_API_TOKEN;
    const { handler, envLogsSpy } = await setupBootstrap({
      kind: "returns",
      logs: [],
    });
    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    expect(
      (parsed.warnings as string[]).some((w) =>
        w.includes("Synthesis transport fallback"),
      ),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED",
      ),
    ).toBe(false);
    // The Railway log fetch was never attempted because the token gate fired.
    expect(envLogsSpy).not.toHaveBeenCalled();
  });

  it("surfaces no warning when getEnvironmentLogs throws (defensive contract)", async () => {
    const { handler } = await setupBootstrap({
      kind: "throws",
      error: new Error("Railway API 502: Bad Gateway"),
    });
    const result = await handler({ project_slug: "prism" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.project).toBe("prism");
    expect(parsed.handoff_version).toBe(1);
    expect(
      (parsed.warnings as string[]).some((w) =>
        w.includes("Synthesis transport fallback"),
      ),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED",
      ),
    ).toBe(false);
  });

  it("surfaces no warning when no logs match an observation kind", async () => {
    const { handler } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message: "Some unrelated warn",
          timestamp: new Date().toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      (parsed.warnings as string[]).some((w) =>
        w.includes("Synthesis transport fallback"),
      ),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED",
      ),
    ).toBe(false);
  });

  it("surfaces a warning + SYNTHESIS_OBSERVATION_DETECTED diagnostic on a single fallback event", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const { handler } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message:
            "SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed, retrying via messages_api",
          timestamp: ts,
          severity: "warn",
          attributes: [PROJECT_TAG, { key: "callSite", value: "pdu" }],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    const fallbackWarning = (parsed.warnings as string[]).find((w) =>
      w.includes("Synthesis transport fallback"),
    );
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning).toContain("INS-242");
    expect(fallbackWarning).not.toMatch(/× \d+/); // single event has no count suffix

    const diag = (
      parsed.diagnostics as Array<{
        code: string;
        level: string;
        context?: Record<string, unknown>;
      }>
    ).find((d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED");
    expect(diag).toBeDefined();
    expect(diag?.level).toBe("info");
    expect(diag?.context?.fallback_count).toBe(1);
    expect(diag?.context?.byte_warning_count).toBe(0);
    expect(diag?.context?.preamble_warning_count).toBe(0);

    // Banner text includes the warning line through the existing ⚠ channel.
    expect(parsed.banner_text).toContain("Synthesis transport fallback");
  });

  it("does NOT surface a fallback event tagged for a different project", async () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const { handler } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK",
          timestamp: ts,
          severity: "warn",
          attributes: [{ key: "projectSlug", value: "platformforge-v2" }],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      (parsed.warnings as string[]).some((w) =>
        w.includes("Synthesis transport fallback"),
      ),
    ).toBe(false);
    expect(
      (parsed.diagnostics as Array<{ code: string }>).some(
        (d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED",
      ),
    ).toBe(false);
  });

  it("surfaces three warning lines when one of each kind is detected", async () => {
    const baseTs = Date.now() - 60_000;
    const { handler } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK",
          timestamp: new Date(baseTs).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
        {
          message: "CS3_QUALITY_BYTE_COUNT_WARNING",
          timestamp: new Date(baseTs + 1_000).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
        {
          message: "CS3_QUALITY_PREAMBLE_WARNING",
          timestamp: new Date(baseTs + 2_000).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    const warnings = parsed.warnings as string[];
    expect(warnings.some((w) => w.includes("Synthesis transport fallback"))).toBe(true);
    expect(warnings.some((w) => w.includes("CS-3 output byte-count outside baseline"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes("CS-3 preamble-leak warning"))).toBe(true);

    const diag = (
      parsed.diagnostics as Array<{ code: string; context?: Record<string, unknown> }>
    ).find((d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED");
    expect(diag?.context?.fallback_count).toBe(1);
    expect(diag?.context?.byte_warning_count).toBe(1);
    expect(diag?.context?.preamble_warning_count).toBe(1);
  });

  it("appends a (× N) count suffix when multiple events of the same kind appear", async () => {
    const baseTs = Date.now() - 60_000;
    const { handler } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK first",
          timestamp: new Date(baseTs).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK second",
          timestamp: new Date(baseTs + 1_000).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK third",
          timestamp: new Date(baseTs + 2_000).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);

    const fallbackWarning = (parsed.warnings as string[]).find((w) =>
      w.includes("Synthesis transport fallback"),
    );
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning).toContain("(× 3)");

    const diag = (
      parsed.diagnostics as Array<{ code: string; context?: Record<string, unknown> }>
    ).find((d) => d.code === "SYNTHESIS_OBSERVATION_DETECTED");
    expect(diag?.context?.fallback_count).toBe(3);
  });

  it("surfaces no warning when RAILWAY_ENVIRONMENT_ID is unset", async () => {
    delete process.env.RAILWAY_ENVIRONMENT_ID;
    const { handler, envLogsSpy } = await setupBootstrap({
      kind: "returns",
      logs: [
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK",
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          severity: "warn",
          attributes: [PROJECT_TAG],
        },
      ],
    });
    const result = await handler({ project_slug: "prism" });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      (parsed.warnings as string[]).some((w) =>
        w.includes("Synthesis transport fallback"),
      ),
    ).toBe(false);
    expect(envLogsSpy).not.toHaveBeenCalled();
  });
});
