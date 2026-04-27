/**
 * prism_analytics tool — Cross-session analytics computed entirely server-side.
 * Zero context cost for historical data. Returns computed summaries, not raw data.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFiles,
  listDirectory,
  listCommits,
  getCommit,
  listRepos,
} from "../github/client.js";
import { LIVING_DOCUMENTS, LIVING_DOCUMENT_NAMES } from "../config.js";
import { resolveDocPath, resolveDocExists, resolveDocFiles } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import {
  parseMarkdownTable,
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
    summary: `${totalDecisions} decisions across ${totalSessions} sessions (avg ${avgPerSession.toFixed(1)}/session). ${statusCounts.SETTLED ?? 0} settled, ${statusCounts.PENDING ?? 0} pending.`,
  };
}

/**
 * Parse session headers out of a session-log body. Supports two real-world
 * formats observed across PRISM projects:
 *
 *   PRISM-style:  `### Session 25 (2026-03-15)` or `### CC Session 3 (03-27-26 CST)`
 *   PF2-style:    `## S162 — 03-15-26`
 *
 * Returns one entry per matched header. Ignores any line that matches neither
 * format. Handles both em-dash (U+2014) and en-dash (U+2013) between "S" and
 * the date in PF2-style headers.
 */
export function parseSessionHeaders(
  content: string
): Array<{ number: number; date: string }> {
  const parsed: Array<{ number: number; date: string }> = [];

  for (const line of content.split("\n")) {
    // PRISM-style: ### [CC ]Session N (date...)
    const prismMatch = line.match(
      /^#{2,3}\s+(?:CC\s+)?Session\s+(\d+)\s*\(([^)]+)\)/i
    );
    // PF2-style: ## S{N} — MM-DD-YY (accepts em-dash, en-dash, or ASCII dash)
    const pf2Match = line.match(
      /^#{2,3}\s+S(\d+)\s+[—–-]+\s+([0-9]{1,4}[-/][0-9]{1,2}[-/][0-9]{1,4})/i
    );

    let sessionNum: number;
    let rawDate: string;
    if (prismMatch) {
      sessionNum = parseInt(prismMatch[1], 10);
      rawDate = prismMatch[2].trim();
    } else if (pf2Match) {
      sessionNum = parseInt(pf2Match[1], 10);
      rawDate = pf2Match[2].trim();
    } else {
      continue;
    }

    // Normalize date to YYYY-MM-DD. Accepts MM-DD-YY (PF2/PRISM-CST) and YYYY-MM-DD.
    const mmddyy = rawDate.match(/^(\d{2})[-/](\d{2})[-/](\d{2})(?:\D|$)/);
    if (mmddyy) {
      const year = 2000 + parseInt(mmddyy[3], 10);
      parsed.push({
        number: sessionNum,
        date: `${year}-${mmddyy[1]}-${mmddyy[2]}`,
      });
      continue;
    }
    const yyyymmdd = rawDate.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (yyyymmdd) {
      parsed.push({
        number: sessionNum,
        date: `${yyyymmdd[1]}-${yyyymmdd[2]}-${yyyymmdd[3]}`,
      });
    }
  }

  return parsed;
}

/**
 * Compute session patterns — frequency and duration trends.
 *
 * Reads both `session-log.md` (current) and `session-log-archive.md` (rotated
 * older sessions) when present, then sorts by parsed date ASC before computing
 * gaps. Handles multiple session header formats via {@link parseSessionHeaders}.
 */
async function sessionPatterns(projectSlug: string) {
  const resolved = await resolveDocPath(projectSlug, "session-log.md");
  const currentSessions = parseSessionHeaders(resolved.content);

  // Archive is optional — absence is normal for projects that have not rotated.
  let archiveSessions: Array<{ number: number; date: string }> = [];
  try {
    const archive = await resolveDocPath(projectSlug, "session-log-archive.md");
    archiveSessions = parseSessionHeaders(archive.content);
  } catch {
    // No archive — fine.
  }

  // Merge + dedupe by session number (archive is authoritative for older numbers;
  // current wins on collision since it reflects any re-numbering fixes).
  const bySessionNum = new Map<number, { number: number; date: string }>();
  for (const s of archiveSessions) bySessionNum.set(s.number, s);
  for (const s of currentSessions) bySessionNum.set(s.number, s);

  // Sort by parsed date ASC. Document order is not reliable — PRISM writes
  // newest-on-top, so relying on .split("\n") order inverts first/last.
  const sessions = Array.from(bySessionNum.values()).sort((a, b) => {
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

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
      archive_included: archiveSessions.length > 0,
    },
    summary: `${totalSessions} sessions from ${firstDate} to ${lastDate}. Average gap: ${avgGap.toFixed(1)} days between sessions.`,
  };
}

