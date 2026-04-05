/**
 * prism_analytics tool — Cross-session analytics computed entirely server-side.
 * Zero context cost for historical data. Returns computed summaries, not raw data.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
  fetchFiles,
  listDirectory,
  listCommits,
  getCommit,
  fileExists,
  listRepos,
} from "../github/client.js";
import { LIVING_DOCUMENTS, LEGACY_LIVING_DOCUMENTS } from "../config.js";
import { resolveDocPath, resolveDocExists, resolveDocFiles } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import {
  parseMarkdownTable,
  extractSection,
  extractHeaders,
} from "../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount } from "../validation/handoff.js";

const METRICS = [
  "decision_velocity",
  "session_patterns",
  "handoff_size_history",
  "file_churn",
  "decision_graph",
  "health_summary",
  "fresh_eyes_check",
] as const;

type Metric = (typeof METRICS)[number];

/**
 * Compute decision velocity — decisions per session over time.
 */
async function decisionVelocity(projectSlug: string) {
  const resolved = await resolveDocPath(projectSlug, "decisions/_INDEX.md");
  const decisionFile = { content: resolved.content, sha: resolved.sha, size: resolved.content.length };
  const rows = parseMarkdownTable(decisionFile.content);

  const idKey = Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "id") ?? "ID";
  const sessionKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "session") ?? "Session";
  const statusKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "status") ?? "Status";

  // Group by session
  const bySession: Record<string, number> = {};
  for (const row of rows) {
    const session = row[sessionKey] ?? "unknown";
    bySession[session] = (bySession[session] ?? 0) + 1;
  }

  const sessions = Object.keys(bySession).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10)
  );
  const totalDecisions = rows.length;
  const totalSessions = sessions.length;
  const avgPerSession = totalSessions > 0 ? totalDecisions / totalSessions : 0;

  // Status breakdown
  const statusCounts: Record<string, number> = {};
  for (const row of rows) {
    const status = (row[statusKey] ?? "unknown").toUpperCase();
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    data: {
      total_decisions: totalDecisions,
      total_sessions: totalSessions,
      average_per_session: Math.round(avgPerSession * 10) / 10,
      by_session: bySession,
      status_breakdown: statusCounts,
      recent_trend: sessions.slice(-5).map((s) => ({
        session: s,
        count: bySession[s],
      })),
    },
    summary: `${totalDecisions} decisions across ${totalSessions} sessions (avg ${avgPerSession.toFixed(1)}/session). ${statusCounts["SETTLED"] ?? 0} settled, ${statusCounts["PENDING"] ?? 0} pending.`,
  };
}

/**
 * Compute session patterns — frequency and duration trends.
 *
 * Handles multiple session header formats:
 *   ### Session 7 (03-23-26 CST)
 *   ### Session 9 (03-27-26 18:08:29 CST)
 *   ### CC Session 3 (03-27-26 CST)
 *   ### Session 3 (2026-02-19)
 */
async function sessionPatterns(projectSlug: string) {
  const resolved = await resolveDocPath(projectSlug, "session-log.md");
  const sessionLog = { content: resolved.content, size: resolved.content.length };
  const content = sessionLog.content;

  const sessions: Array<{ number: number; date: string }> = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Match: ### Session N (...) or ### CC Session N (...)
    const headerMatch = line.match(/^###\s+(?:CC\s+)?Session\s+(\d+)\s*\(([^)]+)\)/i);
    if (!headerMatch) continue;

    const sessionNum = parseInt(headerMatch[1], 10);
    const dateStr = headerMatch[2].trim();

    // Try MM-DD-YY format first (e.g., "03-23-26 CST" or "03-27-26 18:08:29 CST")
    const mmddyy = dateStr.match(/^(\d{2})-(\d{2})-(\d{2})/);
    if (mmddyy) {
      const year = 2000 + parseInt(mmddyy[3], 10);
      sessions.push({ number: sessionNum, date: `${year}-${mmddyy[1]}-${mmddyy[2]}` });
      continue;
    }

    // Try YYYY-MM-DD format (e.g., "2026-02-19")
    const yyyymmdd = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (yyyymmdd) {
      sessions.push({ number: sessionNum, date: `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}` });
      continue;
    }
  }

  // Calculate gaps between sessions
  const gaps: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const prev = new Date(sessions[i - 1].date);
    const curr = new Date(sessions[i].date);
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
    gaps.push(diffDays);
  }

  const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const totalSessions = sessions.length;
  const firstDate = sessions[0]?.date ?? "unknown";
  const lastDate = sessions[sessions.length - 1]?.date ?? "unknown";

  return {
    data: {
      total_sessions: totalSessions,
      first_session_date: firstDate,
      last_session_date: lastDate,
      average_gap_days: Math.round(avgGap * 10) / 10,
      recent_sessions: sessions.slice(-5),
      gap_trend: gaps.slice(-10),
    },
    summary: `${totalSessions} sessions from ${firstDate} to ${lastDate}. Average gap: ${avgGap.toFixed(1)} days between sessions.`,
  };
}

