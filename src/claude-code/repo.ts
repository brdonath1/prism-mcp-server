/**
 * repo — Temporary repo clones for Claude Code dispatch (brief-104 B.3).
 *
 * The Agent SDK needs a real filesystem working directory. We shallow-clone
 * the target repo into /tmp, run the task, then clean up. The clone uses the
 * GitHub PAT so private repos work automatically.
 *
 * Safety:
 * - Shallow clone (`--depth 1`) to minimize disk usage.
 * - Unique temp directory per dispatch — no state leaks between runs.
 * - Cleanup is idempotent and swallows errors (best-effort).
 * - Never logs the PAT, even on failure.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GITHUB_OWNER, GITHUB_PAT } from "../config.js";
import { logger } from "../utils/logger.js";

export interface ClonedRepo {
  /** Absolute path to the working directory containing the checkout. */
  path: string;
  /** Branch the checkout is currently on. */
  branch: string;
  /** Idempotent cleanup — removes the temp directory. */
  cleanup: () => Promise<void>;
}

/**
 * Shallow-clone a repo owned by `GITHUB_OWNER` into /tmp and return the path.
 *
 * Uses `https://x-access-token:{pat}@github.com/...` URL form so the `git`
 * subprocess authenticates without prompting. The URL is passed directly to
 * execFileSync and never logged.
 *
 * @param repoSlug  Repo name (e.g. "platformforge-v2")
 * @param branch    Optional branch to check out. Defaults to whatever HEAD is.
 */
export async function cloneRepo(
  repoSlug: string,
  branch?: string,
): Promise<ClonedRepo> {
  if (!GITHUB_PAT) {
    throw new Error(
      "GITHUB_PAT is not set — cloneRepo cannot authenticate to GitHub.",
    );
  }

  const prefix = join(tmpdir(), "cc-dispatch-");
  const workdir = mkdtempSync(prefix);
  const start = Date.now();

  logger.info("cloneRepo start", { repo: repoSlug, branch, workdir });

  const authUrl = `https://x-access-token:${GITHUB_PAT}@github.com/${GITHUB_OWNER}/${repoSlug}.git`;

  try {
    const args = [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      ...(branch ? ["--branch", branch] : []),
      authUrl,
      workdir,
    ];

    execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Give git a timeout — Railway's network should respond in seconds,
      // not minutes.
      timeout: 60_000,
    });

    // Resolve the branch name we actually ended up on. When the caller did
    // not specify one, we want to report whatever HEAD landed at.
    let resolvedBranch = branch ?? "main";
    try {
      const head = execFileSync(
        "git",
        ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      if (head && head !== "HEAD") resolvedBranch = head;
    } catch {
      // Non-fatal — fall back to the requested branch.
    }

    logger.info("cloneRepo complete", {
      repo: repoSlug,
      branch: resolvedBranch,
      workdir,
      ms: Date.now() - start,
    });

    return {
      path: workdir,
      branch: resolvedBranch,
      cleanup: async () => {
        try {
          rmSync(workdir, { recursive: true, force: true });
          logger.debug("cloneRepo cleanup complete", { workdir });
        } catch (err) {
          logger.warn("cloneRepo cleanup failed", {
            workdir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    };
  } catch (error) {
    // Make sure we don't leak a half-created temp dir on error.
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : String(error);
    // Scrub the PAT from any error message git may have echoed back.
    const scrubbed = message.replace(GITHUB_PAT, "***");
    throw new Error(`cloneRepo failed: ${scrubbed}`);
  }
}

/**
 * Create a new branch from the current HEAD, commit all pending changes,
 * and push the branch to origin. Returns the branch name and commit SHA.
 *
 * Designed for `execute` mode in cc_dispatch: after Claude Code modifies
 * files, we persist the work as a feature branch rather than touching main
 * directly. A separate PR can be created by the caller (see cc-dispatch.ts).
 */
export async function commitAndPushBranch(
  workdir: string,
  branchName: string,
  commitMessage: string,
): Promise<{ branch: string; sha: string; filesChanged: number }> {
  if (!GITHUB_PAT) {
    throw new Error(
      "GITHUB_PAT is not set — commitAndPushBranch cannot push.",
    );
  }

  const run = (args: string[], opts?: { capture?: boolean }) => {
    return execFileSync("git", ["-C", workdir, ...args], {
      encoding: "utf8",
      stdio: opts?.capture ? ["ignore", "pipe", "pipe"] : "pipe",
      timeout: 60_000,
    });
  };

  // Configure a throwaway committer identity. Railway containers don't have
  // a user.email configured, so git would refuse to commit.
  run(["config", "user.email", "prism-mcp-server@anthropic.local"]);
  run(["config", "user.name", "prism-mcp-server"]);

  // Create and switch to the branch. If it already exists (unlikely — we
  // generate unique names with a timestamp), reset to HEAD.
  try {
    run(["checkout", "-b", branchName]);
  } catch {
    run(["checkout", "-B", branchName]);
  }

  // Stage everything. `git add -A` picks up new files, edits, and deletions.
  run(["add", "-A"]);

  // If there are no changes, bail out cleanly. This is not an error from the
  // dispatcher's perspective — the task may just have been read-only.
  const status = run(["status", "--porcelain"], { capture: true }).trim();
  if (!status) {
    return { branch: branchName, sha: "", filesChanged: 0 };
  }
  const filesChanged = status.split("\n").length;

  run(["commit", "-m", commitMessage]);

  const sha = run(["rev-parse", "HEAD"], { capture: true }).trim();

  // Push the branch. The origin URL already has credentials baked in from
  // the clone step, so `git push -u origin <branch>` works without extra
  // plumbing.
  run(["push", "-u", "origin", branchName]);

  return { branch: branchName, sha, filesChanged };
}