/**
 * Sort handoff-history entries in ascending numeric version order.
 * Lexicographic sort mixes `v49` before `v9`; the numeric sort produces a
 * chronological order that makes the size trend meaningful. (A-11)
 */
export function sortHandoffVersionsAsc<T extends { name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const va = parseInt(a.name.match(/handoff_v(\d+)/)?.[1] ?? "0", 10);
    const vb = parseInt(b.name.match(/handoff_v(\d+)/)?.[1] ?? "0", 10);
    return va - vb;
  });
}

/**
 * Parse a handoff-history filename into `{ version, date }`.
 *
 * Accepts:
 *   - `handoff_vN_YYYY-MM-DD.md`       → `{ version: N, date: "YYYY-MM-DD" }`
 *   - `handoff_vN_MM-DD-YY.md`         → `{ version: N, date: "20YY-MM-DD" }` (A-20)
 *   - `handoff_vN.md` (no date)        → `{ version: N, date: "unknown" }`
 *   - anything else                    → `{ version: 0, date: "unknown" }`
 */
export function parseHandoffFilename(name: string): { version: number; date: string } {
  const versionMatch = name.match(/handoff_v(\d+)/);
  const version = versionMatch ? parseInt(versionMatch[1], 10) : 0;
  const iso = name.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return { version, date: iso[1] };
  const short = name.match(/_(\d{2})-(\d{2})-(\d{2})\.md$/);
  if (short) return { version, date: `20${short[3]}-${short[1]}-${short[2]}` };
  return { version, date: "unknown" };
}

/**
 * Compute handoff size history from handoff-history/ directory.
 */
