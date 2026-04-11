/**
 * railway_env — Read, set, and delete Railway environment variables.
 *
 * Security: `list` masks sensitive values by default (first 6 chars + `***`).
 * Keys matching KEY/SECRET/TOKEN/PASSWORD/AUTH/CREDENTIAL/PRIVATE and values
 * containing embedded URL credentials (e.g. postgres://user:pass@host) are
 * always masked in `list` output — even when `mask_values=false` — to
 * prevent accidental secret leakage.
 *
 * `get` returns unmasked values when a specific variable is requested by name.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RailwayResolver,
  deleteVariable,
  hasUrlCredentials,
  isSensitiveKey,
  listVariables,
  maskValue,
  maskVariables,
  upsertVariable,
} from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  action: z
    .enum(["list", "get", "set", "delete"])
    .optional()
    .default("list")
    .describe("Action to perform"),
  name: z
    .string()
    .optional()
    .describe("Variable name (required for get/set/delete)"),
  value: z
    .string()
    .optional()
    .describe("Variable value (required for set)"),
  mask_values: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Mask non-sensitive values in list output. Sensitive keys and URLs with credentials are always masked.",
    ),
};

function buildResponse(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

export function registerRailwayEnv(server: McpServer): void {
  server.tool(
    "railway_env",
    "Read, set, and delete Railway environment variables. Sensitive values are masked in list output by default.",
    inputSchema,
    async ({ project, service, environment, action, name, value, mask_values }) => {
      const start = Date.now();
      logger.info("railway_env", {
        project,
        service,
        environment,
        action,
        name,
        mask_values,
      });

      try {
        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        const baseBody = {
          project: resolvedProject.name,
          service: resolvedService.name,
          environment: resolvedEnv.name,
          action,
        };

        if (action === "list") {
          const variables = await listVariables(
            resolvedProject.id,
            resolvedService.id,
            resolvedEnv.id,
          );
          const keys = Object.keys(variables).sort();
          const masked = maskVariables(variables, mask_values);
          const sensitive = keys.filter(
            (k) => isSensitiveKey(k) || hasUrlCredentials(variables[k]),
          );

          logger.info("railway_env complete", {
            project: resolvedProject.name,
            service: resolvedService.name,
            action,
            variable_count: keys.length,
            ms: Date.now() - start,
          });

          return buildResponse({
            ...baseBody,
            variable_count: keys.length,
            sensitive_keys: sensitive,
            masked: mask_values,
            variables: masked,
          });
        }

        if (action === "get") {
          if (!name) {
            return buildResponse(
              { ...baseBody, error: "'name' is required for get action" },
              true,
            );
          }
          const variables = await listVariables(
            resolvedProject.id,
            resolvedService.id,
            resolvedEnv.id,
          );
          if (!(name in variables)) {
            return buildResponse(
              { ...baseBody, name, error: `Variable "${name}" not found` },
              true,
            );
          }
          logger.info("railway_env complete", {
            project: resolvedProject.name,
            service: resolvedService.name,
            action,
            name,
            ms: Date.now() - start,
          });
          return buildResponse({
            ...baseBody,
            name,
            value: variables[name],
          });
        }

        if (action === "set") {
          if (!name) {
            return buildResponse(
              { ...baseBody, error: "'name' is required for set action" },
              true,
            );
          }
          if (value === undefined) {
            return buildResponse(
              { ...baseBody, name, error: "'value' is required for set action" },
              true,
            );
          }
          await upsertVariable(
            resolvedProject.id,
            resolvedService.id,
            resolvedEnv.id,
            name,
            value,
          );
          logger.info("railway_env complete", {
            project: resolvedProject.name,
            service: resolvedService.name,
            action,
            name,
            ms: Date.now() - start,
          });
          return buildResponse({
            ...baseBody,
            name,
            value_preview: maskValue(value),
            confirmation: `Set variable "${name}" on service ${resolvedService.name} in environment ${resolvedEnv.name}.`,
          });
        }

        if (action === "delete") {
          if (!name) {
            return buildResponse(
              { ...baseBody, error: "'name' is required for delete action" },
              true,
            );
          }
          await deleteVariable(
            resolvedProject.id,
            resolvedService.id,
            resolvedEnv.id,
            name,
          );
          logger.info("railway_env complete", {
            project: resolvedProject.name,
            service: resolvedService.name,
            action,
            name,
            ms: Date.now() - start,
          });
          return buildResponse({
            ...baseBody,
            name,
            confirmation: `Deleted variable "${name}" from service ${resolvedService.name} in environment ${resolvedEnv.name}.`,
          });
        }

        return buildResponse({ ...baseBody, error: `Unsupported action: ${action}` }, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_env failed", { project, service, action, error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, project, service, action }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
