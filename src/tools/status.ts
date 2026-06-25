/**
 * prism_status tool — Health status for one project or all PRISM projects.
 * Checks living document completeness, handoff size, and overall project health.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listDirectory, listRepos } from "../github/client.js";
import {
  DOC_ROOT,
  LIVING_DOCUMENTS,
  LIVING_DOCUMENT_NAMES,
  HANDOFF_CRITICAL_SIZE,
  HANDOFF_WARNING_SIZE,
  STATUS_WALL_CLOCK_DEADLINE_MS,
  SYNTHESIS_ENABLED,
} from "../config.js";
import { resolveDocExists, resolveDocPath } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import { MemoryCache } from "../utils/cache.js";
import { parseHandoffVersion, parseSessionCount } from "../validation/handoff.js";
import { extractSection } from "../utils/summarizer.js";
import { getSynthesisHealth } from "../ai/synthesis-tracker.js";
import { buildRouteReadinessStatus } from "../llm/route-status.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

/**
 * Repo list cache (A-9 / S47 P3.1). Multi-project status calls `listRepos`
 * every invocation; back-to-back calls from a single session hit GitHub up
 * to N+1 times for data that is effectively stable on minute-scale.
 *
 * 5-minute TTL. Short enough that a newly created repo becomes visible
 * within one coffee break; long enough that consecutive status calls in a
 * single session share one fetch. Invalidate explicitly via
 * {@link clearRepoListCache} when a new repo is created.
 */
const listReposCache = new MemoryCache<string[]>("status-list-repos", 5);
const REPO_LIST_KEY = "owner";

/**
 * Handoff-existence cache (A-9 / S47 P3.1). The multi-project fan-out
 * probes `handoff.md` once per repo to decide which are PRISM projects.
 * Result changes only when a repo joins/leaves the PRISM fold — rare.
 * 10-minute TTL. Keyed by repo slug.
 */
const handoffExistenceCache = new MemoryCache<{ exists: boolean; path: string; legacy: boolean }>(
  "status-handoff-exists",
  10,
);

/**
 * Invalidate the repo-list cache. Call after a new repo is created so the
 * next multi-project status call picks it up without waiting for the TTL.
 *
 * Deliberate test-only export (SRV-112/SRV-113): no production caller wires
 * this today — multi-status tolerates up to one TTL of staleness for a brand
 * new repo. status-cache.test.ts uses it to reset module-level cache state
 * between cases, so it is retained (not zero-consumer dead code).
 */
export function clearRepoListCache(): void {
  listReposCache.invalidate(REPO_LIST_KEY);
}

/**
 * Invalidate the handoff-existence cache entry for a specific repo. Call
 * when a repo is scaffolded into PRISM (first handoff.md created) so the
 * next status sweep sees it.
 *
 * Deliberate test-only export (SRV-112/SRV-113), same rationale as
 * {@link clearRepoListCache}: retained as test cache-reset infrastructure.
 */
export function clearHandoffExistenceCache(repo?: string): void {
  if (repo) handoffExistenceCache.invalidate(repo);
  else handoffExistenceCache.clear();
}

async function getCachedRepoList(): Promise<string[]> {
  const cached = listReposCache.get(REPO_LIST_KEY);
  if (cached) return cached;
  const fresh = await listRepos();
  listReposCache.set(REPO_LIST_KEY, fresh);
  return fresh;
}

async function getCachedHandoffExists(
  repo: string,
): Promise<{ exists: boolean; path: string; legacy: boolean }> {
  const cached = handoffExistenceCache.get(repo);
  if (cached) return cached;
  const fresh = await resolveDocExists(repo, "handoff.md");
  handoffExistenceCache.set(repo, fresh);
  return fresh;
}

/** Sentinel used to signal that the tool-level deadline fired (brief-444 R-deadlines). */
const STATUS_DEADLINE_SENTINEL = Symbol("status.deadline");

/** Input schema for prism_status */
const inputSchema = {
  project_slug: z.string().optional().describe("Specific project or omit for all PRISM projects"),
  include_details: z.boolean().optional().default(false).describe("Include detailed document status"),
};

type HealthLevel = "healthy" | "needs-attention" | "critical";

/** Archive files tracked by prism_status (S40 FINDING-14 C4).
 *  Writers exist for session-log-archive.md and insights-archive.md; the other
 *  two are reserved in doc-guard for future lifecycle tools. All four are
 *  reported regardless so operators can see when any writer kicks in. */
