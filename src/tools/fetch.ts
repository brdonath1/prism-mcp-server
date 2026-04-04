/**
 * prism_fetch tool — Fetch files from a PRISM project repo.
 * Supports summary mode for large files to stay within context budget.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile } from "../github/client.js";
import { SUMMARY_SIZE_THRESHOLD } from "../config.js";
import { logger } from "../utils/logger.js";
import { summarizeMarkdown } from "../utils/summarizer.js";

/** Input schema for prism_fetch */
const inputSchema = {
  project_slug: z.string().describe("Project repo name"),
  files: z.array(z.string()).describe("File paths relative to repo root"),
  summary_mode: z.boolean().optional().default(false).describe("Return summaries for files >5KB"),
};

/**
 * Register the prism_fetch tool on an MCP server instance.
 */
export function registerFetch(server: McpServer): void {
  server.tool(
    "prism_fetch",
    "Fetch files from a PRISM project repo. Summary mode returns summaries for files >5KB.",
    inputSchema,
    async ({ project_slug, files, summary_mode }) => {
      const start = Date.now();
      logger.info("prism_fetch", { project_slug, fileCount: files.length, summary_mode });

      try {
        let bytesDelivered = 0;
        let filesFetched = 0;

        // Fetch all files in parallel
        const results = await Promise.allSettled(
          files.map(async (filePath) => {
            try {
              const result = await fetchFile(project_slug, filePath);
              return { path: filePath, exists: true, ...result };
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              // 404 = file doesn't exist, not necessarily an error
              if (msg.includes("Not found")) {
                return { path: filePath, exists: false, content: "", sha: "", size: 0 };
              }
              throw error;
            }
          })
        );

        const fileResults = results.map((outcome, idx) => {
          if (outcome.status === "fulfilled") {
            const file = outcome.value;

            if (!file.exists) {
              return {
                path: file.path,
                exists: false,
                size_bytes: 0,
                content: null,
                summary: null,
                is_summarized: false,
              };
            }

            filesFetched++;
            const shouldSummarize = summary_mode && file.size > SUMMARY_SIZE_THRESHOLD;

            if (shouldSummarize) {
              const summary = summarizeMarkdown(file.content);
              bytesDelivered += new TextEncoder().encode(summary).length;
              return {
                path: file.path,
                exists: true,
                size_bytes: file.size,
                content: null,
                summary,
                is_summarized: true,
              };
            }

            bytesDelivered += file.size;
            return {
              path: file.path,
              exists: true,
              size_bytes: file.size,
              content: file.content,
              summary: null,
              is_summarized: false,
            };
          }

          // Failed to fetch
          return {
            path: files[idx],
            exists: false,
            size_bytes: 0,
            content: null,
            summary: null,
            is_summarized: false,
          };
        });

        const result = {
          project: project_slug,
          files: fileResults,
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
        };

        logger.info("prism_fetch complete", {
          project_slug,
          filesFetched,
          bytesDelivered,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_fetch failed", { project_slug, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message, project: project_slug }) }],
          isError: true,
        };
      }
    }
  );
}
