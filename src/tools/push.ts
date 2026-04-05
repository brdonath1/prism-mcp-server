/**
 * prism_push tool — Push files with server-side validation.
 * Validates ALL files first; if any fail, pushes NONE.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pushFile, fetchFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { validateFileAndCommit } from "../validation/index.js";
import { templateCache } from "../utils/cache.js";
import { FRAMEWORK_REPO, MCP_TEMPLATE_PATH } from "../config.js";
import { guardPushPath } from "../utils/doc-guard.js";

/** Input schema for prism_push */
const inputSchema = {
  project_slug: z.string().describe("Project repo name"),
  files: z.array(
    z.object({
      path: z.string().describe("File path relative to repo root"),
      content: z.string().describe("File content to push"),
      message: z.string().describe("Commit message (must start with prism:, fix:, docs:, or chore:)"),
    })
  ).describe("Files to push"),
  skip_validation: z.boolean().optional().default(false).describe("Skip validation (not recommended)"),
};

/**
 * Register the prism_push tool on an MCP server instance.
 */
export function registerPush(server: McpServer): void {
  server.tool(
    "prism_push",
    "Push files to a PRISM project repo. Validates all files first — none pushed if any fail.",
    inputSchema,
    async ({ project_slug, files, skip_validation }) => {
      const start = Date.now();
      logger.info("prism_push", { project_slug, fileCount: files.length, skip_validation });

      try {
        // 1. Validate ALL files first
        const validationResults = files.map((file) => {
          if (skip_validation) {
            return { path: file.path, errors: [] as string[], warnings: [] as string[] };
          }
          const result = validateFileAndCommit(file.path, file.content, file.message);
          return { path: file.path, ...result };
        });

        // Check if any validations failed
        const hasErrors = validationResults.some(r => r.errors.length > 0);

        if (hasErrors) {
          // Return all validation errors without pushing anything
          const results = validationResults.map(r => ({
            path: r.path,
            success: false,
            size_bytes: 0,
            sha: "",
            verified: false,
            validation_errors: r.errors,
            validation_warnings: r.warnings,
          }));

          logger.warn("prism_push validation failed", {
            project_slug,
            errorCount: results.reduce((sum, r) => sum + r.validation_errors.length, 0),
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: project_slug,
                results,
                all_succeeded: false,
                files_pushed: 0,
                files_failed: files.length,
                total_bytes: 0,
              }, null, 2),
            }],
          };
        }

        // 2. Guard all paths against root-level duplication (D-67 addendum)
        const guardResults = await Promise.all(
          files.map(file => guardPushPath(project_slug, file.path))
        );

        // 3. Push all validated files in parallel using guarded paths
        const pushResults = await Promise.allSettled(
          files.map(async (file, idx) => {
            const guarded = guardResults[idx];
            const pushPath = guarded.path;

            const pushResult = await pushFile(project_slug, pushPath, file.content, file.message);

            // Verify the push by fetching the file back and checking SHA
            let verified = false;
            if (pushResult.success) {
              try {
                const verifyResult = await fetchFile(project_slug, pushPath);
                verified = verifyResult.sha === pushResult.sha;
              } catch {
                // Verification failed but push might have succeeded
                verified = false;
              }
            }

            return {
              path: pushPath,
              original_path: guarded.redirected ? file.path : undefined,
              redirected: guarded.redirected,
              success: pushResult.success,
              size_bytes: pushResult.size,
              sha: pushResult.sha,
              verified,
              validation_errors: validationResults[idx].errors,
              validation_warnings: validationResults[idx].warnings,
              error: pushResult.error,
            };
          })
        );

        const results = pushResults.map((outcome, idx) => {
          if (outcome.status === "fulfilled") {
            return outcome.value;
          }
          return {
            path: files[idx].path,
            success: false,
            size_bytes: 0,
            sha: "",
            verified: false,
            validation_errors: [] as string[],
            validation_warnings: [] as string[],
            error: outcome.reason?.message ?? "Unknown push error",
          };
        });

        const succeeded = results.filter(r => r.success);
        const totalBytes = succeeded.reduce((sum, r) => sum + r.size_bytes, 0);

        // 3. Invalidate template cache if we just pushed an update to the core template
        if (project_slug === FRAMEWORK_REPO) {
          const templatePushed = succeeded.some(r => r.path === MCP_TEMPLATE_PATH);
          if (templatePushed) {
            templateCache.invalidate(MCP_TEMPLATE_PATH);
            logger.info("template cache invalidated", { reason: "core template pushed via prism_push" });
          }
        }

        const result = {
          project: project_slug,
          results,
          all_succeeded: succeeded.length === files.length,
          files_pushed: succeeded.length,
          files_failed: files.length - succeeded.length,
          total_bytes: totalBytes,
        };

        logger.info("prism_push complete", {
          project_slug,
          pushed: succeeded.length,
          failed: files.length - succeeded.length,
          totalBytes,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_push failed", { project_slug, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message, project: project_slug }) }],
          isError: true,
        };
      }
    }
  );
}
