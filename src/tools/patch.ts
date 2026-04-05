/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { applyPatch, validateIntegrity } from "../utils/markdown-sections.js";

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
        // 1. Fetch the current file
        const fileResult = await fetchFile(project_slug, file);
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

        // 4. Push the updated file
        const pushResult = await pushFile(
          project_slug,
          file,
          content,
          `prism: patch ${file} (${patches.length} ops)`
        );

        logger.info("prism_patch complete", {
          project_slug, file,
          success: pushResult.success,
          patchCount: patches.length,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file,
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
