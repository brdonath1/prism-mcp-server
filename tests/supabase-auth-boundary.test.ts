import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

// Never import real configuration: these boundary tests must not load a local
// .env, resolve production credentials, or invoke any provider or subprocess.
const config = vi.hoisted(() => ({ token: "boundary-test-token", ipAllowlist: true }));
vi.mock("../src/config.js", () => ({
  get MCP_AUTH_TOKEN() {
    return config.token;
  },
  get ENABLE_IP_ALLOWLIST() {
    return config.ipAllowlist;
  },
  ANTHROPIC_CIDRS: ["160.79.104.0/21"],
  ALLOWED_CIDRS: [],
  resolveAuthRequireBearer: () => false,
  CC_DISPATCH_EFFORT: "max",
  CC_DISPATCH_MODEL: "unused-test-model",
  CLAUDE_CODE_OAUTH_TOKEN: "unused-test-oauth",
  RAILWAY_API_ENDPOINT: "https://invalid.example.test/graphql",
  RAILWAY_API_TOKEN: "unused-test-railway",
  RAILWAY_WORKSPACE_ID: "unused-test-workspace",
  MCP_SAFE_TIMEOUT: 50_000,
  SERVER_VERSION: "test",
}));
vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    throw new Error("Provider execution is forbidden in auth boundary tests");
  }),
}));
vi.mock("../src/llm/llm-call-telemetry.js", () => ({ emitLlmCall: vi.fn() }));
vi.mock("../src/llm/route-observer.js", () => ({ observeRoute: vi.fn() }));

import { authMiddleware, isBearerAuthenticated } from "../src/middleware/auth.js";
import { buildDispatchEnv } from "../src/claude-code/client.js";

function request(authorization?: string): Request {
  return {
    path: "/mcp",
    headers: {
      "x-forwarded-for": "160.79.104.42",
      ...(authorization === undefined ? {} : { authorization }),
    },
    ip: "203.0.113.7",
    socket: { remoteAddress: "203.0.113.7" },
  } as Request;
}

function middlewareResult(req: Request): { accepted: boolean; status?: number } {
  const next = vi.fn();
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  authMiddleware(req, res as unknown as Response, next);
  return { accepted: next.mock.calls.length === 1, status: res.status.mock.calls[0]?.[0] };
}

function legacyMiddlewareAccepts(req: Request): boolean {
  return middlewareResult(req).accepted;
}

beforeEach(() => {
  config.token = "boundary-test-token";
  config.ipAllowlist = true;
  vi.stubEnv("SUPABASE_ACCESS_TOKEN", undefined);
  vi.stubEnv("SUPABASE_PROJECT_CREDENTIALS_JSON", undefined);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Supabase requires trusted Bearer proof", () => {
  it("accepts the exact configured Bearer token", () => {
    expect(isBearerAuthenticated(request("Bearer boundary-test-token"))).toBe(true);
  });

  it.each([
    undefined,
    "",
    "Basic boundary-test-token",
    "bearer boundary-test-token",
    "Bearer ",
    "Bearer wrong-token",
    "Bearer boundary-test-token ",
    "Bearer  boundary-test-token",
  ])("rejects missing, malformed, or wrong Authorization: %s", (header) => {
    expect(isBearerAuthenticated(request(header))).toBe(false);
  });

  it.each([
    undefined,
    "Bearer ",
    "Bearer boundary-test-token",
  ])("never authenticates without a configured server token: %s", (header) => {
    config.token = "";
    expect(isBearerAuthenticated(request(header))).toBe(false);
  });

  it("compares byte lengths safely when equal character lengths have different UTF-8 lengths", () => {
    config.token = "aa";
    const check = () => isBearerAuthenticated(request("Bearer éé"));
    expect(check).not.toThrow();
    expect(check()).toBe(false);
  });

  it("accepts an exact multibyte token and rejects a different multibyte token without throwing", () => {
    config.token = "éé";
    expect(isBearerAuthenticated(request("Bearer éé"))).toBe(true);
    expect(isBearerAuthenticated(request("Bearer èè"))).toBe(false);
    expect(() => isBearerAuthenticated(request("Bearer aa"))).not.toThrow();
    expect(isBearerAuthenticated(request("Bearer aa"))).toBe(false);
  });

  it("does not treat legacy allowlisted IP access as Bearer authentication", () => {
    const req = request();
    expect(legacyMiddlewareAccepts(req)).toBe(true);
    expect(isBearerAuthenticated(req)).toBe(false);
  });

  it("does not authenticate the legacy development fallback when IP filtering is disabled", () => {
    config.ipAllowlist = false;
    const req = request();
    expect(legacyMiddlewareAccepts(req)).toBe(true);
    expect(isBearerAuthenticated(req)).toBe(false);
    config.token = "";
    expect(legacyMiddlewareAccepts(req)).toBe(true);
    expect(isBearerAuthenticated(req)).toBe(false);
  });

  it("does not take trusted authentication from JSON-RPC arguments or request metadata", () => {
    const req = Object.assign(request(), {
      bearerAuthenticated: true,
      body: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "supabase_sql",
          arguments: {
            bearerAuthenticated: true,
            authenticated: true,
            authorization: "Bearer boundary-test-token",
            headers: { authorization: "Bearer boundary-test-token" },
          },
          _meta: { bearerAuthenticated: true },
        },
      },
    });
    expect(legacyMiddlewareAccepts(req)).toBe(true);
    expect(isBearerAuthenticated(req)).toBe(false);
  });
});

