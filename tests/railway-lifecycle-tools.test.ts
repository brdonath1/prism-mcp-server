/**
 * railway-lifecycle-tools.test.ts — unit tests for the six Railway
 * provisioning/lifecycle tools, with mocked GraphQL responses.
 *
 * Per INS-31, HTTP-routing tests mock fetch. Here we stub `globalThis.fetch`
 * with a query-dispatching mock so the REAL client (railwayQuery,
 * RailwayResolver, and the new create/update/delete helpers) runs against
 * canned GraphQL envelopes. Each tool gets a happy path and a failure path.
 */

// Set dummy creds to prevent config.ts from process.exit(1) and to enable the
// Railway client's token guard.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || "test-railway-token";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerRailwayCreateProject } from "../src/tools/railway-create-project.js";
import { registerRailwayCreateService } from "../src/tools/railway-create-service.js";
import { registerRailwayUpdateServiceSettings } from "../src/tools/railway-update-service-settings.js";
import { registerRailwayCreateVolume } from "../src/tools/railway-create-volume.js";
import { registerRailwayCreateDomain } from "../src/tools/railway-create-domain.js";
import { registerRailwayDeleteService } from "../src/tools/railway-delete-service.js";

// --- Canned entity IDs (UUID-shaped so the resolver treats them as IDs) ------
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const ENV_ID = "33333333-3333-4333-8333-333333333333";
const NEW_PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const NEW_SERVICE_ID = "55555555-5555-4555-8555-555555555555";
const VOLUME_ID = "66666666-6666-4666-8666-666666666666";
const DOMAIN_ID = "77777777-7777-4777-8777-777777777777";
const GENERATED_DOMAIN = "web-production.up.railway.app";

interface CapturedCall {
  query: string;
  variables: Record<string, unknown>;
}

/** Recorded fetch calls for assertion. */
let calls: CapturedCall[] = [];

type Responder = (query: string, variables: Record<string, unknown>) => unknown;

/**
 * Default responder: resolves the project/service/environment name lookups and
 * returns success envelopes for every mutation. `failOn` forces a GraphQL error
 * envelope for any query containing that substring (to simulate a failure).
 */
function makeResponder(failOn?: string): Responder {
  return (query, variables) => {
    if (failOn && query.includes(failOn)) {
      return { errors: [{ message: `simulated failure for ${failOn}` }] };
    }
    // --- Mutations (checked before the singular/plural project queries) ------
    if (query.includes("projectCreate")) {
      const input = (variables.input ?? {}) as { name?: string };
      return {
        data: {
          projectCreate: {
            id: NEW_PROJECT_ID,
            name: input.name ?? "new-project",
            environments: { edges: [{ node: { id: ENV_ID, name: "production" } }] },
          },
        },
      };
    }
    if (query.includes("serviceCreate")) {
      const input = (variables.input ?? {}) as { name?: string };
      return { data: { serviceCreate: { id: NEW_SERVICE_ID, name: input.name ?? "new-service" } } };
    }
    if (query.includes("serviceInstanceUpdate")) {
      return { data: { serviceInstanceUpdate: true } };
    }
    if (query.includes("volumeCreate")) {
      return { data: { volumeCreate: { id: VOLUME_ID, name: "volume-brave-sky" } } };
    }
    if (query.includes("serviceDomainCreate")) {
      return { data: { serviceDomainCreate: { id: DOMAIN_ID, domain: GENERATED_DOMAIN } } };
    }
    if (query.includes("serviceDelete")) {
      return { data: { serviceDelete: true } };
    }
    // --- Resolver queries ---------------------------------------------------
    if (query.includes("project(id:")) {
      return {
        data: {
          project: {
            id: PROJECT_ID,
            name: "prism",
            services: { edges: [{ node: { id: SERVICE_ID, name: "web" } }] },
            environments: { edges: [{ node: { id: ENV_ID, name: "production" } }] },
          },
        },
      };
    }
    if (query.includes("projects")) {
      return { data: { projects: { edges: [{ node: { id: PROJECT_ID, name: "prism" } }] } } };
    }
    throw new Error(`unexpected query in test: ${query}`);
  };
}

/** Install a query-dispatching fetch stub built from `responder`. */
function installFetch(responder: Responder): void {
  globalThis.fetch = (async (_url: unknown, options: { body: string }) => {
    const body = JSON.parse(options.body) as CapturedCall;
    calls.push({ query: body.query, variables: body.variables ?? {} });
    const result = responder(body.query, body.variables ?? {});
    return {
      ok: true,
      status: 200,
      json: async () => result,
      text: async () => JSON.stringify(result),
    };
  }) as unknown as typeof fetch;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Register a tool on a minimal fake server and return its handler. */
function captureHandler(register: (server: never) => void): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  };
  register(fakeServer as never);
  if (!handler) throw new Error("tool handler was not registered");
  return handler;
}

