// S208 PR-S3 / audit R20 - authMiddleware credential and IP behavior.
//
// R20 named two cases that had no test at all:
//   1. "missing Authorization with token set -> 401"
//   2. "forged leftmost XFF -> 403"
//
// (1) is what AUTH_REQUIRE_BEARER buys, and it is pinned here in BOTH gate
// states: ON it is a 401; OFF it is today's fall-through to the IP allowlist,
// pinned exactly so a later refactor cannot change the default silently.
//
// (2) is pinned as what the middleware ACTUALLY does rather than as the
// case's original wording. `getClientIp` trusts the LEFTMOST X-Forwarded-For
// value verbatim, so a forged header naming an allowlisted address is
// ALLOWED, not 403'd - the 403 only arrives when the claimed address is
// outside the allowlist. Writing the test to expect 403 on a forged in-range
// header would have pinned a fiction. The honest pin is: forging works while
// the gate is off, and the gate closes it by rejecting before the IP check is
// ever reached. The XFF/trust-proxy repair itself is explicitly DEFERRED out
// of PR-S3 (it needs a live-topology decision about how many proxy hops to
// trust); these tests are the record of the exposure in the meantime.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// The middleware reads MCP_AUTH_TOKEN / ENABLE_IP_ALLOWLIST as import-time
// consts, so per-test control needs getters over a mutable holder rather than
// a static mock object. AUTH_REQUIRE_BEARER deliberately does NOT go here: it
// resolves from process.env at call time, and these tests drive the real
// resolver so the shipped resolution path is what is under test.
const configState = vi.hoisted(() => ({
  MCP_AUTH_TOKEN: "",
  ENABLE_IP_ALLOWLIST: true,
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    get MCP_AUTH_TOKEN() {
      return configState.MCP_AUTH_TOKEN;
    },
    get ENABLE_IP_ALLOWLIST() {
      return configState.ENABLE_IP_ALLOWLIST;
    },
  };
});

vi.mock("../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { authMiddleware } from "../src/middleware/auth.js";
import { resolveAuthRequireBearer } from "../src/config.js";
import { logger } from "../src/utils/logger.js";

const TOKEN = "s208-pr-s3-test-token";
/** Inside ANTHROPIC_CIDRS (160.79.104.0/21) - the production allowlist. */
const ALLOWED_IP = "160.79.104.42";
/** Outside every allowlisted range. */
const OUTSIDE_IP = "203.0.113.7";

interface FakeRes {
  statusCode: number | null;
  payload: unknown;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    payload: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
  };
  return res;
}

function makeReq(opts: { path?: string; authorization?: string; xff?: string; ip?: string }) {
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  return {
    path: opts.path ?? "/mcp",
    headers,
    ip: opts.ip,
    socket: { remoteAddress: opts.ip },
  } as unknown as Request;
}

/** Drive the real middleware and report which of the three exits it took. */
function run(opts: Parameters<typeof makeReq>[0]) {
  const req = makeReq(opts);
  const res = makeRes();
  const next = vi.fn() as unknown as NextFunction;
  authMiddleware(req, res as unknown as Response, next);
  return {
    allowed: (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1,
    status: res.statusCode,
    payload: res.payload as { error?: string } | undefined,
  };
}

beforeEach(() => {
  configState.MCP_AUTH_TOKEN = "";
  configState.ENABLE_IP_ALLOWLIST = true;
  delete process.env.AUTH_REQUIRE_BEARER;
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.AUTH_REQUIRE_BEARER;
});

describe("S208 PR-S3 - resolveAuthRequireBearer", () => {
  it("defaults to false when the var is unset or blank", () => {
    expect(resolveAuthRequireBearer({})).toBe(false);
    expect(resolveAuthRequireBearer({ AUTH_REQUIRE_BEARER: "" })).toBe(false);
    expect(resolveAuthRequireBearer({ AUTH_REQUIRE_BEARER: "   " })).toBe(false);
  });

  it("accepts the true-ish spellings, case- and whitespace-insensitively", () => {
    for (const v of ["true", "TRUE", " True ", "1", "yes", "YES", "on", "ON"]) {
      expect(resolveAuthRequireBearer({ AUTH_REQUIRE_BEARER: v }), v).toBe(true);
    }
  });

  it("treats an unparseable value as OFF - a typo must never harden auth silently", () => {
    for (const v of ["false", "0", "no", "off", "maybe", "TRUEISH", "y"]) {
      expect(resolveAuthRequireBearer({ AUTH_REQUIRE_BEARER: v }), v).toBe(false);
    }
  });

  it("reads process.env at CALL time (flip needs no re-import)", () => {
    expect(resolveAuthRequireBearer()).toBe(false);
    process.env.AUTH_REQUIRE_BEARER = "true";
    expect(resolveAuthRequireBearer()).toBe(true);
  });
});

describe("S208 PR-S3 - AUTH_REQUIRE_BEARER OFF (default): 4.13.2 behavior, unchanged", () => {
  it("R20 case 1, gate off: a MISSING Authorization header with a token set falls through to the IP check and an allowlisted source is served", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ xff: ALLOWED_IP });
    // This is the finding, pinned as behavior: a configured MCP_AUTH_TOKEN is
    // not actually required of an allowlisted caller.
    expect(r.allowed).toBe(true);
    expect(r.status).toBeNull();
  });

  it("gate off: a missing Authorization header from a NON-allowlisted source is still 403 (IP), not 401", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ xff: OUTSIDE_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.payload?.error).toContain("IP not in allowlist");
  });

  it("gate off: a NON-Bearer Authorization header (Basic) also falls through to the IP check", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ authorization: "Basic dXNlcjpwYXNz", xff: ALLOWED_IP });
    expect(r.allowed).toBe(true);
    expect(r.status).toBeNull();
  });

  it("gate off: a correct Bearer token is served even from a non-allowlisted source", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ authorization: `Bearer ${TOKEN}`, xff: OUTSIDE_IP });
    expect(r.allowed).toBe(true);
  });

  it("gate off: a WRONG Bearer token is 403 and never falls through to the IP check", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    // Same length as TOKEN so the rejection is the timing-safe compare, not
    // the length short-circuit; the source IP is allowlisted, proving the
    // wrong-token path does not fall through.
    const wrong = "x".repeat(TOKEN.length);
    const r = run({ authorization: `Bearer ${wrong}`, xff: ALLOWED_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.payload?.error).toContain("invalid token");
  });

  it("gate off: with no token configured and the allowlist disabled, everything is served (development mode)", () => {
    configState.MCP_AUTH_TOKEN = "";
    configState.ENABLE_IP_ALLOWLIST = false;
    expect(run({ xff: OUTSIDE_IP }).allowed).toBe(true);
  });

  it("gate off: /health is exempt from the IP allowlist", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ path: "/health", xff: OUTSIDE_IP });
    expect(r.allowed).toBe(true);
    expect(r.status).toBeNull();
  });
});

