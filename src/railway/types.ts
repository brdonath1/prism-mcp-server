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

/** Railway log entry */
export interface RailwayLog {
  message: string;
  timestamp: string;
  severity: string;
}

/** Railway environment variables are returned as a flat key→value object, not an array. */
export type RailwayVariables = Record<string, string>;

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
