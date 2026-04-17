/**
 * GitHub API client for the PRISM MCP Server.
 * Thin fetch-based wrapper with parallelized operations, retry logic, and structured logging.
 */

import { GITHUB_PAT, GITHUB_OWNER, GITHUB_API_BASE, SERVER_VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
import type {
  FileResult,
  PushResult,
  PushFileInput,
  BatchPushResult,
  AtomicCommitResult,
  GitHubContentsResponse,
  GitHubPutResponse,
  GitHubRepoListItem,
  DirectoryEntry,
  CommitSummary,
  GitHubCommitListItem,
} from "./types.js";

/** Standard headers for all GitHub API requests */
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `prism-mcp-server/${SERVER_VERSION}`,
  };
}

/** Per-request timeout for GitHub API calls. A stuck socket aborts after this. */
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/** Build the full API URL for a repo contents path */
function contentsUrl(repo: string, path: string): string {
  return `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/contents/${path}`;
}

/**
 * Handle GitHub error responses with clear, actionable messages.
 */
function handleApiError(status: number, body: string, context: string): Error {
  if (status === 401) {
    return new Error(`GitHub PAT is invalid or expired. (${context})`);
  }
  if (status === 403) {
    return new Error(`GitHub API forbidden — check PAT scopes. (${context})`);
  }
  if (status === 404) {
    return new Error(`Not found: ${context}`);
  }
  if (status === 422) {
    return new Error(`GitHub validation failed: ${body} (${context})`);
  }
  if (status === 429) {
    return new Error(`GitHub rate limit exceeded. (${context})`);
  }
  return new Error(`GitHub API ${status}: ${body} (${context})`);
}

/**
 * Sleep for the specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch with retry logic for rate limiting (B.7) and per-request timeouts (S40 C1).
 *
 * Each attempt applies a {@link GITHUB_REQUEST_TIMEOUT_MS} deadline via
 * AbortSignal. If the caller already passed a signal, we combine it with our
 * timeout via AbortSignal.any so either source can abort. On timeout we throw
 * a clear error and do NOT retry — retrying a hung socket just wastes wall
 * clock. 429 responses still trigger exponential backoff as before.
 */
async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(url, { ...options, signal });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const isAbort = name === "AbortError" || name === "TimeoutError";
      if (isAbort) {
        if (timeoutSignal.aborted) {
          logger.warn("github fetch timed out", { url, timeoutMs: GITHUB_REQUEST_TIMEOUT_MS, attempt });
          throw new Error(`GitHub API request timed out after ${GITHUB_REQUEST_TIMEOUT_MS}ms: ${url}`);
        }
        // Caller aborted — propagate unchanged.
        throw error;
      }
      throw error;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) {
        return res; // Let caller handle final 429
      }
      await res.body?.cancel(); // Prevent response body leak on retry
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "1", 10);
      const delay = Math.min(retryAfter * 1000 * Math.pow(2, attempt), 120_000);
      logger.warn("Rate limited, retrying", { attempt: attempt + 1, delay, url });
      await sleep(delay);
      continue;
    }
    return res;
  }
  throw new Error(`Rate limited after ${maxRetries} retries: ${url}`);
}

/**
 * Fetch a single file from a GitHub repo (B.1 — single API call).
 * Uses JSON mode to get both content (base64) and SHA in one request.
 */
export async function fetchFile(repo: string, path: string): Promise<FileResult> {
  const url = contentsUrl(repo, path);
  const start = Date.now();

  logger.debug("github.fetchFile", { repo, path });

  const res = await fetchWithRetry(url, { headers: headers() });

  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `fetchFile ${repo}/${path}`);
  }

  const data = (await res.json()) as GitHubContentsResponse;
  if (!data.content) {
    throw new Error(`No content returned for ${repo}/${path} — file may be a directory or too large`);
  }
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  const size = data.size;

  logger.debug("github.fetchFile complete", { repo, path, size, ms: Date.now() - start });
  return { content, sha: data.sha, size };
}

