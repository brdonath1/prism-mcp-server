/**
 * prism_synthesize tool — On-demand intelligence brief + pending-doc-updates
 * generation.
 *
 * D-156 §3.6 / D-155 / Phase 2 PR 4 §5: PR 3 wired the parallel dispatch into
 * `prism_finalize`'s commit-action handler so a finalize automatically refreshes
 * BOTH `intelligence-brief.md` AND `pending-doc-updates.md`. This tool now
 * mirrors that wiring — `mode: "generate"` invokes both synthesis functions in
 * parallel via `Promise.allSettled`, and `mode: "status"` reports on both
 * artifacts. The previous behavior (brief-only) caused divergence: a manual
 * refresh produced only half of what an auto-finalize did.
 *
 * Cost note: `mode: "generate"` now fires TWO Opus calls (~2x API cost vs
 * pre-PR-4 behavior). Operators calling this tool manually for refresh should
 * be aware. See D-156 §3.6 for design rationale.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYNTHESIS_ENABLED } from "../config.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
  type SynthesisOutcome,
} from "../ai/synthesize.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

/** Synthesis kinds — used in diagnostics context to disambiguate outcomes. */
type SynthesisKind = "intelligence_brief" | "pending_doc_updates";

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

/**
 * Classify a synthesis failure into a diagnostic code.
 * Mirrors the previous single-await branch's logic — timeouts get
 * SYNTHESIS_TIMEOUT, everything else gets SYNTHESIS_RETRY.
 */
function emitFailureDiagnostic(
  diagnostics: DiagnosticsCollector,
  kind: SynthesisKind,
  errorMessage: string,
): void {
  const lower = errorMessage.toLowerCase();
  const isTimeout =
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout");
  if (isTimeout) {
    diagnostics.error(
      "SYNTHESIS_TIMEOUT",
      `Synthesis (${kind}) timed out: ${errorMessage}`,
      { error: errorMessage, synthesis_kind: kind },
    );
  } else {
    diagnostics.error(
      "SYNTHESIS_RETRY",
      `Synthesis (${kind}) failed: ${errorMessage}`,
      { error: errorMessage, synthesis_kind: kind },
    );
  }
}

/**
 * Convert a `Promise.allSettled` element into a `SynthesisOutcome`-shaped
 * value. Rejected promises (uncaught throws) become a synthetic failure
 * outcome so the caller can surface the error consistently. Defensive:
 * `undefined`/`null` values from a broken upstream contract become
 * `{ success: false, error: ... }` instead of crashing the tool.
 */
function settledToOutcome(
  settled: PromiseSettledResult<SynthesisOutcome | undefined>,
): SynthesisOutcome {
  if (settled.status === "fulfilled") {
    if (settled.value && typeof settled.value === "object") return settled.value;
    return { success: false, error: "synthesis function returned no outcome" };
  }
  const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
  return { success: false, error: reason };
}

export function registerSynthesize(server: McpServer) {
  server.tool(
    "prism_synthesize",
    "Generate or check AI-synthesized artifacts. Modes: generate (refresh BOTH intelligence-brief.md AND pending-doc-updates.md in parallel — D-156 §3.6), status (check existence of both).",
    {
      project_slug: z.string().describe("Project repo name"),
      mode: z.enum(["generate", "status"]).describe("'generate' to create/refresh, 'status' to check"),
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

        // PR 4 §5.1: parallel dispatch — slower of the two does not block the
        // other. Both outcomes are surfaced to the caller (partial success is a
        // valid response).
        const [briefSettled, pendingSettled] = await Promise.allSettled([
          generateIntelligenceBrief(project_slug, session_number),
          generatePendingDocUpdates(project_slug, session_number),
        ]);

        const briefOutcome = settledToOutcome(briefSettled);
        const pendingOutcome = settledToOutcome(pendingSettled);

        if (!briefOutcome.success && briefOutcome.error) {
          emitFailureDiagnostic(diagnostics, "intelligence_brief", briefOutcome.error);
        }
        if (!pendingOutcome.success && pendingOutcome.error) {
          emitFailureDiagnostic(diagnostics, "pending_doc_updates", pendingOutcome.error);
        }

        const bothFailed = !briefOutcome.success && !pendingOutcome.success;

        logger.info("prism_synthesize complete", {
          project_slug,
          mode,
          brief_success: briefOutcome.success,
          pending_success: pendingOutcome.success,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              intelligence_brief: briefOutcome,
              pending_doc_updates: pendingOutcome,
              diagnostics: diagnostics.list(),
            }),
          }],
          // PR 4 §5.3: total failure (neither artifact refreshed) sets isError.
          // Partial success (one of two succeeded) returns 200 — caller asked
          // for two refreshes, one happened, that's worth reporting non-error.
          ...(bothFailed ? { isError: true as const } : {}),
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
