/**
 * prism_log_insight — Log an insight to insights.md with STANDING RULE support.
 * Eliminates full-file roundtrips for insight capture.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";

export function registerLogInsight(server: McpServer): void {
  server.tool(
    "prism_log_insight",
    "Log an insight to insights.md. Supports STANDING RULE tagging for auto-loading at bootstrap.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().describe("Insight ID (e.g., 'INS-12')"),
      title: z.string().describe("Insight title"),
      category: z.string().describe("Category (e.g., 'pattern', 'gotcha', 'preference', 'exploration', 'operations')"),
      description: z.string().describe("Full description of the insight"),
      session: z.number().describe("Session number where insight was discovered"),
      standing_rule: z.boolean().optional().describe("Whether this is a STANDING RULE (auto-loaded at bootstrap via D-44 Track 1)"),
      procedure: z.string().optional().describe("Standing procedure steps (required if standing_rule is true). Use numbered steps."),
    },
    async ({ project_slug, id, title, category, description, session, standing_rule, procedure }) => {
      const start = Date.now();
      logger.info("prism_log_insight", { project_slug, id, standing_rule });

      try {
        // Validate: standing rules must have procedures
        if (standing_rule && !procedure) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "standing_rule entries require a procedure field" }) }],
            isError: true,
          };
        }

        // 1. Fetch current insights.md (D-67: backward-compatible resolution)
        let content: string;
        let insightsResolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, "insights.md");
          content = resolved.content;
          insightsResolvedPath = resolved.path;
        } catch {
          content = `# Insights — ${project_slug}\n\n> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).\n\n## Active\n\n## Formalized\n\n<!-- EOF: insights.md -->\n`;
          const basePushPath = await resolveDocPushPath(project_slug, "insights.md");
          const guarded = await guardPushPath(project_slug, basePushPath);
          insightsResolvedPath = guarded.path;
        }

        // 2. Build the entry
        const standingTag = standing_rule ? " — STANDING RULE" : "";
        const categoryTag = standing_rule ? `${category} — **STANDING RULE**` : category;

        const entryLines = [
          `### ${id}: ${title}${standingTag}`,
          `- Category: ${categoryTag}`,
          `- Discovered: Session ${session}`,
          `- Description: ${description}`,
        ];

        if (standing_rule && procedure) {
          entryLines.push(`- **Standing procedure:** ${procedure}`);
        }

        const entry = entryLines.join("\n");

        // 3. Insert into ## Active section (before ## Formalized or EOF)
        const formalizedMarker = "## Formalized";
        const eofSentinel = "<!-- EOF: insights.md -->";

        if (content.includes(formalizedMarker)) {
          content = content.replace(formalizedMarker, `${entry}\n\n${formalizedMarker}`);
        } else if (content.includes(eofSentinel)) {
          content = content.replace(eofSentinel, `${entry}\n\n${eofSentinel}`);
        } else {
          content = content.trimEnd() + `\n\n${entry}\n`;
        }

        // 4. Push to resolved path
        const result = await pushFile(
          project_slug,
          insightsResolvedPath,
          content,
          `prism: ${id} ${title}`
        );

        logger.info("prism_log_insight complete", {
          project_slug, id, standing_rule: !!standing_rule,
          success: result.success,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id,
              title,
              category,
              standing_rule: !!standing_rule,
              success: result.success,
              size_bytes: result.size,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_log_insight failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
