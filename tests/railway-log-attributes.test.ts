/**
 * S40 C2 — Railway log structured attributes plumbing.
 *
 * Verifies FINDING-1 and FINDING-3 fixes:
 *  - GraphQL selection in src/railway/client.ts includes `attributes { key value }`
 *    for both `getDeploymentLogs` and `getEnvironmentLogs`.
 *  - `RailwayLog` carries an optional `attributes` field.
 *  - The `railway_logs` tool response preserves `attributes` on each log.
 *  - Logs without attributes (e.g. legacy or mocked entries) still serialize
 *    cleanly — no `"attributes": undefined` leakage.
 */

// tests/setup.ts seeds GITHUB_PAT/GITHUB_OWNER before imports. The Railway
// integration test below mocks the client layer directly so we don't need a
// live RAILWAY_API_TOKEN — that decouples the test from config.ts's
// load-time token capture.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import type { RailwayLog, RailwayLogAttribute } from "../src/railway/types.js";

// Mock the railway client at the module boundary. The tool calls into these
// exports; returning canned data exercises the tool's plumbing without
// touching fetch or config.
vi.mock("../src/railway/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/railway/client.js")>(
    "../src/railway/client.js",
  );
  return {
    ...actual,
    RailwayResolver: class MockResolver {
      async resolveProject(name: string) {
        return {
          id: "proj-1",
          name,
          services: [{ id: "svc-1", name: "web" }],
          environments: [{ id: "env-1", name: "production" }],
        };
      }
      resolveService(_project: unknown, name: string) {
        return { id: "svc-1", name };
      }
      resolveEnvironment(_project: unknown, name: string) {
        return { id: "env-1", name };
      }
    },
    getDeploymentLogs: vi.fn(),
    getEnvironmentLogs: vi.fn(),
    getLatestDeployment: vi.fn(),
  };
});

import { registerRailwayLogs } from "../src/tools/railway-logs.js";
import { getEnvironmentLogs, getDeploymentLogs, getLatestDeployment } from "../src/railway/client.js";

const mockEnvLogs = vi.mocked(getEnvironmentLogs);
const mockDepLogs = vi.mocked(getDeploymentLogs);
const mockLatestDep = vi.mocked(getLatestDeployment);

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function createMockServer(): { tools: CapturedTool[]; tool: (...args: unknown[]) => void } {
  const tools: CapturedTool[] = [];
  return {
    tools,
    tool(...args: unknown[]) {
      const [name, description, inputSchema, handler] = args as [
        string,
        string,
        Record<string, unknown>,
        CapturedTool["handler"],
      ];
      tools.push({ name, description, inputSchema, handler });
    },
  };
}

describe("S40 C2 — RailwayLog type carries optional attributes", () => {
  it("accepts attributes at the type level", () => {
    const log: RailwayLog = {
      message: "boom",
      timestamp: "2026-04-17T00:00:00Z",
      severity: "error",
      attributes: [
        { key: "err", value: "TypeError: foo" },
        { key: "stack", value: "at bar (x.js:1)" },
      ],
    };
    expect(log.attributes).toHaveLength(2);
    expect((log.attributes as RailwayLogAttribute[])[0].key).toBe("err");
  });

  it("permits logs without attributes (backward compatible)", () => {
    const log: RailwayLog = {
      message: "hi",
      timestamp: "2026-04-17T00:00:00Z",
      severity: "info",
    };
    expect(log.attributes).toBeUndefined();
  });

  it("types.ts declares RailwayLogAttribute and adds attributes to RailwayLog", () => {
    const source = readFileSync("src/railway/types.ts", "utf-8");
    expect(source).toContain("export interface RailwayLogAttribute");
    expect(source).toContain("key: string");
    expect(source).toContain("value: string");
    expect(source).toMatch(/attributes\?\s*:\s*RailwayLogAttribute\[\]/);
  });
});

describe("S40 C2 — client.ts GraphQL selections request attributes", () => {
  const source = readFileSync("src/railway/client.ts", "utf-8");

  function extract(fnName: string): string {
    const start = source.indexOf(`export async function ${fnName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport ", start + 1);
    return source.slice(start, nextExport !== -1 ? nextExport : source.length);
  }

  it("getDeploymentLogs selects attributes { key value }", () => {
    const fn = extract("getDeploymentLogs");
    expect(fn).toContain("... on Log");
    expect(fn).toContain("attributes { key value }");
  });

  it("getEnvironmentLogs selects attributes { key value }", () => {
    const fn = extract("getEnvironmentLogs");
    expect(fn).toContain("... on Log");
    expect(fn).toContain("attributes { key value }");
  });
});

describe("S40 C2 — railway_logs tool threads attributes through the response", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns attributes in the logs array for environment-wide queries", async () => {
    const sampleLogs: RailwayLog[] = [
      {
        message: "handled request",
        timestamp: "2026-04-17T10:00:00Z",
        severity: "info",
        attributes: [
          { key: "path", value: "/mcp" },
          { key: "ms", value: "12" },
        ],
      },
      {
        message: "boom",
        timestamp: "2026-04-17T10:00:01Z",
        severity: "error",
        attributes: [
          { key: "err", value: "TypeError: foo" },
          { key: "stack", value: "at bar (x.js:1)" },
        ],
      },
    ];
    mockEnvLogs.mockResolvedValue(sampleLogs);

    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayLogs(server as any);
    const tool = server.tools[0];

    const result = await tool.handler({
      project: "demo",
      environment: "production",
      limit: 10,
      type: "deploy",
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.log_count).toBe(2);
    expect(payload.logs).toHaveLength(2);
    expect(payload.logs[0].attributes).toEqual([
      { key: "path", value: "/mcp" },
      { key: "ms", value: "12" },
    ]);
    expect(payload.logs[1].attributes).toEqual([
      { key: "err", value: "TypeError: foo" },
      { key: "stack", value: "at bar (x.js:1)" },
    ]);
  });

  it("returns attributes for deployment-scoped queries (service provided)", async () => {
    mockLatestDep.mockResolvedValue({
      id: "dep-1",
      status: "SUCCESS",
      createdAt: "2026-04-17T09:00:00Z",
    });
    mockDepLogs.mockResolvedValue([
      {
        message: "boot",
        timestamp: "t",
        severity: "info",
        attributes: [{ key: "version", value: "4.0.0" }],
      },
    ]);

    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayLogs(server as any);
    const tool = server.tools[0];
    const result = await tool.handler({
      project: "demo",
      service: "web",
      environment: "production",
      limit: 10,
      type: "deploy",
    });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.logs[0].attributes).toEqual([{ key: "version", value: "4.0.0" }]);
  });

  it("logs without attributes serialize cleanly (no 'undefined' keys)", () => {
    const log: RailwayLog = {
      message: "legacy entry",
      timestamp: "t",
      severity: "info",
    };
    const json = JSON.stringify([log]);
    expect(json).not.toContain("attributes");
    expect(json).not.toContain("undefined");
  });
});
