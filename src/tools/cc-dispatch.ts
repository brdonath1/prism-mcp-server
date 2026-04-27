/**
 * cc_dispatch — Dispatch a task to Claude Code from a claude.ai session.
 *
 * This tool is the entry point for the Claude Code orchestration layer added
 * in brief-104 (PRISM MCP Server v4.0). It clones the target repo into a
 * temp directory, runs the Agent SDK against it, and returns structured
 * results.
 *
 * Two modes:
 * - `query`  — read-only analysis. Allowed tools: Read/Glob/Grep.
 * - `execute`— write access. Allowed tools: Read/Write/Edit/Bash/Glob/Grep.
 *              On completion, changes are committed to a feature branch
 *              (`cc-dispatch/{timestamp}`) and pushed, then a PR is opened
 *              against the source branch via the GitHub API.
 *
 * Sync vs async:
 * - By default (`async_mode: false`), the tool runs to completion within the
 *   MCP timeout budget and returns results inline.
 * - With `async_mode: true`, the tool returns immediately with a
 *   `dispatch_id` of status `running` and the Agent SDK continues in the
 *   background. Use `cc_status` to retrieve results. This is the pattern for
 *   tasks that will exceed the ~60s MCP client timeout.
 *
 * Persistence:
 * - Every dispatch (sync or async) writes a status record to
 *   `brdonath1/prism-mcp-server/.dispatch/{id}.json`. The cc_status tool
 *   reads that file. The records survive server restarts because they live
 *   in GitHub, not memory.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CC_DISPATCH_MAX_TURNS,
  CC_DISPATCH_MODEL,
  CC_DISPATCH_SYNC_TIMEOUT_MS,
  GITHUB_API_BASE,
  GITHUB_OWNER,
  GITHUB_PAT,
  SERVER_VERSION,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { dispatchTask } from "../claude-code/client.js";
import { fetchWithRetry } from "../github/client.js";
import { cloneRepo, commitAndPushBranch } from "../claude-code/repo.js";
import { writeDispatchRecord, type DispatchRecord } from "../dispatch-store.js";

/** Tool allowlists per mode. Keep these narrow by default — the caller can
 *  widen them via the `allowed_tools` argument if they know what they need. */
const QUERY_MODE_TOOLS = ["Read", "Glob", "Grep"];
const EXECUTE_MODE_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"];

const inputSchema = {
  repo: z
    .string()
    .describe(
      "GitHub repo slug (e.g., 'platformforge-v2', 'prism-mcp-server'). Must be owned by GITHUB_OWNER.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe("Task description for Claude Code. Goes in as the user prompt."),
  branch: z
    .string()
    .optional()
    .default("main")
    .describe("Branch to clone and work on. Defaults to main."),
  mode: z
    .enum(["query", "execute"])
    .default("query")
    .describe(
      "query = read-only analysis (Read/Glob/Grep). execute = full write access + PR creation.",
    ),
  allowed_tools: z
    .array(z.string())
    .optional()
    .describe(
      "Override the default tool allowlist for the chosen mode. Useful for constrained runs.",
    ),
  max_turns: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum agent turns before the SDK stops. Defaults to CC_DISPATCH_MAX_TURNS."),
  async_mode: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, return immediately with a dispatch_id and run the task in the background. Use cc_status to retrieve results.",
    ),
  pr_title: z
    .string()
    .optional()
    .describe("(execute mode) Title for the pull request. Defaults to a summary of the prompt."),
  pr_body: z
    .string()
    .optional()
    .describe("(execute mode) Body for the pull request. Defaults to the prompt + dispatch metadata."),
};

/** Payload returned to the MCP client. */
interface DispatchResponse {
  dispatch_id: string;
  repo: string;
  mode: "query" | "execute";
  branch: string;
  status: "running" | "completed" | "failed";
  result: string | null;
  turns: number;
  usage: Record<string, number>;
  cost_usd: number;
  duration_ms: number;
  pr_url: string | null;
  error: string | null;
}