async function handoffSizeHistory(projectSlug: string) {
  let historyEntries = await listDirectory(projectSlug, ".prism/handoff-history");
  if (historyEntries.length === 0) {
    historyEntries = await listDirectory(projectSlug, "handoff-history");
  }
  const handoffFiles = sortHandoffVersionsAsc(
    historyEntries.filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md")),
  );

  const versions = handoffFiles.map((f) => {
    const parsed = parseHandoffFilename(f.name);
    return {
      version: parsed.version,
      date: parsed.date,
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

  // Compute trend from most-recent delta (versions[-1] vs versions[-2]).
  // Comparing first vs last across many versions obscures the current trend
  // if there was a mid-lifecycle refactor; single-step delta is the clearest
  // "are we growing right now?" signal.
  let trend: "growing" | "shrinking" | "stable" | "insufficient_data";
  if (versions.length < 2) {
    trend = "insufficient_data";
  } else {
    const last = versions[versions.length - 1].size_bytes;
    const prior = versions[versions.length - 2].size_bytes;
    if (last > prior) trend = "growing";
    else if (last < prior) trend = "shrinking";
    else trend = "stable";
  }

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
 * Extract directional decision edges from a decision domain-file body.
 *
 * Splits the content into per-decision sections headed by `### D-N:` and,
 * for each section, records an edge `ownerId → ref` for every D-N id cited
 * inside that section's body (excluding the owner itself and any reference
 * to an id not present in `knownIds`).
 *
 * Pure function — no network, no filesystem — so it can be tested with
 * synthetic content.
 */
export function extractDecisionEdges(
  content: string,
  knownIds: Set<string>,
): Array<{ from: string; to: string }> {
  const sectionRegex = /^###\s+(D-\d+)\s*:/gm;
  const starts: Array<{ index: number; id: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRegex.exec(content)) !== null) {
    starts.push({ index: m.index, id: m[1] });
  }
  const edges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const ownerId = starts[i].id;
    if (!knownIds.has(ownerId)) continue;
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : content.length;
    const body = content.slice(start, end);
    const refs = body.match(/D-\d+/g) ?? [];
    for (const ref of refs) {
      if (ref === ownerId) continue;
      if (!knownIds.has(ref)) continue;
      const edgeKey = `${ownerId}→${ref}`;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({ from: ownerId, to: ref });
    }
  }
  return edges;
}

/**
 * Compute decision graph — find cross-references between decisions.
 *
 * The `_INDEX.md` lookup table only contains one row per decision with no
 * cross-references — scanning it produces a trivially-disconnected graph.
 * Real edges live in the decision domain files (`architecture.md`,
 * `operations.md`, etc.), inside individual `### D-N:` entries that cite
 * other D-N IDs in their prose. Scan those instead.
 *
 * Edges are directional: `D-Y` mentions `D-X` → edge `Y → X` (Y refines/
 * supersedes/depends-on X). The prior `/2` divisor assumed undirected graphs
 * and halved the real edge count.
 */
async function decisionGraph(projectSlug: string) {
  const indexResolved = await resolveDocPath(projectSlug, "decisions/_INDEX.md");
  const rows = parseMarkdownTable(indexResolved.content);

  const idKey = Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "id") ?? "ID";
  const titleKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "title") ?? "Title";
  const statusKey =
    Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "status") ?? "Status";

  const decisions = rows.map((row) => ({
    id: row[idKey] ?? "",
    title: row[titleKey] ?? "",
    status: row[statusKey] ?? "",
  }));
  const decisionIds = new Set(decisions.map((d) => d.id).filter((id): id is string => !!id));

  // Initialize adjacency with all decisions (so isolated ones show up).
  const adjacency: Record<string, string[]> = {};
  for (const d of decisions) {
    if (d.id) adjacency[d.id] = [];
  }

  // Locate and scan domain files under .prism/decisions/. Fall back to legacy
  // root `decisions/` for pre-migration projects.
  let domainDirEntries = await listDirectory(projectSlug, ".prism/decisions");
  let domainDir = ".prism/decisions";
  if (domainDirEntries.length === 0) {
    domainDirEntries = await listDirectory(projectSlug, "decisions");
    domainDir = "decisions";
  }

  const domainPaths = domainDirEntries
    .filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== "_INDEX.md")
    .map((e) => `${domainDir}/${e.name}`);

  const domainFiles = await fetchFiles(projectSlug, domainPaths);

  for (const [, file] of domainFiles.files) {
    const edges = extractDecisionEdges(file.content, decisionIds);
    for (const { from, to } of edges) {
      if (!adjacency[from].includes(to)) {
        adjacency[from].push(to);
      }
    }
  }

  // Directional edge count — no /2 halving. "D-Y supersedes D-X" is one edge,
  // not half of a symmetric pair.
  const totalEdges = Object.values(adjacency).reduce((sum, refs) => sum + refs.length, 0);

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
      domain_files_scanned: domainPaths.length,
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
    const docMap = await resolveDocFiles(projectSlug, [...LIVING_DOCUMENT_NAMES]);
    const present = LIVING_DOCUMENT_NAMES.filter((d) => docMap.has(d));
    const missing = LIVING_DOCUMENT_NAMES.filter((d) => !docMap.has(d));

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
        LIVING_DOCUMENT_NAMES.map((d) => resolveDocExists(repo, d))
      );
      const presentCount = docChecks.filter(
        (r) => r.status === "fulfilled" && r.value.exists
      ).length;
      const missingCount = LIVING_DOCUMENT_NAMES.length - presentCount;

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
      const diagnostics = new DiagnosticsCollector();
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
            const criticalCount = result.data.critical as number | undefined;
            const needsAttCount = result.data.needs_attention as number | undefined;
            const healthVal = result.data.health as string | undefined;
            if (criticalCount !== undefined && needsAttCount !== undefined && (criticalCount > 0 || needsAttCount > 0)) {
              diagnostics.warn("METRIC_PARTIAL_DATA", `${criticalCount} critical and ${needsAttCount} needs-attention project(s)`, { critical: criticalCount, needsAttention: needsAttCount });
            } else if (healthVal !== undefined && healthVal !== "healthy") {
              diagnostics.warn("METRIC_PARTIAL_DATA", `Project health: ${healthVal}`, { health: healthVal });
            }
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
          diagnostics: diagnostics.list(),
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