/**
 * Compute handoff size history from handoff-history/ directory.
 */
async function handoffSizeHistory(projectSlug: string) {
  let historyEntries = await listDirectory(projectSlug, ".prism/handoff-history");
  if (historyEntries.length === 0) {
    historyEntries = await listDirectory(projectSlug, "handoff-history");
  }
  const handoffFiles = historyEntries
    .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));

  const versions = handoffFiles.map((f) => {
    const versionMatch = f.name.match(/handoff_v(\d+)/);
    const dateMatch = f.name.match(/(\d{4}-\d{2}-\d{2})/);
    return {
      version: versionMatch ? parseInt(versionMatch[1], 10) : 0,
      date: dateMatch ? dateMatch[1] : "unknown",
      size_bytes: f.size,
      size_kb: Math.round((f.size / 1024) * 10) / 10,
      file: f.name,
    };
  });

  // Get current handoff size
  let currentSize = 0;
  let currentVersion = 0;
  try {
    const resolved = await resolveDocPath(projectSlug, "handoff.md");
    currentSize = resolved.content.length;
    currentVersion = parseHandoffVersion(resolved.content) ?? 0;
  } catch {
    // Current handoff might not exist
  }

  const trend =
    versions.length >= 2
      ? versions[versions.length - 1].size_bytes > versions[0].size_bytes
        ? "growing"
        : "shrinking"
      : "insufficient_data";

  return {
    data: {
      current_size_bytes: currentSize,
      current_size_kb: Math.round((currentSize / 1024) * 10) / 10,
      current_version: currentVersion,
      history: versions,
      trend,
      version_count: versions.length,
    },
    summary: `Handoff currently at ${(currentSize / 1024).toFixed(1)}KB (v${currentVersion}). ${versions.length} historical versions tracked. Trend: ${trend}.`,
  };
}

/**
 * Compute file churn — which files change most often.
 */
async function fileChurn(projectSlug: string) {
  const commits = await listCommits(projectSlug, { per_page: 100 });

  // Fetch file details for recent commits
  const fileChanges: Record<string, number> = {};
  const commitDetails = await Promise.allSettled(
    commits.slice(0, 30).map((c) => getCommit(projectSlug, c.sha))
  );

  for (const outcome of commitDetails) {
    if (outcome.status === "fulfilled") {
      for (const file of outcome.value.files) {
        fileChanges[file] = (fileChanges[file] ?? 0) + 1;
      }
    }
  }

  const ranked = Object.entries(fileChanges)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([file, count]) => ({ file, changes: count }));

  const totalCommits = commits.length;

  return {
    data: {
      total_commits_analyzed: Math.min(totalCommits, 30),
      total_commits: totalCommits,
      most_changed_files: ranked,
    },
    summary: `Analyzed ${Math.min(totalCommits, 30)} commits. Most changed: ${ranked.slice(0, 3).map((f) => `${f.file} (${f.changes}x)`).join(", ")}.`,
  };
}

/**
 * Compute decision graph — find cross-references between decisions.
 */
