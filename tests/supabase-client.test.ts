import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupabaseReadiness,
  SUPABASE_MAX_REQUEST_BYTES,
  SUPABASE_MAX_RESPONSE_BYTES,
  SUPABASE_TIMEOUT_MS,
  SupabaseClient,
  SupabaseRequestError,
  type SupabaseManagementRequest,
  type SupabaseProjectRequest,
} from "../src/supabase/client.js";

const REF = "abcdefghijklmnopqrst";
const OTHER = "bbbbbbbbbbbbbbbbbbbb";
const PAT = "sbp_private_management_canary_123";
const AUTH = "private_mcp_canary_456";
const KEY = "legacy_service_role_canary_789";
function environment(key = KEY): NodeJS.ProcessEnv {
  return {
    SUPABASE_ACCESS_TOKEN: PAT,
    MCP_AUTH_TOKEN: AUTH,
    SUPABASE_PROJECT_REFS: REF,
    SUPABASE_PROJECT_CREDENTIALS_JSON: JSON.stringify({ [REF]: { serviceRoleKey: key } }),
  };
}
function input(overrides: Partial<SupabaseManagementRequest> = {}): SupabaseManagementRequest {
  return { projectRef: REF, method: "GET", path: "config/auth", ...overrides };
}
function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}
function sent(fetcher: ReturnType<typeof vi.fn>): {
  url: URL;
  options: RequestInit;
  headers: Headers;
} {
  const [url, options] = fetcher.mock.calls[0]!;
  return { url: new URL(String(url)), options, headers: new Headers(options.headers) };
}

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn().mockResolvedValue(json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Supabase readiness and project scope", () => {
  it("is inert without env and reports only presence, explicit refs and static diagnostics", () => {
    const missing = getSupabaseReadiness({});
    expect(missing.ready).toBe(false);
    expect(missing.issues).toHaveLength(3);
    expect(fetcher).not.toHaveBeenCalled();
    expect(getSupabaseReadiness(environment())).toEqual({
      ready: true,
      managementReady: true,
      projectApiReady: true,
      authConfigured: true,
      tokenConfigured: true,
      projectRefs: [REF],
      projectCredentialRefs: [REF],
      issues: [],
    });
    expect(JSON.stringify(getSupabaseReadiness(environment()))).not.toMatch(/canary/);
  });

  it.each([
    undefined,
    "",
    `${REF},${REF}`,
    `${REF},`,
    "https://evil.example",
    "../projects",
    "TOO_SHORT",
    "a".repeat(4097),
  ])("rejects invalid project allowlist case %#", (refs) => {
    const env = environment();
    env.SUPABASE_PROJECT_REFS = refs;
    const result = getSupabaseReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.projectRefs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    "",
    "not-json-CANARY",
    "null",
    "[]",
    JSON.stringify({ [OTHER]: { serviceRoleKey: KEY } }),
    JSON.stringify({ [REF]: { serviceRoleKey: KEY, password: "CANARY" } }),
    JSON.stringify({ [REF]: { serviceRoleKey: "with whitespace" } }),
    JSON.stringify({ [REF]: { serviceRoleKey: null } }),
  ])("fails closed for malformed credentials", (credentials) => {
    const env = environment();
    env.SUPABASE_PROJECT_CREDENTIALS_JSON = credentials;
    const result = getSupabaseReadiness(env);
    expect(result.ready).toBe(false);
    expect(result.projectCredentialRefs).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/CANARY|canary/);
  });

  it("allows management without project credentials, with per-project data API checks", async () => {
    const env = environment();
    delete env.SUPABASE_PROJECT_CREDENTIALS_JSON;
    expect(getSupabaseReadiness(env)).toMatchObject({ ready: true, projectApiReady: false });
    const client = new SupabaseClient(env);
    await client.managementRequest(input());
    await expect(client.projectRequest({ ...input(), service: "rest" })).rejects.toMatchObject({
      code: "PROJECT_CREDENTIAL_MISSING",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows a partial credential map but never discovers the missing key", async () => {
    const env = environment();
    env.SUPABASE_PROJECT_REFS = ` ${REF}, ${OTHER} `;
    expect(getSupabaseReadiness(env)).toMatchObject({
      ready: true,
      projectApiReady: false,
      projectRefs: [REF, OTHER],
    });
    const client = new SupabaseClient(env);
    await client.projectRequest({ ...input(), service: "rest" });
    await expect(
      client.projectRequest({ ...input({ projectRef: OTHER }), service: "rest" }),
    ).rejects.toMatchObject({ code: "PROJECT_CREDENTIAL_MISSING" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("requires bridge auth and explicit allowlisted reference and service before any transport", async () => {
    const env = environment();
    delete env.MCP_AUTH_TOKEN;
    await expect(new SupabaseClient(env).managementRequest(input())).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    const client = new SupabaseClient(environment());
    await expect(client.managementRequest(input({ projectRef: "" }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(client.managementRequest(input({ projectRef: OTHER }))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(client.projectRequest(input() as SupabaseProjectRequest)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      client.projectRequest({ ...input(), service: "evil" } as unknown as SupabaseProjectRequest),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("fixed-host transport and request representation", () => {
  it.each([
    "https://evil.example",
    "//evil.example",
    "../other",
    "x/../other",
    "x/./y",
    "/%2e%2e/other",
    "/%252e%252e/other",
    "x/%2fy",
    "x/%252fy",
    "x/%5cy",
    "x\\y",
    "x?secret=yes",
    "x#fragment",
    "x/%3fsecret=yes",
    "x/%00",
    "%",
    "%GG",
    "%25",
    "x\n",
    "http:evil",
    "/" + "%25".repeat(5000),
  ])("rejects scope escape path case %#", async (path) => {
    await expect(
      new SupabaseClient(environment()).managementRequest(input({ path })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the exact documented project root and separately encoded query parameters", async () => {
    await new SupabaseClient(environment()).managementRequest(
      input({ path: "", query: { test: "../other?x=#z" } }),
    );
    const { url, options, headers } = sent(fetcher);
    expect(url.origin).toBe("https://api.supabase.com");
    expect(url.pathname).toBe(`/v1/projects/${REF}`);
    expect(url.searchParams.get("test")).toBe("../other?x=#z");
    expect(headers.get("Authorization")).toBe(`Bearer ${PAT}`);
    expect(headers.has("apikey")).toBe(false);
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "rest",
    "auth",
    "storage",
    "functions",
  ] as const)("pins %s API to the chosen project and legacy credential", async (service) => {
    await new SupabaseClient(environment()).projectRequest({
      ...input({ path: "object/bucket/hello%20world" }),
      service,
    });
    const { url, headers } = sent(fetcher);
    expect(url.href).toBe(`https://${REF}.supabase.co/${service}/v1/object/bucket/hello%20world`);
    expect(headers.get("apikey")).toBe(KEY);
    expect(headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(PAT);
  });

  it("sends modern secret keys only on apikey because they are not JWTs", async () => {
    const key = "sb_secret_modern_canary";
    await new SupabaseClient(environment(key)).projectRequest({ ...input(), service: "auth" });
    const { headers } = sent(fetcher);
    expect(headers.get("apikey")).toBe(key);
    expect(headers.has("Authorization")).toBe(false);
  });

  it("preserves SQL source, parameters and allowlisted headers exactly", async () => {
    const query = "begin;\nselect $1::text;\ncommit;";
    await new SupabaseClient(environment()).managementRequest(
      input({
        method: "POST",
        path: "database/query",
        body: { query, parameters: ["x\n$()"], read_only: false },
        headers: {
          Prefer: "return=representation",
          Accept: "application/json",
          "Content-Profile": "private",
          "Accept-Profile": "private",
        },
      }),
    );
    const { options, headers } = sent(fetcher);
    expect(options.body).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(Buffer.from(options.body as ArrayBuffer).toString())).toEqual({
      query,
      parameters: ["x\n$()"],
      read_only: false,
    });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("prefer")).toBe("return=representation");
    expect(headers.get("content-profile")).toBe("private");
  });

  it.each([
    { Authorization: "override" },
    { apikey: "override" },
    { Host: "evil.example" },
    { Cookie: "secret" },
    { Prefer: "x\r\ny" },
    { Prefer: "x", prefer: "y" },
  ])("rejects credential and malformed headers", async (headers) => {
    await expect(
      new SupabaseClient(environment()).managementRequest(input({ headers })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serializes bounded binary and multipart uploads using Node 18 APIs", async () => {
    const client = new SupabaseClient(environment());
    const bytes = Buffer.from([0, 127, 128, 255]);
    await client.projectRequest({
      ...input({
        method: "POST",
        path: "object/assets/file.bin",
        base64Body: bytes.toString("base64"),
      }),
      service: "storage",
    });
    expect(Buffer.from(sent(fetcher).options.body as ArrayBuffer)).toEqual(bytes);
    fetcher.mockClear();
    await client.managementRequest(
      input({
        method: "POST",
        path: "functions/deploy",
        query: { slug: "hello" },
        multipart: [
          {
            name: "metadata",
            value: JSON.stringify({ name: "hello", entrypoint_path: "index.ts" }),
            contentType: "application/json",
          },
          {
            name: "file",
            base64: Buffer.from("Deno.serve(() => new Response('ok'))").toString("base64"),
            filename: "index.ts",
            contentType: "application/typescript",
          },
        ],
      }),
    );
    const { options, headers } = sent(fetcher);
    const form = await new Response(options.body, { headers }).formData();
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      name: "hello",
      entrypoint_path: "index.ts",
    });
    const file = form.get("file");
    expect(file).toBeTruthy();
    expect(typeof file).toBe("object");
    expect(await (file as Blob).text()).toBe("Deno.serve(() => new Response('ok'))");
  });

  it.each([
    { method: "GET", body: {} },
    { method: "POST", body: {}, textBody: "both" },
    { method: "POST", base64Body: "YQ" },
    { method: "POST", base64Body: "YR==" },
    { method: "POST", base64Body: "====" },
    { method: "POST", multipart: [{ name: "a", value: "x", base64: "eA==" }] },
    { method: "POST", multipart: [{ name: "bad\r\nheader", value: "x" }] },
    { method: "POST", multipart: [{ name: "x", filename: 'bad".txt', value: "x" }] },
    { method: "POST", multipart: [{ name: "x", value: "x" }], contentType: "multipart/form-data" },
    { method: "POST", textBody: "x", contentType: "text/plain\r\nx-evil: x" },
  ] as Partial<SupabaseManagementRequest>[])("rejects ambiguous or malformed request bodies", async (body) => {
    await expect(
      new SupabaseClient(environment()).managementRequest(input(body)),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds actual UTF-8 and multipart bytes before dispatch", async () => {
    const client = new SupabaseClient(environment());
    for (const body of [
      { textBody: "é".repeat(SUPABASE_MAX_REQUEST_BYTES / 2 + 1) },
      { body: { x: "x".repeat(SUPABASE_MAX_REQUEST_BYTES) } },
      { base64Body: Buffer.alloc(SUPABASE_MAX_REQUEST_BYTES + 1).toString("base64") },
      { multipart: [{ name: "x", value: "x".repeat(SUPABASE_MAX_REQUEST_BYTES) }] },
      {
        multipart: [
          { name: "x", value: "x".repeat(SUPABASE_MAX_REQUEST_BYTES / 2) },
          { name: "y", value: "y".repeat(SUPABASE_MAX_REQUEST_BYTES / 2 + 1) },
        ],
      },
    ]) {
      await expect(
        client.managementRequest(input({ method: "POST", ...body })),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await expect(
      client.managementRequest(input({ method: "POST", body: cycle })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("sanitized response handling", () => {
  it("keeps ordinary rows useful while redacting credential fields and reflected bridge secrets", async () => {
    fetcher.mockResolvedValue(
      json(
        {
          rows: [{ id: 42, name: "Ashley", city: "Dallas", delivered: true }],
          nested: {
            password: "not-a-bridge-secret",
            apiKey: "private-api-value",
            service_role_key: KEY,
          },
          secret: [{ name: "STRIPE_SECRET_KEY", value: "stripe-key" }],
          echo: `${PAT} ${AUTH} ${KEY} ${encodeURIComponent(KEY)} ${Buffer.from(KEY).toString("base64")}`,
        },
        {
          headers: {
            "x-request-id": PAT,
            "set-cookie": "should-not-escape",
            Location: "https://evil.example",
          },
        },
      ),
    );
    const result = await new SupabaseClient(environment()).managementRequest(input());
    expect(result.data).toMatchObject({
      rows: [{ id: 42, name: "Ashley", city: "Dallas", delivered: true }],
      nested: { password: "[REDACTED]", apiKey: "[REDACTED]", service_role_key: "[REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /canary|stripe-key|not-a-bridge-secret|private-api-value|should-not-escape|evil.example/,
    );
    expect(result.headers).toEqual({ "x-request-id": "[REDACTED]" });
  });

  it("reveals intentional newly managed secrets only when explicit, never bridge-held credentials", async () => {
    fetcher.mockImplementation(() =>
      Promise.resolve(
        json({
          password: "new-user-password",
          token: "new-token",
          echo: PAT,
          key: KEY,
          auth: AUTH,
        }),
      ),
    );
    const client = new SupabaseClient(environment());
    const safe = await client.managementRequest(input());
    expect(safe.data).toMatchObject({ password: "[REDACTED]", token: "[REDACTED]" });
    const revealed = await client.managementRequest(input({ revealSecrets: true }));
    expect(revealed.data).toMatchObject({
      password: "new-user-password",
      token: "new-token",
      echo: "[REDACTED]",
      key: "[REDACTED]",
      auth: "[REDACTED]",
    });
    expect(JSON.stringify(revealed)).not.toMatch(/canary/);
  });

  it("scrubs reflected credentials in text, metadata and binary output", async () => {
    const client = new SupabaseClient(environment());
    fetcher.mockResolvedValue(
      new Response(
        `hello ${PAT} Bearer unknown-user-token postgresql://user:password@db.example/db`,
        { headers: { "Content-Type": `text/plain; example=${KEY}` } },
      ),
    );
    const text = await client.managementRequest(input());
    expect(text.text).toContain("hello [REDACTED]");
    expect(JSON.stringify(text)).not.toMatch(/canary|unknown-user-token|user:password/);
    const binary = Buffer.concat([Buffer.from([0, 128, 255]), Buffer.from(KEY)]);
    fetcher.mockResolvedValue(
      new Response(binary, { headers: { "Content-Type": "application/octet-stream" } }),
    );
    const result = await client.managementRequest(input({ revealSecrets: true }));
    expect(Buffer.from(result.base64!, "base64").subarray(0, 3)).toEqual(
      Buffer.from([0, 128, 255]),
    );
    expect(Buffer.from(result.base64!, "base64").toString()).not.toContain(KEY);
  });

  it("preserves normal binary bytes and exposes no content for HEAD or empty responses", async () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    fetcher.mockResolvedValue(new Response(bytes));
    expect((await new SupabaseClient(environment()).managementRequest(input())).base64).toBe(
      bytes.toString("base64"),
    );
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    expect(
      await new SupabaseClient(environment()).managementRequest(input({ method: "HEAD" })),
    ).toEqual({ status: 204, contentType: "application/octet-stream", headers: {} });
  });
});

describe("bounded failures and mutation reconciliation", () => {
  it.each([
    400, 401, 403, 409, 429, 500, 503,
  ])("never returns or logs upstream HTTP %i error content and does not retry", async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fetcher.mockResolvedValue(json({ error: `${PAT} ${KEY} private SQL source` }, { status }));
    const result = await new SupabaseClient(environment())
      .managementRequest(input({ method: "POST", body: { query: "private SQL source" } }))
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(SupabaseRequestError);
    expect(result).toMatchObject({ code: "HTTP_ERROR", status, ambiguousMutation: true });
    expect((result as SupabaseRequestError).requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect((result as SupabaseRequestError).sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(String(result)).not.toMatch(/canary|private SQL source/);
    expect(log).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes arbitrary network errors and distinguishes read failures from uncertain mutations", async () => {
    fetcher.mockRejectedValue(new Error(`private failure ${PAT} ${KEY}`));
    const client = new SupabaseClient(environment());
    const read = await client.managementRequest(input()).catch((error: unknown) => error);
    expect(read).toMatchObject({ code: "NETWORK_ERROR", ambiguousMutation: false });
    expect(String(read)).not.toMatch(/private failure|canary/);
    const write = await client
      .managementRequest(input({ method: "DELETE" }))
      .catch((error: unknown) => error);
    expect(write).toMatchObject({ code: "NETWORK_ERROR", ambiguousMutation: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fingerprints exact body and semantic headers, independent of header insertion order or credentials", async () => {
    fetcher.mockRejectedValue(new Error("network"));
    const failed = (env: NodeJS.ProcessEnv, headers: Record<string, string>) =>
      new SupabaseClient(env)
        .managementRequest(input({ method: "POST", body: { a: 1 }, headers }))
        .catch((error: SupabaseRequestError) => error);
    const a = (await failed(environment(), {
      Prefer: "resolution=merge-duplicates",
      "x-upsert": "true",
    })) as SupabaseRequestError;
    const b = (await failed(environment("another-project-key"), {
      "x-upsert": "true",
      prefer: "resolution=merge-duplicates",
    })) as SupabaseRequestError;
    const c = (await failed(environment(), {
      Prefer: "resolution=ignore-duplicates",
      "x-upsert": "true",
    })) as SupabaseRequestError;
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.requestHash).not.toBe(c.requestHash);
    expect(a.sourceHash).toBe(c.sourceHash);
  });

  it("has a finite 45-second total deadline even when fetch never settles", async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const pending = new SupabaseClient(environment())
      .managementRequest(input({ method: "PATCH", body: { a: 1 } }))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SUPABASE_TIMEOUT_MS);
    expect(await pending).toMatchObject({ code: "TIMEOUT", ambiguousMutation: true });
    expect(sent(fetcher).options.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("applies the same deadline to response-body reads and cancels the stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(new ReadableStream({ start() {}, cancel }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const pending = new SupabaseClient(environment())
      .managementRequest(input())
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SUPABASE_TIMEOUT_MS);
    expect(await pending).toMatchObject({ code: "TIMEOUT", ambiguousMutation: false });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized declared and streamed bodies, preserving unknown mutation outcome", async () => {
    const client = new SupabaseClient(environment());
    fetcher.mockResolvedValue(
      new Response("x", { headers: { "Content-Length": String(SUPABASE_MAX_RESPONSE_BYTES + 1) } }),
    );
    await expect(client.managementRequest(input({ method: "POST" }))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      ambiguousMutation: true,
    });
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(SUPABASE_MAX_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
      ),
    );
    await expect(client.managementRequest(input())).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      ambiguousMutation: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("sanitizes invalid JSON and stream exceptions without exposing source text", async () => {
    const client = new SupabaseClient(environment());
    fetcher.mockResolvedValue(
      new Response(`not-json ${PAT}`, { headers: { "content-type": "application/json" } }),
    );
    await expect(client.managementRequest(input({ method: "POST" }))).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      ambiguousMutation: true,
    });
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(KEY));
          },
        }),
      ),
    );
    const failure = await client.managementRequest(input()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "RESPONSE_ERROR" });
    expect(String(failure)).not.toContain(KEY);
  });
});
