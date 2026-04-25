/**
 * prism_push tool — Push files with server-side validation.
 *
 * Validates ALL files first; if any fail, pushes NONE. Uses safeMutation as
 * the atomic-commit primitive (S64 Phase 1 Brief 1.5): one GitHub operation
 * for N files via Git Trees, no 409 race conditions from parallel Contents
 * API calls, and a single commit SHA shared by every file in the batch.
 * safeMutation handles HEAD snapshot, atomic commit, 409 retry with refreshed
 * content, and null-safe HEAD comparison. Atomic-only by design (S62 audit
 * Verdict C).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeMutation } from "../utils/safe-mutation.js";
import { logger } from "../utils/logger.js";
import { validateFileAndCommit } from "../validation/index.js";
import { templateCache } from "../utils/cache.js";
import {
  FRAMEWORK_REPO,
  MCP_TEMPLATE_PATH,
  PUSH_WALL_CLOCK_DEADLINE_MS,
} from "../config.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

/** Sentinel used to signal that the tool-level deadline fired (S40 C4). */
const PUSH_DEADLINE_SENTINEL = Symbol("push.deadline");

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

interface PushFileResult {
  path: string;
  original_path?: string;
  redirected?: boolean;
  success: boolean;
  size_bytes: number;
  sha: string;
  verified: boolean;
  validation_errors: string[];
  validation_warnings: string[];
  error?: string;
}

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
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_push", { project_slug, fileCount: files.length, skip_validation });

      // S40 C4 — Tool-level wall-clock deadline. Hard backstop on top of the
      // per-request GitHub timeout. If we hit this, something is wrong enough
      // that the user deserves a visible error instead of a silent hang.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlinePromise = new Promise<typeof PUSH_DEADLINE_SENTINEL>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(PUSH_DEADLINE_SENTINEL), PUSH_WALL_CLOCK_DEADLINE_MS);
      });

      const workPromise = (async () => {
        try {
        // 1. Validate ALL files first
        const validationResults = files.map((file) => {
          if (skip_validation) {
            return { path: file.path, errors: [] as string[], warnings: [] as string[] };
          }
          const result = validateFileAndCommit(file.path, file.content, file.message);
          return { path: file.path, ...result };
        });

        const hasErrors = validationResults.some((r) => r.errors.length > 0);

        if (hasErrors) {
          const results = validationResults.map((r) => ({
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
          diagnostics.warn("VALIDATION_WARNING", `Validation failed for ${results.filter(r => r.validation_errors.length > 0).length} file(s)`, { errorCount: results.reduce((sum, r) => sum + r.validation_errors.length, 0) });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    project: project_slug,
                    results,
                    all_succeeded: false,
                    files_pushed: 0,
                    files_failed: files.length,
                    total_bytes: 0,
                    diagnostics: diagnostics.list(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // 2. Guard all paths against root-level duplication (D-67 addendum)
        const guardResults = await Promise.all(
          files.map((file) => guardPushPath(project_slug, file.path)),
        );

        // 3. Derive the single commit message for the atomic commit. Atomic
        //    commits can only carry one message — if callers passed different
        //    strings, use the first and log a warning so the mismatch is not
        //    silent.
        const messages = files.map((f) => f.message);
        const uniqueMessages = new Set(messages);
        const commitMessage = messages[0];
        if (uniqueMessages.size > 1) {
          logger.warn("prism_push received differing messages; using first", {
            project_slug,
            count: uniqueMessages.size,
            used: commitMessage,
          });
          diagnostics.warn("VALIDATION_WARNING", `Received ${uniqueMessages.size} differing commit messages; using first`, { count: uniqueMessages.size, used: commitMessage });
        }

        // 4. Atomic commit via safeMutation (S64 Phase 1 Brief 1.5).
        //    safeMutation handles: HEAD snapshot, atomic Git Trees commit, 409
        //    retry with refreshed content, null-safe HEAD comparison.
        //    Atomic-only by design (S62 audit Verdict C).
        const atomicFiles = files.map((file, idx) => ({
          path: guardResults[idx].path,
          content: file.content,
        }));
        const safeMutationResult = await safeMutation({
          repo: project_slug,
          commitMessage,
          readPaths: [],
          diagnostics,
          computeMutation: () => ({ writes: atomicFiles }),
        });

        let results: PushFileResult[];
        if (safeMutationResult.ok) {
          results = files.map((file, idx) => ({
            path: guardResults[idx].path,
            original_path: guardResults[idx].redirected ? file.path : undefined,
            redirected: guardResults[idx].redirected,
            success: true,
            size_bytes: new TextEncoder().encode(file.content).length,
            sha: safeMutationResult.commitSha,
            verified: true,
            validation_errors: validationResults[idx].errors,
            validation_warnings: validationResults[idx].warnings,
          }));
        } else {
          results = files.map((file, idx) => ({
            path: guardResults[idx].path,
            original_path: guardResults[idx].redirected ? file.path : undefined,
            redirected: guardResults[idx].redirected,
            success: false,
            size_bytes: 0,
            sha: "",
            verified: false,
            validation_errors: [
              ...validationResults[idx].errors,
              safeMutationResult.error,
            ],
            validation_warnings: validationResults[idx].warnings,
            error: safeMutationResult.error,
          }));
        }

        const succeeded = results.filter((r) => r.success);
        const totalBytes = succeeded.reduce((sum, r) => sum + r.size_bytes, 0);

        // Invalidate template cache if we just pushed an update to the core template
        if (project_slug === FRAMEWORK_REPO) {
          const templatePushed = succeeded.some((r) => r.path === MCP_TEMPLATE_PATH);
          if (templatePushed) {
            templateCache.invalidate(MCP_TEMPLATE_PATH);
            logger.info("template cache invalidated", {
              reason: "core template pushed via prism_push",
            });
          }
        }

        const result = {
          project: project_slug,
          results,
          all_succeeded: succeeded.length === files.length,
          files_pushed: succeeded.length,
          files_failed: files.length - succeeded.length,
          total_bytes: totalBytes,
          commit_sha: safeMutationResult.ok ? safeMutationResult.commitSha : undefined,
          diagnostics: diagnostics.list(),
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
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, project: project_slug }),
            },
          ],
          isError: true,
        };
      }
      })();

      try {
        const raced = await Promise.race([workPromise, deadlinePromise]);
        if (raced === PUSH_DEADLINE_SENTINEL) {
          const deadlineSec = Math.round(PUSH_WALL_CLOCK_DEADLINE_MS / 1000);
          logger.error("prism_push deadline exceeded", {
            project_slug,
            deadlineMs: PUSH_WALL_CLOCK_DEADLINE_MS,
            elapsedMs: Date.now() - start,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  project: project_slug,
                  error: `prism_push deadline exceeded (${deadlineSec}s)`,
                  partial_state_warning:
                    "Atomic commit may have partially succeeded — verify repo state manually",
                }),
              },
            ],
            isError: true,
          };
        }
        return raced;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    },
  );
}