export const STATUS_ARCHIVE_FILES = [
  "session-log-archive.md",
  "insights-archive.md",
  "known-issues-archive.md",
  "build-history-archive.md",
] as const;

type ArchiveFileName = (typeof STATUS_ARCHIVE_FILES)[number];
type ArchiveStatus = { exists: boolean; sizeBytes: number | null };
type ArchiveMap = Record<ArchiveFileName, ArchiveStatus>;

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
  archives: ArchiveMap;
  archives_summary?: string;
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
 * SRV-70: existence + size for every living doc + archive, sourced from
 * directory LISTINGS rather than a fetchFile-per-doc fan-out. Lists .prism/ and
 * .prism/decisions/, falling back to the legacy repo root for pre-migration
 * projects (assertValidPath permits the "" root path). Returns bare-name → byte
 * size; absence from the map means the file does not exist.
 */
async function listLivingDocSizes(projectSlug: string): Promise<Map<string, number>> {
  let root = await listDirectory(projectSlug, DOC_ROOT);
  let decisions = await listDirectory(projectSlug, `${DOC_ROOT}/decisions`);
  if (root.length === 0) {
    // Legacy pre-.prism layout — living docs live at the repo root.
    root = await listDirectory(projectSlug, "");
    decisions = await listDirectory(projectSlug, "decisions");
  }
  const sizes = new Map<string, number>();
  for (const e of root) if (e.type === "file") sizes.set(e.name, e.size);
  for (const e of decisions) if (e.type === "file") sizes.set(`decisions/${e.name}`, e.size);
  return sizes;
}

/**
 * Get health status for a single project.
 *
 * SRV-70: one directory listing carries existence + size for all 10 docs + 4
 * archives. Pre-brief-465 this fetched every doc AND archive in FULL per project
 * (~30 GitHub calls; a 10-project sweep ≈ 300) purely to read sizes the listing
 * already provides — then used ONLY handoff.md's content. Now only handoff.md's
 * content is fetched; everything else is existence + size from the listing.
 */
async function getProjectHealth(
  projectSlug: string,
  includeDetails: boolean
): Promise<ProjectHealth> {
  const sizes = await listLivingDocSizes(projectSlug);

  const documents = LIVING_DOCUMENT_NAMES.map((docName) => {
    const size = sizes.get(docName);
    return { document: docName, exists: size !== undefined, size_bytes: size ?? 0 };
  });

  const archives = STATUS_ARCHIVE_FILES.reduce((acc, name) => {
    const size = sizes.get(name);
    acc[name] = { exists: size !== undefined, sizeBytes: size ?? null };
    return acc;
  }, {} as ArchiveMap);

  const missingDocs = documents.filter(d => !d.exists).map(d => d.document);
  const handoffSize = sizes.get("handoff.md") ?? 0;

  // Only handoff.md's CONTENT is consumed (version/session/status). Existence is
  // already known from the listing, so a content-fetch failure degrades to the
  // parse defaults rather than dropping the project.
  let handoffContent = "";
  if (sizes.has("handoff.md")) {
    try {
      const resolved = await resolveDocPath(projectSlug, "handoff.md");
      handoffContent = resolved.content;
    } catch {
      // keep "" — health still computes from the listed sizes
    }
  }

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
    archives,
  };

  if (includeDetails) {
    result.details = documents.map(d => ({
      document: d.document,
      exists: d.exists,
      size_bytes: d.size_bytes,
    }));
    result.archives_summary = formatArchivesLine(archives);
  }

  return result;
}

/**
 * Format archives section for human-readable output (include_details=true).
 * Returns a one-line summary suitable for inclusion in a status report.
 */
