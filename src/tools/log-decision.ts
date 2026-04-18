/**
 * prism_log_decision — Log a decision to both _INDEX.md and domain file atomically.
 * Eliminates full-file roundtrips for decision logging.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../github/client.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";

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

        // 6. Atomic-commit both files (A-5). The docstring has long claimed
        // atomicity but the original implementation pushed sequentially, so a
        // mid-sequence failure left `_INDEX.md` referencing a decision whose
        // domain entry had not yet been written. Mirrors push.ts's pattern:
        // atomic first; on failure, check HEAD — if HEAD moved, surface a
        // "partial state" error and abort; if HEAD unchanged, fall back to
        // sequential pushFile (matching push.ts's recovery contract).
        const commitMessage = `prism: ${id} ${title}`;
        const headShaBefore = await getHeadSha(project_slug);
        const atomicResult = await createAtomicCommit(
          project_slug,
          [
            { path: indexResolvedPath, content: indexContent },
            { path: domainResolvedPath, content: domainContent },
          ],
          commitMessage,
        );

        let indexSuccess: boolean;
        let domainSuccess: boolean;
        let partialStateError: string | undefined;

        if (atomicResult.success) {
          indexSuccess = true;
          domainSuccess = true;
        } else {
          let headChanged = false;
          if (headShaBefore) {
            const headShaAfter = await getHeadSha(project_slug);
            if (headShaAfter) headChanged = headShaAfter !== headShaBefore;
          }

          if (headChanged) {
            logger.error(
              "prism_log_decision atomic failed with HEAD changed — partial state",
              { project_slug, id, atomicError: atomicResult.error },
            );
            partialStateError =
              "Concurrent write during log_decision atomic commit; please retry";
            indexSuccess = false;
            domainSuccess = false;
          } else {
            logger.warn(
              "prism_log_decision atomic failed; falling back to sequential pushFile",
              { project_slug, id, atomicError: atomicResult.error },
            );
            const indexResult = await pushFile(
              project_slug,
              indexResolvedPath,
              indexContent,
              commitMessage,
            );
            const domainResult = await pushFile(
              project_slug,
              domainResolvedPath,
              domainContent,
              commitMessage,
            );
            indexSuccess = indexResult.success;
            domainSuccess = domainResult.success;
          }
        }

        if (partialStateError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: partialStateError,
                  id,
                  title,
                  domain,
                  index_updated: false,
                  domain_file_updated: false,
                }),
              },
            ],
            isError: true,
          };
        }

        logger.info("prism_log_decision complete", {
          project_slug, id, domain,
          indexSuccess,
          domainSuccess,
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
              index_updated: indexSuccess,
              domain_file_updated: domainSuccess,
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