describe("S208 PR-S3 - AUTH_REQUIRE_BEARER ON: a configured token becomes a required token", () => {
  beforeEach(() => {
    process.env.AUTH_REQUIRE_BEARER = "true";
    configState.MCP_AUTH_TOKEN = TOKEN;
  });

  it("R20 case 1, gate on: a MISSING Authorization header with a token set is 401 immediately", () => {
    const r = run({ xff: ALLOWED_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(401);
    expect(r.payload?.error).toContain("Bearer token required");
    expect(logger.warn).toHaveBeenCalledWith("Missing Bearer token", {
      ip: ALLOWED_IP,
      path: "/mcp",
    });
  });

  it("gate on: a NON-Bearer Authorization header is 401 on the same path", () => {
    const r = run({ authorization: "Basic dXNlcjpwYXNz", xff: ALLOWED_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("gate on: the reject fires even with the IP allowlist DISABLED (no allowlist to fall back to)", () => {
    configState.ENABLE_IP_ALLOWLIST = false;
    const r = run({ xff: ALLOWED_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("gate on: a correct Bearer token is still served", () => {
    expect(run({ authorization: `Bearer ${TOKEN}`, xff: OUTSIDE_IP }).allowed).toBe(true);
  });

  it("gate on: a WRONG Bearer token stays 403 (authenticated attempt, bad credential) - not 401", () => {
    const wrong = "x".repeat(TOKEN.length);
    const r = run({ authorization: `Bearer ${wrong}`, xff: ALLOWED_IP });
    expect(r.status).toBe(403);
    expect(r.payload?.error).toContain("invalid token");
  });

  it("gate on: /health stays exempt - Railway's probe sends no credential", () => {
    const r = run({ path: "/health", xff: OUTSIDE_IP });
    expect(r.allowed).toBe(true);
    expect(r.status).toBeNull();
  });

  it("gate on with NO token configured: nothing to require, so the IP allowlist still decides", () => {
    configState.MCP_AUTH_TOKEN = "";
    expect(run({ xff: ALLOWED_IP }).allowed).toBe(true);
    expect(run({ xff: OUTSIDE_IP }).status).toBe(403);
  });
});

describe("S208 PR-S3 - R20 case 2: what a forged X-Forwarded-For actually buys", () => {
  it("gate off: a FORGED leftmost XFF naming an allowlisted address is SERVED (the header is trusted verbatim)", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    // Socket address is outside the allowlist; only the attacker-supplied
    // header claims otherwise. getClientIp takes the leftmost value and the
    // allowlist believes it.
    const r = run({ xff: `${ALLOWED_IP}, ${OUTSIDE_IP}`, ip: OUTSIDE_IP });
    expect(r.allowed).toBe(true);
    expect(r.status).toBeNull();
  });

  it("gate off: only a leftmost value OUTSIDE the allowlist produces the 403", () => {
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ xff: `${OUTSIDE_IP}, ${ALLOWED_IP}`, ip: ALLOWED_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(403);
    expect(r.payload?.error).toContain("IP not in allowlist");
  });

  it("gate on: the forged header buys nothing - the 401 lands before the IP check runs", () => {
    process.env.AUTH_REQUIRE_BEARER = "true";
    configState.MCP_AUTH_TOKEN = TOKEN;
    const r = run({ xff: `${ALLOWED_IP}, ${OUTSIDE_IP}`, ip: OUTSIDE_IP });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe(401);
    expect(r.payload?.error).toContain("Bearer token required");
  });

  it("an ARRAY-valued X-Forwarded-For resolves to the leftmost value of its first entry", () => {
    configState.MCP_AUTH_TOKEN = "";
    const req = makeReq({});
    (req.headers as Record<string, unknown>)["x-forwarded-for"] = [
      `${OUTSIDE_IP}, ${ALLOWED_IP}`,
    ];
    const res = makeRes();
    const next = vi.fn();
    authMiddleware(req, res as unknown as Response, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
