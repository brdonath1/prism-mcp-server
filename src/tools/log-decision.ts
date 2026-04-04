/**
 * prism_log_decision — Log a decision to both _INDEX.md and domain file atomically.
 * Eliminates full-file roundtrips for decision logging.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";

export function registerLogDecision(server: McpServer): void {
  server.tool(
    "prism_log_decision",
    "Log a decision atomically to _INDEX.md and domain file. Server-side formatting.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().describe("Decision ID (e.g., 'D-45')"),
      title: z.string().describe("Decision title"),
      domain: z.string().describe("Decision domain (e.g., 'architecture', 'operations', 'optimization')"),
      status: z.string().describe("Decision status (e.g., 'SETTLED', 'OPEN')"),
      reasoning: z.string().describe("Full reasoning text for the decision entry"),
      assumptions: z.string().optional().describe("Assumptions (if any)"),
      impact: z.string().optional().describe("Impact description (if any)"),
      session: z.number().describe("Session number where decision was made"),
    },
    async ({ project_slug, id, title, domain, status, reasoning, assumptions, impact, session }) => {
      const start = Date.now();
      logger.info("prism_log_decision", { project_slug, id, domain });

      try {
        // 1. Fetch current _INDEX.md
        let indexContent: string;
        try {
          const indexFile = await fetchFile(project_slug, "decisions/_INDEX.md");
          indexContent = indexFile.content;
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "decisions/_INDEX.md not found" }) }],
            isError: true,
          };
        }

        // 2. Insert new row into the table (before EOF sentinel)
        const newRow = `| ${id} | ${title} | ${domain} | ${status} | ${session} |`;
        const eofSentinel = "<!-- EOF: _INDEX.md -->";

        if (indexContent.includes(eofSentinel)) {
          indexContent = indexContent.replace(eofSentinel, `${newRow}\n${eofSentinel}`);
        } else {
          indexContent = indexContent.trimEnd() + `\n${newRow}\n`;
        }

        // 3. Fetch or create domain file
        const domainPath = `decisions/${domain}.md`;
        let domainContent: string;
        try {
          const domainFile = await fetchFile(project_slug, domainPath);
          domainContent = domainFile.content;
        } catch {
          domainContent = `# Decisions — ${domain}\n\n> Domain: ${domain}\n> Full decision entries. See _INDEX.md for lookup table.\n\n<!-- EOF: ${domain}.md -->\n`;
        }

        // 4. Build full decision entry
        const entryLines = [
          `### ${id}: ${title}`,
          `- Domain: ${domain}`,
          `- Status: ${status}`,
          `- Reasoning: ${reasoning}`,
        ];
        if (assumptions) entryLines.push(`- Assumptions: ${assumptions}`);
        if (impact) entryLines.push(`- Impact: ${impact}`);
        entryLines.push(`- Decided: Session ${session}`);

        const entry = entryLines.join("\n");
        const domainEof = `<!-- EOF: ${domain}.md -->`;

        if (domainContent.includes(domainEof)) {
          domainContent = domainContent.replace(domainEof, `${entry}\n\n${domainEof}`);
        } else {
          domainContent = domainContent.trimEnd() + `\n\n${entry}\n\n${domainEof}\n`;
        }

        // 5. Push both files
        const indexResult = await pushFile(
          project_slug,
          "decisions/_INDEX.md",
          indexContent,
          `prism: ${id} ${title}`
        );

        const domainResult = await pushFile(
          project_slug,
          domainPath,
          domainContent,
          `prism: ${id} full entry`
        );

        logger.info("prism_log_decision complete", {
          project_slug, id, domain,
          indexSuccess: indexResult.success,
          domainSuccess: domainResult.success,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id,
              title,
              domain,
              status,
              index_updated: indexResult.success,
              domain_file_updated: domainResult.success,
              domain_file: domainPath,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_log_decision failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
