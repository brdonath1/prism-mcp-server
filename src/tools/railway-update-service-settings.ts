/**
 * railway_update_service_settings — Update service-instance settings for a
 * service in a given environment (defaults to production).
 *
 * Wraps Railway's serviceInstanceUpdate. Only the fields you pass are changed;
 * omitted fields are left untouched. At least one setting must be provided.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RailwayResolver, updateServiceInstanceSettings } from "../railway/client.js";
import type { RailwayServiceInstanceSettings } from "../railway/types.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  rootDirectory: z
    .string()
    .optional()
    .describe("Monorepo subdirectory to build/deploy from"),
  startCommand: z.string().optional().describe("Override the service start command"),
  healthcheckPath: z
    .string()
    .optional()
    .describe("HTTP path Railway polls to gate a deploy as healthy, e.g. /health"),
  restartPolicy: z
    .enum(["ON_FAILURE", "ALWAYS", "NEVER"])
    .optional()
    .describe("Restart policy applied to the service container"),
};

export function registerRailwayUpdateServiceSettings(server: McpServer): void {
  server.tool(
    "railway_update_service_settings",
    "Update Railway service settings (rootDirectory, startCommand, healthcheckPath, restartPolicy) for a service in an environment.",
    inputSchema,
    async ({ project, service, environment, rootDirectory, startCommand, healthcheckPath, restartPolicy }) => {
      const start = Date.now();
      logger.info("railway_update_service_settings", {
        project,
        service,
        environment,
        rootDirectory,
        startCommand,
        healthcheckPath,
        restartPolicy,
      });

      try {
        const settings: RailwayServiceInstanceSettings = {};
        if (rootDirectory !== undefined) settings.rootDirectory = rootDirectory;
        if (startCommand !== undefined) settings.startCommand = startCommand;
        if (healthcheckPath !== undefined) settings.healthcheckPath = healthcheckPath;
        if (restartPolicy !== undefined) settings.restartPolicyType = restartPolicy;

        if (Object.keys(settings).length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "No settings provided. Pass at least one of rootDirectory, startCommand, healthcheckPath, restartPolicy.",
                  project,
                  service,
                }),
              },
            ],
            isError: true,
          };
        }

        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        await updateServiceInstanceSettings(resolvedService.id, resolvedEnv.id, settings);

        logger.info("railway_update_service_settings complete", {
          project: resolvedProject.name,
          service: resolvedService.name,
          environment: resolvedEnv.name,
          updated: Object.keys(settings),
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "update_service_settings",
                  project: resolvedProject.name,
                  service: resolvedService.name,
                  environment: resolvedEnv.name,
                  updated: settings,
                  confirmation: `Updated settings [${Object.keys(settings).join(", ")}] on service "${resolvedService.name}" in environment ${resolvedEnv.name}.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_update_service_settings failed", {
          project,
          service,
          error: message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, project, service }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
