/**
 * railway_deploy — Manage Railway deployments.
 *
 * Actions:
 * - status: current deployment status, uptime, created timestamp
 * - list: last N deployments with status and timestamps
 * - redeploy: trigger a full rebuild + deploy of the latest deployment
 * - restart: restart the latest deployment without rebuilding
 *
 * Mutations (redeploy/restart) operate on the most recent deployment for the
 * resolved service+environment.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RailwayResolver,
  getLatestDeployment,
  listDeployments,
  redeployDeployment,
  restartDeployment,
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
    .enum(["status", "list", "redeploy", "restart"])
    .optional()
    .default("status")
    .describe("Action to perform"),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(5)
    .describe("Number of deployments to return (only used for the 'list' action)."),
};

export function registerRailwayDeploy(server: McpServer): void {
  server.tool(
    "railway_deploy",
    "Manage Railway deployments — status, list, redeploy, restart. Mutations target the most recent deployment.",
    inputSchema,
    async ({ project, service, environment, action, count }) => {
      const start = Date.now();
      logger.info("railway_deploy", { project, service, environment, action, count });

      try {
        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        const body: Record<string, unknown> = {
          project: resolvedProject.name,
          service: resolvedService.name,
          environment: resolvedEnv.name,
          action,
        };

        if (action === "status") {
          const deployment = await getLatestDeployment(resolvedService.id, resolvedEnv.id);
          body.deployment = deployment ?? null;
          if (!deployment) {
            body.note = "No deployments found for this service/environment combination.";
          }
        } else if (action === "list") {
          const deployments = await listDeployments(resolvedService.id, resolvedEnv.id, count);
          body.count = deployments.length;
          body.deployments = deployments;
        } else if (action === "redeploy" || action === "restart") {
          const latest = await getLatestDeployment(resolvedService.id, resolvedEnv.id);
          if (!latest) {
            throw new Error(
              `No deployments found to ${action} for ${resolvedService.name}/${resolvedEnv.name}.`,
            );
          }
          const result =
            action === "redeploy"
              ? await redeployDeployment(latest.id)
              : await restartDeployment(latest.id);
          body.previous_deployment_id = latest.id;
          body.result = result;
          body.confirmation = `${
            action === "redeploy" ? "Redeployed" : "Restarted"
          } service ${resolvedService.name} in environment ${resolvedEnv.name}. Deployment ID: ${result.id}`;
        }

        logger.info("railway_deploy complete", {
          project: resolvedProject.name,
          service: resolvedService.name,
          action,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_deploy failed", { project, service, action, error: message });
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
