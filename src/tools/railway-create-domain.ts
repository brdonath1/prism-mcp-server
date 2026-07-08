/**
 * railway_create_domain — Generate a Railway service domain (e.g.
 * *.up.railway.app) for a service and return the generated domain.
 *
 * `targetPort` binds the domain to a specific container port; omit it to let
 * Railway infer the port. The environment defaults to production, matching the
 * other Railway tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RailwayResolver, createServiceDomain } from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  targetPort: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe("Container port to bind the domain to. Omit to let Railway infer it."),
};

export function registerRailwayCreateDomain(server: McpServer): void {
  server.tool(
    "railway_create_domain",
    "Generate a Railway service domain for a service and return the generated domain URL.",
    inputSchema,
    async ({ project, service, environment, targetPort }) => {
      const start = Date.now();
      logger.info("railway_create_domain", { project, service, environment, targetPort });

      try {
        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        const created = await createServiceDomain(resolvedEnv.id, resolvedService.id, targetPort);

        logger.info("railway_create_domain complete", {
          project: resolvedProject.name,
          service: resolvedService.name,
          domain: created.domain,
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "create_domain",
                  project: resolvedProject.name,
                  service: resolvedService.name,
                  environment: resolvedEnv.name,
                  domain: created.domain,
                  url: `https://${created.domain}`,
                  domain_id: created.id,
                  targetPort: targetPort ?? null,
                  confirmation: `Created domain ${created.domain} for service "${resolvedService.name}" in environment ${resolvedEnv.name}.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_create_domain failed", { project, service, error: message });
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
