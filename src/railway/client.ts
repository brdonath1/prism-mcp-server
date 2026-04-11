/**
 * Railway API client for the PRISM MCP Server.
 *
 * Thin fetch-based wrapper around Railway's GraphQL v2 API. Follows the same
 * pattern as src/github/client.ts: no external dependencies, structured
 * logging, clear error messages, typed responses.
 *
 * Scope is infrastructure operations: project/service/environment inspection,
 * deployment management, log retrieval, and environment variable CRUD.
 */

import {
  RAILWAY_API_ENDPOINT,
  RAILWAY_API_TOKEN,
  MCP_SAFE_TIMEOUT,
  SERVER_VERSION,
} from "../config.js";
import { logger } from "../utils/logger.js";
import type {
  Connection,
  GraphQLResponse,
  RailwayDeployment,
  RailwayEnvironment,
  RailwayLog,
  RailwayProject,
  RailwayService,
  RailwayVariables,
  ResolvedProject,
} from "./types.js";

/** UUID pattern — Railway uses standard v4-style UUIDs for all entity IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Return true if the string looks like a UUID (used to skip name resolution). */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Standard headers for all Railway API requests */
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": `prism-mcp-server/${SERVER_VERSION}`,
  };
}

/**
 * Execute a Railway GraphQL query or mutation.
 *
 * Enforces a 45-second AbortSignal timeout to stay well under MCP_SAFE_TIMEOUT
 * (50s) and leave headroom for response marshalling and downstream work.
 */
