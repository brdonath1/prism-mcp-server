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

import { fetchFile, fetchFileConditional, fileExists } from "../github/client.js";
import { DOC_ROOT } from "../config.js";
import { logger } from "./logger.js";
import { ruleSourceCache, type RuleSourceCacheEntry } from "./cache.js";

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

/** Outcome of {@link resolveRuleSourceDoc}. Superset of `resolveDocPath`'s
 *  shape plus the cache-provenance flag callers log/diagnose with. */
export interface RuleSourceResolution {
  path: string;
  content: string;
  sha: string;
  legacy: boolean;
  /** True when GitHub answered 304 and the cached body was served. */
  notModified: boolean;
}

/**
 * Resolve a RULE-SOURCE document (standing-rules.md, insights.md,
 * standing-rules-archive.md) through the sha/ETag-keyed cache (S208 PR-S2a).
 *
 * Contract, and why it is safe: this is `resolveDocPath` with a conditional
 * request bolted on. A cache hit still asks GitHub -- with `If-None-Match` --
 * and only serves the cached body when the server answers 304, i.e. when it
 * has certified the body unchanged. So the CONTENT returned is exactly what
 * `resolveDocPath` would have returned at the same instant; what changes is
 * that ~320KB (prism's standing-rules.md) stops crossing the wire on the
 * unchanged case, and 304s do not consume rate-limit budget.
 *
 * Path resolution mirrors `resolveDocPath` exactly, SRV-44 discrimination
 * included: `.prism/{docName}` first, legacy repo root only on a genuine 404.
 * A cached entry that 404s (the doc moved, or was migrated to `.prism/`) drops
 * from the cache and re-resolves from scratch.
 *
 * Callers that are NOT rule sources should keep using `resolveDocPath` -- the
 * cache is deliberately scoped to the three heavy, repeatedly-read documents.
 */
export async function resolveRuleSourceDoc(
  projectSlug: string,
  docName: string,
): Promise<RuleSourceResolution> {
  const key = `${projectSlug}:${docName}`;
  const cached = ruleSourceCache.get(key);

  if (cached?.etag) {
    try {
      const conditional = await fetchFileConditional(projectSlug, cached.path, cached.etag);
      if (conditional.status === "not_modified") {
        logger.debug("rule source served from cache (304)", {
          projectSlug,
          docName,
          path: cached.path,
          bytes: cached.content.length,
        });
        return {
          path: cached.path,
          content: cached.content,
          sha: cached.sha,
          legacy: cached.legacy,
          notModified: true,
        };
      }
      return storeRuleSource(key, {
        path: cached.path,
        content: conditional.content,
        sha: conditional.sha,
        etag: conditional.etag,
        legacy: cached.legacy,
      });
    } catch (error) {
      // The cached path no longer resolves. Only a genuine 404 justifies a
      // re-resolve (SRV-44): an operational 401/403/timeout must surface as
      // the real cause rather than silently walking to the legacy root copy.
      const msg = error instanceof Error ? error.message : String(error);
      if (!/Not found/i.test(msg)) throw error;
      ruleSourceCache.invalidate(key);
      logger.info("rule source cached path vanished - re-resolving", {
        projectSlug,
        docName,
        path: cached.path,
      });
    }
  }

  const newPath = `${DOC_ROOT}/${docName}`;
  try {
    const file = await fetchFileConditional(projectSlug, newPath);
    if (file.status === "not_modified") {
      // Unreachable: no If-None-Match was sent. Treated as a cache miss.
      throw new Error(`Unexpected 304 without a conditional request: ${projectSlug}/${newPath}`);
    }
    return storeRuleSource(key, {
      path: newPath,
      content: file.content,
      sha: file.sha,
      etag: file.etag,
      legacy: false,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!/Not found/i.test(msg)) throw error;
    const file = await fetchFileConditional(projectSlug, docName);
    if (file.status === "not_modified") {
      throw new Error(`Unexpected 304 without a conditional request: ${projectSlug}/${docName}`);
    }
    logger.info("doc-resolver: using legacy path", { projectSlug, docName });
    return storeRuleSource(key, {
      path: docName,
      content: file.content,
      sha: file.sha,
      etag: file.etag,
      legacy: true,
    });
  }
}

/** Write a resolved rule source into the cache and return the caller's view. */
function storeRuleSource(key: string, entry: RuleSourceCacheEntry): RuleSourceResolution {
  // No ETag means no conditional path is available; caching the body would
  // only risk serving it unvalidated later, so skip the write entirely.
  if (entry.etag) {
    ruleSourceCache.set(key, entry);
  }
  return {
    path: entry.path,
    content: entry.content,
    sha: entry.sha,
    legacy: entry.legacy,
    notModified: false,
  };
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
