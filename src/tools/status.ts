/**
 * prism_status tool — Health status for one project or all PRISM projects.
 * Checks living document completeness, handoff size, and overall project health.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fileExists, listRepos } from "../github/client.js";
import {
  LIVING_DOCUMENTS,
  HANDOFF_CRITICAL_SIZE,
  HANDOFF_WARNING_SIZE,
  SYNTHESIS_ENABLED,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { parseHandoffVersion, parseSessionCount } from "../validation/handoff.js";
import { extractSection } from "../utils/summarizer.js";
import { getSynthesisHealth } from "../ai/synthesis-tracker.js";

/** Input schema for prism_status */
const inputSchema = {
  project_slug: z.string().optional().describe("Specific project or omit for all PRISM projects"),
  include_details: z.boolean().optional().default(false).describe("Include detailed document status"),
};

type HealthLevel = "healthy" | "needs-attention" | "critical";

interface ProjectHealth {
  project: string;
  health: HealthLevel;
  handoff_size_bytes: number;
  handoff_version: number;
  session_count: number;
  documents_present: number;
  documents_total: number;
  missing_documents: string[];
  current_status: string;
  details?: Array<{ document: string; exists: boolean; size_bytes: number }>;
}

/**
 * Compute health level based on document completeness and handoff size.
 */
function computeHealth(missingCount: number, handoffSize: number): HealthLevel {
  if (missingCount >= 3 || handoffSize > HANDOFF_CRITICAL_SIZE) return "critical";
  if (missingCount >= 1 || handoffSize > HANDOFF_WARNING_SIZE) return "needs-attention";
  return "healthy";
}

/**
 * Get health status for a single project.
 */
async function getProjectHealth(
  projectSlug: string,
  includeDetails: boolean
): Promise<ProjectHealth> {
  // Check all 8 living documents in parallel
  const docChecks = await Promise.allSettled(
    LIVING_DOCUMENTS.map(async (doc) => {
      try {
        const result = await fetchFile(projectSlug, doc);
        return { document: doc, exists: true, size_bytes: result.size, content: result.content };
      } catch {
        return { document: doc, exists: false, size_bytes: 0, content: null };
      }
    })
  );

  const documents = docChecks.map((outcome) => {
    if (outcome.status === "fulfilled") return outcome.value;
    return { document: "unknown", exists: false, size_bytes: 0, content: null };
  });

  const missingDocs = documents.filter(d => !d.exists).map(d => d.document);
  const handoffDoc = documents.find(d => d.document === "handoff.md");
  const handoffSize = handoffDoc?.size_bytes ?? 0;
  const handoffContent = handoffDoc?.content ?? "";

  const handoffVersion = parseHandoffVersion(handoffContent) ?? 0;
  const sessionCount = parseSessionCount(handoffContent) ?? 0;

  // Extract status from handoff Meta section
  const meta = extractSection(handoffContent, "Meta") ?? "";
  const statusMatch = meta.match(/Status[:\s]*(.+)/i);
  const currentStatus = statusMatch ? statusMatch[1].trim() : "unknown";

  const health = computeHealth(missingDocs.length, handoffSize);

  const result: ProjectHealth = {
    project: projectSlug,
    health,
    handoff_size_bytes: handoffSize,
    handoff_version: handoffVersion,
    session_count: sessionCount,
    documents_present: LIVING_DOCUMENTS.length - missingDocs.length,
    documents_total: LIVING_DOCUMENTS.length,
    missing_documents: missingDocs,
    current_status: currentStatus,
  };

  if (includeDetails) {
    result.details = documents.map(d => ({
      document: d.document,
      exists: d.exists,
      size_bytes: d.size_bytes,
    }));
  }

  return result;
}

/**
 * Register the prism_status tool on an MCP server instance.
 */
export function registerStatus(server: McpServer): void {
  server.tool(
    "prism_status",
    "Health status for one or all PRISM projects. Checks document completeness and handoff size.",
    inputSchema,
    async ({ project_slug, include_details }) => {
      const start = Date.now();
      logger.info("prism_status", { project_slug: project_slug ?? "all", include_details });

      try {
        if (project_slug) {
          // Single project status
          const health = await getProjectHealth(project_slug, include_details ?? false);

          logger.info("prism_status complete (single)", {
            project: project_slug,
            health: health.health,
            ms: Date.now() - start,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(health) }],
          };
        }

        // Multi-project status — discover all PRISM projects
        const allRepos = await listRepos();
        logger.info("prism_status repos discovered", { count: allRepos.length, repos: allRepos.slice(0, 5) });

        // Check which repos have a handoff.md (i.e., are PRISM projects)
        const prismChecks = await Promise.allSettled(
          allRepos.map(async (repo) => {
            const exists = await fileExists(repo, "handoff.md");
            return { repo, isPrism: exists };
          })
        );

        const prismProjects = prismChecks
          .filter((r): r is PromiseFulfilledResult<{ repo: string; isPrism: boolean }> =>
            r.status === "fulfilled" && r.value.isPrism
          )
          .map(r => r.value.repo);

        logger.info("prism_status handoff check complete", {
          checked: prismChecks.length,
          prismFound: prismProjects.length,
          projects: prismProjects,
          fulfilled: prismChecks.filter(r => r.status === "fulfilled").length,
          rejected: prismChecks.filter(r => r.status === "rejected").length,
        });

        // Fetch health for all PRISM projects in parallel
        const healthResults = await Promise.allSettled(
          prismProjects.map(repo => getProjectHealth(repo, include_details ?? false))
        );

        const projects = healthResults
          .filter((r): r is PromiseFulfilledResult<ProjectHealth> => r.status === "fulfilled")
          .map(r => r.value);

        const summary = {
          total_projects: projects.length,
          healthy: projects.filter(p => p.health === "healthy").length,
          needs_attention: projects.filter(p => p.health === "needs-attention").length,
          critical: projects.filter(p => p.health === "critical").length,
          synthesis: {
            enabled: SYNTHESIS_ENABLED,
            ...getSynthesisHealth(),
          },
          projects,
        };

        logger.info("prism_status complete (multi)", {
          totalProjects: projects.length,
          healthy: summary.healthy,
          needsAttention: summary.needs_attention,
          critical: summary.critical,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_status failed", { error: message });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: message, project: project_slug ?? "all" }),
          }],
          isError: true,
        };
      }
    }
  );
}
