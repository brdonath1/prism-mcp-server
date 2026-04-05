/**
 * doc-guard — Prevents duplicate living documents at repo root (D-67).
 *
 * RULES:
 * 1. If a push targets a root-level living doc path AND .prism/ version exists → REDIRECT to .prism/
 * 2. If a push targets a root-level living doc path AND no .prism/ version exists → ALLOW (unmigrated repo)
 * 3. If a push targets a .prism/ path → ALLOW (correct path)
 * 4. If a push targets a non-living-doc path → ALLOW (not our concern)
 *
 * This function is called before EVERY file push across ALL tools.
 */

import { fileExists } from "../github/client.js";
import { DOC_ROOT } from "../config.js";
import { logger } from "./logger.js";

/**
 * Known PRISM living document base names (without DOC_ROOT prefix).
 * Includes mandatory docs, archive files, support files, and known directory prefixes.
 */
const KNOWN_PRISM_PATHS: string[] = [
  // 10 mandatory living documents
  "handoff.md",
  "decisions/_INDEX.md",
  "session-log.md",
  "task-queue.md",
  "eliminated.md",
  "architecture.md",
  "glossary.md",
  "known-issues.md",
  "insights.md",
  "intelligence-brief.md",
  // Support files
  "boot-test.md",
  // Archive files
  "session-log-archive.md",
  "known-issues-archive.md",
  "build-history-archive.md",
];

/**
 * Known PRISM directory prefixes (files under these dirs are PRISM-managed).
 */
const KNOWN_PRISM_DIR_PREFIXES: string[] = [
  "decisions/",
  "handoff-history/",
  "artifacts/",
  "briefs/",
  "_scratch/",
];

/**
 * Check if a path is a root-level PRISM document (without .prism/ prefix).
 */
function isRootLevelPrismPath(path: string): boolean {
  if (path.startsWith(`${DOC_ROOT}/`)) return false; // Already .prism/-prefixed

  // Check exact file matches
  if (KNOWN_PRISM_PATHS.includes(path)) return true;

  // Check directory prefixes (e.g., "decisions/architecture.md")
  if (KNOWN_PRISM_DIR_PREFIXES.some(prefix => path.startsWith(prefix))) return true;

  return false;
}

/**
 * Resolve a push path to prevent duplication.
 *
 * If the path is a root-level PRISM doc and .prism/ version exists,
 * redirects to .prism/. Otherwise returns the original path.
 *
 * @param projectSlug - Project repo name
 * @param path - The file path about to be pushed
 * @returns The safe path to push to (may be redirected to .prism/)
 */
export async function guardPushPath(
  projectSlug: string,
  path: string
): Promise<{ path: string; redirected: boolean }> {
  // Not a root-level PRISM path — allow as-is
  if (!isRootLevelPrismPath(path)) {
    return { path, redirected: false };
  }

  // It IS a root-level PRISM path. Check if .prism/ version exists.
  const newPath = `${DOC_ROOT}/${path}`;

  if (await fileExists(projectSlug, newPath)) {
    // .prism/ version exists — REDIRECT to prevent duplication
    logger.warn("doc-guard: REDIRECTED root push to .prism/", {
      projectSlug,
      originalPath: path,
      redirectedPath: newPath,
    });
    return { path: newPath, redirected: true };
  }

  // No .prism/ version — repo not yet migrated, allow root push
  return { path, redirected: false };
}
