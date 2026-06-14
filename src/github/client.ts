/**
 * GitHub API client for the PRISM MCP Server.
 * Thin fetch-based wrapper with parallelized operations, retry logic, and structured logging.
 */

import { GITHUB_PAT, GITHUB_OWNER, GITHUB_API_BASE, SERVER_VERSION } from "../config.js";
import { validateFilePath, validateProjectSlug } from "../validation/slug.js";
import { logger } from "../utils/logger.js";
import type {
  FileResult,
  PushResult,
  AtomicCommitResult,
  GitHubContentsResponse,
  GitHubPutResponse,
  GitHubRepoListItem,
  DirectoryEntry,
  CommitSummary,
  GitHubCommitListItem,
  ReleaseResult,
  BranchProtectionResult,
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

/**
 * B.11 input guards — wired at the URL-construction choke point (brief-444
 * R5-c / audit brief-431). `validateProjectSlug` / `validateFilePath`
 * shipped in S28 as src/validation/slug.ts but were never called from
 * production code (test-only — dead guards). Every Contents-API operation
 * funnels through {@link contentsUrl}, and the repo-scoped builders below
 * interpolate `repo` directly into request URLs, so validating here closes
 * the path-traversal / null-byte / encoded-traversal injection surface for
 * ALL callers at once instead of per-tool. Throws a plain Error — callers
 * already route thrown errors into their structured error envelopes, and
 * the result-shaped helpers (createAtomicCommit, deleteRef, releases) call
 * these inside their try blocks so the guard surfaces as
 * `{ success: false, error }` like any other failure.
 */
function assertValidRepo(repo: string, context: string): void {
  const check = validateProjectSlug(repo);
  if (!check.valid) {
    throw new Error(`Invalid repo slug: ${check.error} (${context})`);
  }
}

function assertValidPath(path: string, context: string): void {
  // Empty path = repo-root listing — legitimate, and carries no traversal
  // surface. validateFilePath's empty-check targets file operations.
  if (path === "") return;
  const check = validateFilePath(path);
  if (!check.valid) {
    throw new Error(`Invalid file path: ${check.error} (${context})`);
  }
}

/**
 * Build the full API URL for a repo contents path.
 *
 * Optional `ref` (branch, tag, or commit SHA) is appended as a `?ref=`
 * query string for callers that need to read off the default branch
 * (e.g. brief-416 reads `brdonath1/trigger:state/<slug>.json`). Other
 * helpers that wrap `contentsUrl` (`fetchSha`, `fileExists`, `getFileSize`,
 * `listDirectory`) deliberately do NOT plumb `ref` — they are used only on
 * PRISM-managed default-branch paths and widening their signatures would
 * add surface area for misuse without a current caller need.
 */
function contentsUrl(repo: string, path: string, ref?: string): string {
  // B.11 (brief-444 R5-c): single choke point for every Contents-API URL —
  // fetchFile, fetchSha, pushFile, fileExists, getFileSize, listDirectory,
  // and deleteFile all build their URLs here.
  assertValidRepo(repo, `contentsUrl ${repo}/${path}`);
  assertValidPath(path, `contentsUrl ${repo}/${path}`);
  const base = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/contents/${path}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

/**
 * Handle GitHub error responses with clear, actionable messages.
 */
function handleApiError(status: number, body: string, context: string): Error {
  if (status === 401) {
    // SRV-35 / INS-311: a 401 on a valid PAT is a documented transient GitHub
    // blip. fetchWithRetry already retried before we reached here, so the
    // message must acknowledge the transient case instead of flatly declaring
    // the credential dead — the old "invalid or expired" wording sent
    // operators rotating a perfectly good PAT.
    return new Error(
      `GitHub returned 401 after bounded retries — this may be transient ` +
        `(INS-311); retry before rotating the PAT. If it persists, the PAT ` +
        `may be invalid or expired. (${context})`,
    );
  }
  if (status === 403) {
    // SRV-40: GitHub returns 403 for BOTH rate limiting (primary/secondary)
    // and genuine scope/permission failures. Inspect the body for the
    // rate-limit signature before emitting the (often wrong) PAT-scope
    // message — retryWithBackoff already handled the retry decision from
    // headers; this is the surfaced-error classification.
    if (/rate limit/i.test(body)) {
      return new Error(
        `GitHub rate limit exceeded (403) — back off and retry, not a PAT-scope failure. (${context})`,
      );
    }
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
 * Bounded retries for transient 401s (SRV-35 / INS-311). A valid PAT can
 * intermittently return 401; retry a small number of times with short backoff
 * before surfacing — far fewer than the 429/rate-limit budget because a real
 * credential failure should still fail fast-ish.
 */
const MAX_TRANSIENT_401_RETRIES = 2;

/**
 * Detect whether a 403 is a rate-limit response (SRV-40). GitHub signals its
 * primary rate limit with `x-ratelimit-remaining: 0` and secondary rate limits
 * with a `retry-after` header. Header-only by design: deciding from headers
 * means we never consume the response body, so a non-rate-limit 403 (genuine
 * scope failure) still has its body intact for the caller's error path.
 */
function is403RateLimited(res: Response): boolean {
  return (
    res.headers.get("retry-after") !== null ||
    res.headers.get("x-ratelimit-remaining") === "0"
  );
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
export async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 3): Promise<Response> {
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
      const delay = Math.min(retryAfter * 1000 * 2 ** attempt, 120_000);
      logger.warn("Rate limited, retrying", { attempt: attempt + 1, delay, url });
      await sleep(delay);
      continue;
    }
    // SRV-35 / INS-311: transient 401 on a valid PAT. Retry a bounded number
    // of times with short backoff before letting the 401 surface as a
    // credential diagnosis. GETs and the result-shaped mutations whose
    // server-side effect did not occur on a real 401 are safe to re-issue.
    if (res.status === 401 && attempt < MAX_TRANSIENT_401_RETRIES) {
      await res.body?.cancel();
      const delay = Math.min(500 * 2 ** attempt, 2_000);
      logger.warn("Transient 401, retrying before diagnosing PAT death (INS-311)", {
        attempt: attempt + 1,
        delay,
        url,
      });
      await sleep(delay);
      continue;
    }
    // SRV-40: 403 rate limit (primary via x-ratelimit-remaining:0, secondary
    // via retry-after). Back off and retry like a 429 instead of failing fast
    // with a misleading PAT-scope error. Header-only detection keeps the body
    // intact for the non-rate-limit 403 path.
    if (res.status === 403 && is403RateLimited(res) && attempt < maxRetries) {
      await res.body?.cancel();
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "1", 10);
      const delay = Math.min(retryAfter * 1000 * 2 ** attempt, 120_000);
      logger.warn("403 rate limit, retrying", { attempt: attempt + 1, delay, url });
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
 *
 * Optional `ref` selects a branch / tag / commit SHA. Omit for default-branch
 * reads (existing behavior — all PRISM-managed living-document paths).
 * brief-416 introduces the first cross-branch caller (Trigger state files
 * live on the `state` branch of `brdonath1/trigger`).
 */
export async function fetchFile(
  repo: string,
  path: string,
  ref?: string,
): Promise<FileResult> {
  const url = contentsUrl(repo, path, ref);
  const start = Date.now();

  logger.debug("github.fetchFile", { repo, path, ref });

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
  } catch (error) {
    // Only a genuine 404 ("Not found") means the file doesn't exist yet —
    // that's the create-mode signal. Operational errors (transient 401/403,
    // timeout) must surface as the real cause; swallowing them turns an
    // existing-file update into a sha-less PUT that fails as a misleading
    // 422 "validation failed" (SRV-75).
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("Not found")) throw error;
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
    } catch (error) {
      // Same discrimination as the initial fetch (SRV-75): only "Not found"
      // means the file was deleted between attempts (retry as create);
      // operational errors must surface instead of forcing create-mode.
      const msg = error instanceof Error ? error.message : String(error);
      if (!msg.includes("Not found")) throw error;
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
    // SRV-14: treat a timed-out existence check as "file does not exist"
    // rather than aborting the whole tool call. Match every real timeout
    // shape: AbortSignal.timeout() aborts with a DOMException named
    // "TimeoutError" (NOT "AbortError", which the old check looked for — so
    // the degraded path was dead code), a caller-aborted signal yields
    // "AbortError", and fetchWithRetry converts its own deadline into a plain
    // Error whose message contains "timed out".
    const errName = (error as { name?: string })?.name;
    const errMsg = error instanceof Error ? error.message : String(error);
    const isTimeout =
      errName === "TimeoutError" ||
      errName === "AbortError" ||
      /timed out/i.test(errMsg);
    if (isTimeout) {
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
  assertValidRepo(repo, `listCommits ${repo}`);
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
  assertValidRepo(repo, `getCommit ${repo}`);
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
  const start = Date.now();
  logger.debug("github.deleteFile", { repo, path });

  try {
    // URL construction inside the try: contentsUrl now throws on invalid
    // repo/path (B.11) and deleteFile's contract is result-shaped.
    const url = contentsUrl(repo, path);
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
    // B.11: guard inside the try — invalid repos take the existing silent
    // "main" fallback; the calling operation hits a visible guard at its
    // own URL builder.
    assertValidRepo(repo, `getDefaultBranch ${repo}`);
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
    // B.11: invalid repos return undefined — callers treat that as "can't
    // verify" by contract, and the mutation itself hits a visible guard.
    assertValidRepo(repo, `getHeadSha ${repo}`);
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
 * 1. GET  /repos/{owner}/{repo}/git/ref/heads/{branch}   → current HEAD SHA
 * 2. GET  /repos/{owner}/{repo}/git/commits/{sha}        → base tree SHA
 * 3. POST /repos/{owner}/{repo}/git/trees                → create tree with all files
 * 4. POST /repos/{owner}/{repo}/git/commits              → create commit pointing to new tree
 * 5. PATCH /repos/{owner}/{repo}/git/refs/heads/{branch} → update HEAD (note plural /refs/)
 *
 * IMPORTANT URL ASYMMETRY: GitHub's Git Refs API uses different paths for
 * read vs. write. Step 1 (GET a single ref) uses `/git/ref/{ref}` (singular).
 * Step 5 (PATCH update a ref) uses `/git/refs/{ref}` (plural). Reusing the
 * GET URL for the PATCH returns a fast 404 ("Not found: updateRef <repo>"),
 * which is exactly how S40 C3 shipped and went unnoticed for five days until
 * S42 traced it via Railway logs. See tests/atomic-commit-url.test.ts for
 * the regression guard.
 *
 * Deletes (S63 brief 1, audit Change 1): pass an optional `deletes: string[]`
 * to remove paths in the same commit. Each deleted path is included in the
 * Git Trees API payload as a tree entry with `sha: null`, which is GitHub's
 * documented mechanism for removing files via the Trees API. Existing callers
 * that pass no `deletes` parameter observe identical behavior (the tree
 * payload only contains write entries).
 */
export async function createAtomicCommit(
  repo: string,
  files: Array<{ path: string; content: string }>,
  message: string,
  deletes: string[] = [],
  signal?: AbortSignal,
): Promise<AtomicCommitResult> {
  const start = Date.now();
  logger.debug("github.createAtomicCommit", { repo, fileCount: files.length, deleteCount: deletes.length });

  try {
    // B.11 (brief-444 R5-c): atomic-commit tree paths bypass contentsUrl —
    // they travel in the Git Trees JSON body — so repo AND every write/
    // delete path are validated here. Failure surfaces as the standard
    // `{ success: false, error }` result shape.
    assertValidRepo(repo, `createAtomicCommit ${repo}`);
    for (const f of files) {
      assertValidPath(f.path, `createAtomicCommit ${repo}/${f.path}`);
    }
    for (const path of deletes) {
      assertValidPath(path, `createAtomicCommit delete ${repo}/${path}`);
    }

    // SRV-42: an aborted deadline must stop work before it starts a new
    // attempt — short-circuit if the caller's signal already fired.
    if (signal?.aborted) {
      throw new Error("createAtomicCommit aborted before start (deadline)");
    }

    // 1. Get current HEAD ref (dynamic branch detection — KI-17).
    //    GET uses the singular /git/ref/{ref} endpoint.
    const branch = await getDefaultBranch(repo);
    const refUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`;
    const refRes = await fetchWithRetry(refUrl, { headers: headers(), signal });
    if (!refRes.ok) {
      throw handleApiError(refRes.status, await refRes.text(), `getRef ${repo}`);
    }
    const refData = await refRes.json() as { object: { sha: string } };
    const headSha = refData.object.sha;

    // 2. Get base tree from HEAD commit
    const commitUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/commits/${headSha}`;
    const commitRes = await fetchWithRetry(commitUrl, { headers: headers(), signal });
    if (!commitRes.ok) {
      throw handleApiError(commitRes.status, await commitRes.text(), `getCommit ${repo}/${headSha}`);
    }
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // 3. Create new tree with all files (writes) and deletes.
    //    Deletes are encoded as tree entries with `sha: null` per GitHub's
    //    Git Trees API contract.
    const treeUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/trees`;
    const writeEntries = files.map(f => ({
      path: f.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: f.content,
    }));
    const deleteEntries = deletes.map(path => ({
      path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: null,
    }));
    const treePayload = {
      base_tree: baseTreeSha,
      tree: [...writeEntries, ...deleteEntries],
    };
    const treeRes = await fetchWithRetry(treeUrl, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(treePayload),
      signal,
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
      signal,
    });
    if (!newCommitRes.ok) {
      throw handleApiError(newCommitRes.status, await newCommitRes.text(), `createCommit ${repo}`);
    }
    const newCommitData = await newCommitRes.json() as { sha: string };

    // 5. Update HEAD ref.
    //    PATCH uses the PLURAL /git/refs/{ref} endpoint — distinct from the
    //    singular GET URL reused for step 1. See function docstring for the
    //    S42 history on why this asymmetry must not be collapsed.
    const updateRefUrl = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/refs/heads/${branch}`;
    const updateRefRes = await fetchWithRetry(updateRefUrl, {
      method: "PATCH",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommitData.sha }),
      signal,
    });
    if (!updateRefRes.ok) {
      throw handleApiError(updateRefRes.status, await updateRefRes.text(), `updateRef ${repo}`);
    }

    logger.info("github.createAtomicCommit complete", {
      repo,
      files: files.length,
      deletes: deletes.length,
      sha: newCommitData.sha,
      ms: Date.now() - start,
    });

    return {
      success: true,
      sha: newCommitData.sha,
      files_committed: files.length + deletes.length,
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

/**
 * Delete a Git ref (branch or tag) from a repo (brief-403).
 *
 * `ref` is the fully-qualified ref form GitHub expects on the wire: e.g.
 * `heads/feature-branch` for a branch or `tags/v1.2.3` for a tag. Caller
 * decides which prefix to use; this function does not validate or assume.
 *
 * URL note: GitHub's Refs API uses the PLURAL `/git/refs/{ref}` for DELETE
 * (and PATCH) — distinct from the singular `/git/ref/{ref}` used for GET.
 * See `createAtomicCommit` for the same asymmetry that bit S40/S42.
 *
 * Behavior:
 *   - 2xx (typically 204 No Content) → success.
 *   - 422 ("Reference does not exist") → idempotent success with a
 *     `note: "ref already absent"` so cleanup re-runs don't error.
 *   - Any other non-2xx routes through `handleApiError` and is returned
 *     as `{ success: false, error }` (mirrors `deleteFile`'s shape).
 */
export async function deleteRef(
  repo: string,
  ref: string,
): Promise<{ success: boolean; note?: string; error?: string }> {
  const start = Date.now();
  logger.debug("github.deleteRef", { repo, ref });

  try {
    assertValidRepo(repo, `deleteRef ${repo}`);
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/git/refs/${ref}`;
    const res = await fetchWithRetry(url, {
      method: "DELETE",
      headers: headers(),
    });

    if (res.ok) {
      await res.body?.cancel();
      logger.debug("github.deleteRef complete", { repo, ref, ms: Date.now() - start });
      return { success: true };
    }

    if (res.status === 422) {
      // SRV-45: GitHub uses 422 generically ("Validation Failed") — including
      // a refusal to delete a protected branch. Only the specific
      // "Reference does not exist" body is the idempotent already-deleted
      // case; treating EVERY 422 as success would report deleted:true for a
      // branch that still exists. Read the body and discriminate.
      const errText = await res.text();
      if (/Reference does not exist/i.test(errText)) {
        logger.debug("github.deleteRef ref already absent", { repo, ref });
        return { success: true, note: "ref already absent" };
      }
      const refusedMsg = handleApiError(422, errText, `deleteRef ${repo}/${ref}`).message;
      logger.error("github.deleteRef refused (422 not 'already absent')", {
        repo,
        ref,
        status: 422,
        error: refusedMsg,
      });
      return { success: false, error: refusedMsg };
    }

    const errText = await res.text();
    const errMsg = handleApiError(res.status, errText, `deleteRef ${repo}/${ref}`).message;
    logger.error("github.deleteRef failed", { repo, ref, status: res.status, error: errMsg });
    return { success: false, error: errMsg };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.deleteRef error", { repo, ref, error: errMsg });
    return { success: false, error: errMsg };
  }
}

/**
 * Create a new release on a repo (brief-403).
 *
 * Pass-through of the GitHub Releases API `POST /repos/{owner}/{repo}/releases`.
 * Undefined fields are stripped from the request body.
 *
 * Behavior:
 *   - 201 Created → success with `release_id`, `html_url`, `tag_name`.
 *   - 422 with `"already_exists"` → soft `{ success: false, error }` so
 *     callers can fall back to `updateRelease` instead of throwing.
 *   - Any other non-2xx routes through `handleApiError`.
 */
export async function createRelease(
  repo: string,
  params: {
    tag_name: string;
    target_commitish?: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    generate_release_notes?: boolean;
  },
): Promise<ReleaseResult> {
  const start = Date.now();
  logger.debug("github.createRelease", { repo, tag_name: params.tag_name });

  try {
    assertValidRepo(repo, `createRelease ${repo}`);
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/releases`;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body[k] = v;
    }

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as { id: number; html_url: string; tag_name: string };
      logger.debug("github.createRelease complete", { repo, release_id: data.id, ms: Date.now() - start });
      return {
        success: true,
        release_id: data.id,
        html_url: data.html_url,
        tag_name: data.tag_name,
      };
    }

    const errText = await res.text();
    if (res.status === 422 && errText.includes("already_exists")) {
      logger.warn("github.createRelease tag already exists", { repo, tag_name: params.tag_name });
      return {
        success: false,
        error: `Release with tag ${params.tag_name} already exists`,
      };
    }

    const errMsg = handleApiError(res.status, errText, `createRelease ${repo}`).message;
    logger.error("github.createRelease failed", { repo, status: res.status, error: errMsg });
    return { success: false, error: errMsg };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.createRelease error", { repo, error: errMsg });
    return { success: false, error: errMsg };
  }
}

/**
 * Update an existing release on a repo (brief-403).
 *
 * `PATCH /repos/{owner}/{repo}/releases/{release_id}`. Only fields the
 * caller explicitly set are sent — undefined values are stripped so we do
 * not send `null` and clear server-side fields the caller did not intend
 * to touch.
 *
 * Behavior:
 *   - 200 OK → success with `release_id`, `html_url`, `tag_name`.
 *   - 404 → soft `{ success: false, error: "Release not found" }`.
 *   - Any other non-2xx routes through `handleApiError`.
 */
export async function updateRelease(
  repo: string,
  releaseId: number,
  params: {
    tag_name?: string;
    target_commitish?: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    generate_release_notes?: boolean;
  },
): Promise<ReleaseResult> {
  const start = Date.now();
  logger.debug("github.updateRelease", { repo, releaseId });

  try {
    assertValidRepo(repo, `updateRelease ${repo}`);
    const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}/releases/${releaseId}`;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body[k] = v;
    }

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as { id: number; html_url: string; tag_name: string };
      logger.debug("github.updateRelease complete", { repo, release_id: data.id, ms: Date.now() - start });
      return {
        success: true,
        release_id: data.id,
        html_url: data.html_url,
        tag_name: data.tag_name,
      };
    }

    if (res.status === 404) {
      await res.body?.cancel();
      logger.warn("github.updateRelease not found", { repo, releaseId });
      return { success: false, error: "Release not found" };
    }

    const errText = await res.text();
    const errMsg = handleApiError(res.status, errText, `updateRelease ${repo}/${releaseId}`).message;
    logger.error("github.updateRelease failed", { repo, releaseId, status: res.status, error: errMsg });
    return { success: false, error: errMsg };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.updateRelease error", { repo, releaseId, error: errMsg });
    return { success: false, error: errMsg };
  }
}

/**
 * The four top-level keys GitHub REQUIRES in every branch-protection PUT
 * body (brief-446). When the caller does not supply one of them it must be
 * sent explicitly as `null`, or the API rejects the request with a 422.
 */
const PROTECTION_REQUIRED_OR_NULL_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/**
 * Read a branch's protection settings (brief-446).
 *
 * `GET /repos/{owner}/{repo}/branches/{branch}/protection`.
 *
 * Behavior:
 *   - 200 → success with the parsed protection JSON.
 *   - 404 "Branch not protected" → soft success with the sentinel
 *     `{ protected: false }`, so callers can distinguish "no protection
 *     rule" from a real error without a throw.
 *   - Any other 404 (missing branch or repo) and any other non-2xx routes
 *     through `handleApiError` and is returned as `{ success: false, error }`.
 */
export async function getBranchProtection(
  repo: string,
  branch: string,
): Promise<BranchProtectionResult> {
  const start = Date.now();
  logger.debug("github.getBranchProtection", { repo, branch });

  try {
    assertValidRepo(repo, `getBranchProtection ${repo}`);
    // encodeURIComponent keeps slash-containing branch names (feature/x)
    // addressable as a single path segment.
    const url =
      `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}` +
      `/branches/${encodeURIComponent(branch)}/protection`;
    const res = await fetchWithRetry(url, { headers: headers() });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      logger.debug("github.getBranchProtection complete", { repo, branch, ms: Date.now() - start });
      return { success: true, protection: data };
    }

    const errText = await res.text();
    if (res.status === 404 && errText.includes("Branch not protected")) {
      // GitHub 404s both for "branch has no protection rule" and for a
      // missing branch/repo. Only the former is the documented soft case —
      // it gets the sentinel; the latter falls through as a real error.
      logger.debug("github.getBranchProtection branch not protected", { repo, branch });
      return { success: true, protection: { protected: false } };
    }

    const errMsg = handleApiError(res.status, errText, `getBranchProtection ${repo}/${branch}`).message;
    logger.error("github.getBranchProtection failed", { repo, branch, status: res.status, error: errMsg });
    return { success: false, error: errMsg };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.getBranchProtection error", { repo, branch, error: errMsg });
    return { success: false, error: errMsg };
  }
}

/**
 * Replace a branch's protection settings (brief-446).
 *
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection`. The PUT
 * replaces protection wholesale — callers that mean to preserve existing
 * settings should GET first and merge.
 *
 * GitHub PUT quirk: `required_status_checks`, `enforce_admins`,
 * `required_pull_request_reviews`, and `restrictions` are REQUIRED in the
 * body and must be explicit `null` when not supplied, or the API returns
 * 422. This helper normalizes the payload — any of those four absent from
 * `protection` are sent as `null`; all other defined fields pass through
 * unchanged (undefined values are stripped, like the release helpers).
 *
 * Behavior:
 *   - 200 → success with the parsed resulting protection JSON.
 *   - Any other non-2xx routes through `handleApiError` and is returned
 *     as `{ success: false, error }`.
 */
export async function setBranchProtection(
  repo: string,
  branch: string,
  protection: Record<string, unknown>,
): Promise<BranchProtectionResult> {
  const start = Date.now();
  logger.debug("github.setBranchProtection", { repo, branch });

  try {
    assertValidRepo(repo, `setBranchProtection ${repo}`);
    const url =
      `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${repo}` +
      `/branches/${encodeURIComponent(branch)}/protection`;

    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(protection)) {
      if (v !== undefined) body[k] = v;
    }
    for (const key of PROTECTION_REQUIRED_OR_NULL_KEYS) {
      if (body[key] === undefined) body[key] = null;
    }

    const res = await fetchWithRetry(url, {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      logger.debug("github.setBranchProtection complete", { repo, branch, ms: Date.now() - start });
      return { success: true, protection: data };
    }

    const errText = await res.text();
    const errMsg = handleApiError(res.status, errText, `setBranchProtection ${repo}/${branch}`).message;
    logger.error("github.setBranchProtection failed", { repo, branch, status: res.status, error: errMsg });
    return { success: false, error: errMsg };
  } catch (error) {
    const errMsg = (error as Error).message;
    logger.error("github.setBranchProtection error", { repo, branch, error: errMsg });
    return { success: false, error: errMsg };
  }
}
