/**
 * prism_synthesize tool — On-demand intelligence brief + pending-doc-updates
 * generation.
 *
 * D-156 §3.6 / D-155 / Phase 2 PR 4 §5: `mode: "generate"` refreshes BOTH
 * `intelligence-brief.md` AND `pending-doc-updates.md`; `mode: "status"`
 * reports on both artifacts.
 *
 * brief-460 Task C / INS-331: `mode: "generate"` is FIRE-AND-FORGET. The
 * pre-460 handler awaited both synthesis legs in-request; measured live
 * (S172), synthesis runs far past the MCP client transport ceiling (brief at
 * 107s, PDU ~8 min), so the client connection dropped ("MCP server
 * connection lost") while the handler survived and completed — the operator
 * paid for the work and never saw the response. Now the handler dispatches
 * both legs in the background — exactly the INS-178 ¶8 pattern the
 * finalize-commit synthesis leg uses (finalize.ts) — and returns an
 * accepted/started payload immediately. Completion is observed via
 * `mode: "status"` (or the next bootstrap). Background failures land in
 * structured logs, same as the finalize leg.
 *
 * The deeper `prism_finalize action=full` orchestration redesign (deadline
 * cancellation, etc.) is M-010 / W3-S5 — out of scope here.
 *
 * Cost note: `mode: "generate"` fires TWO Opus calls (~2x API cost vs
 * pre-PR-4 behavior). Operators calling this tool manually for refresh
 * should be aware. See D-156 §3.6 for design rationale.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYNTHESIS_ENABLED } from "../config.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
} from "../ai/synthesize.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

/**
 * Shape of a single artifact's status field. Both `intelligence_brief` and
 * `pending_doc_updates` share this shape in `mode: "status"` responses.
 */
interface ArtifactStatus {
  exists: boolean;
  size_bytes?: number;
  last_synthesized?: string;
}

/**
 * Resolve a single artifact's existence + size + Last synthesized line.
 * Used for `mode: "status"`. Returns `{ exists: false }` when the file is
 * missing — that is not an error, the file may not have been generated yet.
 */
async function loadArtifactStatus(
  projectSlug: string,
  filename: string,
): Promise<ArtifactStatus> {
  try {
    const resolved = await resolveDocPath(projectSlug, filename);
    return {
      exists: true,
      size_bytes: resolved.content.length,
      last_synthesized: resolved.content.match(/Last synthesized:\s*(S\d+ \([^)]+\))/)?.[1] ?? "unknown",
    };
  } catch {
    return { exists: false };
  }
}

export function registerSynthesize(server: McpServer) {
  server.tool(
    "prism_synthesize",
    "Generate or check AI-synthesized artifacts. Modes: generate (kick off background refresh of BOTH intelligence-brief.md AND pending-doc-updates.md and return immediately — INS-331; check completion via mode=status), status (existence + Last-synthesized of both).",
    {
      project_slug: z.string().describe("Project repo name"),
      mode: z.enum(["generate", "status"]).describe("'generate' to start a background refresh (returns immediately), 'status' to check artifacts"),
      session_number: z.number().optional().describe("Session number (required for generate)"),
    },
    async ({ project_slug, mode, session_number }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_synthesize", { project_slug, mode });

      try {
        if (mode === "status") {
          // Status mirror: both artifacts checked in parallel. Either may be
          // absent (synthesis hasn't run yet) — that's `exists: false`, not error.
          const [briefStatus, pendingStatus] = await Promise.all([
            loadArtifactStatus(project_slug, "intelligence-brief.md"),
            loadArtifactStatus(project_slug, "pending-doc-updates.md"),
          ]);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                intelligence_brief: briefStatus,
                pending_doc_updates: pendingStatus,
                synthesis_enabled: SYNTHESIS_ENABLED,
                diagnostics: diagnostics.list(),
              }),
            }],
          };
        }

        // Generate mode
        if (!session_number) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "session_number is required for generate mode" }),
            }],
            isError: true,
          };
        }

        if (!SYNTHESIS_ENABLED) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Synthesis disabled — ANTHROPIC_API_KEY not configured on server.",
                diagnostics: diagnostics.list(),
              }),
            }],
            isError: true,
          };
        }

        // brief-460 Task C / INS-331: dispatch both synthesis legs in the
        // background and return immediately — the INS-178 ¶8 fire-and-forget
        // pattern from finalize.ts. Awaiting here held the request open for
        // the full synthesis duration and outlived the MCP client transport.
        const synthStart = Date.now();
        const synthesisLabels = ["intelligence_brief", "pending_updates"] as const;
        void Promise.allSettled([
          generateIntelligenceBrief(project_slug, session_number),
          generatePendingDocUpdates(project_slug, session_number),
        ])
          .then((results) => {
            results.forEach((r, idx) => {
              const label = synthesisLabels[idx];
              if (r.status === "fulfilled") {
                logger.info("background synthesis complete", {
                  projectSlug: project_slug,
                  sessionNumber: session_number,
                  synthesis_kind: label,
                  success: r.value?.success ?? false,
                  trigger: "prism_synthesize",
                  durationMs: Date.now() - synthStart,
                });
              } else {
                logger.error("background synthesis failed", {
                  projectSlug: project_slug,
                  sessionNumber: session_number,
                  synthesis_kind: label,
                  err: r.reason instanceof Error ? r.reason.message : String(r.reason),
                  trigger: "prism_synthesize",
                  durationMs: Date.now() - synthStart,
                });
              }
            });
          })
          .catch((err) => {
            // Defensive — Promise.allSettled itself never rejects, so this
            // catches synchronous throws from the .then callback.
            logger.error("background synthesis dispatch failed", {
              projectSlug: project_slug,
              sessionNumber: session_number,
              err: err instanceof Error ? err.message : String(err),
              trigger: "prism_synthesize",
              durationMs: Date.now() - synthStart,
            });
          });

        logger.info("prism_synthesize dispatched background synthesis", {
          project_slug,
          mode,
          session_number,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "started",
              synthesis_outcome: "background",
              intelligence_brief: { status: "started" },
              pending_doc_updates: { status: "started" },
              status_hint:
                "Synthesis running in background (brief ~1-2 min, pending-doc-updates up to ~8 min). Check completion via prism_synthesize mode=status — compare 'Last synthesized' against this session.",
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_synthesize failed", { project_slug, mode, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
