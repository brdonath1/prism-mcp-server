/** Supabase operations for the explicitly authenticated operator connection. */
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSupabaseReadiness,
  SupabaseClient,
  SupabaseRequestError,
} from "../supabase/client.js";
import { logger } from "../utils/logger.js";

const projectRef = z.string().min(1).optional().describe(
  "Allowed Supabase project reference. May be omitted only when exactly one project is allowed.",
);
const method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const multipartPart = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  base64: z.string().optional(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
}).strict();
const requestSchema = {
  project_ref: projectRef,
  method: method.default("GET"),
  path: z.string().describe("Relative endpoint path within the selected project's fixed API scope; use an empty string for the exact project or service root. Never a URL."),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional().describe("JSON request body. Supply at most one body format."),
  text_body: z.string().optional(),
  base64_body: z.string().optional(),
  multipart: z.array(multipartPart).min(1).optional(),
  content_type: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional().describe(
    "Additional client-allowlisted headers only. Credentials and host overrides are not accepted.",
  ),
  reveal_secrets: z.boolean().default(false).describe(
    "Explicitly reveal sensitive fields in the response. Keep false for routine inspection; credentials are never logged.",
  ),
};

const SQL_WARNING = "SQL is sent once as a complete batch. If the result is uncertain, verify database state and the migration ledger before retrying; a timeout does not prove rollback.";
const MIGRATION_WARNING = "The Supabase migration API owns the migration journal and version. For existing exact-ledger SQL wrappers, use supabase_execute_sql instead. Verify the ledger before retrying an uncertain result.";

