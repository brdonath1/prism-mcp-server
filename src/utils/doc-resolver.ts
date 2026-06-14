/**
 * doc-resolver — Document path resolution with `.prism/`-first, root-fallback.
 *
 * Prefers `.prism/{docName}`; falls back to `{docName}` at repo root. The
 * fallback serves two purposes: (1) belt-and-suspenders safety for any repo
 * whose living docs are still at the root level, and (2) explicit support for
 * arbitrary non-living-doc paths (e.g. `reports/*.md`, `briefs/*.md`) passed
 * through prism_fetch — those files legitimately live at the root and rely on
 * the fallback to resolve. Do NOT remove the fallback without first replacing
 * (2) with an explicit "arbitrary-path" code path.
 */

import { fetchFile, fileExists } from "../github/client.js";
import { DOC_ROOT } from "../config.js";
import { logger } from "./logger.js";

/**
 * Resolve a document path: tries .prism/{docName} first, then {docName} at root.
 * Returns the content and the resolved path.
 *
 * @param projectSlug - Project repo name
 * @param docName - Document name WITHOUT DOC_ROOT prefix (e.g., "handoff.md", "decisions/_INDEX.md")
 * @returns Object with path (resolved), content, sha, and a `legacy` flag indicating
 *   whether the root fallback was used (true) instead of the `.prism/` path (false).
 *   The fallback is a live feature for arbitrary root-path fetches — not a migration-only
 *   path — so `legacy: true` is NOT an error or deprecation signal.
 */
export async function resolveDocPath(
  projectSlug: string,
  docName: string
): Promise<{ path: string; content: string; sha: string; legacy: boolean }> {
  const newPath = `${DOC_ROOT}/${docName}`;

  try {
    const file = await fetchFile(projectSlug, newPath);
    return { path: newPath, content: file.content, sha: file.sha, legacy: false };
  } catch (error) {
    // SRV-44: only a genuine 404 ("Not found") justifies the legacy root
    // fallback. A transient 401/403/timeout/5xx on the `.prism/` path is an
    // operational error — falling through to the root copy would either serve
    // a stale legacy file or surface a misleading "decisions/_INDEX.md not
    // found" for what was really an INS-311 auth blip. Rethrow operational
    // errors; mirror the discrimination already done in pushFile (client.ts)
    // and collectRegistryIdSets (finalize.ts).
    const msg = error instanceof Error ? error.message : String(error);
    if (!/Not found/i.test(msg)) {
      throw error;
    }
    // Fall back to legacy root path (genuine .prism/ 404).
    const file = await fetchFile(projectSlug, docName);
    logger.info("doc-resolver: using legacy path", { projectSlug, docName });
    return { path: docName, content: file.content, sha: file.sha, legacy: true };
  }
}

/**
 * Check if a document exists at either .prism/ or root path.
 * Returns the resolved path or null if not found.
 */
export async function resolveDocExists(
  projectSlug: string,
  docName: string
): Promise<{ exists: boolean; path: string; legacy: boolean }> {
  const newPath = `${DOC_ROOT}/${docName}`;

  if (await fileExists(projectSlug, newPath)) {
    return { exists: true, path: newPath, legacy: false };
  }
  if (await fileExists(projectSlug, docName)) {
    return { exists: true, path: docName, legacy: true };
  }
  return { exists: false, path: newPath, legacy: false };
}

/**
 * Given a document name, return the path to push to.
 * If the file currently exists at legacy path, push to legacy path (don't create duplicates).
 * If the file exists at .prism/ or doesn't exist yet, push to .prism/.
 */
export async function resolveDocPushPath(
  projectSlug: string,
  docName: string
): Promise<string> {
  const newPath = `${DOC_ROOT}/${docName}`;

  // Check if file exists at .prism/ — if so, push there
  if (await fileExists(projectSlug, newPath)) {
    return newPath;
  }

  // Check if file exists at legacy root — if so, push there (repo not yet migrated)
  if (await fileExists(projectSlug, docName)) {
    return docName;
  }

  // File doesn't exist anywhere — create at .prism/
  return newPath;
}

/**
 * Resolve and fetch multiple documents in parallel. This is the production
 * multi-doc resolver used by all call sites; it per-doc resolves .prism/ vs
 * legacy-root location and fetches concurrently. (SRV-111: the never-wired
 * `resolveDocFilesOptimized` variant was removed; this is no longer deprecated.)
 * Returns a Map keyed by docName (without DOC_ROOT prefix) for callers that use
 * .get("handoff.md"), etc.
 */
export async function resolveDocFiles(
  projectSlug: string,
  docNames: string[]
): Promise<Map<string, { content: string; sha: string; size: number }>> {
  const results = new Map<string, { content: string; sha: string; size: number }>();

  const resolved = await Promise.allSettled(
    docNames.map(async (docName) => {
      const result = await resolveDocPath(projectSlug, docName);
      return { docName, content: result.content, sha: result.sha, size: result.content.length };
    })
  );

  for (const outcome of resolved) {
    if (outcome.status === "fulfilled") {
      const { docName, ...fileResult } = outcome.value;
      results.set(docName, fileResult);
    }
  }

  return results;
}
