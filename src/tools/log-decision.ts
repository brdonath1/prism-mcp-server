/**
 * prism_log_decision — Log a decision to both _INDEX.md and domain file atomically.
 * Eliminates full-file roundtrips for decision logging.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { parseMarkdownTable } from "../utils/summarizer.js";

/**
 * Parse existing decision IDs from a decisions/_INDEX.md content string.
 * Reads the markdown table and collects any value in the ID column
 * (case-insensitive) that matches the D-N format.
 */
export function parseExistingDecisionIds(indexContent: string): Map<string, string> {
  const ids = new Map<string, string>();
  const rows = parseMarkdownTable(indexContent);
  for (const row of rows) {
    const idKey = Object.keys(row).find((k) => k.toLowerCase() === "id");
    const titleKey = Object.keys(row).find((k) => k.toLowerCase() === "title");
    if (!idKey) continue;
    const id = row[idKey]?.trim();
    if (id && /^D-\d+$/.test(id)) {
      ids.set(id, titleKey ? (row[titleKey] ?? "").trim() : "");
    }
  }
  return ids;
}

export function registerLogDecision(server: McpServer): void {
  server.tool(
    "prism_log_decision",
    "Log a decision atomically to _INDEX.md and domain file. Server-side formatting.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().regex(/^D-\d{1,4}$/, "Decision ID must match D-N format (e.g., 'D-45')").describe("Decision ID (e.g., 'D-45')"),
      title: z.string().min(1).max(200).describe("Decision title"),
      domain: z.string().min(1).max(50).describe("Decision domain (e.g., 'architecture', 'operations', 'optimization')"),
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
        // 1. Fetch current _INDEX.md (D-67: backward-compatible resolution)
        let indexContent: string;
        let indexResolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, "decisions/_INDEX.md");
          indexContent = resolved.content;
          indexResolvedPath = resolved.path;
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "decisions/_INDEX.md not found" }) }],
            isError: true,
          };
        }

        // 2. Dedup guard (A.1 — brief 104): reject if the requested D-N ID
        // already exists in _INDEX.md. The concurrent-write race (two requests
        // passing the check simultaneously) is a known edge case — resolved
        // downstream by GitHub's SHA-based optimistic concurrency (409 →
        // retry with fresh SHA, which re-reads _INDEX.md and re-checks).
        const existingIds = parseExistingDecisionIds(indexContent);
        if (existingIds.has(id)) {
          const existingTitle = existingIds.get(id) ?? "";
          const msg =
            `Decision ID ${id} already exists in _INDEX.md` +
            (existingTitle ? ` (title: "${existingTitle}")` : "") +
            `. Use a different ID or update the existing entry via prism_patch.`;
          logger.warn("prism_log_decision duplicate rejected", {
            project_slug,
            id,
            existingTitle,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: msg,
                  duplicate: true,
                  id,
                  existing_title: existingTitle,
                }),
              },
            ],
            isError: true,
          };
        }

        // 3. Insert new row into the table (before EOF sentinel)
        const newRow = `| ${id} | ${title} | ${domain} | ${status} | ${session} |`;
        const eofSentinel = "<!-- EOF: _INDEX.md -->";

        if (indexContent.includes(eofSentinel)) {
          indexContent = indexContent.replace(eofSentinel, `${newRow}\n${eofSentinel}`);
        } else {
          indexContent = indexContent.trimEnd() + `\n${newRow}\n`;
        }

        // 4. Fetch or create domain file (D-67: backward-compatible resolution)
        const domainDocName = `decisions/${domain}.md`;
        let domainContent: string;
        let domainResolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, domainDocName);
          domainContent = resolved.content;
          domainResolvedPath = resolved.path;
        } catch {
          domainContent = `# Decisions — ${domain}\n\n> Domain: ${domain}\n> Full decision entries. See _INDEX.md for lookup table.\n\n<!-- EOF: ${domain}.md -->\n`;
          const basePushPath = await resolveDocPushPath(project_slug, domainDocName);
          const guarded = await guardPushPath(project_slug, basePushPath);
          domainResolvedPath = guarded.path;
        }

        // 5. Build full decision entry
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

        // 6. Push both files to resolved paths
        const indexResult = await pushFile(
          project_slug,
          indexResolvedPath,
          indexContent,
          `prism: ${id} ${title}`
        );

        const domainResult = await pushFile(
          project_slug,
          domainResolvedPath,
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
              domain_file: domainResolvedPath,
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
