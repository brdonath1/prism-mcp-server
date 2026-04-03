/**
 * prism_search tool — Search across all living documents within a single PRISM project.
 * Returns relevant snippets ranked by keyword match score.
 *
 * GUARDRAIL: Strictly single-project. Accepts one project_slug, searches only that project.
 * Cross-project search is prohibited (D-2, INS-4).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fileExists } from "../github/client.js";
import { LIVING_DOCUMENTS } from "../config.js";
import { logger } from "../utils/logger.js";

/** Input schema for prism_search */
const inputSchema = {
  project_slug: z.string().describe("Project repo name — search is strictly limited to this single project"),
  query: z.string().describe("Search query — keywords or phrases to find across living documents"),
  max_results: z.number().optional().describe("Maximum snippets to return (default: 10)"),
};

/** A single search result snippet */
interface SearchSnippet {
  file: string;
  section: string;
  score: number;
  snippet: string;
}

/**
 * Split markdown content into sections based on headers.
 * Each section includes the header line and all content until the next header of equal or higher level.
 */
function splitIntoSections(content: string, filePath: string): Array<{ file: string; section: string; body: string }> {
  const lines = content.split("\n");
  const sections: Array<{ file: string; section: string; body: string }> = [];
  let currentSection = filePath; // Default section = file name
  let currentBody: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      // Save previous section if it has content
      if (currentBody.length > 0) {
        const bodyText = currentBody.join("\n").trim();
        if (bodyText.length > 0) {
          sections.push({ file: filePath, section: currentSection, body: bodyText });
        }
      }
      currentSection = headerMatch[2].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  // Don't forget the last section
  if (currentBody.length > 0) {
    const bodyText = currentBody.join("\n").trim();
    if (bodyText.length > 0) {
      sections.push({ file: filePath, section: currentSection, body: bodyText });
    }
  }

  return sections;
}

/**
 * Score a section against query terms.
 * Higher score = better match.
 */
function scoreSection(body: string, section: string, queryTerms: string[], fullQuery: string): number {
  const lowerBody = body.toLowerCase();
  const lowerSection = section.toLowerCase();
  const lowerQuery = fullQuery.toLowerCase();
  let score = 0;

  // Exact phrase match in body (highest value)
  if (lowerBody.includes(lowerQuery)) {
    score += 10;
  }

  // Exact phrase match in section header
  if (lowerSection.includes(lowerQuery)) {
    score += 8;
  }

  // Individual term matches
  for (const term of queryTerms) {
    const lowerTerm = term.toLowerCase();

    // Term in section header (high value — headers are semantically dense)
    if (lowerSection.includes(lowerTerm)) {
      score += 3;
    }

    // Count term occurrences in body (diminishing returns after 3)
    const regex = new RegExp(lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const matches = lowerBody.match(regex);
    if (matches) {
      score += Math.min(matches.length, 3);
    }
  }

  return score;
}

/**
 * Extract a snippet from the body, centered around the first match.
 * Returns up to ~500 characters of context.
 */
function extractSnippet(body: string, queryTerms: string[], maxLength: number = 500): string {
  const lowerBody = body.toLowerCase();

  // Find the first matching term's position
  let firstMatchIdx = body.length;
  for (const term of queryTerms) {
    const idx = lowerBody.indexOf(term.toLowerCase());
    if (idx !== -1 && idx < firstMatchIdx) {
      firstMatchIdx = idx;
    }
  }

  // If no match found (scored on header only), return the start of the body
  if (firstMatchIdx >= body.length) {
    firstMatchIdx = 0;
  }

  // Extract a window around the match
  const start = Math.max(0, firstMatchIdx - 100);
  const end = Math.min(body.length, start + maxLength);
  let snippet = body.slice(start, end).trim();

  // Add ellipsis if we're not at the boundaries
  if (start > 0) snippet = "..." + snippet;
  if (end < body.length) snippet = snippet + "...";

  return snippet;
}

/**
 * Discover decision domain files by checking which ones exist (F.2 — use fileExists, not fetchFile).
 * Returns paths for existing domain files.
 */
async function discoverDecisionDomainFiles(projectSlug: string): Promise<string[]> {
  const possibleDomains = [
    "decisions/architecture.md",
    "decisions/operations.md",
    "decisions/optimization.md",
    "decisions/onboarding.md",
    "decisions/integrity.md",
    "decisions/resilience.md",
    "decisions/efficiency.md",
  ];

  const results = await Promise.allSettled(
    possibleDomains.map(async (path) => {
      try {
        const exists = await fileExists(projectSlug, path);
        return exists ? path : null;
      } catch {
        return null;
      }
    })
  );

  return results
    .filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((p): p is string => p !== null);
}

/**
 * Register the prism_search tool on an MCP server instance.
 */
export function registerSearch(server: McpServer): void {
  server.tool(
    "prism_search",
    "Search across all living documents within a single PRISM project. Returns relevant snippets ranked by keyword match. Strictly single-project — cross-project search is prohibited.",
    inputSchema,
    async ({ project_slug, query, max_results }) => {
      const start = Date.now();
      const limit = max_results ?? 10;
      logger.info("prism_search", { project_slug, query, max_results: limit });

      try {
        // Step 1: Discover all searchable files
        const livingDocPaths = [...LIVING_DOCUMENTS];
        const domainFiles = await discoverDecisionDomainFiles(project_slug);
        const allPaths = [...livingDocPaths, ...domainFiles];

        // Step 2: Fetch all files in parallel
        const fetchResults = await Promise.allSettled(
          allPaths.map(async (path) => {
            try {
              const result = await fetchFile(project_slug, path);
              return { path, content: result.content, size: result.size };
            } catch {
              return null;
            }
          })
        );

        const files = fetchResults
          .filter((r): r is PromiseFulfilledResult<{ path: string; content: string; size: number } | null> =>
            r.status === "fulfilled"
          )
          .map((r) => r.value)
          .filter((f): f is { path: string; content: string; size: number } => f !== null);

        // Step 3: Split all files into sections
        const allSections = files.flatMap((f) => splitIntoSections(f.content, f.path));

        // Step 4: Score each section
        const queryTerms = query
          .split(/\s+/)
          .filter((t) => t.length > 2) // Skip tiny words
          .map((t) => t.replace(/[^a-zA-Z0-9-_]/g, ""));

        if (queryTerms.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Query must contain at least one term with 3+ characters",
                project: project_slug,
              }),
            }],
            isError: true,
          };
        }

        const scored: SearchSnippet[] = allSections
          .map((section) => {
            const score = scoreSection(section.body, section.section, queryTerms, query);
            return {
              file: section.file,
              section: section.section,
              score,
              snippet: extractSnippet(section.body, queryTerms),
            };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        // Step 5: Build response
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

        const result = {
          project: project_slug,
          query,
          results_count: scored.length,
          files_searched: files.length,
          sections_searched: allSections.length,
          bytes_searched: totalBytes,
          results: scored,
          ms: Date.now() - start,
        };

        logger.info("prism_search complete", {
          project_slug,
          query,
          resultsCount: scored.length,
          filesSearched: files.length,
          sectionsSearched: allSections.length,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_search failed", { project_slug, query, error: message });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: message, project: project_slug }),
          }],
          isError: true,
        };
      }
    }
  );
}
