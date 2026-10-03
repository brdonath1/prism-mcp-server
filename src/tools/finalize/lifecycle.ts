/**
 * prism_finalize — archive / prune / architecture-metadata lifecycle helpers.
 *
 * Extracted verbatim from `src/tools/finalize.ts` (D-FINALIZE-SPLIT F2): the
 * archive configs, the task-queue Recently Completed cap + pruner, and the
 * architecture.md metadata refresh. The in-commitPhase archive block that
 * consumes these deliberately stays in finalize.ts (write-path control flow).
 * Must not import finalize.ts.
 */

import { fetchFile, pushFile } from "../../github/client.js";
import { logger } from "../../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../../utils/doc-resolver.js";
import type { ArchiveConfig } from "../../utils/archive.js";

/** Archive lifecycle configs (S40 FINDING-14). Applied during commitPhase
 *  before the atomic commit so live + archive changes land together. */
export const SESSION_LOG_ARCHIVE_CONFIG: ArchiveConfig = {
  thresholdBytes: 15_000,
  retentionCount: 20,
  // brief-459 / SRV-79: 20 entries on the flagship project measure ~18.8KB —
  // ABOVE the 15KB threshold — so fixed-count retention left the live log
  // permanently over threshold, running a 1-entry archive cycle every
  // finalize. The size-aware floor lets retention shrink until the live log
  // actually fits, while always keeping the 5 newest sessions.
  minRetentionCount: 5,
  entryMarker: /^### Session (\d+)/m,
  archiveHeader:
    "# Session Log Archive — PRISM Framework\n\n" +
    "> Archived sessions moved here during finalization when session-log.md exceeds 15KB.\n" +
    "> Archives are NEVER read by synthesis.\n",
  // Session-log layout varies per project (prism's is chronological, newest
  // LAST) — a hardcoded "top" archived the newest entries (S165, INS-316).
  mostRecentAt: "auto",
};

export const INSIGHTS_ARCHIVE_CONFIG: ArchiveConfig = {
  thresholdBytes: 20_000,
  retentionCount: 15,
  entryMarker: /^### INS-(\d+):/m,
  protectedMarkers: ["STANDING RULE"],
  activeSection: "## Active",
  archiveHeader:
    "# Insights Archive — PRISM Framework\n\n" +
    "> Archived insights moved here during finalization when insights.md exceeds 20KB.\n" +
    "> Only non-STANDING-RULE insights are archived.\n" +
    "> Archives are NEVER read by synthesis.\n\n" +
    "## Archived\n",
  mostRecentAt: "bottom",
};

/** Default cap for the `## Recently Completed` section in task-queue.md (brief-422 Piece 4). */
export const TASK_QUEUE_RECENTLY_COMPLETED_CAP = 15;

/**
 * Prune `## Recently Completed` in task-queue.md to keep at most `maxEntries`
 * `### ` entries (brief-422 Piece 4). The section is reverse-chronological —
 * newest entries at the top — so excess entries are dropped from the bottom.
 *
 * Header rewrite: when the section header carries a `(last N sessions)`
 * decoration (e.g. `## Recently Completed (last 10 sessions)`), update it to
 * `(last {maxEntries} sessions)` so the displayed cap matches the enforced
 * cap. A header without the decoration is left untouched — operators may
 * have intentionally omitted the count.
 *
 * Returns the modified content, or `null` when the section is missing or
 * already within cap (no-op signal — the caller skips the write).
 */