async function decisionGraph(projectSlug: string) {
  const resolved = await resolveDocPath(projectSlug, "decisions/_INDEX.md");
  const decisionFile = { content: resolved.content, size: resolved.content.length };
  const rows = parseMarkdownTable(decisionFile.content);

  const idKey = Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "id") ?? "ID";
  const titleKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "title") ?? "Title";
  const statusKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "status") ?? "Status";

  // Build adjacency list by scanning for D-N references in the full content
  const decisions = rows.map((row) => ({
    id: row[idKey] ?? "",
    title: row[titleKey] ?? "",
    status: row[statusKey] ?? "",
  }));

  const decisionIds = new Set(decisions.map((d) => d.id));

  // Scan full content for cross-references
  const adjacency: Record<string, string[]> = {};
  const lines = decisionFile.content.split("\n");

  // Look for lines mentioning decisions and track context
  for (const decision of decisions) {
    adjacency[decision.id] = [];
  }

  // Simple approach: for each decision row, check if it references other D-N ids
  for (const row of rows) {
    const rowId = row[idKey] ?? "";
    const rowContent = Object.values(row).join(" ");
    const refs = rowContent.match(/D-\d+/g) ?? [];

    for (const ref of refs) {
      if (ref !== rowId && decisionIds.has(ref)) {
        if (!adjacency[rowId]) adjacency[rowId] = [];
        if (!adjacency[rowId].includes(ref)) {
          adjacency[rowId].push(ref);
        }
      }
    }
  }

  // Note: Cross-references are extracted from per-row content above.
  // Previously, this block scanned full content split by ## headers,
  // which created a complete graph because all D-N IDs appeared in the
  // same table block. Removed in KI-2 fix.

  const totalEdges = Object.values(adjacency).reduce((sum, refs) => sum + refs.length, 0) / 2;
  const connectedDecisions = Object.entries(adjacency).filter(
    ([, refs]) => refs.length > 0
  );
  const isolatedDecisions = Object.entries(adjacency).filter(
    ([, refs]) => refs.length === 0
  );

  // Find most-connected decisions (hubs)
  const hubs = Object.entries(adjacency)
    .map(([id, refs]) => ({
      id,
      title: decisions.find((d) => d.id === id)?.title ?? "",
      connections: refs.length,
    }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 5);

  return {
    data: {
      total_decisions: decisions.length,
      total_edges: totalEdges,
      adjacency,
      hubs,
      connected_count: connectedDecisions.length,
      isolated_count: isolatedDecisions.length,
      decisions: decisions.map((d) => ({
        ...d,
        references: adjacency[d.id] ?? [],
      })),
    },
    summary: `${decisions.length} decisions, ${totalEdges} cross-references. ${connectedDecisions.length} connected, ${isolatedDecisions.length} isolated. Top hub: ${hubs[0]?.id ?? "none"} (${hubs[0]?.connections ?? 0} connections).`,
  };
}

/**
 * Compute health summary for one or all projects.
 */