/**
 * Fetch the SHA of a file (needed for updates).
 */
async function fetchSha(repo: string, path: string): Promise<string> {
  const url = contentsUrl(repo, path);
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `fetchSha ${repo}/${path}`);
  }
  const data = (await res.json()) as GitHubContentsResponse;
  return data.sha;
}

/**
 * Fetch multiple files in parallel. One failure does not abort others.
 * Returns a Map of path → FileResult for successful fetches.
 */
export async function fetchFiles(
  repo: string,
  paths: string[]
): Promise<{ files: Map<string, FileResult>; failed: string[]; incomplete: boolean }> {
  const start = Date.now();
  logger.debug("github.fetchFiles", { repo, count: paths.length, paths });

  const results = await Promise.allSettled(
    paths.map(async (path) => ({ path, result: await fetchFile(repo, path) }))
  );

  const fileMap = new Map<string, FileResult>();
  const failedPaths: string[] = [];
  for (const outcome of results) {
    if (outcome.status === "fulfilled") {
      fileMap.set(outcome.value.path, outcome.value.result);
    } else {
      const failedPath = paths[results.indexOf(outcome)];
      failedPaths.push(failedPath);
      logger.warn("github.fetchFiles partial failure", { path: failedPath, error: outcome.reason?.message });
    }
  }

  logger.debug("github.fetchFiles complete", {
    repo,
    requested: paths.length,
    fetched: fileMap.size,
    failed: failedPaths.length,
    ms: Date.now() - start,
  });

  return { files: fileMap, failed: failedPaths, incomplete: failedPaths.length > 0 };
}

/**
 * Push a single file to GitHub.
 * Fetches SHA first (for updates), then PUTs with base64-encoded content.
 */
