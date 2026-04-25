/**
 * prism_synthesize tool — On-demand intelligence brief generation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYNTHESIS_ENABLED } from "../config.js";
import { fetchFile } from "../github/client.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { generateIntelligenceBrief } from "../ai/synthesize.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

export function registerSynthesize(server: McpServer) {
  server.tool(
    "prism_synthesize",
    "Generate or check AI-synthesized intelligence brief. Modes: generate (create/refresh), status (check existence).",
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
          try {
            const resolved = await resolveDocPath(project_slug, "intelligence-brief.md");
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  exists: true,
                  size_bytes: resolved.content.length,
                  synthesis_enabled: SYNTHESIS_ENABLED,
                  // Extract the "Last synthesized" line
                  last_synthesized: resolved.content.match(/Last synthesized: (S\d+ \([^)]+\))/)?.[1] ?? "unknown",
                  diagnostics: diagnostics.list(),
                }),
              }],
            };
          } catch {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  exists: false,
                  synthesis_enabled: SYNTHESIS_ENABLED,
                  message: SYNTHESIS_ENABLED
                    ? "No intelligence brief exists yet. Run mode:'generate' after a finalization."
                    : "Synthesis disabled — ANTHROPIC_API_KEY not configured on server.",
                  diagnostics: diagnostics.list(),
                }),
              }],
            };
          }
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

        const result = await generateIntelligenceBrief(project_slug, session_number);

        if (!result.success && result.error) {
          if (result.error.toLowerCase().includes("timeout") || result.error.toLowerCase().includes("timed out") || result.error.toLowerCase().includes("etimedout")) {
            diagnostics.error("SYNTHESIS_TIMEOUT", `Synthesis timed out: ${result.error}`, { error: result.error });
          } else {
            diagnostics.error("SYNTHESIS_RETRY", `Synthesis failed: ${result.error}`, { error: result.error });
          }
        }

        logger.info("prism_synthesize complete", {
          project_slug,
          mode,
          success: result.success,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, diagnostics: diagnostics.list() }) }],
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
