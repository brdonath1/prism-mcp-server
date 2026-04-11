// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { registerRailwayLogs } from "../src/tools/railway-logs.js";
import { registerRailwayDeploy } from "../src/tools/railway-deploy.js";
import { registerRailwayEnv } from "../src/tools/railway-env.js";
import { registerRailwayStatus } from "../src/tools/railway-status.js";

interface CapturedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Minimal McpServer stand-in that captures tool registrations for inspection. */
function createMockServer(): { tools: CapturedTool[]; tool: (...args: unknown[]) => void } {
  const tools: CapturedTool[] = [];
  return {
    tools,
    // Mirror `server.tool(name, description, schema, handler)` signature used by registrations.
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

describe("Railway tool registration", () => {
  it("railway_logs registers with the expected schema", () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayLogs(server as any);
    expect(server.tools).toHaveLength(1);
    const tool = server.tools[0];
    expect(tool.name).toBe("railway_logs");
    expect(tool.description).toMatch(/logs/i);
    expect(Object.keys(tool.inputSchema)).toEqual(
      expect.arrayContaining(["project", "service", "environment", "limit", "filter", "type"]),
    );
    expect(typeof tool.handler).toBe("function");
  });

  it("railway_deploy registers with the expected schema", () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayDeploy(server as any);
    expect(server.tools).toHaveLength(1);
    const tool = server.tools[0];
    expect(tool.name).toBe("railway_deploy");
    expect(Object.keys(tool.inputSchema)).toEqual(
      expect.arrayContaining(["project", "service", "environment", "action", "count"]),
    );
  });

  it("railway_env registers with the expected schema", () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayEnv(server as any);
    expect(server.tools).toHaveLength(1);
    const tool = server.tools[0];
    expect(tool.name).toBe("railway_env");
    expect(Object.keys(tool.inputSchema)).toEqual(
      expect.arrayContaining([
        "project",
        "service",
        "environment",
        "action",
        "name",
        "value",
        "mask_values",
      ]),
    );
  });

  it("railway_status registers with the expected schema", () => {
    const server = createMockServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerRailwayStatus(server as any);
    expect(server.tools).toHaveLength(1);
    const tool = server.tools[0];
    expect(tool.name).toBe("railway_status");
    expect(Object.keys(tool.inputSchema)).toEqual(
      expect.arrayContaining(["project", "include_services"]),
    );
  });
});

describe("Railway tools — handler resilience", () => {
  // Each handler should return a JSON error payload (not throw) when the
  // Railway API is unreachable. We simulate by stubbing fetch to reject.
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RAILWAY_API_TOKEN;

  beforeEach(() => {
    process.env.RAILWAY_API_TOKEN = "test-railway-token";
    // Replace global fetch with a rejecting stub. This only affects the
    // test-scope so it's safe.
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.RAILWAY_API_TOKEN;
    } else {
      process.env.RAILWAY_API_TOKEN = originalToken;
    }
  });

  async function invoke(
    register: (server: unknown) => void,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
    const server = createMockServer();
    register(server);
    const tool = server.tools[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tool.handler(args) as any;
  }

  it("railway_logs returns an error payload on network failure", async () => {
    const result = await invoke(registerRailwayLogs as (s: unknown) => void, {
      project: "nonexistent",
      environment: "production",
      limit: 10,
      type: "deploy",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
    expect(payload.project).toBe("nonexistent");
  });

  it("railway_deploy returns an error payload on network failure", async () => {
    const result = await invoke(registerRailwayDeploy as (s: unknown) => void, {
      project: "nonexistent",
      service: "svc",
      environment: "production",
      action: "status",
      count: 5,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
  });

  it("railway_env returns an error payload on network failure", async () => {
    const result = await invoke(registerRailwayEnv as (s: unknown) => void, {
      project: "nonexistent",
      service: "svc",
      environment: "production",
      action: "list",
      mask_values: true,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
  });

  it("railway_status returns an error payload on network failure", async () => {
    const result = await invoke(registerRailwayStatus as (s: unknown) => void, {
      project: "nonexistent",
      include_services: true,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toBeDefined();
  });
});

describe("Railway tools — source-level contract", () => {
  const files = [
    "src/tools/railway-logs.ts",
    "src/tools/railway-deploy.ts",
    "src/tools/railway-env.ts",
    "src/tools/railway-status.ts",
  ];

  it("all four tool files exist and export register functions", () => {
    for (const path of files) {
      const source = readFileSync(path, "utf-8");
      expect(source).toMatch(/export function registerRailway\w+\(server: McpServer\): void/);
    }
  });

  it("every tool registration uses the RailwayResolver for name→ID resolution", () => {
    for (const path of files) {
      const source = readFileSync(path, "utf-8");
      // railway-status optionally skips the resolver for the all-projects path,
      // but still imports it for the single-project path.
      expect(source).toContain("RailwayResolver");
    }
  });

  it("every tool returns errors via isError: true instead of throwing", () => {
    for (const path of files) {
      const source = readFileSync(path, "utf-8");
      expect(source).toContain("isError: true");
      expect(source).toContain("catch (error)");
    }
  });

  it("env tool imports the masking helpers from the client", () => {
    const source = readFileSync("src/tools/railway-env.ts", "utf-8");
    expect(source).toContain("maskValue");
    expect(source).toContain("maskVariables");
    expect(source).toContain("isSensitiveKey");
    expect(source).toContain("hasUrlCredentials");
  });

  it("index.ts conditionally registers Railway tools behind RAILWAY_ENABLED", () => {
    const source = readFileSync("src/index.ts", "utf-8");
    expect(source).toContain("RAILWAY_ENABLED");
    expect(source).toContain("registerRailwayLogs");
    expect(source).toContain("registerRailwayDeploy");
    expect(source).toContain("registerRailwayEnv");
    expect(source).toContain("registerRailwayStatus");
    expect(source).toMatch(/if \(RAILWAY_ENABLED\)/);
  });

  it("config.ts exposes Railway configuration", () => {
    const source = readFileSync("src/config.ts", "utf-8");
    expect(source).toContain("RAILWAY_API_TOKEN");
    expect(source).toContain("RAILWAY_API_ENDPOINT");
    expect(source).toContain("RAILWAY_ENABLED");
    expect(source).toContain("https://backboard.railway.app/graphql/v2");
  });

  it("SERVER_VERSION reflects the current release (>= 3.0.0)", () => {
    const source = readFileSync("src/config.ts", "utf-8");
    // Brief-104 bumped this to 4.0.0; keep the assertion tolerant of future
    // minor/patch bumps so it doesn't have to be touched every release.
    expect(source).toMatch(/SERVER_VERSION\s*=\s*"[4-9]\.\d+\.\d+"/);
  });
});