export async function pushFile(
  repo: string,
  path: string,
  content: string,
  message: string
): Promise<PushResult> {
  const url = contentsUrl(repo, path);
  const start = Date.now();

  logger.debug("github.pushFile", { repo, path, messageLength: message.length });

  // Get existing SHA if file exists (needed for updates)
  let sha: string | undefined;
  try {
    sha = await fetchSha(repo, path);
  } catch {
    // File doesn't exist yet — that's fine, we'll create it
  }

  const base64Content = Buffer.from(content, "utf-8").toString("base64");

  const body: Record<string, unknown> = {
    message,
    content: base64Content,
  };
  if (sha) {
    body.sha = sha;
  }

  const putOptions = {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };

  let res = await fetchWithRetry(url, putOptions);

  // Handle 409 conflict — retry once with fresh SHA
  if (res.status === 409) {
    logger.warn("github.pushFile conflict, retrying with fresh SHA", { repo, path });
    try {
      const freshSha = await fetchSha(repo, path);
      body.sha = freshSha;
    } catch {
      // File may have been deleted between attempts
      delete body.sha;
    }
    res = await fetchWithRetry(url, {
      ...putOptions,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    logger.error("github.pushFile failed", { repo, path, status: res.status, body: errText });
    return {
      success: false,
      size: 0,
      sha: "",
      error: handleApiError(res.status, errText, `pushFile ${repo}/${path}`).message,
    };
  }

  const data = (await res.json()) as GitHubPutResponse;
  const size = new TextEncoder().encode(content).length;

  logger.debug("github.pushFile complete", { repo, path, size, ms: Date.now() - start });

  return {
    success: true,
    size,
    sha: data.content.sha,
  };
}

/**
 * Push multiple files in parallel. One failure does not abort others.
 */
export async function pushFiles(
  repo: string,
  files: PushFileInput[]
): Promise<{ results: BatchPushResult[]; failed_count: number; incomplete: boolean }> {
  const start = Date.now();
  logger.debug("github.pushFiles", { repo, count: files.length });

  const outcomes = await Promise.allSettled(
    files.map(async (file) => {
      const result = await pushFile(repo, file.path, file.content, file.message);
      return { path: file.path, ...result };
    })
  );

  const batchResults: BatchPushResult[] = outcomes.map((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    return {
      path: files[idx].path,
      success: false,
      size: 0,
      sha: "",
      error: outcome.reason?.message ?? "Unknown error",
    };
  });

  const failedCount = batchResults.filter(r => !r.success).length;

  logger.debug("github.pushFiles complete", {
    repo,
    total: files.length,
    succeeded: batchResults.length - failedCount,
    failed: failedCount,
    ms: Date.now() - start,
  });

  return { results: batchResults, failed_count: failedCount, incomplete: failedCount > 0 };
}

/**
 * Check if a file exists in a repo (B.12, B.13 — proper error handling + body consumption).
 */
export async function fileExists(repo: string, path: string): Promise<boolean> {
  const url = contentsUrl(repo, path);
  try {
    const res = await fetchWithRetry(url, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    // B.13: consume response body to prevent socket leaks
    await res.body?.cancel();
    if (res.status === 404) return false;
    if (res.ok) return true;
    // Non-404 errors should propagate
    logger.error("fileExists unexpected status", { repo, path, status: res.status });
    throw new Error(`Unexpected status ${res.status} checking ${repo}/${path}`);
  } catch (error) {
    // Treat timeout as "file does not exist"
    if (error instanceof DOMException && error.name === "AbortError") {
      logger.warn("fileExists timed out, treating as not found", { repo, path });
      return false;
    }
    if (error instanceof TypeError && error.message.includes("fetch")) {
      logger.error("Network error checking file existence", { repo, path, error: String(error) });
      throw error;
    }
    throw error;
  }
}

/**
 * Get the size of a file in bytes.
 */
export async function getFileSize(repo: string, path: string): Promise<number> {
  const url = contentsUrl(repo, path);
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `getFileSize ${repo}/${path}`);
  }
  const data = (await res.json()) as GitHubContentsResponse;
  return data.size;
}

/**
 * List all repos owned by GITHUB_OWNER.
 */
export async function listRepos(): Promise<string[]> {
  const start = Date.now();
  logger.debug("github.listRepos");

  const allRepos: string[] = [];
  let page = 1;

  while (true) {
    const url = `${GITHUB_API_BASE}/user/repos?per_page=100&page=${page}&affiliation=owner`;
    const res = await fetchWithRetry(url, { headers: headers() });

    if (!res.ok) {
      throw handleApiError(res.status, await res.text(), "listRepos");
    }

    const repos = (await res.json()) as GitHubRepoListItem[];
    if (repos.length === 0) break;

    allRepos.push(...repos.map(r => r.name));
    page++;
  }

  logger.debug("github.listRepos complete", { count: allRepos.length, ms: Date.now() - start });
  return allRepos;
}

/**
 * List directory contents in a repo. Returns files and subdirectories.
 */
export async function listDirectory(repo: string, path: string): Promise<DirectoryEntry[]> {
  const url = contentsUrl(repo, path);
  const start = Date.now();
  logger.debug("github.listDirectory", { repo, path });

  const res = await fetchWithRetry(url, { headers: headers() });

  if (res.status === 404) {
    return []; // Directory doesn't exist
  }

  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `listDirectory ${repo}/${path}`);
  }

  const data = (await res.json()) as Array<{ name: string; path: string; size: number; sha: string; type: string }>;

  if (!Array.isArray(data)) {
    return []; // Path points to a file, not a directory
  }

  logger.debug("github.listDirectory complete", { repo, path, count: data.length, ms: Date.now() - start });

  return data.map(entry => ({
    name: entry.name,
    path: entry.path,
    size: entry.size,
    sha: entry.sha,
    type: entry.type as DirectoryEntry["type"],
  }));
}

