/**
 * doc-guard — Prevents duplicate living documents at repo root (D-67).
 *
 * RULES (KI-28 — unified with resolveDocPushPath):
 * 1. If a push targets a root-level living doc path AND .prism/ version exists → REDIRECT to .prism/
 * 2. If a push targets a root-level living doc path AND only a legacy root copy exists → ALLOW root (unmigrated repo)
 * 3. If a push targets a root-level living doc path AND it exists NOWHERE → REDIRECT to .prism/ (create canonical)
 * 4. If a push targets a .prism/ path → ALLOW (correct path)
 * 5. If a push targets a non-living-doc path → ALLOW (not our concern)
 *
 * This function is called before EVERY file push across ALL tools.
 *
 * KI-28: the redirect itself is NOT re-implemented here. doc-guard only owns
 * the "is this a root-level PRISM living doc?" GATE; the actual root→.prism/
 * resolution is delegated to `resolveDocPushPath` (src/utils/doc-resolver.ts) —
 * the SAME write-path resolver used by prism_fetch/prism_patch's sibling
 * resolveDocPath and by finalize/log-decision/log-insight/synthesize. Before
 * this fix, prism_push fell back to the LITERAL root path when no `.prism/`
 * copy existed, silently creating a root-level duplicate while the canonical
 * `.prism/` file went stale. Delegating closes that divergence: a brand-new
 * living doc now lands at `.prism/<path>` exactly like every other write path.
 */

import { DOC_ROOT } from "../config.js";
import { resolveDocPushPath } from "./doc-resolver.js";
import { logger } from "./logger.js";

/**
 * Known PRISM living document base names (without DOC_ROOT prefix).
 * Includes mandatory docs, archive files, support files, and known directory prefixes.
 *
 * Exported (SRV-17) as the single source for the set of bare names that resolve
 * through the doc-resolver — prism_fetch derives its resolver allowlist from
 * this same list so the two can no longer drift (the drift made a bare
 * standing-rules.md / *-archive.md / boot-test.md fetch return a false
 * FILE_NOT_FOUND on migrated repos).
 */
export const KNOWN_PRISM_PATHS: string[] = [
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
  "standing-rules.md",
  // Archive files
  "session-log-archive.md",
  "known-issues-archive.md",
  "build-history-archive.md",
  "insights-archive.md",
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
 * Resolve a push path to prevent duplication (KI-28).
 *
 * doc-guard owns ONLY the gate: "is this a root-level PRISM living doc?".
 * The actual root→`.prism/` resolution is delegated to the shared
 * `resolveDocPushPath` so prism_push resolves a bare living-doc path
 * IDENTICALLY to every other write path — including the brand-new-doc case,
 * which now lands at the canonical `.prism/<path>` instead of the literal
 * repo root. Non-living-doc and already-`.prism/`-prefixed paths short-circuit
 * the gate and never touch the resolver (so arbitrary files are untouched).
 *
 * @param projectSlug - Project repo name
 * @param path - The file path about to be pushed
 * @returns The safe path to push to (redirected to `.prism/` when applicable)
 */
export async function guardPushPath(
  projectSlug: string,
  path: string
): Promise<{ path: string; redirected: boolean }> {
  // Not a root-level PRISM living doc (arbitrary file, or already `.prism/`-
  // prefixed) — allow as-is. This gate is what keeps resolveDocPushPath, which
  // would otherwise `.prism/`-prefix ANY non-existent path, from redirecting
  // genuine non-living-doc pushes (e.g. src/index.ts, CHANGELOG.md).
  if (!isRootLevelPrismPath(path)) {
    return { path, redirected: false };
  }

  // Root-level PRISM living doc — resolve through the shared write-path
  // resolver: `.prism/` if it exists, else a legacy root copy if it exists,
  // else the canonical `.prism/<path>` for a brand-new doc.
  const resolvedPath = await resolveDocPushPath(projectSlug, path);
  const redirected = resolvedPath !== path;

  if (redirected) {
    logger.warn("doc-guard: REDIRECTED root push to .prism/", {
      projectSlug,
      originalPath: path,
      redirectedPath: resolvedPath,
    });
  }

  return { path: resolvedPath, redirected };
}