describe("Supabase credential presence protects the entire MCP service", () => {
  it.each([
    ["SUPABASE_ACCESS_TOKEN", "access-token-canary"],
    [
      "SUPABASE_PROJECT_CREDENTIALS_JSON",
      JSON.stringify({ abcdefghijklmnopqrst: { serviceRoleKey: "project-key-canary" } }),
    ],
    ["SUPABASE_PROJECT_CREDENTIALS_JSON", "malformed-json-containing-live-secret"],
    ["SUPABASE_ACCESS_TOKEN", " "],
  ])("requires Bearer despite legacy IP access and flag off when %s is present", (name, value) => {
    vi.stubEnv(name, value);
    expect(middlewareResult(request())).toEqual({ accepted: false, status: 401 });
    expect(middlewareResult(request("Basic boundary-test-token"))).toEqual({
      accepted: false,
      status: 401,
    });
    expect(middlewareResult(request("Bearer wrong-token"))).toEqual({
      accepted: false,
      status: 403,
    });
    expect(middlewareResult(request("Bearer boundary-test-token"))).toEqual({
      accepted: true,
      status: undefined,
    });
  });

  it.each([
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_PROJECT_CREDENTIALS_JSON",
  ])("fails closed without a configured server token when %s is present", (name) => {
    vi.stubEnv(name, "credential-canary");
    config.token = "";
    config.ipAllowlist = false;
    for (const header of [undefined, "Bearer ", "Bearer boundary-test-token"]) {
      expect(middlewareResult(request(header))).toEqual({ accepted: false, status: 401 });
    }
  });

  it("protects every legacy tool route, including credential-revealing calls", () => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "access-token-canary");
    config.ipAllowlist = false;
    const req = Object.assign(request(), {
      body: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "railway_env",
          arguments: { action: "get", reveal: true, bearerAuthenticated: true },
        },
      },
    });
    expect(middlewareResult(req)).toEqual({ accepted: false, status: 401 });
  });

  it("keeps only the exact health endpoint public even with missing server authentication", () => {
    vi.stubEnv("SUPABASE_PROJECT_CREDENTIALS_JSON", "malformed-json-containing-live-secret");
    config.token = "";
    const req = request();
    Object.defineProperty(req, "path", { value: "/health", configurable: true });
    expect(middlewareResult(req)).toEqual({ accepted: true, status: undefined });
    Object.defineProperty(req, "path", { value: "/health/other", configurable: true });
    expect(middlewareResult(req)).toEqual({ accepted: false, status: 401 });
  });

  it("preserves legacy fallback only when both Supabase credentials are absent or empty", () => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "");
    vi.stubEnv("SUPABASE_PROJECT_CREDENTIALS_JSON", "");
    expect(middlewareResult(request())).toEqual({ accepted: true, status: undefined });
  });
});

describe("Supabase server credentials stay out of subprocess environments", () => {
  it("removes both the Management API token and project credential map", () => {
    const accessToken = "supabase-access-canary-never-dispatch";
    const projectCredentials = JSON.stringify({
      abcdefghijklmnopqrst: { secretKey: "supabase-project-canary-never-dispatch" },
    });
    const parentEnv = {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      SUPABASE_ACCESS_TOKEN: accessToken,
      SUPABASE_PROJECT_CREDENTIALS_JSON: projectCredentials,
    };
    const childEnv = buildDispatchEnv(parentEnv, "unused-test-oauth", "max");
    expect(childEnv.SUPABASE_ACCESS_TOKEN).toBeUndefined();
    expect(childEnv.SUPABASE_PROJECT_CREDENTIALS_JSON).toBeUndefined();
    expect(JSON.stringify(childEnv)).not.toContain(accessToken);
    expect(JSON.stringify(childEnv)).not.toContain("supabase-project-canary-never-dispatch");
    expect(childEnv.PATH).toBe(parentEnv.PATH);
    expect(childEnv.LANG).toBe(parentEnv.LANG);
    expect(parentEnv.SUPABASE_ACCESS_TOKEN).toBe(accessToken);
    expect(parentEnv.SUPABASE_PROJECT_CREDENTIALS_JSON).toBe(projectCredentials);
  });
});
