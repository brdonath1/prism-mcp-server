import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  construct: vi.fn(),
  management: vi.fn(),
  project: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../src/supabase/client.js", () => ({
  getSupabaseReadiness: mocks.readiness,
  SupabaseClient: class {
    constructor() { mocks.construct(); }
    managementRequest(input: unknown) { return mocks.management(input); }
    projectRequest(input: unknown) { return mocks.project(input); }
  },
  SupabaseRequestError: class extends Error {
    code: string;
    status: number | undefined;
    ambiguousMutation: boolean;
    requestHash: string | undefined;
    constructor(code: string, message: string, ambiguousMutation = false) {
      super(message);
      this.code = code;
      this.ambiguousMutation = ambiguousMutation;
    }
  },
}));
vi.mock("../src/utils/logger.js", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));

import { registerSupabaseTools } from "../src/tools/supabase.js";
import { SupabaseRequestError } from "../src/supabase/client.js";

const ref = "abcdefghijklmnopqrst";
const secondRef = "zyxwvutsrqponmlkjihg";
const ready = {
  ready: true,
  managementReady: true,
  projectApiReady: true,
  authConfigured: true,
  tokenConfigured: true,
  projectRefs: [ref],
  projectCredentialRefs: [ref],
  issues: [],
};
const response = { status: 200, data: { accepted: true }, contentType: "application/json", headers: {} };
type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Captured = {
  name: string;
  config: { description: string; inputSchema: z.ZodRawShape; annotations: Record<string, boolean> };
  handler: (input: unknown) => Promise<Result>;
};

function registrations(bearerAuthenticated = true): Map<string, Captured> {
  const tools = new Map<string, Captured>();
  const server = {
    registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
      tools.set(name, { name, config, handler });
    },
  } as unknown as McpServer;
  registerSupabaseTools(server, { bearerAuthenticated });
  return tools;
}

async function call(name: string, input: unknown = {}, authenticated = true) {
  const tool = registrations(authenticated).get(name);
  expect(tool).toBeDefined();
  const result = await tool!.handler(input);
  return { result, payload: JSON.parse(result.content[0].text) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readiness.mockReturnValue({ ...ready, projectRefs: [ref] });
  mocks.management.mockResolvedValue(response);
  mocks.project.mockResolvedValue(response);
});