export async function railwayQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!RAILWAY_API_TOKEN) {
    throw new Error(
      "Railway API token is not configured. Set RAILWAY_API_TOKEN to enable Railway tools.",
    );
  }

  const start = Date.now();
  const body = JSON.stringify({ query, variables: variables ?? {} });

  logger.debug("railway.query", { bodySize: body.length });

  let res: Response;
  try {
    res = await fetch(RAILWAY_API_ENDPOINT, {
      method: "POST",
      headers: headers(),
      body,
      // 45s — leaves 5s buffer inside the 50s MCP_SAFE_TIMEOUT.
      signal: AbortSignal.timeout(Math.min(45_000, MCP_SAFE_TIMEOUT - 5_000)),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("railway.query network error", { error: msg, ms: Date.now() - start });
    throw new Error(`Railway API network error: ${msg}`);
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      logger.error("railway.query auth failure", { status: res.status });
      throw new Error(
        `Railway authentication failed (${res.status}). Check RAILWAY_API_TOKEN scopes.`,
      );
    }
    if (res.status === 429) {
      logger.warn("railway.query rate limited", { status: res.status });
      throw new Error("Railway API rate limit exceeded (429). Try again shortly.");
    }
    logger.error("railway.query http error", { status: res.status, body: text.slice(0, 500) });
    throw new Error(`Railway API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    const msgs = json.errors.map((e) => e.message).join("; ");
    logger.error("railway.query graphql errors", { errors: msgs, ms: Date.now() - start });
    throw new Error(`Railway GraphQL error: ${msgs}`);
  }
  if (json.data === undefined) {
    throw new Error("Railway API returned an empty response.");
  }

  logger.debug("railway.query complete", { ms: Date.now() - start });
  return json.data;
}

// ---------------------------------------------------------------------------
// Top-level queries
// ---------------------------------------------------------------------------

/**
 * List all projects accessible to the authenticated token.
 */
export async function listProjects(): Promise<RailwayProject[]> {
  const query = `query {
    projects {
      edges {
        node {
          id
          name
        }
      }
    }
  }`;
  const data = await railwayQuery<{ projects: Connection<RailwayProject> }>(query);
  return (data.projects?.edges ?? []).map((e) => e.node);
}

/**
 * Fetch project details including services and environments.
 */
export async function getProject(projectId: string): Promise<ResolvedProject> {
  const query = `query($id: String!) {
    project(id: $id) {
      id
      name
      services {
        edges { node { id name } }
      }
      environments {
        edges { node { id name } }
      }
    }
  }`;
  const data = await railwayQuery<{
    project: {
      id: string;
      name: string;
      services: Connection<RailwayService>;
      environments: Connection<RailwayEnvironment>;
    } | null;
  }>(query, { id: projectId });

  if (!data.project) {
    throw new Error(`Railway project not found: ${projectId}`);
  }
  return {
    id: data.project.id,
    name: data.project.name,
    services: (data.project.services?.edges ?? []).map((e) => e.node),
    environments: (data.project.environments?.edges ?? []).map((e) => e.node),
  };
}

// ---------------------------------------------------------------------------
// Name-to-ID resolution with per-request cache
// ---------------------------------------------------------------------------

/**
 * Per-request resolver that caches project list and per-project details so
 * resolving (project + service + environment) only costs 1-2 API calls.
 *
 * Each tool invocation should create its own resolver. Do NOT share instances
 * across requests — the server is stateless.
 */
export class RailwayResolver {
  private projectsPromise?: Promise<RailwayProject[]>;
  private projectDetails = new Map<string, ResolvedProject>();

  /**
   * Resolve a project name or UUID to its full details (including services
   * and environments). Case-insensitive name matching with a substring
   * fallback.
   */
  async resolveProject(nameOrId: string): Promise<ResolvedProject> {
    if (isUuid(nameOrId)) {
      const cached = this.projectDetails.get(nameOrId);
      if (cached) return cached;
      try {
        const details = await getProject(nameOrId);
        this.projectDetails.set(details.id, details);
        return details;
      } catch (error) {
        logger.warn("railway.resolveProject uuid lookup failed, trying name match", {
          nameOrId,
          error: (error as Error).message,
        });
        // Fall through — the string might still match a project name.
      }
    }

    const projects = await this.listProjectsCached();
    const lower = nameOrId.toLowerCase().trim();
    const match =
      projects.find((p) => p.name.toLowerCase() === lower) ??
      projects.find((p) => p.name.toLowerCase().includes(lower));

    if (!match) {
      const available = projects.map((p) => p.name).join(", ");
      throw new Error(
        `Railway project not found: "${nameOrId}". Available: ${available || "(none)"}`,
      );
    }

    const cached = this.projectDetails.get(match.id);
    if (cached) return cached;
    const details = await getProject(match.id);
    this.projectDetails.set(details.id, details);
    return details;
  }

  /**
   * Resolve a service name or UUID within an already-resolved project.
   * Prefers exact match, falls back to substring.
   */
  resolveService(project: ResolvedProject, nameOrId: string): RailwayService {
    if (isUuid(nameOrId)) {
      const byId = project.services.find((s) => s.id === nameOrId);
      if (byId) return byId;
    }
    const lower = nameOrId.toLowerCase().trim();
    const match =
      project.services.find((s) => s.name.toLowerCase() === lower) ??
      project.services.find((s) => s.name.toLowerCase().includes(lower));
    if (!match) {
      const available = project.services.map((s) => s.name).join(", ");
      throw new Error(
        `Railway service not found: "${nameOrId}" in project "${project.name}". Available: ${available || "(none)"}`,
      );
    }
    return match;
  }

  /**
   * Resolve an environment name or UUID within an already-resolved project.
   */
  resolveEnvironment(project: ResolvedProject, nameOrId: string): RailwayEnvironment {
    if (isUuid(nameOrId)) {
      const byId = project.environments.find((e) => e.id === nameOrId);
      if (byId) return byId;
    }
    const lower = nameOrId.toLowerCase().trim();
    const match =
      project.environments.find((e) => e.name.toLowerCase() === lower) ??
      project.environments.find((e) => e.name.toLowerCase().includes(lower));
    if (!match) {
      const available = project.environments.map((e) => e.name).join(", ");
      throw new Error(
        `Railway environment not found: "${nameOrId}" in project "${project.name}". Available: ${available || "(none)"}`,
      );
    }
    return match;
  }

  private async listProjectsCached(): Promise<RailwayProject[]> {
    if (!this.projectsPromise) {
      this.projectsPromise = listProjects();
    }
    return this.projectsPromise;
  }
}

// ---------------------------------------------------------------------------
// Deployment operations
// ---------------------------------------------------------------------------

/** Fetch the latest deployment for a (service, environment) pair. */
export async function getLatestDeployment(
  serviceId: string,
  environmentId: string,
): Promise<RailwayDeployment | null> {
  const query = `query($serviceId: String!, $environmentId: String!) {
    deployments(first: 1, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges {
        node {
          id
          status
          createdAt
        }
      }
    }
  }`;
  const data = await railwayQuery<{ deployments: Connection<RailwayDeployment> }>(query, {
    serviceId,
    environmentId,
  });
  const edges = data.deployments?.edges ?? [];
  if (edges.length === 0) return null;
  return edges[0].node;
}

/** List the most recent `count` deployments for a (service, environment) pair. */
export async function listDeployments(
  serviceId: string,
  environmentId: string,
  count: number,
): Promise<RailwayDeployment[]> {
  const capped = Math.max(1, Math.min(count, 50));
  const query = `query($serviceId: String!, $environmentId: String!, $count: Int!) {
    deployments(first: $count, input: { serviceId: $serviceId, environmentId: $environmentId }) {
      edges {
        node {
          id
          status
          createdAt
        }
      }
    }
  }`;
  const data = await railwayQuery<{ deployments: Connection<RailwayDeployment> }>(query, {
    serviceId,
    environmentId,
    count: capped,
  });
  return (data.deployments?.edges ?? []).map((e) => e.node);
}

/** Fetch deployment logs. Filter is applied client-side (see filterLogs). */
export async function getDeploymentLogs(
  deploymentId: string,
  limit: number,
): Promise<RailwayLog[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const query = `query($deploymentId: String!, $limit: Int!) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      ... on Log {
        message
        timestamp
        severity
      }
    }
  }`;
  const data = await railwayQuery<{ deploymentLogs: RailwayLog[] }>(query, {
    deploymentId,
    limit: capped,
  });
  return data.deploymentLogs ?? [];
}

/**
 * Fetch environment-wide logs (across all services). Railway accepts a
 * filter expression here (e.g. `@level:error`).
 */
export async function getEnvironmentLogs(
  environmentId: string,
  limit: number,
  filter?: string,
): Promise<RailwayLog[]> {
  const capped = Math.max(1, Math.min(limit, 200));
  const params: string[] = ["$environmentId: String!", "$limit: Int!"];
  const args: string[] = ["environmentId: $environmentId", "limit: $limit"];
  if (filter) {
    params.push("$filter: String!");
    args.push("filter: $filter");
  }
  const query = `query(${params.join(", ")}) {
    environmentLogs(${args.join(", ")}) {
      ... on Log {
        message
        timestamp
        severity
      }
    }
  }`;
  const vars: Record<string, unknown> = { environmentId, limit: capped };
  if (filter) vars.filter = filter;
  const data = await railwayQuery<{ environmentLogs: RailwayLog[] }>(query, vars);
  return data.environmentLogs ?? [];
}

/**
 * Apply a Railway-style filter expression to an in-memory log list.
 *
 * Supports `@level:<severity>` (exact severity match, case-insensitive) and
 * falls back to a case-insensitive substring search on the message body.
 * An empty filter returns the input unchanged.
 */
export function filterLogs(logs: RailwayLog[], filter: string | undefined): RailwayLog[] {
  if (!filter) return logs;
  const trimmed = filter.trim();
  if (!trimmed) return logs;

  const levelMatch = trimmed.match(/^@level:(\w+)$/i);
  if (levelMatch) {
    const want = levelMatch[1].toLowerCase();
    return logs.filter((l) => (l.severity ?? "").toLowerCase() === want);
  }

  const lower = trimmed.toLowerCase();
  return logs.filter((l) => (l.message ?? "").toLowerCase().includes(lower));
}

/**
 * Trigger a full redeploy (rebuild + deploy) of an existing deployment.
 *
 * Note: the `deploymentRedeploy` mutation has not yet been exercised from the
 * S143 verification run. If Railway changes the schema, surface the error
 * rather than silently retrying.
 */
export async function redeployDeployment(
  deploymentId: string,
): Promise<{ id: string; status: string }> {
  const query = `mutation($id: String!) {
    deploymentRedeploy(id: $id) {
      id
      status
    }
  }`;
  const data = await railwayQuery<{ deploymentRedeploy: { id: string; status: string } }>(
    query,
    { id: deploymentId },
  );
  return data.deploymentRedeploy;
}

/**
 * Restart a deployment without rebuilding.
 *
 * Note: the `deploymentRestart` mutation has not yet been exercised from the
 * S143 verification run. If Railway changes the schema, surface the error.
 */
export async function restartDeployment(
  deploymentId: string,
): Promise<{ id: string; status: string }> {
  const query = `mutation($id: String!) {
    deploymentRestart(id: $id) {
      id
      status
    }
  }`;
  const data = await railwayQuery<{ deploymentRestart: { id: string; status: string } }>(
    query,
    { id: deploymentId },
  );
  return data.deploymentRestart;
}

// ---------------------------------------------------------------------------
// Variables operations
// ---------------------------------------------------------------------------

/**
 * List all environment variables for a (project, service, environment).
 * Railway returns a flat key→value object (not an edges/node array).
 */
export async function listVariables(
  projectId: string,
  serviceId: string,
  environmentId: string,
): Promise<RailwayVariables> {
  const query = `query($projectId: String!, $serviceId: String!, $environmentId: String!) {
    variables(
      projectId: $projectId,
      serviceId: $serviceId,
      environmentId: $environmentId,
      unrendered: false
    )
  }`;
  const data = await railwayQuery<{ variables: RailwayVariables }>(query, {
    projectId,
    serviceId,
    environmentId,
  });
  return data.variables ?? {};
}

/** Upsert a single variable (create or update). */
export async function upsertVariable(
  projectId: string,
  serviceId: string,
  environmentId: string,
  name: string,
  value: string,
): Promise<void> {
  const query = `mutation($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
  }`;
  await railwayQuery<{ variableUpsert: boolean }>(query, {
    input: { projectId, serviceId, environmentId, name, value },
  });
}

/** Delete a single variable. */
export async function deleteVariable(
  projectId: string,
  serviceId: string,
  environmentId: string,
  name: string,
): Promise<void> {
  const query = `mutation($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }`;
  await railwayQuery<{ variableDelete: boolean }>(query, {
    input: { projectId, serviceId, environmentId, name },
  });
}

// ---------------------------------------------------------------------------
// Masking helpers (security — never leak secrets in tool responses)
// ---------------------------------------------------------------------------

/** Variable name patterns that signal a secret/sensitive value. */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /AUTH/i,
  /CREDENTIAL/i,
  /PRIVATE/i,
];

/** URL with embedded userinfo credentials (e.g. postgres://user:pass@host/db). */
const URL_WITH_CREDS_RE = /^[a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+:[^\s@]+@/i;

/** Return true if the variable name looks sensitive. */
export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(name));
}

/** Return true if the value is a URL with embedded credentials. */
export function hasUrlCredentials(value: string): boolean {
  return URL_WITH_CREDS_RE.test(value);
}

/**
 * Mask a value by keeping the first `prefix` characters and appending `***`.
 * Values shorter than `prefix` are masked entirely.
 */
export function maskValue(value: string, prefix = 6): string {
  if (!value) return "";
  if (value.length <= prefix) return "***";
  return value.slice(0, prefix) + "***";
}

/**
 * Mask a variables object.
 *
 * - If `maskAll` is true, every value is masked.
 * - If `maskAll` is false, only values whose key looks sensitive OR whose
 *   value is a URL with embedded credentials are masked. Safe variables
 *   (e.g. `NODE_ENV=production`) are returned unchanged.
 */
export function maskVariables(
  vars: RailwayVariables,
  maskAll: boolean,
): RailwayVariables {
  const out: RailwayVariables = {};
  for (const [key, value] of Object.entries(vars)) {
    const sensitive = isSensitiveKey(key) || hasUrlCredentials(value);
    if (maskAll || sensitive) {
      out[key] = maskValue(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