/** Parse the JSON body of a tool response. */
function parseBody(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// railway_create_project
// ---------------------------------------------------------------------------

describe("railway_create_project", () => {
  it("creates a project and returns the production environment (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateProject);
    const res = await handler({ name: "brand-new-project" });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("create_project");
    expect(body.project).toEqual({ id: NEW_PROJECT_ID, name: "brand-new-project" });
    expect(body.production_environment).toEqual({ id: ENV_ID, name: "production" });

    // The name flowed through to the projectCreate mutation input.
    const create = calls.find((c) => c.query.includes("projectCreate"));
    expect((create?.variables.input as { name: string }).name).toBe("brand-new-project");
  });

  it("returns an error payload when projectCreate fails (failure path)", async () => {
    installFetch(makeResponder("projectCreate"));
    const handler = captureHandler(registerRailwayCreateProject);
    const res = await handler({ name: "doomed" });

    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error).toBeDefined();
    expect(body.name).toBe("doomed");
  });
});

// ---------------------------------------------------------------------------
// railway_create_service
// ---------------------------------------------------------------------------

describe("railway_create_service", () => {
  it("creates a repo-based service, applies settings, and passes variables verbatim (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateService);
    const res = await handler({
      project: "prism",
      name: "api",
      environment: "production",
      source: { repo: "brdonath1/api", rootDirectory: "services/api", branch: "main" },
      variables: { DATABASE_URL: "${{Postgres.DATABASE_URL}}", NODE_ENV: "production" },
      region: "us-west1",
    });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("create_service");
    expect(body.service).toEqual({ id: NEW_SERVICE_ID, name: "api" });
    expect((body.source as { type: string }).type).toBe("repo");
    expect(body.variables_set).toEqual(["DATABASE_URL", "NODE_ENV"]);

    // serviceCreate input carried the repo source + verbatim reference syntax.
    const create = calls.find((c) => c.query.includes("serviceCreate"));
    const input = create?.variables.input as {
      source: { repo?: string; image?: string };
      variables: Record<string, string>;
      branch?: string;
    };
    expect(input.source).toEqual({ repo: "brdonath1/api" });
    expect(input.branch).toBe("main");
    // The Railway reference syntax must reach the API completely un-interpolated.
    expect(input.variables.DATABASE_URL).toBe("${{Postgres.DATABASE_URL}}");

    // rootDirectory + region were applied via serviceInstanceUpdate.
    const update = calls.find((c) => c.query.includes("serviceInstanceUpdate"));
    expect(update).toBeDefined();
    expect(update?.variables.input).toEqual({ rootDirectory: "services/api", region: "us-west1" });
  });

  it("creates an image-based service without a settings update (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateService);
    // NOTE: calling the captured handler directly bypasses the MCP SDK's zod
    // parsing, so schema defaults (environment -> "production") are not applied.
    // Pass environment explicitly, as the other railway_* tests do.
    const res = await handler({
      project: "prism",
      name: "cache",
      environment: "production",
      source: { image: "redis:7-alpine" },
    });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect((body.source as { type: string; image: string })).toEqual({
      type: "image",
      image: "redis:7-alpine",
    });
    const create = calls.find((c) => c.query.includes("serviceCreate"));
    expect((create?.variables.input as { source: unknown }).source).toEqual({ image: "redis:7-alpine" });
    // No rootDirectory/region → no instance update.
    expect(calls.some((c) => c.query.includes("serviceInstanceUpdate"))).toBe(false);
  });

  it("rejects a source specifying both repo and image without any network call (validation)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateService);
    const res = await handler({
      project: "prism",
      name: "bad",
      source: { repo: "a/b", image: "redis:7" },
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toMatch(/exactly one of 'repo' or 'image'/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a source specifying neither repo nor image (validation)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateService);
    const res = await handler({ project: "prism", name: "bad", source: {} });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toMatch(/exactly one of 'repo' or 'image'/);
    expect(calls).toHaveLength(0);
  });

  it("returns an error payload when serviceCreate fails (failure path)", async () => {
    installFetch(makeResponder("serviceCreate"));
    const handler = captureHandler(registerRailwayCreateService);
    const res = await handler({
      project: "prism",
      name: "api",
      environment: "production",
      source: { repo: "brdonath1/api" },
    });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error).toBeDefined();
    expect(body.name).toBe("api");
  });
});

// ---------------------------------------------------------------------------
// railway_update_service_settings
// ---------------------------------------------------------------------------