describe("Supabase tool registration and connection authorization", () => {
  it("registers exactly five tools only when readiness is enabled", () => {
    expect([...registrations().keys()]).toEqual([
      "supabase_status", "supabase_management_request", "supabase_project_request",
      "supabase_execute_sql", "supabase_apply_migration",
    ]);
    mocks.readiness.mockReturnValue({ ...ready, ready: false });
    expect(registrations().size).toBe(0);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("rejects every unauthenticated handler before credential resolution, schema work or network", async () => {
    const tools = registrations(false);
    vi.clearAllMocks();
    for (const tool of tools.values()) {
      const result = await tool.handler({ bearerAuthenticated: true, invalid: "do not trust input" });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error.code).toBe("BEARER_REQUIRED");
    }
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.management).not.toHaveBeenCalled();
    expect(mocks.project).not.toHaveBeenCalled();
  });

  it("rechecks readiness on an existing authenticated connection", async () => {
    const tools = registrations();
    mocks.readiness.mockReturnValue({ ...ready, ready: false });
    const result = await tools.get("supabase_execute_sql")!.handler({ query: "select 1" });
    expect(JSON.parse(result.content[0].text).error.code).toBe("NOT_READY");
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("marks status read-only and all general or SQL mutation surfaces conservatively", () => {
    for (const [name, tool] of registrations()) {
      const readOnly = name === "supabase_status";
      expect(tool.config.annotations.readOnlyHint).toBe(readOnly);
      expect(tool.config.annotations.destructiveHint).toBe(!readOnly);
      expect(tool.config.annotations.idempotentHint).toBe(readOnly);
      expect(Object.keys(tool.config.inputSchema)).not.toContain("confirmation");
      expect(Object.keys(tool.config.inputSchema)).not.toContain("bearerAuthenticated");
    }
  });

  it("returns only readiness metadata without resolving a client or retrieving rows", async () => {
    mocks.readiness.mockReturnValue({ ...ready, accessToken: "must-not-leak", customerRows: [{ private: true }] });
    const { payload } = await call("supabase_status");
    expect(payload).toMatchObject({ ready: true, project_refs: [ref], capabilities: { execute_sql: true } });
    expect(JSON.stringify(payload)).not.toMatch(/must-not-leak|customerRows/);
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.management).not.toHaveBeenCalled();
    expect(mocks.project).not.toHaveBeenCalled();
  });
});

describe("Supabase project selection and request schemas", () => {
  it("uses the sole allowed project when omitted", async () => {
    await call("supabase_management_request", { path: "config/auth" });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ projectRef: ref, method: "GET" }));
  });

  it("forwards an empty path for the exact management or project API root", async () => {
    await call("supabase_management_request", { path: "" });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ projectRef: ref, path: "", method: "GET" }));
    await call("supabase_project_request", { service: "rest", path: "" });
    expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ projectRef: ref, service: "rest", path: "" }));
  });

  it("rejects an omitted ambiguous project or a project outside the allowlist before client construction", async () => {
    mocks.readiness.mockReturnValue({ ...ready, projectRefs: [ref, secondRef] });
    const missing = await call("supabase_management_request", { path: "config/auth" });
    expect(missing.payload.error.message).toMatch(/explicitly.*ambiguous/);
    const outside = await call("supabase_execute_sql", { project_ref: "outside", query: "select 1" });
    expect(outside.payload.error.message).toMatch(/allowlist/);
    expect(mocks.construct).not.toHaveBeenCalled();
  });

  it("uses an explicitly allowed project when several are configured", async () => {
    mocks.readiness.mockReturnValue({ ...ready, projectRefs: [ref, secondRef] });
    await call("supabase_management_request", { project_ref: secondRef, path: "config/auth" });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ projectRef: secondRef }));
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])("dispatches %s without changing its method", async (method) => {
    await call("supabase_management_request", { path: "config/auth", method, query: { limit: "5" } });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ method, query: { limit: "5" } }));
  });

  it.each(["rest", "auth", "storage", "functions"])("routes the %s project API through projectRequest", async (service) => {
    await call("supabase_project_request", { service, path: "endpoint", method: "POST", body: { key: "value" } });
    expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ service, projectRef: ref, body: { key: "value" } }));
    expect(mocks.management).not.toHaveBeenCalled();
  });

  it.each([
    [{ body: null }, { body: null }],
    [{ text_body: "line one\nline two", content_type: "text/plain" }, { textBody: "line one\nline two", contentType: "text/plain" }],
    [{ base64_body: "AAECAw==", content_type: "application/octet-stream" }, { base64Body: "AAECAw==", contentType: "application/octet-stream" }],
    [{ multipart: [{ name: "file", base64: "AAE=", filename: "asset.bin", contentType: "application/octet-stream" }] }, { multipart: [{ name: "file", base64: "AAE=", filename: "asset.bin", contentType: "application/octet-stream" }] }],
  ])("preserves the selected body representation %j", async (input, expected) => {
    await call("supabase_management_request", { path: "functions", method: "POST", ...input });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("forwards safe header candidates and explicit response-reveal preference to the central client", async () => {
    await call("supabase_project_request", {
      service: "rest", path: "items", headers: { Prefer: "return=minimal" }, reveal_secrets: true,
    });
    expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ headers: { Prefer: "return=minimal" }, revealSecrets: true }));
  });

  it.each([
    { path: "config/auth", method: "TRACE" },
    { path: "config/auth", reveal_secrets: "true" },
    { path: "config/auth", bearerAuthenticated: true },
    { path: "config/auth", body: null, text_body: "ambiguous" },
  ])("rejects malformed or conflicting request inputs before network: %j", async (input) => {
    const { result, payload } = await call("supabase_management_request", input);
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(mocks.management).not.toHaveBeenCalled();
  });
});

