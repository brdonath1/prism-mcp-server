/**
 * prism_fetch tool — Fetch files from a PRISM project repo.
 * Supports summary mode for large files to stay within context budget.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile } from "../github/client.js";
import {
  DOC_ROOT,
  FETCH_AGGREGATE_BUDGET_BYTES,
  FETCH_CONTENT_CAP_BYTES,
  FETCH_WALL_CLOCK_DEADLINE_MS,
  SUMMARY_SIZE_THRESHOLD,
} from "../config.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { summarizeMarkdown } from "../utils/summarizer.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { KNOWN_PRISM_PATHS } from "../utils/doc-guard.js";

/**
 * Known PRISM document names that should be resolved through the doc-resolver
 * (A.2 — brief 104). Callers can request these by bare name (e.g.,
 * "decisions/_INDEX.md") and the server resolves to the actual path
 * (".prism/…" or legacy root).
 *
 * SRV-17: derived from doc-guard's KNOWN_PRISM_PATHS — the SAME list the push
 * guard uses — so the fetch resolver covers standing-rules.md, the four
 * *-archive.md files, and boot-test.md (not just the 10 mandatory docs). The
 * two had drifted, causing a bare-name fetch of those files to 404 falsely.
 */
const KNOWN_PRISM_DOC_NAMES = new Set<string>(KNOWN_PRISM_PATHS);

/**
 * Determine whether a requested path should go through doc-resolver.
 *
 * Rules:
 * - Paths already prefixed with ".prism/" are passed through as-is
 *   (existing callers and arbitrary files under .prism/ keep working).
 * - Paths matching a known living-document name are resolved.
 * - Decisions domain files ("decisions/foo.md") are resolved — they live
 *   under .prism/decisions/ in migrated repos.
 * - Any other path is passed through literally (arbitrary repo files).
 */
export function shouldResolveDocPath(filePath: string): boolean {
  if (filePath.startsWith(`${DOC_ROOT}/`)) return false;
  if (KNOWN_PRISM_DOC_NAMES.has(filePath)) return true;
  if (filePath.startsWith("decisions/") && filePath.endsWith(".md")) return true;
  return false;
}

/** Sentinel used to signal that the tool-level deadline fired (brief-444 R-deadlines). */
const FETCH_DEADLINE_SENTINEL = Symbol("fetch.deadline");

/**
 * Cap content at `capBytes`, cutting at the last complete line so a torn
 * line is never delivered (brief-444). Byte-accurate: encodes once, slices
 * the byte buffer, and strips any U+FFFD replacement character a mid-code-
 * point cut may have produced. Returns the input unchanged when it already
 * fits. Exported for direct unit testing.
 */
export function capContent(content: string, capBytes: number): string {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= capBytes) return content;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, capBytes));
  // Prefer the last complete line; fall back to the raw byte cut for
  // single-line bodies (minified JSON, long tables) where no newline exists.
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline > 0) text = text.slice(0, lastNewline + 1);
  return text.replace(/�+$/, "");
}

/** Input schema for prism_fetch */
const inputSchema = {
  project_slug: z.string().describe("Project repo name"),
  files: z.array(z.string()).describe("File paths relative to repo root"),
  summary_mode: z.boolean().optional().default(false).describe("Return summaries for files >5KB"),
  full_content: z.boolean().optional().default(false).describe(
    `Deliver complete file bodies, bypassing the default per-file content cap (~${Math.round(FETCH_CONTENT_CAP_BYTES / 1024)}KB). Use only when the full body is genuinely needed — large bodies consume session context.`,
  ),
};

/**
 * Register the prism_fetch tool on an MCP server instance.
 */