async function healthSummary(projectSlug?: string) {
  if (projectSlug) {
    // Single project health (D-67: backward-compatible resolution)
    const docMap = await resolveDocFiles(projectSlug, [...LEGACY_LIVING_DOCUMENTS]);
    const present = LEGACY_LIVING_DOCUMENTS.filter((d) => docMap.has(d));
    const missing = LEGACY_LIVING_DOCUMENTS.filter((d) => !docMap.has(d));

    const handoff = docMap.get("handoff.md");
    const handoffSize = handoff?.size ?? 0;
    const handoffVersion = handoff ? (parseHandoffVersion(handoff.content) ?? 0) : 0;
    const sessionCount = handoff ? (parseSessionCount(handoff.content) ?? 0) : 0;

    const health =
      missing.length >= 3 || handoffSize > 15360
        ? "critical"
        : missing.length >= 1 || handoffSize > 10240
          ? "needs-attention"
          : "healthy";

    return {
      data: {
        project: projectSlug,
        health,
        documents_present: present.length,
        documents_total: LIVING_DOCUMENTS.length,
        missing_documents: missing,
        handoff_size_kb: Math.round((handoffSize / 1024) * 10) / 10,
        handoff_version: handoffVersion,
        session_count: sessionCount,
      },
      summary: `${projectSlug}: ${health}. ${present.length}/${LIVING_DOCUMENTS.length} docs present. Handoff: ${(handoffSize / 1024).toFixed(1)}KB (v${handoffVersion}), ${sessionCount} sessions.`,
    };
  }

  // Cross-project health (D-67: backward-compatible resolution)
  const allRepos = await listRepos();
  const prismChecks = await Promise.allSettled(
    allRepos.map(async (repo) => {
      const resolved = await resolveDocExists(repo, "handoff.md");
      return { repo, isPrism: resolved.exists };
    })
  );

  const prismProjects = prismChecks
    .filter(
      (r): r is PromiseFulfilledResult<{ repo: string; isPrism: boolean }> =>
        r.status === "fulfilled" && r.value.isPrism
    )
    .map((r) => r.value.repo);

  const projectHealthResults = await Promise.allSettled(
    prismProjects.map(async (repo) => {
      const resolved = await resolveDocPath(repo, "handoff.md");
      const version = parseHandoffVersion(resolved.content) ?? 0;
      const sessions = parseSessionCount(resolved.content) ?? 0;

      // Quick doc check using resolver
      const docChecks = await Promise.allSettled(
        LEGACY_LIVING_DOCUMENTS.map((d) => resolveDocExists(repo, d))
      );
      const presentCount = docChecks.filter(
        (r) => r.status === "fulfilled" && r.value.exists
      ).length;
      const missingCount = LEGACY_LIVING_DOCUMENTS.length - presentCount;

      const handoffSize = resolved.content.length;
      const health =
        missingCount >= 3 || handoffSize > 15360
          ? "critical"
          : missingCount >= 1 || handoffSize > 10240
            ? "needs-attention"
            : "healthy";

      return {
        project: repo,
        health,
        handoff_size_kb: Math.round((handoffSize / 1024) * 10) / 10,
        handoff_version: version,
        session_count: sessions,
        documents_present: presentCount,
      };
    })
  );

  const projects = projectHealthResults
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value);

  const healthy = projects.filter((p: any) => p.health === "healthy").length;
  const needsAttention = projects.filter((p: any) => p.health === "needs-attention").length;
  const critical = projects.filter((p: any) => p.health === "critical").length;

  return {
    data: {
      total_projects: projects.length,
      healthy,
      needs_attention: needsAttention,
      critical,
      projects,
    },
    summary: `${projects.length} PRISM projects: ${healthy} healthy, ${needsAttention} need attention, ${critical} critical.`,
  };
}

/**
 * Compute fresh-eyes check — which projects are overdue for fresh-eyes review.
 */
async function freshEyesCheck(projectSlug?: string) {
  const projectsToCheck: string[] = [];

  if (projectSlug) {
    projectsToCheck.push(projectSlug);
  } else {
    // Discover all PRISM projects (D-67: backward-compatible)
    const allRepos = await listRepos();
    const prismChecks = await Promise.allSettled(
      allRepos.map(async (repo) => {
        const resolved = await resolveDocExists(repo, "handoff.md");
        return { repo, isPrism: resolved.exists };
      })
    );

    for (const result of prismChecks) {
      if (result.status === "fulfilled" && result.value.isPrism) {
        projectsToCheck.push(result.value.repo);
      }
    }
  }

  const checks = await Promise.allSettled(
    projectsToCheck.map(async (repo) => {
      let sessionCount = 0;
      let lastFreshEyesSession = 0;

      try {
        const resolved = await resolveDocPath(repo, "handoff.md");
        sessionCount = parseSessionCount(resolved.content) ?? 0;
      } catch {
        return { project: repo, session_count: 0, sessions_since_fresh_eyes: 0, overdue: false };
      }

      try {
        const resolved = await resolveDocPath(repo, "session-log.md");
        const sessionLog = { content: resolved.content };
        const content = sessionLog.content.toLowerCase();

        // Find last mention of "fresh-eyes" or "fresh eyes"
        const lines = content.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i].includes("fresh-eyes") || lines[i].includes("fresh eyes")) {
            // Look backwards for session number
            for (let j = i; j >= Math.max(0, i - 10); j--) {
              const sessionMatch = lines[j].match(/session\s+(\d+)/i);
              if (sessionMatch) {
                lastFreshEyesSession = parseInt(sessionMatch[1], 10);
                break;
              }
            }
            break;
          }
        }
      } catch {
        // session-log might not exist
      }

      const sessionsSince = sessionCount - lastFreshEyesSession;
      const overdue = sessionsSince > 10;

      return {
        project: repo,
        session_count: sessionCount,
        last_fresh_eyes_session: lastFreshEyesSession || null,
        sessions_since_fresh_eyes: sessionsSince,
        overdue,
      };
    })
  );

  const results = checks
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value);

  const overdueCount = results.filter((r: any) => r.overdue).length;
  const overdueProjects = results
    .filter((r: any) => r.overdue)
    .map((r: any) => r.project);

  return {
    data: {
      projects_checked: results.length,
      overdue_count: overdueCount,
      overdue_projects: overdueProjects,
      details: results,
      threshold_sessions: 10,
    },
    summary: overdueCount > 0
      ? `${overdueCount} project(s) overdue for fresh-eyes review: ${overdueProjects.join(", ")}.`
      : `All ${results.length} project(s) are within fresh-eyes review threshold.`,
  };
}