export function registerCCDispatch(server: McpServer): void {
  server.tool(
    "cc_dispatch",
    "Dispatch a task to Claude Code. query mode = read-only analysis, execute mode = writes + PR. Returns inline for quick tasks; use async_mode for longer runs.",
    inputSchema,
    async ({
      repo,
      prompt,
      branch,
      mode,
      allowed_tools,
      max_turns,
      async_mode,
      pr_title,
      pr_body,
    }) => {
      const start = Date.now();
      const dispatchId = `cc-${Date.now()}-${randomUUID().slice(0, 8)}`;

      const resolvedTools =
        allowed_tools ??
        (mode === "execute" ? EXECUTE_MODE_TOOLS : QUERY_MODE_TOOLS);
      const resolvedMaxTurns = max_turns ?? CC_DISPATCH_MAX_TURNS;

      logger.info("cc_dispatch", {
        dispatch_id: dispatchId,
        repo,
        branch,
        mode,
        async_mode,
        allowed_tools: resolvedTools,
        max_turns: resolvedMaxTurns,
      });

      // Persist the initial "running" record BEFORE any heavy lifting so that
      // cc_status can always find something to return, even if the clone or
      // dispatch crashes immediately.
      const initialRecord: DispatchRecord = {
        dispatch_id: dispatchId,
        repo,
        branch,
        mode,
        prompt,
        status: "running",
        started_at: new Date().toISOString(),
        agent: "claude-code",
        server_version: SERVER_VERSION,
      };
      try {
        await writeDispatchRecord(initialRecord);
      } catch (err) {
        logger.warn("cc_dispatch: failed to write initial record", {
          dispatch_id: dispatchId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Non-fatal — we'll still try to run the dispatch. cc_status just
        // won't be able to find this dispatch until the final write.
      }

      if (async_mode) {
        // Kick off the work but don't await it. The Node event loop keeps
        // the promise alive after Express closes the response. Any failure
        // is persisted to the dispatch record for cc_status to surface.
        void runDispatch({
          dispatchId,
          repo,
          branch,
          mode,
          prompt,
          allowedTools: resolvedTools,
          maxTurns: resolvedMaxTurns,
          prTitle: pr_title,
          prBody: pr_body,
          timeoutMs: 0, // no hard deadline — background runs may be long
        }).catch((err) => {
          logger.error("cc_dispatch async task failed", {
            dispatch_id: dispatchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        const response: DispatchResponse = {
          dispatch_id: dispatchId,
          repo,
          mode,
          branch,
          status: "running",
          result: null,
          turns: 0,
          usage: {},
          cost_usd: 0,
          duration_ms: Date.now() - start,
          pr_url: null,
          error: null,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...response,
                  note:
                    "Async dispatch — task running in background. Call cc_status with this dispatch_id to check results.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // Synchronous mode — run inline within the MCP timeout budget.
      const result = await runDispatch({
        dispatchId,
        repo,
        branch,
        mode,
        prompt,
        allowedTools: resolvedTools,
        maxTurns: resolvedMaxTurns,
        prTitle: pr_title,
        prBody: pr_body,
        // CC_DISPATCH_SYNC_TIMEOUT_MS leaves a buffer under MCP_SAFE_TIMEOUT
        // so we have time to serialize the response and write the final record.
        // Override via the CC_DISPATCH_SYNC_TIMEOUT_MS env var.
        timeoutMs: CC_DISPATCH_SYNC_TIMEOUT_MS,
      });

      const response: DispatchResponse = {
        dispatch_id: dispatchId,
        repo,
        mode,
        branch: result.branch ?? branch,
        status: result.status,
        result: result.result,
        turns: result.turns,
        usage: result.usage,
        cost_usd: result.cost_usd,
        duration_ms: Date.now() - start,
        pr_url: result.pr_url,
        error: result.error,
      };

      // Only set isError when the dispatch actually failed — MCP spec says
      // isError should be absent on success, not `false`.
      const toolResult: {
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      } = {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
      if (result.status === "failed") {
        toolResult.isError = true;
      }
      return toolResult;
    },
  );
}

/** Internal state machine — runs clone → dispatch → commit/push/PR → persist. */
interface RunDispatchInput {
  dispatchId: string;
  repo: string;
  branch: string;
  mode: "query" | "execute";
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  prTitle?: string;
  prBody?: string;
  timeoutMs: number;
}

interface RunDispatchResult {
  status: "completed" | "failed";
  result: string | null;
  turns: number;
  usage: Record<string, number>;
  cost_usd: number;
  branch?: string;
  pr_url: string | null;
  error: string | null;
}

async function runDispatch(
  input: RunDispatchInput,
): Promise<RunDispatchResult> {
  const {
    dispatchId,
    repo,
    branch,
    mode,
    prompt,
    allowedTools,
    maxTurns,
    prTitle,
    prBody,
    timeoutMs,
  } = input;

  let cleanup: (() => Promise<void>) | null = null;
  let resultObj: RunDispatchResult = {
    status: "failed",
    result: null,
    turns: 0,
    usage: {},
    cost_usd: 0,
    pr_url: null,
    error: null,
  };

  try {
    // 1. Clone the repo into a temp directory.
    const cloned = await cloneRepo(repo, branch);
    cleanup = cloned.cleanup;

    // 2. Run the Agent SDK.
    const sdkResult = await dispatchTask({
      prompt,
      workingDirectory: cloned.path,
      allowedTools,
      maxTurns,
      model: CC_DISPATCH_MODEL,
      timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
    });

    resultObj = {
      status: sdkResult.success ? "completed" : "failed",
      result: sdkResult.result || null,
      turns: sdkResult.turns,
      usage: sdkResult.usage as Record<string, number>,
      cost_usd: sdkResult.cost_usd,
      pr_url: null,
      error: sdkResult.error ?? null,
      branch: cloned.branch,
    };

    // 3. Execute mode — commit, push, PR.
    if (mode === "execute" && sdkResult.success) {
      const featureBranch = `cc-dispatch/${dispatchId}`;
      try {
        const pushed = await commitAndPushBranch(
          cloned.path,
          featureBranch,
          `prism: cc_dispatch ${dispatchId}\n\n${prompt.slice(0, 400)}`,
        );
        if (pushed.filesChanged > 0) {
          const pr = await createPullRequest({
            repo,
            head: featureBranch,
            base: cloned.branch,
            title:
              prTitle ??
              `cc_dispatch ${dispatchId}: ${summarize(prompt)}`,
            body:
              prBody ??
              renderPrBody(dispatchId, prompt, sdkResult.result, pushed.sha),
          });
          resultObj.pr_url = pr.html_url;
        } else {
          // INS-174: The wrapper saw no diff, but CC may have created a PR
          // autonomously via gh/git. Scan the agent's output for a matching
          // PR URL before assuming no changes were made.
          const agentPrUrl = detectAgentCreatedPr(
            sdkResult.result ?? "",
            GITHUB_OWNER,
            repo,
          );
          if (agentPrUrl) {
            resultObj.pr_url = agentPrUrl;
            resultObj.result =
              (resultObj.result ?? "") +
              `\n\n(PR was created by Claude Code: ${agentPrUrl})`;
          } else {
            // Genuinely no changes — surface it in the result but skip the PR.
            resultObj.result =
              (resultObj.result ?? "") + "\n\n(No file changes were made.)";
          }
        }
      } catch (pushErr) {
        const msg =
          pushErr instanceof Error ? pushErr.message : String(pushErr);
        resultObj.status = "failed";
        resultObj.error =
          (resultObj.error ? resultObj.error + "; " : "") +
          `commit/push/PR failed: ${msg}`;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    resultObj.status = "failed";
    resultObj.error = msg;
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // already logged
      }
    }
  }

  // 4. Persist the terminal record for cc_status to read.
  const finalRecord: DispatchRecord = {
    dispatch_id: dispatchId,
    repo,
    branch: resultObj.branch ?? branch,
    mode,
    prompt,
    status: resultObj.status,
    started_at: new Date().toISOString(), // overwritten by writeDispatchRecord when an existing record exists
    completed_at: new Date().toISOString(),
    agent: "claude-code",
    server_version: SERVER_VERSION,
    result: resultObj.result ?? undefined,
    turns: resultObj.turns,
    usage: resultObj.usage,
    cost_usd: resultObj.cost_usd,
    pr_url: resultObj.pr_url ?? undefined,
    error: resultObj.error ?? undefined,
  };
  try {
    await writeDispatchRecord(finalRecord);
  } catch (err) {
    logger.warn("cc_dispatch: failed to persist final record", {
      dispatch_id: dispatchId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return resultObj;
}

/**
 * Detect a CC-created PR by scanning the agent's output text for GitHub PR
 * URLs constrained to the dispatched repo. Returns the clean PR URL if found,
 * or null when no matching URL is present.
 *
 * When multiple distinct PRs from the dispatched repo are detected, returns
 * the one with the highest PR number (newest). Logs a warning so we can audit
 * if this branch is hit in real traffic.
 *
 * Exported for unit testing.
 */
export function detectAgentCreatedPr(
  resultText: string,
  owner: string,
  repo: string,
): string | null {
  if (!resultText) return null;

  // Escape special regex characters in owner/repo to prevent injection.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `https://github\\.com/${esc(owner)}/${esc(repo)}/pull/(\\d+)`,
    "gi",
  );

  const seen = new Map<number, string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(resultText)) !== null) {
    const prNum = parseInt(match[1], 10);
    // Reconstruct a clean URL (strips any trailing punctuation the regex
    // may have been adjacent to — the \d+ capture naturally excludes it).
    const cleanUrl = `https://github.com/${owner}/${repo}/pull/${prNum}`;
    seen.set(prNum, cleanUrl);
  }

  if (seen.size === 0) return null;

  if (seen.size > 1) {
    logger.warn("detectAgentCreatedPr: multiple distinct PRs detected", {
      owner,
      repo,
      prNumbers: [...seen.keys()],
    });
  }

  // Return the highest PR number (newest).
  const highest = Math.max(...seen.keys());
  return seen.get(highest) ?? null;
}

/** Trim a prompt to a one-line summary for PR titles / status display. */
function summarize(prompt: string): string {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

function renderPrBody(
  dispatchId: string,
  prompt: string,
  result: string,
  sha: string,
): string {
  return [
    `## Claude Code dispatch`,
    ``,
    `**Dispatch ID:** \`${dispatchId}\``,
    `**Commit:** \`${sha}\``,
    `**Server:** \`prism-mcp-server ${SERVER_VERSION}\``,
    ``,
    `### Task`,
    prompt,
    ``,
    `### Result`,
    result || "_(no summary returned)_",
    ``,
    `---`,
    `_Generated by cc_dispatch. Review before merging._`,
  ].join("\n");
}

/**
 * Open a pull request via the GitHub REST API. Inlined here because no other
 * tool creates PRs, and pulling in Octokit for one call is overkill.
 */
async function createPullRequest(opts: {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ html_url: string; number: number }> {
  if (!GITHUB_PAT) {
    throw new Error("GITHUB_PAT is required to create pull requests.");
  }
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_OWNER}/${opts.repo}/pulls`;
  // A-14: route through fetchWithRetry so a 429 from GitHub retries with the
  // same POST body + Authorization header instead of failing outright.
  // fetchWithRetry preserves the full RequestInit across retry attempts.
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": `prism-mcp-server/${SERVER_VERSION}`,
    },
    body: JSON.stringify({
      title: opts.title,
      head: opts.head,
      base: opts.base,
      body: opts.body,
      maintainer_can_modify: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createPullRequest ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { html_url: string; number: number };
  return { html_url: data.html_url, number: data.number };
}
