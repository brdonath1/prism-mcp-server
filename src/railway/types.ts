/**
 * Railway GraphQL API response and internal types for the PRISM MCP Server.
 */

/** Railway project (top-level resource) */
export interface RailwayProject {
  id: string;
  name: string;
}

/** Railway service */
export interface RailwayService {
  id: string;
  name: string;
}

/** Railway environment */
export interface RailwayEnvironment {
  id: string;
  name: string;
}

/** Railway deployment */
export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  canRollback?: boolean;
  staticUrl?: string;
}

/** A single key/value pair from Railway's structured log attributes. */
export interface RailwayLogAttribute {
  key: string;
  value: string;
}

/**
 * Railway log entry.
 *
 * `attributes` carries the structured payload written by the logger
 * (`logger.error(msg, { err, stack, repo, path, ... })`). Railway's GraphQL
 * `Log.attributes` is `[LogAttribute!]!` — shape `{ key, value }`. Optional on
 * this interface for backward compatibility with callers that mock logs
 * without it.
 */
export interface RailwayLog {
  message: string;
  timestamp: string;
  severity: string;
  attributes?: RailwayLogAttribute[];
}

/** Railway environment variables are returned as a flat key→value object, not an array. */
export type RailwayVariables = Record<string, string>;

/**
 * Service source — repo-based OR image-based deploy. Railway's
 * `ServiceSourceInput` accepts exactly one of these; callers enforce the
 * mutual exclusivity before building the mutation input.
 */
export interface RailwayServiceSource {
  /** GitHub repo in `owner/name` form for repo-based deploys. */
  repo?: string;
  /** Docker image reference (e.g. `postgres:16-alpine`) for image-based deploys. */
  image?: string;
}

/**
 * Service-instance settings updatable via `serviceInstanceUpdate`. Only the
 * provided fields are sent; omitted fields are left unchanged server-side.
 */
export interface RailwayServiceInstanceSettings {
  rootDirectory?: string;
  startCommand?: string;
  healthcheckPath?: string;
  /** Railway `RestartPolicyType` enum. */
  restartPolicyType?: "ON_FAILURE" | "ALWAYS" | "NEVER";
  region?: string;
}

/** Result of `volumeCreate`. */
export interface RailwayVolume {
  id: string;
  name: string;
}

/** Result of `serviceDomainCreate` — the generated Railway domain. */
export interface RailwayServiceDomain {
  id: string;
  domain: string;
}

/**
 * Result of `projectCreate`. Includes the auto-created environments (Railway
 * seeds a default `production` environment) so callers can immediately scope
 * follow-up service/volume/domain operations.
 */
export interface RailwayCreatedProject {
  id: string;
  name: string;
  environments: RailwayEnvironment[];
}

/** Standard GraphQL edges/node connection pattern */
export interface Connection<T> {
  edges: Array<{ node: T }>;
}

/** Resolved project with its services and environments (used by RailwayResolver) */
export interface ResolvedProject {
  id: string;
  name: string;
  services: RailwayService[];
  environments: RailwayEnvironment[];
}

/** GraphQL error from Railway */
export interface RailwayGraphQLError {
  message: string;
  path?: string[];
  extensions?: Record<string, unknown>;
}

/** Raw GraphQL response envelope */
export interface GraphQLResponse<T> {
  data?: T;
  errors?: RailwayGraphQLError[];
}
