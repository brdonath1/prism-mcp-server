/**
 * GitHub API client for the PRISM MCP Server.
 * Thin fetch-based wrapper with parallelized operations, retry logic, and structured logging.
 */

import { GITHUB_PAT, GITHUB_OWNER, GITHUB_API_BASE } from "../config.js";
import { logger } from "../utils/logger.js";
import type {
  FileResult,
  PushResult,
  PushFileInput,
  BatchPushResult,
  GitHubContentsResponse,
  GitHubPutResponse,
  GitHubRepoListItem,
} from "./types.js";

/** Standard headers for all GitHub API requests */
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "prism-mcp-server/2.0.0",
  };
}

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
 * Fetch a single file from a GitHub repo.
 * Returns content as a UTF-8 string along with SHA and size.
 */
export async function fetchFile(repo: string, path: string): Promise<FileResult> {
  const url = contentsUrl(repo, path);
  const start = Date.now();

  logger.debug("github.fetchFile", { repo, path });

  // Fetch raw content
  const rawRes = await fetch(url, {
    headers: {
      ...headers(),
      Accept: "application/vnd.github.raw+json",
    },
  });

  if (rawRes.status === 429) {
    const retryAfter = parseInt(rawRes.headers.get("retry-after") ?? "2", 10);
    logger.warn("github.fetchFile rate limited, retrying", { repo, path, retryAfter });
    await sleep(retryAfter * 1000);
    const retryRes = await fetch(url, {
      headers: { ...headers(), Accept: "application/vnd.github.raw+json" },
    });
    if (!retryRes.ok) {
      throw handleApiError(retryRes.status, await retryRes.text(), `fetchFile ${repo}/${path}`);
    }
    const content = await retryRes.text();
    // Need SHA from a separate call
    const sha = await fetchSha(repo, path);
    logger.debug("github.fetchFile complete (retry)", { repo, path, ms: Date.now() - start });
    return { content, sha, size: new TextEncoder().encode(content).length };
  }

  if (!rawRes.ok) {
    throw handleApiError(rawRes.status, await rawRes.text(), `fetchFile ${repo}/${path}`);
  }

  const content = await rawRes.text();
  const sha = await fetchSha(repo, path);
  const size = new TextEncoder().encode(content).length;

  logger.debug("github.fetchFile complete", { repo, path, size, ms: Date.now() - start });
  return { content, sha, size };
}

/**
 * Fetch the SHA of a file (needed for updates).
 */
async function fetchSha(repo: string, path: string): Promise<string> {
  const url = contentsUrl(repo, path);
  const res = await fetch(url, { headers: headers() });
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
): Promise<Map<string, FileResult>> {
  const start = Date.now();
  logger.debug("github.fetchFiles", { repo, count: paths.length, paths });

  const results = await Promise.allSettled(
    paths.map(async (path) => ({ path, result: await fetchFile(repo, path) }))
  );

  const fileMap = new Map<string, FileResult>();
  for (const outcome of results) {
    if (outcome.status === "fulfilled") {
      fileMap.set(outcome.value.path, outcome.value.result);
    } else {
      logger.warn("github.fetchFiles partial failure", { error: outcome.reason?.message });
    }
  }

  logger.debug("github.fetchFiles complete", {
    repo,
    requested: paths.length,
    fetched: fileMap.size,
    ms: Date.now() - start,
  });

  return fileMap;
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

  let res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
    res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // Handle rate limit — wait and retry once
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
    logger.warn("github.pushFile rate limited, retrying", { repo, path, retryAfter });
    await sleep(retryAfter * 1000);
    res = await fetch(url, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
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
): Promise<BatchPushResult[]> {
  const start = Date.now();
  logger.debug("github.pushFiles", { repo, count: files.length });

  const results = await Promise.allSettled(
    files.map(async (file) => {
      const result = await pushFile(repo, file.path, file.content, file.message);
      return { path: file.path, ...result };
    })
  );

  const batchResults: BatchPushResult[] = results.map((outcome, idx) => {
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

  logger.debug("github.pushFiles complete", {
    repo,
    total: files.length,
    succeeded: batchResults.filter(r => r.success).length,
    ms: Date.now() - start,
  });

  return batchResults;
}

/**
 * Check if a file exists in a repo.
 * Uses GET (not HEAD) because GitHub Contents API doesn't support HEAD.
 */
export async function fileExists(repo: string, path: string): Promise<boolean> {
  const url = contentsUrl(repo, path);
  try {
    const res = await fetch(url, { headers: headers() });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Get the size of a file in bytes.
 */
export async function getFileSize(repo: string, path: string): Promise<number> {
  const url = contentsUrl(repo, path);
  const res = await fetch(url, { headers: headers() });
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
    const res = await fetch(url, { headers: headers() });

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