describe("railway_update_service_settings", () => {
  it("updates only the provided settings (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayUpdateServiceSettings);
    const res = await handler({
      project: "prism",
      service: "web",
      environment: "production",
      healthcheckPath: "/health",
      restartPolicy: "ON_FAILURE",
    });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("update_service_settings");
    expect(body.updated).toEqual({ healthcheckPath: "/health", restartPolicyType: "ON_FAILURE" });

    const update = calls.find((c) => c.query.includes("serviceInstanceUpdate"));
    expect(update?.variables).toMatchObject({
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      input: { healthcheckPath: "/health", restartPolicyType: "ON_FAILURE" },
    });
  });

  it("refuses when no settings are provided without any network call (validation)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayUpdateServiceSettings);
    const res = await handler({ project: "prism", service: "web" });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toMatch(/No settings provided/);
    expect(calls).toHaveLength(0);
  });

  it("returns an error payload when serviceInstanceUpdate fails (failure path)", async () => {
    installFetch(makeResponder("serviceInstanceUpdate"));
    const handler = captureHandler(registerRailwayUpdateServiceSettings);
    const res = await handler({
      project: "prism",
      service: "web",
      environment: "production",
      startCommand: "node index.js",
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// railway_create_volume
// ---------------------------------------------------------------------------

describe("railway_create_volume", () => {
  it("creates a volume mounted at the requested path (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateVolume);
    const res = await handler({
      project: "prism",
      service: "web",
      environment: "production",
      mountPath: "/data",
    });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("create_volume");
    expect(body.volume).toEqual({ id: VOLUME_ID, name: "volume-brave-sky", mountPath: "/data" });

    const create = calls.find((c) => c.query.includes("volumeCreate"));
    expect(create?.variables.input).toEqual({
      projectId: PROJECT_ID,
      environmentId: ENV_ID,
      serviceId: SERVICE_ID,
      mountPath: "/data",
    });
  });

  it("returns an error payload when volumeCreate fails (failure path)", async () => {
    installFetch(makeResponder("volumeCreate"));
    const handler = captureHandler(registerRailwayCreateVolume);
    const res = await handler({
      project: "prism",
      service: "web",
      environment: "production",
      mountPath: "/data",
    });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// railway_create_domain
// ---------------------------------------------------------------------------

describe("railway_create_domain", () => {
  it("creates a domain and returns the generated domain (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateDomain);
    const res = await handler({
      project: "prism",
      service: "web",
      environment: "production",
      targetPort: 8080,
    });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("create_domain");
    expect(body.domain).toBe(GENERATED_DOMAIN);
    expect(body.url).toBe(`https://${GENERATED_DOMAIN}`);
    expect(body.targetPort).toBe(8080);

    const create = calls.find((c) => c.query.includes("serviceDomainCreate"));
    expect(create?.variables.input).toEqual({
      environmentId: ENV_ID,
      serviceId: SERVICE_ID,
      targetPort: 8080,
    });
  });

  it("omits targetPort from the mutation when not provided (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayCreateDomain);
    const res = await handler({ project: "prism", service: "web", environment: "production" });

    expect(res.isError).toBeUndefined();
    const create = calls.find((c) => c.query.includes("serviceDomainCreate"));
    expect(create?.variables.input).toEqual({ environmentId: ENV_ID, serviceId: SERVICE_ID });
  });

  it("returns an error payload when serviceDomainCreate fails (failure path)", async () => {
    installFetch(makeResponder("serviceDomainCreate"));
    const handler = captureHandler(registerRailwayCreateDomain);
    const res = await handler({ project: "prism", service: "web", environment: "production" });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// railway_delete_service
// ---------------------------------------------------------------------------

describe("railway_delete_service", () => {
  it("deletes the service when confirm=true (happy path)", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayDeleteService);
    const res = await handler({ project: "prism", service: "web", confirm: true });

    expect(res.isError).toBeUndefined();
    const body = parseBody(res);
    expect(body.action).toBe("delete_service");
    expect(body.deleted).toBe(true);
    expect(body.service).toEqual({ id: SERVICE_ID, name: "web" });

    const del = calls.find((c) => c.query.includes("serviceDelete"));
    expect(del?.variables).toEqual({ id: SERVICE_ID });
  });

  it("refuses (and makes no API call) when confirm is omitted", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayDeleteService);
    const res = await handler({ project: "prism", service: "web" });

    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toMatch(/confirm=true/);
    expect(calls).toHaveLength(0); // no resolution, no delete
  });

  it("refuses when confirm is false", async () => {
    installFetch(makeResponder());
    const handler = captureHandler(registerRailwayDeleteService);
    const res = await handler({ project: "prism", service: "web", confirm: false });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toMatch(/confirm=true/);
    expect(calls).toHaveLength(0);
  });

  it("returns an error payload when serviceDelete fails (failure path)", async () => {
    installFetch(makeResponder("serviceDelete"));
    const handler = captureHandler(registerRailwayDeleteService);
    const res = await handler({ project: "prism", service: "web", confirm: true });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toBeDefined();
  });
});
