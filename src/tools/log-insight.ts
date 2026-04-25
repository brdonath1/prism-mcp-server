/**
 * prism_log_insight — Log an insight to insights.md with STANDING RULE support.
 * Eliminates full-file roundtrips for insight capture.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { safeMutation } from "../utils/safe-mutation.js";

/**
 * Parse existing insight IDs from an insights.md content string.
 *
 * Scans for `### INS-N:` section headers and captures the accompanying title
 * (excluding the " — STANDING RULE" suffix if present) for the rejection
 * message. Mirrors {@link parseExistingDecisionIds} in shape so the dedup
 * guard reads the same on both log-decision and log-insight paths.
 */
export function parseExistingInsightIds(content: string): Map<string, string> {
  const ids = new Map<string, string>();
  // Canonical entry header: `### INS-N: Title` with optional " — STANDING RULE"
  // suffix. The regex captures the ID and title separately; we strip the
  // standing-rule marker from the title before storing for a cleaner message.
  const headerPattern = /^###\s+(INS-\d+)\s*:\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(content)) !== null) {
    const id = match[1];
    const rawTitle = match[2].replace(/\s*—\s*STANDING RULE\s*$/, "").trim();
    if (!ids.has(id)) {
      ids.set(id, rawTitle);
    }
  }
  return ids;
}

/**
 * Internal sentinel thrown from inside `computeMutation` when a duplicate
 * insight ID is detected on the freshly-read insights.md. Caught at the
 * tool boundary to surface the existing duplicate response shape unchanged.
 */
class InsightDedupError extends Error {
  readonly duplicate = true as const;
  constructor(
    readonly id: string,
    readonly existingTitle: string,
    message: string,
  ) {
    super(message);
    this.name = "InsightDedupError";
  }
}

export function registerLogInsight(server: McpServer): void {
  server.tool(
    "prism_log_insight",
    "Log an insight to insights.md. Supports STANDING RULE tagging for auto-loading at bootstrap.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().regex(/^INS-\d{1,4}$/, "Insight ID must match INS-N format (e.g., 'INS-12')").describe("Insight ID (e.g., 'INS-12')"),
      title: z.string().min(1).max(200).describe("Insight title"),
      category: z.string().min(1).max(50).describe("Category (e.g., 'pattern', 'gotcha', 'preference', 'exploration', 'operations')"),
      description: z.string().describe("Full description of the insight"),
      session: z.number().describe("Session number where insight was discovered"),
      standing_rule: z.boolean().optional().describe("Whether this is a STANDING RULE (auto-loaded at bootstrap via D-44 Track 1)"),
      procedure: z.string().optional().describe("Standing procedure steps (required if standing_rule is true). Use numbered steps."),
    },
    async ({ project_slug, id, title, category, description, session, standing_rule, procedure }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_log_insight", { project_slug, id, standing_rule });

      try {
        // Validate: standing rules must have procedures
        if (standing_rule && !procedure) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "standing_rule entries require a procedure field" }) }],
            isError: true,
          };
        }

        // 1. Resolve the insights.md path. If the file doesn't exist yet we
        //    use the doc-resolver's push-path resolution and skip the read
        //    in safeMutation.
        let insightsResolvedPath: string;
        let fileExisted = false;
        try {
          const resolved = await resolveDocPath(project_slug, "insights.md");
          insightsResolvedPath = resolved.path;
          fileExisted = true;
        } catch {
          const basePushPath = await resolveDocPushPath(project_slug, "insights.md");
          const guarded = await guardPushPath(project_slug, basePushPath);
          insightsResolvedPath = guarded.path;
        }

        // 2. Build the entry (does not depend on existing file content).
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

        const formalizedMarker = "## Formalized";
        const eofSentinel = "<!-- EOF: insights.md -->";

        const freshStarter =
          `# Insights — ${project_slug}\n\n` +
          `> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).\n\n` +
          `## Active\n\n` +
          `## Formalized\n\n` +
          `${eofSentinel}\n`;

        // 3. safeMutation handles HEAD snapshot, atomic commit, and 409 retry
        //    with re-read. The dedup check moves INSIDE computeMutation so
        //    fresh data is checked on every retry.
        const readPaths = fileExisted ? [insightsResolvedPath] : [];
        const result = await safeMutation({
          repo: project_slug,
          commitMessage: `prism: ${id} ${title}`,
          readPaths,
          diagnostics,
          computeMutation: (files) => {
            let content: string;
            if (fileExisted) {
              const insightsFile = files.get(insightsResolvedPath);
              if (!insightsFile) {
                throw new Error(
                  `safeMutation did not return ${insightsResolvedPath} content`,
                );
              }
              content = insightsFile.content;

              const existingIds = parseExistingInsightIds(content);
              if (existingIds.has(id)) {
                const existingTitle = existingIds.get(id) ?? "";
                const msg =
                  `Insight ID ${id} already exists in insights.md` +
                  (existingTitle ? ` (title: "${existingTitle}")` : "") +
                  `. Use a different ID or update the existing entry via prism_patch.`;
                logger.warn("prism_log_insight duplicate rejected", {
                  project_slug,
                  id,
                  existingTitle,
                });
                diagnostics.warn(
                  "STANDING_RULE_DUPLICATE_ID",
                  `Insight ID ${id} already exists in insights.md`,
                  { id, existingTitle },
                );
                throw new InsightDedupError(id, existingTitle, msg);
              }
            } else {
              content = freshStarter;
            }

            // Insert into ## Active section (before ## Formalized or EOF).
            if (content.includes(formalizedMarker)) {
              content = content.replace(formalizedMarker, `${entry}\n\n${formalizedMarker}`);
            } else if (content.includes(eofSentinel)) {
              content = content.replace(eofSentinel, `${entry}\n\n${eofSentinel}`);
            } else {
              content = content.trimEnd() + `\n\n${entry}\n`;
            }

            return {
              writes: [{ path: insightsResolvedPath, content }],
            };
          },
        });

        if (!result.ok) {
          logger.error("prism_log_insight safeMutation failed", {
            project_slug,
            id,
            code: result.code,
            error: result.error,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error,
                  code: result.code,
                  id,
                  title,
                  category,
                  standing_rule: !!standing_rule,
                  success: false,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }

        logger.info("prism_log_insight complete", {
          project_slug,
          id,
          standing_rule: !!standing_rule,
          retried: result.retried,
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
              success: true,
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        if (error instanceof InsightDedupError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  duplicate: true,
                  id: error.id,
                  existing_title: error.existingTitle,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }
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
