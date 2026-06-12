/**
 * prism_log_decision — Log a decision to both _INDEX.md and domain file atomically.
 * Eliminates full-file roundtrips for decision logging.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { safeMutation } from "../utils/safe-mutation.js";
import { sanitizeContent } from "../utils/sanitize-content.js";

/**
 * Parse existing decision IDs from a decisions/_INDEX.md content string.
 *
 * Scans the raw markdown with a regex so we remain correct on multi-table
 * documents. Historically this function leaned on `parseMarkdownTable()`,
 * but that utility treated every pipe-containing line in the file as one
 * table — so in a real `_INDEX.md` (which leads with a Domain Files
 * reference table before the Decision Summary table) the dedup check
 * always returned an empty map and never rejected duplicates (brief 105).
 *
 * The regex below matches any table row whose first cell is a D-N format
 * decision ID (with or without the hyphen, so legacy `| D101 |` entries
 * are still detected) and records the accompanying title cell for the
 * rejection message.
 */
export function parseExistingDecisionIds(indexContent: string): Map<string, string> {
  const ids = new Map<string, string>();
  // Match table rows shaped like `| D-NNN | Title | ... |`. We accept an
  // optional hyphen (`D-?\d+`) so legacy `| D101 | ... |` rows are still
  // detected. The first capture is the ID, the second is everything up to
  // the next `|`, which we treat as the title cell. `gm` lets us scan
  // every line of the file independently of which table it belongs to.
  const rowPattern = /^\|\s*(D-?\d+)\s*\|\s*([^|]*)\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(indexContent)) !== null) {
    const rawId = match[1].trim();
    const title = match[2].trim();
    // Normalize to the canonical `D-N` form for the map key so lookups
    // still hit when the incoming request uses the hyphenated format
    // (enforced upstream by the Zod schema) but the stored row was
    // written in the legacy hyphenless form. Keep the first occurrence
    // so the stored title matches whatever the canonical row says.
    const id = /^D-\d+$/.test(rawId)
      ? rawId
      : rawId.replace(/^D(\d+)$/, "D-$1");
    if (!ids.has(id)) {
      ids.set(id, title);
    }
  }
  return ids;
}

/**
 * Internal sentinel thrown from inside `computeMutation` when a duplicate
 * decision ID is detected on the freshly-read index. Caught at the tool
 * boundary to surface the existing duplicate response shape unchanged.
 */
class DedupError extends Error {
  readonly duplicate = true as const;
  constructor(
    readonly id: string,
    readonly existingTitle: string,
    message: string,
  ) {
    super(message);
    this.name = "DedupError";
  }
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
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_log_decision", { project_slug, id, domain });

