/**
 * railway_create_service — Create a service inside an existing Railway project.
 *
 * Supports BOTH deploy sources:
 *   - repo-based:  source.repo (owner/name), optional rootDirectory + branch
 *   - image-based: source.image (Docker image reference)
 * Exactly one of repo/image must be provided.
 *
 * Variables are forwarded to Railway VERBATIM — Railway reference syntax such
 * as `${{Postgres.DATABASE_URL}}` is never interpolated server-side here, so it
 * reaches the API untouched and resolves against the target environment.
 *
 * `rootDirectory` and `region` are not part of Railway's ServiceCreateInput, so
 * they are applied via a follow-up serviceInstanceUpdate once the service
 * exists. The environment defaults to production, matching the other tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RailwayResolver,
  createService,
  updateServiceInstanceSettings,
} from "../railway/client.js";
import type { RailwayServiceInstanceSettings } from "../railway/types.js";
import { logger } from "../utils/logger.js";

const inputSchema = {
  project: z.string().describe("Project name or ID"),
  name: z.string().min(1).describe("Name for the new service"),
  environment: z
    .string()
    .optional()
    .default("production")
    .describe("Environment name or ID"),
  source: z
    .object({
      repo: z
        .string()
        .optional()
        .describe("GitHub repo in owner/name form (repo-based deploy)"),
      rootDirectory: z
        .string()
        .optional()
        .describe("Monorepo subdirectory to deploy (repo-based only)"),
      branch: z
        .string()
        .optional()
        .describe("Git branch to deploy (repo-based only)"),
      image: z
        .string()
        .optional()
        .describe("Docker image reference, e.g. postgres:16-alpine (image-based deploy)"),
    })
    .describe(
      "Deploy source. Provide EITHER repo (with optional rootDirectory/branch) OR image — exactly one.",
    ),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: documents the literal Railway reference syntax, which is passed through verbatim (never interpolated).
      "Environment variables as a key→value map. Railway reference syntax like ${{Postgres.DATABASE_URL}} is passed through verbatim (never interpolated server-side).",
    ),
  region: z
    .string()
    .optional()
    .describe("Deploy region, e.g. us-west1. Applied as a service-instance setting after creation."),
};

export function registerRailwayCreateService(server: McpServer): void {
  server.tool(
    "railway_create_service",
    "Create a Railway service from a GitHub repo or a Docker image. Supports variables (with reference-syntax passthrough), rootDirectory, branch, and region.",
    inputSchema,
    async ({ project, name, environment, source, variables, region }) => {
      const start = Date.now();
      logger.info("railway_create_service", {
        project,
        name,
        environment,
        source_type: source?.image ? "image" : source?.repo ? "repo" : "unknown",
        has_variables: !!variables && Object.keys(variables).length > 0,
        region,
      });

      try {
        // Validate mutually-exclusive source before doing any network work.
        const hasRepo = !!source?.repo;
        const hasImage = !!source?.image;
        if (hasRepo === hasImage) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "source must specify exactly one of 'repo' or 'image'.",
                  project,
                  name,
                }),
              },
            ],
            isError: true,
          };
        }
        if (hasImage && (source.rootDirectory || source.branch)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error:
                    "rootDirectory and branch are only valid for repo-based sources, not image-based.",
                  project,
                  name,
                }),
              },
            ],
            isError: true,
          };
        }

        const resolver = new RailwayResolver();
        const resolvedProject = await resolver.resolveProject(project);
        const resolvedEnv = resolver.resolveEnvironment(resolvedProject, environment);

        const created = await createService({
          projectId: resolvedProject.id,
          name,
          environmentId: resolvedEnv.id,
          source: hasRepo ? { repo: source.repo } : { image: source.image },
          branch: hasRepo ? source.branch : undefined,
          variables,
        });

        // rootDirectory/region are instance settings, not ServiceCreateInput
        // fields — apply them in a follow-up mutation when provided.
        const settings: RailwayServiceInstanceSettings = {};
        if (hasRepo && source.rootDirectory) settings.rootDirectory = source.rootDirectory;
        if (region) settings.region = region;
        const appliedSettings = Object.keys(settings).length > 0;
        if (appliedSettings) {
          await updateServiceInstanceSettings(created.id, resolvedEnv.id, settings);
        }

        logger.info("railway_create_service complete", {
          project: resolvedProject.name,
          service: created.name,
          id: created.id,
          applied_settings: appliedSettings,
          ms: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "create_service",
                  project: { id: resolvedProject.id, name: resolvedProject.name },
                  environment: { id: resolvedEnv.id, name: resolvedEnv.name },
                  service: { id: created.id, name: created.name },
                  source: hasRepo
                    ? {
                        type: "repo",
                        repo: source.repo,
                        rootDirectory: source.rootDirectory ?? null,
                        branch: source.branch ?? null,
                      }
                    : { type: "image", image: source.image },
                  region: region ?? null,
                  variables_set: variables ? Object.keys(variables).sort() : [],
                  confirmation: `Created service "${created.name}" (${created.id}) in project "${resolvedProject.name}".`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("railway_create_service failed", { project, name, error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, project, name }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