export function pruneRecentlyCompleted(
  content: string,
  maxEntries: number = TASK_QUEUE_RECENTLY_COMPLETED_CAP,
): string | null {
  const sectionRe = /^##\s+Recently Completed[^\n]*$/m;
  const sectionMatch = content.match(sectionRe);
  if (!sectionMatch) return null;

  const sectionStart = sectionMatch.index!;
  const headerLine = sectionMatch[0];
  const headerEnd = sectionStart + headerLine.length;

  // Find the next top-level (## ) heading or EOF sentinel — that's where the
  // Recently Completed body ends.
  const tail = content.slice(headerEnd);
  const nextH2 = tail.match(/\n##\s+\S/);
  const nextEof = tail.match(/\n<!--\s*EOF:/);
  let bodyEndOffset: number;
  if (nextH2 && (!nextEof || nextH2.index! < nextEof.index!)) {
    bodyEndOffset = nextH2.index! + 1; // +1 to consume leading \n
  } else if (nextEof) {
    bodyEndOffset = nextEof.index! + 1;
  } else {
    bodyEndOffset = tail.length;
  }
  const bodyEnd = headerEnd + bodyEndOffset;
  const body = content.slice(headerEnd, bodyEnd);

  // Enumerate `### ` entry start positions inside the section body.
  const entryStarts: number[] = [];
  for (const m of body.matchAll(/^###\s+/gm)) {
    entryStarts.push(m.index!);
  }
  if (entryStarts.length <= maxEntries) return null;

  const dropFromOffset = entryStarts[maxEntries];
  const trimmedBody = body.slice(0, dropFromOffset).replace(/\s+$/, "") + "\n\n";

  // Update the displayed cap when the header carries a `(last N sessions)`
  // decoration. Match `(last 10 sessions)`, `(last 15 sessions)`, etc.
  const newHeader = headerLine.replace(
    /\(last\s+\d+\s+sessions?\)/i,
    `(last ${maxEntries} sessions)`,
  );

  return (
    content.slice(0, sectionStart) +
    newHeader +
    trimmedBody +
    content.slice(bodyEnd)
  );
}

/**
 * Update architecture.md metadata (brief-422 Piece 3).
 *
 * Behavior:
 *   - Gates on `auto_update_architecture: true` in the project's
 *     `.prism/config.yaml`. Skip silently otherwise so projects opt in
 *     deliberately.
 *   - Refreshes the `> Updated: S{N} ({date})` preamble line via regex.
 *     Skips silently when the pattern is not found (defensive contract for
 *     legacy / non-PRISM-style architecture.md files).
 *   - When the file carries the `**MCP server:**` Stack bullet, refreshes
 *     its parenthetical to the prism-mcp-server version read from
 *     `prism-mcp-server/package.json`. No-op when the version is already
 *     present.
 *
 * All errors are returned in the result, never thrown — the caller surfaces
 * them in the response but commit success is unaffected.
 */
export async function updateArchitectureMetadata(
  projectSlug: string,
  sessionNumber: number,
  sessionDate: string,
): Promise<{ updated: boolean; reason?: string; version?: string }> {
  // 1. Config gate — must explicitly opt in via `.prism/config.yaml`.
  let configEnabled = false;
  try {
    const config = await fetchFile(projectSlug, ".prism/config.yaml");
    configEnabled = /^\s*auto_update_architecture:\s*true\s*$/im.test(config.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Not found")) {
      logger.debug("architecture metadata: config fetch failed", { projectSlug, error: msg });
    }
  }
  if (!configEnabled) {
    return { updated: false, reason: "auto_update_architecture not enabled" };
  }

  // 2. Fetch architecture.md.
  let arch: { content: string; sha: string };
  try {
    const resolved = await resolveDocPath(projectSlug, "architecture.md");
    arch = { content: resolved.content, sha: resolved.sha };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, reason: `architecture.md fetch failed: ${msg}` };
  }

  // 3. Preamble pattern — defensive contract: only process files that
  //    already carry the canonical `> Updated: S{N} ({date})` line.
  const preambleRe = /^>\s*Updated:\s*S\d+\s*\([^)]+\)/m;
  if (!preambleRe.test(arch.content)) {
    return { updated: false, reason: "preamble pattern not found" };
  }

  let newContent = arch.content.replace(
    preambleRe,
    `> Updated: S${sessionNumber} (${sessionDate})`,
  );

  // 4. Stack bullet refresh — best-effort. Reads version from
  //    prism-mcp-server's package.json (the ground-truth source per brief).
  let version: string | undefined;
  try {
    const pkg = await fetchFile("prism-mcp-server", "package.json");
    const versionMatch = pkg.content.match(/"version"\s*:\s*"([^"]+)"/);
    if (versionMatch) {
      version = versionMatch[1];
      const bulletRe = /^(\s*-\s+\*\*MCP server:\*\*\s+Node\.js\/TypeScript on Railway)\s*\(([^)]*)\)\s*$/m;
      newContent = newContent.replace(bulletRe, (match, prefix, parens) => {
        if (parens.includes(`v${version}`)) return match;
        return `${prefix} (v${version})`;
      });
    }
  } catch (err) {
    logger.debug("architecture metadata: package.json read failed", {
      projectSlug,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (newContent === arch.content) {
    return { updated: false, reason: "no change required" };
  }

  // 5. Push.
  try {
    const pushPath = await resolveDocPushPath(projectSlug, "architecture.md");
    const pushResult = await pushFile(
      projectSlug,
      pushPath,
      newContent,
      `prism: S${sessionNumber} architecture.md preamble refresh`,
    );
    // pushFile reports HTTP failures as a result shape — `updated: true` on
    // a failed push would flow into the finalize response as a false
    // architecture_updated journal entry (SRV-18 corroborated site).
    if (!pushResult.success) {
      return {
        updated: false,
        reason: `architecture.md push failed: ${pushResult.error ?? "unknown error"}`,
      };
    }
    return { updated: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, reason: `architecture.md push failed: ${msg}` };
  }
}
