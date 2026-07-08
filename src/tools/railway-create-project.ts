/**
 * railway_create_project — Create a new Railway project.
 *
 * Railway auto-creates a default `production` environment for every new
 * project; it is surfaced in the response so a subsequent railway_create_service
 * call can target it immediately. When RAILWAY_WORKSPACE_ID is configured
 * (workspace-scoped token), the project is created inside that workspace.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createProject } from "../railway/client.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  name: z.string().min(1).describe("Name for the new Railway project"),
};

export function registerRailwayCreateProject(server: McpServer): void {
  server.tool(
    "railway_create_project",
    "Create a new Railway project. Returns the project ID and its auto-created production environment.",
    inputSchema,
    async ({ name }) => {
      const start = Date.now();
      logger.info("railway_create_project", { name });

      try {
        const project = await createProject(name);
        const productionEnv =
          project.environments.find((e) => e.name.toLowerCase() === "production") ??
          project.environments[0] ??
          null;

        logger.info("railway_create_project complete", {
          project: project.name,
          id: project.id,
          environment_count: project.environments.length,
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "create_project",
                  project: { id: project.id, name: project.name },
                  environments: project.environments.map((e) => ({ id: e.id, name: e.name })),
                  production_environment: productionEnv
                    ? { id: productionEnv.id, name: productionEnv.name }
                    : null,
                  confirmation: `Created Railway project "${project.name}" (${project.id}).`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_create_project failed", { name, error: message });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: message, name }) },
          ],
          isError: true,
        };
      }
    },
  );
}
