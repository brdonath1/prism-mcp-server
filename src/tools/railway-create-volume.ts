/**
 * railway_create_volume — Attach a persistent volume to a Railway service at a
 * given mount path.
 *
 * The volume is created in the service's environment (defaults to production,
 * matching the other Railway tools).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RailwayResolver, createVolume } from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  mountPath: z
    .string()
    .min(1)
    .describe("Absolute path inside the container where the volume is mounted, e.g. /data"),
};

export function registerRailwayCreateVolume(server: McpServer): void {
  server.tool(
    "railway_create_volume",
    "Create a persistent Railway volume and mount it into a service at the given path.",
    inputSchema,
    async ({ project, service, environment, mountPath }) => {
      const start = Date.now();
      logger.info("railway_create_volume", { project, service, environment, mountPath });

      try {
        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        const volume = await createVolume(
          resolvedProject.id,
          resolvedEnv.id,
          resolvedService.id,
          mountPath,
        );

        logger.info("railway_create_volume complete", {
          project: resolvedProject.name,
          service: resolvedService.name,
          volume_id: volume.id,
          mountPath,
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "create_volume",
                  project: resolvedProject.name,
                  service: resolvedService.name,
                  environment: resolvedEnv.name,
                  volume: { id: volume.id, name: volume.name, mountPath },
                  confirmation: `Created volume "${volume.name}" (${volume.id}) mounted at ${mountPath} on service "${resolvedService.name}".`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_create_volume failed", { project, service, error: message });
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
