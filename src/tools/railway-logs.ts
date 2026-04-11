/**
 * railway_logs — Fetch deployment or environment logs from Railway with
 * optional filtering.
 *
 * Resolves project/service/environment names to IDs via RailwayResolver,
 * then fetches logs from the latest deployment (service-scoped) or the
 * environment as a whole (all services).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RailwayResolver,
  filterLogs,
  getDeploymentLogs,
  getEnvironmentLogs,
  getLatestDeployment,
} from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z
    .string()
    .optional()
    .describe("Service name or ID. Omit for environment-wide logs across all services."),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(50)
    .describe("Number of log lines (max 200)"),
  filter: z
    .string()
    .optional()
    .describe(
      "Railway filter expression. Supports @level:<severity> or substring keyword search.",
    ),
  type: z
    .enum(["deploy", "build", "http"])
    .optional()
    .default("deploy")
    .describe("Log type (currently informational — Railway's deploymentLogs query covers all types)."),
};

export function registerRailwayLogs(server: McpServer): void {
  server.tool(
    "railway_logs",
    "Fetch Railway deployment or environment logs. Supports @level:error filtering and keyword search.",
    inputSchema,
    async ({ project, service, environment, limit, filter, type }) => {
      const start = Date.now();
      logger.info("railway_logs", { project, service, environment, limit, filter, type });

      try {
        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        let response: Record<string, unknown>;

        if (service) {
          const resolvedService = resolver.resolveService(resolvedProject, service);
          const deployment = await getLatestDeployment(resolvedService.id, resolvedEnv.id);

          if (!deployment) {
            response = {
              project: resolvedProject.name,
              service: resolvedService.name,
              environment: resolvedEnv.name,
              type,
              deployment: null,
              log_count: 0,
              logs: [],
              note: "No deployments found for this service/environment combination.",
            };
          } else {
            const rawLogs = await getDeploymentLogs(deployment.id, limit);
            const logs = filterLogs(rawLogs, filter);
            response = {
              project: resolvedProject.name,
              service: resolvedService.name,
              environment: resolvedEnv.name,
              type,
              deployment: {
                id: deployment.id,
                status: deployment.status,
                createdAt: deployment.createdAt,
              },
              filter: filter ?? null,
              log_count: logs.length,
              raw_log_count: rawLogs.length,
              logs,
            };
          }
        } else {
          const logs = await getEnvironmentLogs(resolvedEnv.id, limit, filter);
          response = {
            project: resolvedProject.name,
            service: null,
            environment: resolvedEnv.name,
            type,
            filter: filter ?? null,
            log_count: logs.length,
            logs,
          };
        }

        logger.info("railway_logs complete", {
          project: resolvedProject.name,
          service,
          log_count: (response.log_count as number) ?? 0,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_logs failed", { project, service, error: message });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message, project, service }) },
          ],
          isError: true,
        };
      }
    },
  );
}
