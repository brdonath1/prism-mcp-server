/**
 * SRV-66 (brief-461 Task C) — railway_env action=get must mask sensitive
 * values, not echo them verbatim.
 *
 * `list` already masks sensitive-keyed / url-credential values; `get`
 * previously returned `value: variables[name]` raw, bypassing the masking
 * infra. A caller who genuinely needs the plaintext passes reveal:true.
 *
 * The real masking helpers (isSensitiveKey / maskValue / hasUrlCredentials)
 * are kept; only the Railway network layer (RailwayResolver / listVariables)
 * is mocked.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || "test-railway-token";

import { describe, it, expect, vi, beforeEach } from "vitest";

const VARIABLES: Record<string, string> = {
  GITHUB_PAT: "ghp_secretvalue123",
  DATABASE_URL: "postgres://user:passw0rd@db.internal:5432/app",
  NODE_ENV: "production",
};

vi.mock("../src/railway/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/railway/client.js")>();
  return {
    ...actual, // keep the REAL isSensitiveKey / maskValue / hasUrlCredentials / maskVariables
    RailwayResolver: class {
      async resolveProject() {
        return { id: "proj-id", name: "prism-mcp-server", services: [], environments: [] };
      }
      resolveService() {
        return { id: "svc-id", name: "web" };
      }
      resolveEnvironment() {
        return { id: "env-id", name: "production" };
      }
    },
    listVariables: vi.fn(async () => ({ ...VARIABLES })),
  };
});

import { registerRailwayEnv } from "../src/tools/railway-env.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Capture the registered railway_env handler via a minimal fake McpServer. */
function captureHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  };
  registerRailwayEnv(fakeServer as never);
  if (!handler) throw new Error("railway_env handler was not registered");
  return handler;
}

async function getValue(
  handler: ToolHandler,
  name: string,
  reveal?: boolean,
): Promise<{ value: string; masked?: boolean }> {
  const res = await handler({
    project: "prism-mcp-server",
    service: "web",
    environment: "production",
    action: "get",
    name,
    reveal,
  });
  return JSON.parse(res.content[0].text);
}

describe("SRV-66 — railway_env get masks sensitive values", () => {
  let handler: ToolHandler;
  beforeEach(() => {
    handler = captureHandler();
  });

  it("masks a sensitive-keyed value (GITHUB_PAT) by default", async () => {
    const body = await getValue(handler, "GITHUB_PAT");
    expect(body.value).not.toBe(VARIABLES.GITHUB_PAT);
    expect(body.value).toBe("ghp_se***"); // maskValue keeps first 6 chars
  });

  it("masks a value with embedded URL credentials (DATABASE_URL) by default", async () => {
    const body = await getValue(handler, "DATABASE_URL");
    expect(body.value).not.toBe(VARIABLES.DATABASE_URL);
    expect(body.value).not.toContain("passw0rd");
  });

  it("returns the unmasked value when reveal:true is passed", async () => {
    const body = await getValue(handler, "GITHUB_PAT", true);
    expect(body.value).toBe(VARIABLES.GITHUB_PAT);
  });

  it("returns a non-sensitive value (NODE_ENV) unmasked", async () => {
    const body = await getValue(handler, "NODE_ENV");
    expect(body.value).toBe("production");
  });
});
