/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { applyPatch, validateIntegrity, type IntegrityIssue } from "../utils/markdown-sections.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { DOC_ROOT } from "../config.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { safeMutation } from "../utils/safe-mutation.js";

interface PatchOpResult {
  operation: string;
  section: string;
  success: boolean;
  error?: string;
}

/**
 * Internal sentinel thrown from inside `computeMutation` when one or more
 * patch operations fail to apply. Caught at the tool boundary to surface
 * the existing PATCH_PARTIAL_FAILURE response shape unchanged.
 */
class PatchPartialFailureError extends Error {
  readonly partial = true as const;
  constructor(
    readonly results: PatchOpResult[],
    message: string,
  ) {
    super(message);
    this.name = "PatchPartialFailureError";
  }
}

/**
 * Internal sentinel thrown when post-patch integrity validation fails.
 * Caught at the tool boundary to surface the existing integrity-error
 * response shape unchanged.
 */
class PatchIntegrityError extends Error {
  readonly integrity = true as const;
  constructor(
    readonly issues: IntegrityIssue[],
    readonly attempted: PatchOpResult[],
    message: string,
  ) {
    super(message);
    this.name = "PatchIntegrityError";
  }
}

export function registerPatch(server: McpServer): void {
  server.tool(
    "prism_patch",
    "Section-level operations (append/prepend/replace) on living documents. All-or-nothing semantics.",
    {
      project_slug: z.string().describe("Project repo name"),
      file: z.string().describe("File path relative to repo root (e.g., 'task-queue.md')"),
      patches: z.array(z.object({
        operation: z.enum(["append", "prepend", "replace"]).describe("Operation type"),
        section: z.string().describe("Section header to target (e.g., '## In Progress', '### Session 22')"),
        content: z.string().describe("Content to append/prepend/replace with"),
      })).describe("One or more patch operations to apply sequentially"),
    },
    async ({ project_slug, file, patches }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_patch", { project_slug, file, patchCount: patches.length });

      try {
        // 1. Resolve file path to prevent root-level duplication (D-67 addendum).
        //    The bare-catch silent fallback below is intentionally preserved in
        //    this brief — Brief 3 will differentiate "not found" from operational
        //    errors in the resolveDocPath path. See S62 audit Change 6 NOTE.
        const baseName = file.startsWith(`${DOC_ROOT}/`) ? file.slice(DOC_ROOT.length + 1) : file;
        let resolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, baseName);
          resolvedPath = resolved.path;
        } catch {
          // Not a living doc or doesn't exist at either location — use original path
          resolvedPath = file;
        }

        if (resolvedPath !== file) {
          diagnostics.warn("PATCH_REDIRECTED", `Path redirected: "${file}" → "${resolvedPath}"`, { original: file, resolved: resolvedPath });
        }

        // 2. safeMutation handles fetch + atomic commit + 409 retry. The patch
        //    operations move INSIDE computeMutation so on retry they re-run
        //    against the latest content (closes the stale-content-on-retry
        //    vulnerability identified in the audit).
        let lastIntegrityIssues: IntegrityIssue[] = [];

        const safeMutationResult = await safeMutation({
          repo: project_slug,
          commitMessage: `prism: patch ${resolvedPath} (${patches.length} ops)`,
          readPaths: [resolvedPath],
          diagnostics,
          computeMutation: (files) => {
            const fileResult = files.get(resolvedPath);
            if (!fileResult) {
              throw new Error(`safeMutation did not return ${resolvedPath} content`);
            }
            let content = fileResult.content;

            const results: PatchOpResult[] = [];
            for (const patch of patches) {
              try {
                content = applyPatch(content, patch.section, patch.operation, patch.content);
                results.push({ operation: patch.operation, section: patch.section, success: true });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({ operation: patch.operation, section: patch.section, success: false, error: msg });
              }
            }

            if (results.some(r => !r.success)) {
              throw new PatchPartialFailureError(results, "One or more patches failed — file not modified");
            }

            const integrity = validateIntegrity(content);
            if (!integrity.valid) {
              throw new PatchIntegrityError(
                integrity.issues,
                results,
                "Post-patch integrity check failed — file not modified",
              );
            }
            lastIntegrityIssues = integrity.issues;

            return {
              writes: [{ path: resolvedPath, content }],
            };
          },
        });

        if (!safeMutationResult.ok) {
          logger.error("prism_patch safeMutation failed", {
            project_slug,
            file: resolvedPath,
            code: safeMutationResult.code,
            error: safeMutationResult.error,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  file: resolvedPath,
                  original_path: resolvedPath !== file ? file : undefined,
                  redirected: resolvedPath !== file,
                  success: false,
                  error: safeMutationResult.error,
                  code: safeMutationResult.code,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }

        const patches_applied: PatchOpResult[] = patches.map(p => ({
          operation: p.operation,
          section: p.section,
          success: true,
        }));

        logger.info("prism_patch complete", {
          project_slug,
          file: resolvedPath,
          patchCount: patches.length,
          redirected: resolvedPath !== file,
          retried: safeMutationResult.retried,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file: resolvedPath,
              original_path: resolvedPath !== file ? file : undefined,
              redirected: resolvedPath !== file,
              success: true,
              patches_applied,
              integrity_check: lastIntegrityIssues.length > 0
                ? { warnings: lastIntegrityIssues }
                : { clean: true },
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        if (error instanceof PatchPartialFailureError) {
          const failedPatches = error.results.filter(r => !r.success);
          diagnostics.error(
            "PATCH_PARTIAL_FAILURE",
            `${failedPatches.length} patch(es) failed`,
            { failedPatches: failedPatches.map(p => ({ section: p.section, error: p.error })) },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  results: error.results,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }
        if (error instanceof PatchIntegrityError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  issues: error.issues,
                  patches_attempted: error.attempted,
                }),
              },
            ],
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_patch failed", { project_slug, file, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