export function formatArchivesLine(archives: ArchiveMap): string {
  const parts = STATUS_ARCHIVE_FILES.map(name => {
    const status = archives[name];
    if (!status.exists) return `${name} (not yet created)`;
    const kb = status.sizeBytes !== null ? (status.sizeBytes / 1024).toFixed(1) : "?";
    return `${name} (${kb} KB)`;
  });
  return `Archives: ${parts.join(", ")}`;
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
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_status", { project_slug: project_slug ?? "all", include_details });

      // brief-444 R-deadlines — tool-level wall-clock deadline. The
      // multi-project sweep probes every repo for handoff.md and fans out
      // 10 doc checks + 4 archive probes per PRISM project; a hung GitHub
      // call previously held the connection until the MCP client gave up.
      // Mirrors prism_push (S40 C4).
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlinePromise = new Promise<typeof STATUS_DEADLINE_SENTINEL>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(STATUS_DEADLINE_SENTINEL), STATUS_WALL_CLOCK_DEADLINE_MS);
      });

      const workPromise = (async () => {
      try {
        const llmRouting = buildRouteReadinessStatus();
        if (project_slug) {
          // Single project status
          const health = await getProjectHealth(project_slug, include_details ?? false);

          if (health.health === "needs-attention" || health.health === "critical") {
            diagnostics.warn("HEALTH_NEEDS_ATTENTION", `Project health: ${health.health}`, { health: health.health, missingDocs: health.missing_documents, handoffSizeBytes: health.handoff_size_bytes });
          }

          logger.info("prism_status complete (single)", {
            project: project_slug,
            health: health.health,
            ms: Date.now() - start,
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ ...health, llm_routing: llmRouting, diagnostics: diagnostics.list() }),
            }],
          };
        }

        // Multi-project status — discover all PRISM projects. Uses the P3.1
        // caches (5-min for repo list, 10-min for handoff existence) so
        // back-to-back multi-project status calls share one fetch per layer.
        const allRepos = await getCachedRepoList();
        logger.info("prism_status repos discovered", { count: allRepos.length, repos: allRepos.slice(0, 5) });

        // Check which repos have a handoff.md (i.e., are PRISM projects) — check both paths
        const prismChecks = await Promise.allSettled(
          allRepos.map(async (repo) => {
            const resolved = await getCachedHandoffExists(repo);
            return { repo, isPrism: resolved.exists };
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

        // SRV-54: confident omission is the most dangerous failure mode for a
        // fleet-health surface — a transient GitHub failure made a project
        // VANISH from the report indistinguishably from not existing, while the
        // summary still claimed completeness. Surface the dropped projects (the
        // health-fetch rejections, plus repos whose PRISM-classification check
        // itself failed) as a diagnostic + a projects_failed field.
        const droppedFromHealth = healthResults.flatMap((r, idx) =>
          r.status === "rejected"
            ? [{ project: prismProjects[idx], reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
            : [],
        );
        const droppedFromClassification = prismChecks.flatMap((r, idx) =>
          r.status === "rejected"
            ? [{ project: allRepos[idx], reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
            : [],
        );
        const droppedProjects = [...droppedFromHealth, ...droppedFromClassification];

        const summary = {
          total_projects: projects.length,
          projects_failed: droppedProjects.length,
          healthy: projects.filter(p => p.health === "healthy").length,
          needs_attention: projects.filter(p => p.health === "needs-attention").length,
          critical: projects.filter(p => p.health === "critical").length,
          synthesis: {
            enabled: SYNTHESIS_ENABLED,
            ...getSynthesisHealth(),
          },
          llm_routing: llmRouting,
          projects,
        };

        if (droppedProjects.length > 0) {
          diagnostics.warn(
            "PROJECTS_DROPPED",
            `${droppedProjects.length} project(s) dropped from the fleet view due to fetch failures — the report below is INCOMPLETE: ${droppedProjects.map(d => d.project).join(", ")}`,
            { dropped: droppedProjects },
          );
        }

        const unhealthyCount = summary.needs_attention + summary.critical;
        if (unhealthyCount > 0) {
          diagnostics.warn("STATUS_PARTIAL", `${unhealthyCount} project(s) need attention or are critical`, { needsAttention: summary.needs_attention, critical: summary.critical });
        }

        logger.info("prism_status complete (multi)", {
          totalProjects: projects.length,
          healthy: summary.healthy,
          needsAttention: summary.needs_attention,
          critical: summary.critical,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...summary, diagnostics: diagnostics.list() }) }],
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
      })();

      try {
        const raced = await Promise.race([workPromise, deadlinePromise]);
        if (raced === STATUS_DEADLINE_SENTINEL) {
          const deadlineSec = Math.round(STATUS_WALL_CLOCK_DEADLINE_MS / 1000);
          logger.error("prism_status deadline exceeded", {
            project_slug: project_slug ?? "all",
            deadlineMs: STATUS_WALL_CLOCK_DEADLINE_MS,
            elapsedMs: Date.now() - start,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `prism_status deadline exceeded (${deadlineSec}s)`,
                project: project_slug ?? "all",
              }),
            }],
            isError: true,
          };
        }
        return raced;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    }
  );
}