export function registerFetch(server: McpServer): void {
  server.tool(
    "prism_fetch",
    "Fetch files from a PRISM project repo. Summary mode returns summaries for files >5KB.",
    inputSchema,
    async ({ project_slug, files, summary_mode, full_content }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_fetch", { project_slug, fileCount: files.length, summary_mode, full_content });

      // brief-444 R-deadlines — tool-level wall-clock deadline. Mirrors
      // prism_push (S40 C4): a hung parallel fetch previously held the MCP
      // client connection until the transport gave up with no structured error.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlinePromise = new Promise<typeof FETCH_DEADLINE_SENTINEL>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(FETCH_DEADLINE_SENTINEL), FETCH_WALL_CLOCK_DEADLINE_MS);
      });

      const workPromise = (async () => {
      try {
        let bytesDelivered = 0;
        let filesFetched = 0;

        // Fetch all files in parallel. For known living-document names that
        // were requested without a ".prism/" prefix, route through
        // resolveDocPath() so both migrated (.prism/) and legacy (root) repos
        // resolve correctly (A.2 — brief 104).
        const results = await Promise.allSettled(
          files.map(async (filePath) => {
            try {
              if (shouldResolveDocPath(filePath)) {
                const resolved = await resolveDocPath(project_slug, filePath);
                return {
                  // Preserve the requested path in the response so the caller
                  // can correlate inputs and outputs without having to know
                  // which variant the server picked.
                  path: filePath,
                  exists: true,
                  content: resolved.content,
                  sha: resolved.sha,
                  size: new TextEncoder().encode(resolved.content).length,
                };
              }

              const result = await fetchFile(project_slug, filePath);
              return { path: filePath, exists: true, ...result };
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              // 404 = file doesn't exist, not necessarily an error
              if (msg.includes("Not found")) {
                return { path: filePath, exists: false, content: "", sha: "", size: 0 };
              }
              throw error;
            }
          })
        );

        const fileResults = results.map((outcome, idx) => {
          if (outcome.status === "fulfilled") {
            const file = outcome.value;

            if (!file.exists) {
              // Genuine 404 — the inner catch above absorbed a "Not found"
              // and returned exists:false. Surface fetch_error: null so the
              // diagnostic loop classifies this as FILE_NOT_FOUND, not
              // FILE_FETCH_ERROR (S63 Phase 1 Brief 2).
              return {
                path: file.path,
                exists: false,
                size_bytes: 0,
                content: null,
                summary: null,
                is_summarized: false,
                is_truncated: false,
                is_aggregate_capped: false,
                fetch_error: null as string | null,
              };
            }

            filesFetched++;

            // SRV-63: aggregate response budget. The per-file cap bounds any
            // single body, but the files[] array is unbounded — N files each
            // under the per-file cap can still blow the ~25K-token MCP ceiling.
            // Once cumulative delivered bytes cross the budget, remaining files
            // (request order) are delivered size-only: true size + a withheld
            // notice + is_aggregate_capped, with a diagnostic below. NOT a
            // silent omission. `full_content: true` does not bypass the
            // aggregate budget — it is a whole-response guard, not per-file.
            if (bytesDelivered >= FETCH_AGGREGATE_BUDGET_BYTES) {
              return {
                path: file.path,
                exists: true,
                size_bytes: file.size,
                content: null,
                summary: `[prism_fetch: aggregate response budget (${(FETCH_AGGREGATE_BUDGET_BYTES / 1024).toFixed(0)}KB) reached — ${file.size}-byte body withheld. Re-request this file alone for the full body.]`,
                is_summarized: false,
                is_truncated: false,
                is_aggregate_capped: true,
                fetch_error: null as string | null,
              };
            }

            const shouldSummarize = summary_mode && file.size > SUMMARY_SIZE_THRESHOLD;

            if (shouldSummarize) {
              const summary = summarizeMarkdown(file.content);
              bytesDelivered += new TextEncoder().encode(summary).length;
              return {
                path: file.path,
                exists: true,
                size_bytes: file.size,
                content: null,
                summary,
                is_summarized: true,
                is_truncated: false,
                is_aggregate_capped: false,
                fetch_error: null as string | null,
              };
            }

            // brief-444: default per-file content cap. Large full-content
            // bodies are truncated at a line boundary so one oversize file
            // cannot blow the ~25K-token MCP response ceiling or flood
            // session context. `full_content: true` is the explicit opt-out;
            // size_bytes always carries the TRUE size so the caller can see
            // what was withheld.
            if (!full_content && file.size > FETCH_CONTENT_CAP_BYTES) {
              const capped = capContent(file.content, FETCH_CONTENT_CAP_BYTES);
              const deliveredBytes = new TextEncoder().encode(capped).length;
              const notice = `\n[prism_fetch: content capped — delivered ${deliveredBytes} of ${file.size} bytes. Pass full_content: true for the complete body.]`;
              const delivered = capped + notice;
              bytesDelivered += new TextEncoder().encode(delivered).length;
              return {
                path: file.path,
                exists: true,
                size_bytes: file.size,
                content: delivered,
                summary: null,
                is_summarized: false,
                is_truncated: true,
                is_aggregate_capped: false,
                fetch_error: null as string | null,
              };
            }

            bytesDelivered += file.size;
            return {
              path: file.path,
              exists: true,
              size_bytes: file.size,
              content: file.content,
              summary: null,
              is_summarized: false,
              is_truncated: false,
              is_aggregate_capped: false,
              fetch_error: null as string | null,
            };
          }

          // Operational failure (5xx, timeout, rate limit, network). The
          // inner try/catch only absorbs 404; everything else re-throws and
          // becomes a rejected Promise.allSettled outcome here. Capture the
          // error message so the operator can distinguish "GitHub is down"
          // from "file is missing" (S63 Phase 1 Brief 2).
          const reason = outcome.reason;
          const errorMessage = reason instanceof Error ? reason.message : String(reason);
          return {
            path: files[idx],
            exists: false,
            size_bytes: 0,
            content: null,
            summary: null,
            is_summarized: false,
            is_truncated: false,
            is_aggregate_capped: false,
            fetch_error: errorMessage as string | null,
          };
        });

        for (const fr of fileResults) {
          if (fr.fetch_error !== null) {
            // Operational failure — distinct from a genuine 404. Severity is
            // warn (not error) because partial results may still be useful
            // and the request itself completed.
            diagnostics.warn("FILE_FETCH_ERROR", `Fetch failed: ${fr.path}`, {
              path: fr.path,
              error: fr.fetch_error,
            });
          } else if (!fr.exists) {
            diagnostics.warn("FILE_NOT_FOUND", `File not found: ${fr.path}`, { path: fr.path });
          }
        }
        if (summary_mode && fileResults.some(fr => fr.is_summarized)) {
          diagnostics.info("SUMMARY_MODE_TRIGGERED", `Summary mode applied to ${fileResults.filter(fr => fr.is_summarized).length} file(s) exceeding ${(SUMMARY_SIZE_THRESHOLD / 1024).toFixed(0)}KB`);
        }
        const cappedCount = fileResults.filter(fr => fr.is_truncated).length;
        if (cappedCount > 0) {
          diagnostics.info(
            "FETCH_CONTENT_CAPPED",
            `Content cap applied to ${cappedCount} file(s) exceeding ${(FETCH_CONTENT_CAP_BYTES / 1024).toFixed(0)}KB — pass full_content: true to bypass`,
            { cappedCount, capBytes: FETCH_CONTENT_CAP_BYTES, paths: fileResults.filter(fr => fr.is_truncated).map(fr => fr.path) },
          );
        }
        // SRV-63: surface aggregate-budget withholding so the omission is never
        // silent — the consumer is told exactly which bodies it must re-request.
        const aggregateCapped = fileResults.filter(fr => fr.is_aggregate_capped);
        if (aggregateCapped.length > 0) {
          diagnostics.warn(
            "FETCH_AGGREGATE_BUDGET_EXCEEDED",
            `Aggregate response budget (${(FETCH_AGGREGATE_BUDGET_BYTES / 1024).toFixed(0)}KB) reached — ${aggregateCapped.length} file(s) delivered size-only. Re-request them individually for full bodies.`,
            { budgetBytes: FETCH_AGGREGATE_BUDGET_BYTES, paths: aggregateCapped.map(fr => fr.path) },
          );
        }

        const result = {
          project: project_slug,
          files: fileResults,
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          diagnostics: diagnostics.list(),
        };

        logger.info("prism_fetch complete", {
          project_slug,
          filesFetched,
          bytesDelivered,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_fetch failed", { project_slug, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message, project: project_slug }) }],
          isError: true,
        };
      }
      })();

      try {
        const raced = await Promise.race([workPromise, deadlinePromise]);
        if (raced === FETCH_DEADLINE_SENTINEL) {
          const deadlineSec = Math.round(FETCH_WALL_CLOCK_DEADLINE_MS / 1000);
          logger.error("prism_fetch deadline exceeded", {
            project_slug,
            fileCount: files.length,
            deadlineMs: FETCH_WALL_CLOCK_DEADLINE_MS,
            elapsedMs: Date.now() - start,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `prism_fetch deadline exceeded (${deadlineSec}s)`,
                project: project_slug,
              }),
            }],
            isError: true,
          };
        }
        return raced;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    }
  );
}
