/**
 * railway_delete_service — Permanently delete a Railway service.
 *
 * DESTRUCTIVE and IRREVERSIBLE: removes the service and all of its
 * deployments. As a safety interlock, the caller MUST pass `confirm: true`.
 * Any other value (including omission) is refused with a clear error BEFORE
 * any network call is made.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RailwayResolver, deleteService } from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  service: z.string().describe("Service name or ID"),
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Must be exactly true to proceed. This permanently deletes the service and all its deployments — irreversible.",
    ),
};

export function registerRailwayDeleteService(server: McpServer): void {
  server.tool(
    "railway_delete_service",
    "Permanently delete a Railway service. Requires confirm=true — refuses otherwise. Destructive and irreversible.",
    inputSchema,
    async ({ project, service, confirm }) => {
      const start = Date.now();
      logger.info("railway_delete_service", { project, service, confirm });

      try {
        // Safety interlock — refuse before any network work unless explicitly confirmed.
        if (confirm !== true) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "Refusing to delete service: pass confirm=true to proceed. This is a destructive, irreversible operation.",
                  project,
                  service,
                  confirm: confirm ?? false,
                }),
              },
            ],
            isError: true,
          };
        }

        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedService = resolver.resolveService(resolvedProject, service);

        await deleteService(resolvedService.id);

        logger.info("railway_delete_service complete", {
          project: resolvedProject.name,
          service: resolvedService.name,
          id: resolvedService.id,
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "delete_service",
                  project: resolvedProject.name,
                  service: { id: resolvedService.id, name: resolvedService.name },
                  deleted: true,
                  confirmation: `Deleted service "${resolvedService.name}" (${resolvedService.id}) from project "${resolvedProject.name}".`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_delete_service failed", { project, service, error: message });
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
