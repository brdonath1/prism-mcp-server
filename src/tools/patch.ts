/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { applyPatch, validateIntegrity } from "../utils/markdown-sections.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { DOC_ROOT } from "../config.js";

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
      logger.info("prism_patch", { project_slug, file, patchCount: patches.length });

      try {
        // 1. Resolve file path to prevent root-level duplication (D-67 addendum)
        const baseName = file.startsWith(`${DOC_ROOT}/`) ? file.slice(DOC_ROOT.length + 1) : file;
        let resolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, baseName);
          resolvedPath = resolved.path;
        } catch {
          // Not a living doc or doesn't exist at either location — use original path
          resolvedPath = file;
        }

        // 2. Fetch the current file using resolved path
        const fileResult = await fetchFile(project_slug, resolvedPath);
        let content = fileResult.content;

        // 2. Apply each patch
        const results: Array<{ operation: string; section: string; success: boolean; error?: string }> = [];

        for (const patch of patches) {
          try {
            content = applyPatch(content, patch.section, patch.operation, patch.content);
            results.push({ operation: patch.operation, section: patch.section, success: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ operation: patch.operation, section: patch.section, success: false, error: msg });
          }
        }

        // If any patch failed, don't push
        if (results.some(r => !r.success)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "One or more patches failed — file not modified",
                results,
              }),
            }],
            isError: true,
          };
        }

        // 3. Integrity validation before pushing
        const integrity = validateIntegrity(content);
        if (!integrity.valid) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Post-patch integrity check failed — file not modified",
                issues: integrity.issues,
                patches_attempted: results,
              }),
            }],
            isError: true,
          };
        }

        // 4. Push the updated file to resolved path
        const pushResult = await pushFile(
          project_slug,
          resolvedPath,
          content,
          `prism: patch ${resolvedPath} (${patches.length} ops)`
        );

        logger.info("prism_patch complete", {
          project_slug, file: resolvedPath,
          success: pushResult.success,
          patchCount: patches.length,
          redirected: resolvedPath !== file,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file: resolvedPath,
              original_path: resolvedPath !== file ? file : undefined,
              redirected: resolvedPath !== file,
              success: pushResult.success,
              size_bytes: pushResult.size,
              patches_applied: results,
              integrity_check: integrity.issues.length > 0
                ? { warnings: integrity.issues }
                : { clean: true },
            }),
          }],
        };
      } catch (error) {
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
