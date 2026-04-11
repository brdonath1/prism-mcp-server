/**
 * railway_status — High-level Railway project / service health overview.
 *
 * - No `project`: list all accessible Railway projects.
 * - With `project`: show project details, environments, and (by default) the
 *   latest deployment status for each service in the primary environment
 *   (production, falling back to the first available environment).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RailwayResolver,
  getLatestDeployment,
  listProjects,
} from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z
    .string()
    .optional()
    .describe("Project name or ID. Omit to list all accessible projects."),
  include_services: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include per-service details with latest deployment status."),
};

export function registerRailwayStatus(server: McpServer): void {
  server.tool(
    "railway_status",
    "High-level Railway project/service health overview. Omit project to list all accessible projects.",
    inputSchema,
    async ({ project, include_services }) => {
      const start = Date.now();
      logger.info("railway_status", { project: project ?? "(all)", include_services });

      try {
        // Multi-project listing
        if (!project) {
          const projects = await listProjects();
          logger.info("railway_status complete (all)", {
            count: projects.length,
            ms: Date.now() - start,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    total_projects: projects.length,
                    projects: projects.map((p) => ({ id: p.id, name: p.name })),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);

        const body: Record<string, unknown> = {
          id: resolvedProject.id,
          name: resolvedProject.name,
          environments: resolvedProject.environments.map((e) => ({
            id: e.id,
            name: e.name,
          })),
          service_count: resolvedProject.services.length,
        };

        if (include_services && resolvedProject.services.length > 0) {
          const primaryEnv =
            resolvedProject.environments.find(
              (e) => e.name.toLowerCase() === "production",
            ) ?? resolvedProject.environments[0];

          if (primaryEnv) {
            const statuses = await Promise.allSettled(
              resolvedProject.services.map(async (s) => {
                const deployment = await getLatestDeployment(s.id, primaryEnv.id);
                return {
                  id: s.id,
                  name: s.name,
                  environment: primaryEnv.name,
                  latest_deployment: deployment ?? null,
                };
              }),
            );

            body.primary_environment = primaryEnv.name;
            body.services = statuses.map((outcome, idx) => {
              if (outcome.status === "fulfilled") return outcome.value;
              const svc = resolvedProject.services[idx];
              return {
                id: svc.id,
                name: svc.name,
                environment: primaryEnv.name,
                error:
                  (outcome.reason instanceof Error
                    ? outcome.reason.message
                    : String(outcome.reason)) ?? "unknown error",
              };
            });
          } else {
            body.services = resolvedProject.services.map((s) => ({
              id: s.id,
              name: s.name,
            }));
          }
        } else if (!include_services) {
          body.services = resolvedProject.services.map((s) => ({
            id: s.id,
            name: s.name,
          }));
        } else {
          body.services = [];
        }

        logger.info("railway_status complete (single)", {
          project: resolvedProject.name,
          service_count: resolvedProject.services.length,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_status failed", { project, error: message });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message, project }) },
          ],
          isError: true,
        };
      }
    },
  );
}