/**
 * Register the prism_analytics tool on an MCP server instance.
 */
export function registerAnalytics(server: McpServer): void {
  server.tool(
    "prism_analytics",
    "Cross-session analytics. Metrics: decision_velocity, session_patterns, handoff_size_history, file_churn, decision_graph, health_summary, fresh_eyes_check.",
    {
      project_slug: z
        .string()
        .optional()
        .describe("Specific project, or omit for cross-project analytics"),
      metric: z
        .enum([
          "decision_velocity",
          "session_patterns",
          "handoff_size_history",
          "file_churn",
          "decision_graph",
          "health_summary",
          "fresh_eyes_check",
        ])
        .optional()
        .default("health_summary")
        .describe("Which metric to compute"),
    },
    async ({ project_slug, metric }) => {
      const start = Date.now();
      const effectiveMetric = (metric ?? "health_summary") as Metric;
      logger.info("prism_analytics", { project_slug: project_slug ?? "all", metric: effectiveMetric });

      try {
        let data: Record<string, any> = {};
        let summary = "";

        switch (effectiveMetric) {
          case "decision_velocity": {
            if (!project_slug) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ error: "decision_velocity requires a project_slug" }),
                }],
                isError: true,
              };
            }
            const result = await decisionVelocity(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "session_patterns": {
            if (!project_slug) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ error: "session_patterns requires a project_slug" }),
                }],
                isError: true,
              };
            }
            const result = await sessionPatterns(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "handoff_size_history": {
            if (!project_slug) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ error: "handoff_size_history requires a project_slug" }),
                }],
                isError: true,
              };
            }
            const result = await handoffSizeHistory(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "file_churn": {
            if (!project_slug) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ error: "file_churn requires a project_slug" }),
                }],
                isError: true,
              };
            }
            const result = await fileChurn(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "decision_graph": {
            if (!project_slug) {
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ error: "decision_graph requires a project_slug" }),
                }],
                isError: true,
              };
            }
            const result = await decisionGraph(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "health_summary": {
            const result = await healthSummary(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }

          case "fresh_eyes_check": {
            const result = await freshEyesCheck(project_slug);
            data = result.data;
            summary = result.summary;
            break;
          }
        }

        const result = {
          metric: effectiveMetric,
          project: project_slug ?? "all",
          data,
          computed_at: new Date().toISOString(),
          summary,
        };

        logger.info("prism_analytics complete", {
          metric: effectiveMetric,
          project_slug: project_slug ?? "all",
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_analytics failed", {
          metric: effectiveMetric,
          project_slug: project_slug ?? "all",
          error: message,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: message,
              metric: effectiveMetric,
              project: project_slug ?? "all",
            }),
          }],
          isError: true,
        };
      }
    }
  );
}
