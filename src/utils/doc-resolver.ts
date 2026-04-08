/**
 * doc-resolver — Backward-compatible document path resolution (D-67).
 * Tries .prism/ path first, falls back to legacy root path.
 * REMOVE fallback after all repos confirmed migrated.
 */

import { fetchFile, fetchFiles, fileExists, listDirectory } from "../github/client.js";
import { DOC_ROOT } from "../config.js";
import { logger } from "./logger.js";

/**
 * Resolve a document path: tries .prism/{docName} first, then {docName} at root.
 * Returns the content and the resolved path.
 *
 * @param projectSlug - Project repo name
 * @param docName - Document name WITHOUT DOC_ROOT prefix (e.g., "handoff.md", "decisions/_INDEX.md")
 * @returns Object with path (resolved), content, sha, and whether legacy path was used
 */
export async function resolveDocPath(
  projectSlug: string,
  docName: string
): Promise<{ path: string; content: string; sha: string; legacy: boolean }> {
  const newPath = `${DOC_ROOT}/${docName}`;

  try {
    const file = await fetchFile(projectSlug, newPath);
    return { path: newPath, content: file.content, sha: file.sha, legacy: false };
  } catch {
    // Fall back to legacy root path
    try {
      const file = await fetchFile(projectSlug, docName);
      logger.info("doc-resolver: using legacy path", { projectSlug, docName });
      return { path: docName, content: file.content, sha: file.sha, legacy: true };
    } catch (err) {
      // Neither path exists — rethrow
      throw err;
    }
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
 * Optimized batch document resolution using a single listDirectory call.
 * Reduces worst-case 20 API calls to 1 listing + N targeted fetches.
 *
 * @param projectSlug - Project repo name
 * @param docNames - Document names WITHOUT DOC_ROOT prefix
 * @returns Map keyed by docName
 */
export async function resolveDocFilesOptimized(
  projectSlug: string,
  docNames: string[]
): Promise<Map<string, { content: string; sha: string; size: number }>> {
  const results = new Map<string, { content: string; sha: string; size: number }>();

  // 1. Single listing of .prism/ directory
  let prismListing: Set<string>;
  try {
    const entries = await listDirectory(projectSlug, DOC_ROOT);
    prismListing = new Set<string>();
    for (const entry of entries) {
      prismListing.add(entry.name);
      if (entry.type === "dir") {
        const subEntries = await listDirectory(projectSlug, `${DOC_ROOT}/${entry.name}`);
        for (const sub of subEntries) {
          prismListing.add(`${entry.name}/${sub.name}`);
        }
      }
    }
  } catch {
    prismListing = new Set();
  }

  // 2. Build fetch paths: .prism/ if listed, legacy root otherwise
  const fetchPaths: string[] = [];
  const pathToDocName = new Map<string, string>();
  for (const docName of docNames) {
    const path = prismListing.has(docName) ? `${DOC_ROOT}/${docName}` : docName;
    fetchPaths.push(path);
    pathToDocName.set(path, docName);
  }

  // 3. Fetch all in parallel
  const fetched = await fetchFiles(projectSlug, fetchPaths);

  for (const [path, file] of fetched.files) {
    const docName = pathToDocName.get(path);
    if (docName) {
      results.set(docName, { content: file.content, sha: file.sha, size: file.size });
    }
  }

  if (fetched.incomplete) {
    logger.warn("resolveDocFilesOptimized: partial fetch", {
      projectSlug,
      requested: docNames.length,
      fetched: results.size,
      failed: fetched.failed,
    });
  }

  return results;
}

/**
 * Resolve and fetch multiple documents in parallel.
 * @deprecated Use resolveDocFilesOptimized for better performance.
 * Returns a Map keyed by docName (without DOC_ROOT prefix) for backward compatibility
 * with existing code that uses .get("handoff.md"), etc.
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