/**
 * List commits for a repo, optionally filtered by path.
 */
export async function listCommits(
  repo: string,
  options?: { path?: string; since?: string; per_page?: number }
): Promise<CommitSummary[]> {
  const start = Date.now();
  const params = new URLSearchParams();
  if (options?.path) params.set("path", options.path);
  if (options?.since) params.set("since", options.since);
  params.set("per_page", String(options?.per_page ?? 30));

  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/commits?${params.toString()}`;
  logger.debug("github.listCommits", { repo, ...options });

  const res = await fetchWithRetry(url, { headers: headers() });

  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `listCommits ${repo}`);
  }

  const data = (await res.json()) as GitHubCommitListItem[];

  const commits: CommitSummary[] = data.map(item => ({
    sha: item.sha,
    message: item.commit.message,
    date: item.commit.author.date,
    files: item.files?.map(f => f.filename) ?? [],
  }));

  logger.debug("github.listCommits complete", { repo, count: commits.length, ms: Date.now() - start });
  return commits;
}

/**
 * Get a single commit with file details.
 */
export async function getCommit(
  repo: string,
  sha: string
): Promise<CommitSummary> {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/commits/${sha}`;
  const res = await fetchWithRetry(url, { headers: headers() });

  if (!res.ok) {
    throw handleApiError(res.status, await res.text(), `getCommit ${repo}/${sha}`);
  }

  const data = (await res.json()) as GitHubCommitListItem;
  return {
    sha: data.sha,
    message: data.commit.message,
    date: data.commit.author.date,
    files: data.files?.map(f => f.filename) ?? [],
  };
}

/**
 * Delete a file from a repo.
 */
export async function deleteFile(repo: string, path: string, message: string): Promise<{ success: boolean; error?: string }> {
  const url = contentsUrl(repo, path);
  const start = Date.now();
  logger.debug("github.deleteFile", { repo, path });

  try {
    const sha = await fetchSha(repo, path);

    const res = await fetchWithRetry(url, {
      method: "DELETE",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha }),
    });

    if (!res.ok) {
      const errText = await res.text();
      const errMsg = handleApiError(res.status, errText, `deleteFile ${repo}/${path}`).message;
      logger.error("github.deleteFile failed", { repo, path, status: res.status, error: errMsg });
      return { success: false, error: errMsg };
    }

    logger.debug("github.deleteFile complete", { repo, path, ms: Date.now() - start });
    return { success: true };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.deleteFile error", { repo, path, error: errMsg });
    return { success: false, error: errMsg };
  }
}

/**
 * Cache for default branch lookups. Branch name won't change mid-session,
 * so we cache indefinitely per repo.
 */
const defaultBranchCache = new Map<string, string>();

/**
 * Get the default branch for a repo. Cached after first lookup.
 * Falls back to "main" if the API call fails.
 */
export async function getDefaultBranch(repo: string): Promise<string> {
  const cached = defaultBranchCache.get(repo);
  if (cached) return cached;

  try {
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}`;
    const res = await fetchWithRetry(url, { headers: headers() });
    if (!res.ok) {
      logger.warn("getDefaultBranch failed, falling back to 'main'", {
        repo,
        status: res.status,
      });
      return "main";
    }
    const data = (await res.json()) as { default_branch: string };
    const branch = data.default_branch ?? "main";
    if (defaultBranchCache.size >= 100) defaultBranchCache.clear();
    defaultBranchCache.set(repo, branch);
    logger.debug("getDefaultBranch resolved", { repo, branch });
    return branch;
  } catch (error) {
    logger.warn("getDefaultBranch error, falling back to 'main'", {
      repo,
      error: (error as Error).message,
    });
    return "main";
  }
}

/**
 * Fetch the HEAD SHA of a repo's default branch. Returns undefined on any
 * failure — callers treat the absence as "can't verify, assume unchanged."
 *
 * Exists so `finalize.ts` commitPhase and `push.ts` can share the exact same
 * HEAD-snapshot pattern when guarding against partial atomic-commit writes
 * (S40 C3).
 */
export async function getHeadSha(repo: string): Promise<string | undefined> {
  try {
    const branch = await getDefaultBranch(repo);
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`;
    const refRes = await fetchWithRetry(refUrl, { headers: headers() });
    if (refRes.ok) {
      const refData = (await refRes.json()) as { object: { sha: string } };
      return refData.object.sha;
    }
    await refRes.body?.cancel();
  } catch {
    // Non-critical — caller proceeds without the safety check.
  }
  return undefined;
}