type Payload = Record<string, unknown>;
type Readiness = ReturnType<typeof getSupabaseReadiness>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function result(payload: Payload, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function resolveProject(requested: string | undefined, readiness: Readiness): string {
  if (requested !== undefined) {
    if (!readiness.projectRefs.includes(requested)) {
      throw new ToolInputError("Project reference is not in the configured allowlist.");
    }
    return requested;
  }
  if (readiness.projectRefs.length !== 1) {
    throw new ToolInputError("Provide project_ref explicitly when the allowed project is ambiguous.");
  }
  return readiness.projectRefs[0];
}

class ToolInputError extends Error {}

function requestInput(input: z.infer<z.ZodObject<typeof requestSchema>>, ref: string) {
  const bodyCount = [input.body, input.text_body, input.base64_body, input.multipart]
    .filter((value) => value !== undefined).length;
  if (bodyCount > 1) throw new ToolInputError("Supply only one request body format.");
  return {
    projectRef: ref,
    method: input.method,
    path: input.path,
    query: input.query,
    body: input.body,
    textBody: input.text_body,
    base64Body: input.base64_body,
    multipart: input.multipart,
    contentType: input.content_type,
    headers: input.headers,
    revealSecrets: input.reveal_secrets,
  };
}

/** Registration readiness is metadata-only; handlers independently gate every invocation. */
export function registerSupabaseTools(
  server: McpServer,
  context: { bearerAuthenticated: boolean },
): void {
  if (!getSupabaseReadiness().ready) return;

  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    action: (input: z.infer<z.ZodObject<S>>, readiness: Readiness) => Promise<Payload> | Payload,
    evidence?: (input: z.infer<z.ZodObject<S>>) => Payload,
  ): void {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(name, {
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: !readOnly,
      },
    }, async (raw) => {
      // This guard must precede validation, credential resolution and all client calls.
      if (!context.bearerAuthenticated) {
        return result({ error: { code: "BEARER_REQUIRED", message: "A verified Bearer-authenticated connection is required for Supabase tools." } }, true);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return result({ error: { code: "INVALID_INPUT", message: "Invalid tool input. Check the tool schema." } }, true);
      }
      const metadata = evidence?.(parsed.data) ?? {};
      const start = Date.now();
      try {
        const readiness = getSupabaseReadiness();
        if (!readiness.ready) {
          return result({ ...metadata, error: { code: "NOT_READY", message: "Supabase tools are not currently configured and enabled." } }, true);
        }
        const payload = await action(parsed.data, readiness);
        const status = typeof payload.status === "number" ? payload.status : 200;
        logger.info(`${name} complete`, { status, ms: Date.now() - start });
        return result({ ...payload, ...metadata }, status >= 400);
      } catch (error) {
        logger.warn(`${name} failed`, { status: "failed", ms: Date.now() - start });
        if (error instanceof ToolInputError) {
          return result({ ...metadata, error: { code: "INVALID_INPUT", message: error.message } }, true);
        }
        if (error instanceof SupabaseRequestError) {
          return result({
            ...metadata,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
              ambiguous_mutation: error.ambiguousMutation,
              request_hash: error.requestHash,
              source_hash: error.sourceHash,
            },
          }, true);
        }
        // Unknown exceptions can contain request bodies or credentials: never echo them.
        return result({
          ...metadata,
          error: { code: "REQUEST_FAILED", message: "Supabase request failed. Inspect sanitized operational diagnostics; do not automatically retry a mutation." },
        }, true);
      }
    });
  }

  register("supabase_status",
    "Inspect sanitized Supabase configuration readiness and available operations. Makes no network request and retrieves no customer rows.",
    {}, true, (_input, readiness) => ({
      ready: readiness.ready,
      management_ready: readiness.managementReady,
      project_api_ready: readiness.projectApiReady,
      auth_configured: readiness.authConfigured,
      token_configured: readiness.tokenConfigured,
      project_refs: readiness.projectRefs,
      project_credential_refs: readiness.projectCredentialRefs,
      issues: readiness.issues,
      capabilities: {
        management_api: readiness.managementReady,
        execute_sql: readiness.managementReady,
        apply_migration: readiness.managementReady,
        project_apis: readiness.projectApiReady ? ["rest", "auth", "storage", "functions"] : [],
      },
    }));

  register("supabase_management_request",
    "Call an allowed project's Supabase Management API endpoint using JSON, text, base64 or multipart data. The client enforces fixed project scopes and safe headers. Mutations are sent once; verify state before retrying an uncertain result.",
    requestSchema, false, (input, readiness) => {
      const ref = resolveProject(input.project_ref, readiness);
      return new SupabaseClient().managementRequest(requestInput(input, ref)).then((response) => ({ project_ref: ref, ...response }));
    });

  register("supabase_project_request",
    "Call an allowed project's REST, Auth, Storage or Edge Functions API using server-side project credentials and JSON, text, base64 or multipart data. Mutations are sent once; verify state before retrying an uncertain result.",
    { ...requestSchema, service: z.enum(["rest", "auth", "storage", "functions"]) }, false,
    (input, readiness) => {
      const ref = resolveProject(input.project_ref, readiness);
      return new SupabaseClient().projectRequest({ ...requestInput(input, ref), service: input.service })
        .then((response) => ({ project_ref: ref, ...response }));
    });

  register("supabase_execute_sql",
    `Execute SQL through the allowed project's database/query endpoint, preserving the complete batch exactly. read_only requests the Management API's read-only transaction behavior. ${SQL_WARNING}`,
    {
      project_ref: projectRef,
      query: z.string().min(1).describe("Complete SQL batch. No splitting, trimming or automatic transaction wrapper is applied."),
      parameters: z.array(z.unknown()).optional(),
      read_only: z.boolean().default(false),
    }, false, (input, readiness) => {
      const ref = resolveProject(input.project_ref, readiness);
      return new SupabaseClient().managementRequest({
        projectRef: ref,
        method: "POST",
        path: "database/query",
        body: {
          query: input.query,
          ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
          read_only: input.read_only,
        },
      }).then((response) => ({ project_ref: ref, read_only: input.read_only, ...response }));
    }, (input) => ({ query_sha256: createHash("sha256").update(input.query, "utf8").digest("hex"), warning: SQL_WARNING }));

  register("supabase_apply_migration",
    `Apply a SQL migration through the allowed project's database/migrations endpoint. ${MIGRATION_WARNING}`,
    {
      project_ref: projectRef,
      query: z.string().min(1),
      name: z.string().min(1).optional(),
      rollback: z.string().optional().describe("Optional rollback SQL accepted by the migration API."),
    }, false, (input, readiness) => {
      const ref = resolveProject(input.project_ref, readiness);
      return new SupabaseClient().managementRequest({
        projectRef: ref,
        method: "POST",
        path: "database/migrations",
        body: {
          query: input.query,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.rollback === undefined ? {} : { rollback: input.rollback }),
        },
      }).then((response) => ({ project_ref: ref, ...response }));
    }, (input) => ({ query_sha256: createHash("sha256").update(input.query, "utf8").digest("hex"), warning: MIGRATION_WARNING }));
}