describe("Supabase SQL and migration fidelity", () => {
  const query = "-- retained ledger\nBEGIN;\nSELECT 'é; $$', $1;\nCOMMIT;\n";
  const hash = createHash("sha256").update(query, "utf8").digest("hex");

  it("sends one unchanged SQL batch with parameters and a SHA-256 receipt", async () => {
    const { payload } = await call("supabase_execute_sql", { query, parameters: ["value", null, 7] });
    expect(mocks.management).toHaveBeenCalledTimes(1);
    expect(mocks.management).toHaveBeenCalledWith({
      projectRef: ref, method: "POST", path: "database/query",
      body: { query, parameters: ["value", null, 7], read_only: false },
    });
    expect(payload.query_sha256).toBe(hash);
    expect(payload.warning).toMatch(/verify database state.*before retrying/);
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("retained ledger");
  });

  it("forwards explicit read-only mode without rewriting the SQL", async () => {
    await call("supabase_execute_sql", { query, read_only: true });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ body: { query, read_only: true } }));
  });

  it("leaves the migration version and journal to the API", async () => {
    const rollback = "-- exact rollback\nSELECT 1;\n";
    const { payload } = await call("supabase_apply_migration", { query, name: "feature", rollback });
    expect(mocks.management).toHaveBeenCalledWith({
      projectRef: ref, method: "POST", path: "database/migrations", body: { query, name: "feature", rollback },
    });
    expect(payload.query_sha256).toBe(hash);
    expect(payload.warning).toMatch(/journal and version.*exact-ledger.*supabase_execute_sql/);
    const bad = await call("supabase_apply_migration", { query, version: "20260908000000" });
    expect(bad.result.isError).toBe(true);
    expect(mocks.management).toHaveBeenCalledTimes(1);
  });

  it("omits unsupplied migration fields and rejects non-SQL rollback types", async () => {
    await call("supabase_apply_migration", { query });
    expect(mocks.management).toHaveBeenCalledWith(expect.objectContaining({ body: { query } }));
    const bad = await call("supabase_apply_migration", { query, rollback: true });
    expect(bad.result.isError).toBe(true);
    expect(mocks.management).toHaveBeenCalledTimes(1);
  });

  it("retains query evidence on uncertain failures and never retries", async () => {
    const error = Object.assign(new Error("Request outcome is uncertain."), {
      code: "NETWORK_ERROR", ambiguousMutation: true,
      requestHash: "request-receipt", sourceHash: "body-receipt", status: 502,
    });
    Object.setPrototypeOf(error, SupabaseRequestError.prototype);
    mocks.management.mockRejectedValue(error);
    const { result, payload } = await call("supabase_execute_sql", { query });
    expect(result.isError).toBe(true);
    expect(payload.error.ambiguous_mutation).toBe(true);
    expect(payload.error).toMatchObject({ request_hash: "request-receipt", source_hash: "body-receipt", status: 502 });
    expect(payload.query_sha256).toBe(hash);
    expect(payload.warning).toMatch(/timeout does not prove rollback/);
    expect(mocks.management).toHaveBeenCalledTimes(1);
  });
});

describe("Supabase tool response and log boundaries", () => {
  it("marks an upstream error response as a tool error", async () => {
    mocks.management.mockResolvedValue({ ...response, status: 503 });
    expect((await call("supabase_management_request", { path: "health" })).result.isError).toBe(true);
  });

  it("does not return or log an unknown exception's potentially sensitive message", async () => {
    mocks.project.mockRejectedValue(new Error("Authorization: Bearer PRIVATE_KEY; customer body"));
    const { result, payload } = await call("supabase_project_request", { service: "rest", path: "items" });
    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("REQUEST_FAILED");
    expect(JSON.stringify([result, mocks.info.mock.calls, mocks.warn.mock.calls])).not.toMatch(/PRIVATE_KEY|customer body|Authorization/);
    expect(mocks.warn).toHaveBeenCalledWith("supabase_project_request failed", { status: "failed", ms: expect.any(Number) });
  });
});