/**
 * Push multiple files as a single atomic commit using Git Trees API.
 * Eliminates 409 race conditions from parallel Contents API pushes.
 *
 * Steps:
 * 1. GET /repos/{owner}/{repo}/git/ref/heads/{branch} → current HEAD SHA
 * 2. GET /repos/{owner}/{repo}/git/commits/{sha} → base tree SHA
 * 3. POST /repos/{owner}/{repo}/git/trees → create tree with all files
 * 4. POST /repos/{owner}/{repo}/git/commits → create commit pointing to new tree
 * 5. PATCH /repos/{owner}/{repo}/git/ref/heads/{branch} → update HEAD
 */
export async function createAtomicCommit(
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<AtomicCommitResult> {
  const start = Date.now();
  logger.debug("github.createAtomicCommit", { repo, fileCount: files.length });

  try {
    // 1. Get current HEAD ref (dynamic branch detection — KI-17)
    const branch = await getDefaultBranch(repo);
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`;
    const refRes = await fetchWithRetry(refUrl, { headers: headers() });
    if (!refRes.ok) {
      throw handleApiError(refRes.status, await refRes.text(), `getRef ${repo}`);
    }
    const refData = await refRes.json() as { object: { sha: string } };
    const headSha = refData.object.sha;

    // 2. Get base tree from HEAD commit
    const commitUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/commits/${headSha}`;
    const commitRes = await fetchWithRetry(commitUrl, { headers: headers() });
    if (!commitRes.ok) {
      throw handleApiError(commitRes.status, await commitRes.text(), `getCommit ${repo}/${headSha}`);
    }
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // 3. Create new tree with all files
    const treeUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/trees`;
    const treePayload = {
      base_tree: baseTreeSha,
      tree: files.map(f => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        content: f.content,
      })),
    };
    const treeRes = await fetchWithRetry(treeUrl, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(treePayload),
    });
    if (!treeRes.ok) {
      throw handleApiError(treeRes.status, await treeRes.text(), `createTree ${repo}`);
    }
    const treeData = await treeRes.json() as { sha: string };

    // 4. Create commit
    const newCommitUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/commits`;
    const newCommitRes = await fetchWithRetry(newCommitUrl, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        tree: treeData.sha,
        parents: [headSha],
      }),
    });
    if (!newCommitRes.ok) {
      throw handleApiError(newCommitRes.status, await newCommitRes.text(), `createCommit ${repo}`);
    }
    const newCommitData = await newCommitRes.json() as { sha: string };

    // 5. Update HEAD ref
    const updateRefRes = await fetchWithRetry(refUrl, {
      method: "PATCH",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommitData.sha }),
    });
    if (!updateRefRes.ok) {
      throw handleApiError(updateRefRes.status, await updateRefRes.text(), `updateRef ${repo}`);
    }

    logger.info("github.createAtomicCommit complete", {
      repo,
      files: files.length,
      sha: newCommitData.sha,
      ms: Date.now() - start,
    });

    return {
      success: true,
      sha: newCommitData.sha,
      files_committed: files.length,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("github.createAtomicCommit failed", { repo, error: msg, ms: Date.now() - start });
    return {
      success: false,
      sha: "",
      files_committed: 0,
      error: msg,
    };
  }
}