      try {
        // 1. Resolve _INDEX.md path. The path is derived from the existing
        //    file; if the index doesn't exist at all, we cannot log a
        //    decision against it.
        let indexResolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, "decisions/_INDEX.md");
          indexResolvedPath = resolved.path;
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "decisions/_INDEX.md not found" }) }],
            isError: true,
          };
        }

        // 2. Resolve domain file path; note whether the domain file exists
        //    so safeMutation knows whether to read it on each attempt.
        const domainDocName = `decisions/${domain}.md`;
        let domainResolvedPath: string;
        let domainExisted = false;
        try {
          const resolved = await resolveDocPath(project_slug, domainDocName);
          domainResolvedPath = resolved.path;
          domainExisted = true;
        } catch {
          const basePushPath = await resolveDocPushPath(project_slug, domainDocName);
          const guarded = await guardPushPath(project_slug, basePushPath);
          domainResolvedPath = guarded.path;
        }

        const readPaths = domainExisted
          ? [indexResolvedPath, domainResolvedPath]
          : [indexResolvedPath];

        // KI-26 (redesigned brief-460 / SRV-77): every sanitized field here is
        // embedded MID-LINE in a server-built template (`| ${id} | ${title} |`,
        // `### ${id}: ${title}`, `- Reasoning: ${reasoning}`), so the field's
        // FIRST line can never start a header — only embedded `\n#...` lines
        // can. anchor "newline-only" leaves the first line untouched, and
        // targetLevel 3 (the `### D-N:` entry level) lets `\n#### detail`
        // sub-structure survive while `\n###`/`\n##`/`\n#` lines — which would
        // terminate the entry or its parent section — are still neutralized.
        // Mutations are reported as a visible diagnostic, never silent.
        const sanitizeField = (field: string, value: string): string => {
          const outcome = sanitizeContent(value, {
            anchor: "newline-only",
            targetLevel: 3,
          });
          if (outcome.neutralized.length > 0) {
            diagnostics.warn(
              "CONTENT_SANITIZED",
              `${outcome.neutralized.length} embedded header line(s) in "${field}" were ZWS-neutralized (they would have broken the ### ${id} entry structure): ${outcome.neutralized.map((n) => `"${n.header}"`).join(", ")}`,
              { field, lines: outcome.neutralized.map((n) => ({ line: n.line, header: n.header })) },
            );
          }
          return outcome.text;
        };
        const safeTitle = sanitizeField("title", title);
        const safeReasoning = sanitizeField("reasoning", reasoning);
        const safeAssumptions = assumptions ? sanitizeField("assumptions", assumptions) : undefined;
        const safeImpact = impact ? sanitizeField("impact", impact) : undefined;

        // Commit message is a non-markdown channel (Git plain text), so it
        // uses the raw title — ZWS injection there is unnecessary and would
        // make the message harder to read.
        const commitMessage = `prism: ${id} ${title}`;
        const domainEof = `<!-- EOF: ${domain}.md -->`;
        const eofSentinel = "<!-- EOF: _INDEX.md -->";
        const newRow = `| ${id} | ${safeTitle} | ${domain} | ${status} | ${session} |`;

        const entryLines = [
          `### ${id}: ${safeTitle}`,
          `- Domain: ${domain}`,
          `- Status: ${status}`,
          `- Reasoning: ${safeReasoning}`,
        ];
        if (safeAssumptions) entryLines.push(`- Assumptions: ${safeAssumptions}`);
        if (safeImpact) entryLines.push(`- Impact: ${safeImpact}`);
        entryLines.push(`- Decided: Session ${session}`);
        const entry = entryLines.join("\n");

        // 3. safeMutation handles HEAD snapshot, atomic commit, and 409 retry
        //    with re-read of the index + domain content. Dedup runs INSIDE
        //    computeMutation so it re-checks fresh data on every retry.
        const result = await safeMutation({
          repo: project_slug,
          commitMessage,
          readPaths,
          diagnostics,
          computeMutation: (files) => {
            const indexFile = files.get(indexResolvedPath);
            if (!indexFile) {
              throw new Error("safeMutation did not return _INDEX.md content");
            }
            let indexContent = indexFile.content;

            // Dedup against fresh data — a concurrent writer may have logged
            // the same ID since our initial path resolution.
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
              diagnostics.warn(
                "DEDUP_TRIGGERED",
                `Decision ID ${id} already exists in _INDEX.md`,
                { id, existingTitle },
              );
              throw new DedupError(id, existingTitle, msg);
            }

            // Insert the new row before the EOF sentinel.
            if (indexContent.includes(eofSentinel)) {
              indexContent = indexContent.replace(eofSentinel, `${newRow}\n${eofSentinel}`);
            } else {
              indexContent = indexContent.trimEnd() + `\n${newRow}\n`;
            }

            // Build domain content. If the domain file existed at request
            // time we expect fresh content in the map; otherwise we write a
            // starter file with the new entry already attached.
            let domainContent: string;
            if (domainExisted) {
              const domainFile = files.get(domainResolvedPath);
              if (!domainFile) {
                throw new Error(
                  `safeMutation did not return ${domainResolvedPath} content`,
                );
              }
              domainContent = domainFile.content;
              if (domainContent.includes(domainEof)) {
                domainContent = domainContent.replace(
                  domainEof,
                  `${entry}\n\n${domainEof}`,
                );
              } else {
                domainContent = domainContent.trimEnd() + `\n\n${entry}\n\n${domainEof}\n`;
              }
            } else {
              domainContent =
                `# Decisions — ${domain}\n\n` +
                `> Domain: ${domain}\n` +
                `> Full decision entries. See _INDEX.md for lookup table.\n\n` +
                `${entry}\n\n${domainEof}\n`;
            }

            return {
              writes: [
                { path: indexResolvedPath, content: indexContent },
                { path: domainResolvedPath, content: domainContent },
              ],
            };
          },
        });

        if (!result.ok) {
          logger.error("prism_log_decision safeMutation failed", {
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
                  domain,
                  index_updated: false,
                  domain_file_updated: false,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }

        logger.info("prism_log_decision complete", {
          project_slug,
          id,
          domain,
          retried: result.retried,
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
              index_updated: true,
              domain_file_updated: true,
              domain_file: domainResolvedPath,
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        if (error instanceof DedupError) {
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
        logger.error("prism_log_decision failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
