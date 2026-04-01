/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";

/**
 * Apply a single patch operation to file content.
 * Finds the target section by header and applies the operation.
 */
function applyPatch(
  content: string,
  sectionHeader: string,
  operation: "append" | "prepend" | "replace",
  patchContent: string
): string {
  const headerLevel = (sectionHeader.match(/^#+/) ?? [""])[0].length;
  if (headerLevel === 0) {
    throw new Error(`Invalid section header: "${sectionHeader}" — must start with #`);
  }

  // Find the section: starts at the header, ends at next header of same/higher level, EOF sentinel, or end of string
  const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `(${escapedHeader}[^\\n]*\\n)([\\s\\S]*?)(?=(?:^#{1,${headerLevel}} )|<!-- EOF:|$)`,
    "m"
  );

  const match = content.match(sectionRegex);
  if (!match) {
    throw new Error(`Section not found: "${sectionHeader}"`);
  }

  const [fullMatch, header, body] = match;
  const matchIndex = content.indexOf(fullMatch);

  let newSection: string;
  switch (operation) {
    case "append":
      newSection = header + body.trimEnd() + "\n" + patchContent + "\n\n";
      break;
    case "prepend":
      newSection = header + patchContent + "\n" + body;
      break;
    case "replace":
      newSection = header + patchContent + "\n\n";
      break;
  }

  return content.substring(0, matchIndex) + newSection + content.substring(matchIndex + fullMatch.length);
}

export function registerPatch(server: McpServer): void {
  server.tool(
    "prism_patch",
    "Apply section-level operations to a living document without full-file roundtrips. Supports append (add to end of section), prepend (add to start of section), and replace (replace entire section content). Multiple patches applied sequentially — all-or-nothing (if any patch fails, file is not modified).",
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

        // 3. Push the updated file
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
