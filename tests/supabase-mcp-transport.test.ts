/** Real SDK round trips, with no provider/network transport beyond a mocked fetch. */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSupabaseTools } from "../src/tools/supabase.js";

const REF = "abcdefghijklmnopqrst";
const PAT = "sbp_transport_management_dummy";
const KEY = "sb_secret_transport_project_dummy";
const names = [
  "supabase_status",
  "supabase_management_request",
  "supabase_project_request",
  "supabase_execute_sql",
  "supabase_apply_migration",
];
const connections: Array<{ client: Client; server: McpServer }> = [];
let fetcher: ReturnType<typeof vi.fn>;

async function connect(bearerAuthenticated = true): Promise<Client> {
  const server = new McpServer({ name: "supabase-transport-test", version: "1.0.0" });
  const client = new Client({ name: "supabase-transport-test-client", version: "1.0.0" });
  registerSupabaseTools(server, { bearerAuthenticated });
  connections.push({ client, server });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  expect(Array.isArray(result.content)).toBe(true);
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text!);
}

function upstream(): { url: string; options: RequestInit; body: unknown } {
  const [url, options] = fetcher.mock.calls[0]! as [URL, RequestInit];
  return {
    url: url.href,
    options,
    body:
      options.body === undefined
        ? undefined
        : JSON.parse(Buffer.from(options.body as ArrayBuffer).toString()),
  };
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_ACCESS_TOKEN", PAT);
  vi.stubEnv("MCP_AUTH_TOKEN", "transport_operator_dummy");
  vi.stubEnv("SUPABASE_PROJECT_REFS", REF);
  vi.stubEnv(
    "SUPABASE_PROJECT_CREDENTIALS_JSON",
    JSON.stringify({ [REF]: { serviceRoleKey: KEY } }),
  );
  fetcher = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetcher);
});

afterEach(async () => {
  const results = await Promise.allSettled(
    connections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]),
  );
  expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Supabase tools through the real MCP SDK in-memory transport", () => {
  it("discovers exactly five tools and returns sanitized readiness without fetch", async () => {
    const client = await connect();
    const discovered = await client.listTools();
    expect(discovered.tools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    expect(discovered.tools).toHaveLength(5);
    expect(
      discovered.tools.find((tool) => tool.name === "supabase_management_request")?.inputSchema
        .properties,
    ).toHaveProperty("path");
    const result = await client.callTool({ name: "supabase_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({
      ready: true,
      project_refs: [REF],
      project_api_ready: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/transport_.*dummy/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts an empty management path and applies real SDK defaults without rewriting the root", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "supabase_management_request",
      arguments: { path: "" },
    });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({ project_ref: REF, status: 200, data: { ok: true } });
    const request = upstream();
    expect(request.url).toBe(`https://api.supabase.com/v1/projects/${REF}`);
    expect(request.options.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves a complete SQL batch, parameters and evidence end to end", async () => {
    const client = await connect();
    const query =
      "\n-- exact source: café\r\nbegin;\nselect $1::text, $$no splitting;$$;\ncommit;\n";
    const parameters = ["literal $() and `ticks`", null, 7, { label: "line\nbreak" }];
    const result = await client.callTool({
      name: "supabase_execute_sql",
      arguments: { project_ref: REF, query, parameters, read_only: true },
    });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({
      project_ref: REF,
      read_only: true,
      query_sha256: createHash("sha256").update(query).digest("hex"),
    });
    expect(upstream()).toMatchObject({
      url: `https://api.supabase.com/v1/projects/${REF}/database/query`,
      body: { query, parameters, read_only: true },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("carries migration source and rollback SQL without inventing a version", async () => {
    const client = await connect();
    const query = "begin;\nselect 1;\ncommit;";
    const rollback = "select 'rollback source';";
    const result = await client.callTool({
      name: "supabase_apply_migration",
      arguments: { query, name: "transport_fixture", rollback },
    });
    expect(result.isError).not.toBe(true);
    expect(upstream()).toMatchObject({
      url: `https://api.supabase.com/v1/projects/${REF}/database/migrations`,
      body: { query, name: "transport_fixture", rollback },
    });
    expect(Object.keys(upstream().body as object).sort()).toEqual(["name", "query", "rollback"]);
  });

  it("carries a project request through service selection and server-owned credentials", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "supabase_project_request",
      arguments: {
        service: "rest",
        path: "orders",
        query: { select: "id", limit: "1" },
        headers: { "Accept-Profile": "private" },
      },
    });
    expect(result.isError).not.toBe(true);
    expect(upstream().url).toBe(`https://${REF}.supabase.co/rest/v1/orders?select=id&limit=1`);
    const headers = new Headers(upstream().options.headers);
    expect(headers.get("apikey")).toBe(KEY);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("accept-profile")).toBe("private");
  });

  it.each([
    ["supabase_status", {}],
    ["supabase_management_request", { path: "" }],
    ["supabase_project_request", { service: "rest", path: "orders" }],
    ["supabase_execute_sql", { query: "select 1;" }],
    ["supabase_apply_migration", { query: "select 1;" }],
  ] as const)("denies %s on a non-Bearer connection without upstream fetch", async (name, args) => {
    const client = await connect(false);
    const result = await client.callTool({
      name,
      arguments: args,
      _meta: { bearerAuthenticated: true, authorization: "Bearer spoofed-in-metadata" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: { code: "BEARER_REQUIRED" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("rejects unknown mutation fields with Bearer context %s before any request", async (bearerAuthenticated) => {
    const client = await connect(bearerAuthenticated);
    const result = await client.callTool({
      name: "supabase_apply_migration",
      arguments: { query: "select 1;", version: "invented-version-must-not-be-ignored" },
    });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
