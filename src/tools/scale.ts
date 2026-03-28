/**
 * prism_scale_handoff tool — Execute handoff scaling protocol server-side.
 * Identifies sections that can be redistributed to living documents and
 * optionally executes the scaling operation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fetchFiles, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { extractSection, extractHeaders, parseNumberedList } from "../utils/summarizer.js";

interface ScaleAction {
  description: string;
  source_section: string;
  destination_file: string;
  bytes_moved: number;
  executed: boolean;
  content_to_move?: string;
}

/**
 * Identify content in handoff that can be moved to living documents.
 */
function identifyScalableContent(
  handoffContent: string,
  livingDocs: Map<string, string>
): ScaleAction[] {
  const actions: ScaleAction[] = [];

  // 1. Session History entries older than last 5 sessions → archive to session-log.md
  const sessionHistory = extractSection(handoffContent, "Session History")
    ?? extractSection(handoffContent, "Recent Sessions")
    ?? extractSection(handoffContent, "Session Log");

  if (sessionHistory) {
    // Find session entries (look for session N patterns)
    const sessionEntries = sessionHistory.split(/(?=###?\s+Session\s+\d+)/i);
    if (sessionEntries.length > 5) {
      const oldEntries = sessionEntries.slice(0, -5);
      const oldContent = oldEntries.join("\n").trim();
      if (oldContent.length > 0) {
        actions.push({
          description: `Archive ${oldEntries.length} old session entries to session-log.md`,
          source_section: "Session History",
          destination_file: "session-log.md",
          bytes_moved: new TextEncoder().encode(oldContent).length,
          executed: false,
          content_to_move: oldContent,
        });
      }
    }
  }

  // 2. Full decision entries with reasoning → keep only summary table in handoff
  const decisionsSection = extractSection(handoffContent, "Decisions")
    ?? extractSection(handoffContent, "Key Decisions")
    ?? extractSection(handoffContent, "Decision Log");

  if (decisionsSection) {
    // If there are full decision entries (with reasoning/rationale blocks), they can be trimmed
    const fullEntryPattern = /###?\s+D-\d+.*?\n[\s\S]*?(?=###?\s+D-\d+|$)/g;
    const fullEntries = decisionsSection.match(fullEntryPattern) ?? [];

    if (fullEntries.length > 0) {
      // Check if entries have reasoning/rationale content
      const entriesWithReasoning = fullEntries.filter(
        (e) => e.includes("Reasoning") || e.includes("Rationale") || e.includes("Context") || e.length > 200
      );

      if (entriesWithReasoning.length > 0) {
        const contentToMove = entriesWithReasoning.join("\n").trim();
        actions.push({
          description: `Move ${entriesWithReasoning.length} full decision entries (with reasoning) to decisions/_INDEX.md — keep only summary table in handoff`,
          source_section: "Decisions",
          destination_file: "decisions/_INDEX.md",
          bytes_moved: new TextEncoder().encode(contentToMove).length,
          executed: false,
          content_to_move: contentToMove,
        });
      }
    }
  }

  // 3. Full guardrail entries → already in eliminated.md, keep only summary in handoff
  const guardrailsSection = extractSection(handoffContent, "Guardrails")
    ?? extractSection(handoffContent, "Eliminated Approaches")
    ?? extractSection(handoffContent, "What Not To Do");

  if (guardrailsSection) {
    const fullGuardrails = guardrailsSection.match(/###?\s+G-\d+.*?\n[\s\S]*?(?=###?\s+G-\d+|$)/g) ?? [];
    const verboseGuardrails = fullGuardrails.filter((g) => g.length > 150);

    if (verboseGuardrails.length > 0) {
      const contentToMove = verboseGuardrails.join("\n").trim();
      actions.push({
        description: `Move ${verboseGuardrails.length} verbose guardrail entries to eliminated.md — keep only summary table in handoff`,
        source_section: "Guardrails",
        destination_file: "eliminated.md",
        bytes_moved: new TextEncoder().encode(contentToMove).length,
        executed: false,
        content_to_move: contentToMove,
      });
    }
  }

  // 4. Open questions that are resolved → remove
  const openQuestions = extractSection(handoffContent, "Open Questions");
  if (openQuestions) {
    const questions = parseNumberedList(openQuestions);
    const resolvedQuestions = questions.filter(
      (q) =>
        q.toLowerCase().includes("resolved") ||
        q.toLowerCase().includes("done") ||
        q.toLowerCase().includes("answered") ||
        q.toLowerCase().includes("closed") ||
        q.toLowerCase().includes("n/a") ||
        q.toLowerCase().includes("no longer")
    );

    if (resolvedQuestions.length > 0) {
      const contentToRemove = resolvedQuestions.join("\n").trim();
      actions.push({
        description: `Remove ${resolvedQuestions.length} resolved open questions`,
        source_section: "Open Questions",
        destination_file: "(remove)",
        bytes_moved: new TextEncoder().encode(contentToRemove).length,
        executed: false,
        content_to_move: contentToRemove,
      });
    }
  }

  // 5. Architecture details → move to architecture.md
  const archSection = extractSection(handoffContent, "Architecture")
    ?? extractSection(handoffContent, "Technical Architecture")
    ?? extractSection(handoffContent, "Stack");

  if (archSection && new TextEncoder().encode(archSection).length > 500) {
    actions.push({
      description: "Move verbose architecture details to architecture.md — keep summary pointer in handoff",
      source_section: "Architecture",
      destination_file: "architecture.md",
      bytes_moved: new TextEncoder().encode(archSection).length,
      executed: false,
      content_to_move: archSection,
    });
  }

  return actions;
}

/**
 * Execute scaling actions — modifies handoff and target living documents.
 */
async function executeScaling(
  projectSlug: string,
  handoffContent: string,
  actions: ScaleAction[]
): Promise<{ updatedHandoff: string; pushResults: Array<{ path: string; success: boolean }> }> {
  let updatedHandoff = handoffContent;
  const pushResults: Array<{ path: string; success: boolean }> = [];

  for (const action of actions) {
    if (!action.content_to_move) continue;

    // Remove content from handoff
    if (action.destination_file === "(remove)") {
      // Remove resolved questions line by line
      for (const line of action.content_to_move.split("\n")) {
        const trimmedLine = line.trim();
        if (trimmedLine.length > 0) {
          // Remove numbered list items matching this content
          updatedHandoff = updatedHandoff.replace(
            new RegExp(`\\d+\\.\\s+${escapeRegex(trimmedLine)}\\n?`, "g"),
            ""
          );
        }
      }
      action.executed = true;
      continue;
    }

    // Append content to destination living document
    try {
      const destFile = await fetchFile(projectSlug, action.destination_file);
      const eofSentinel = `<!-- EOF: ${action.destination_file.split("/").pop()} -->`;
      let destContent = destFile.content;

      // Insert before EOF sentinel
      if (destContent.trimEnd().endsWith(eofSentinel)) {
        destContent =
          destContent.trimEnd().slice(0, -eofSentinel.length).trimEnd() +
          "\n\n" +
          action.content_to_move +
          "\n\n" +
          eofSentinel +
          "\n";
      } else {
        destContent += "\n\n" + action.content_to_move;
      }

      const result = await pushFile(
        projectSlug,
        action.destination_file,
        destContent,
        `prism: extract ${action.destination_file.split("/").pop()}`
      );
      pushResults.push({ path: action.destination_file, success: result.success });

      if (result.success) {
        action.executed = true;
      }
    } catch (error) {
      pushResults.push({ path: action.destination_file, success: false });
    }
  }

  return { updatedHandoff, pushResults };
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Register the prism_scale_handoff tool on an MCP server instance.
 */
export function registerScaleHandoff(server: McpServer): void {
  server.tool(
    "prism_scale_handoff",
    "Execute handoff scaling protocol. Identifies sections that can be moved to living documents to reduce handoff size. Use dry_run:true to preview, dry_run:false to execute.",
    {
      project_slug: z.string().describe("Project repo name"),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe("If true, show what would be moved without executing. Set false to actually scale."),
    },
    async ({ project_slug, dry_run }) => {
      const start = Date.now();
      const isDryRun = dry_run ?? true;
      logger.info("prism_scale_handoff", { project_slug, dry_run: isDryRun });

      try {
        // Fetch current handoff
        const handoff = await fetchFile(project_slug, "handoff.md");
        const beforeSize = handoff.size;

        // Fetch living documents for reference
        const livingDocMap = await fetchFiles(project_slug, [
          "session-log.md",
          "decisions/_INDEX.md",
          "eliminated.md",
          "architecture.md",
        ]);

        const livingDocContents = new Map<string, string>();
        for (const [path, result] of livingDocMap) {
          livingDocContents.set(path, result.content);
        }

        // Identify scalable content
        const actions = identifyScalableContent(handoff.content, livingDocContents);

        if (isDryRun) {
          const totalBytesMovable = actions.reduce((sum, a) => sum + a.bytes_moved, 0);
          const afterSize = beforeSize - totalBytesMovable;
          const reductionPercent =
            beforeSize > 0 ? Math.round((totalBytesMovable / beforeSize) * 100) : 0;

          // Strip content_to_move from dry-run output to save context
          const cleanActions = actions.map(({ content_to_move, ...rest }) => rest);

          const result = {
            project: project_slug,
            dry_run: true,
            before_size_bytes: beforeSize,
            after_size_bytes: Math.max(0, afterSize),
            reduction_percent: reductionPercent,
            actions: cleanActions,
            warnings: actions.length === 0
              ? ["No scalable content identified. Handoff may already be optimally sized."]
              : [],
          };

          logger.info("prism_scale_handoff dry run complete", {
            project_slug,
            actionsFound: actions.length,
            potentialReduction: `${reductionPercent}%`,
            ms: Date.now() - start,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Execute scaling
        const { updatedHandoff, pushResults } = await executeScaling(
          project_slug,
          handoff.content,
          actions
        );

        // Push updated handoff
        const handoffPush = await pushFile(
          project_slug,
          "handoff.md",
          updatedHandoff,
          "prism: scale handoff"
        );
        pushResults.push({ path: "handoff.md", success: handoffPush.success });

        const afterSize = new TextEncoder().encode(updatedHandoff).length;
        const reductionPercent =
          beforeSize > 0 ? Math.round(((beforeSize - afterSize) / beforeSize) * 100) : 0;

        const cleanActions = actions.map(({ content_to_move, ...rest }) => rest);

        const result = {
          project: project_slug,
          dry_run: false,
          before_size_bytes: beforeSize,
          after_size_bytes: afterSize,
          reduction_percent: reductionPercent,
          actions: cleanActions,
          warnings: pushResults.filter((r) => !r.success).map(
            (r) => `Failed to push ${r.path}`
          ),
        };

        logger.info("prism_scale_handoff execute complete", {
          project_slug,
          beforeKB: (beforeSize / 1024).toFixed(1),
          afterKB: (afterSize / 1024).toFixed(1),
          reductionPercent,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_scale_handoff failed", { project_slug, error: message });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: message, project: project_slug }),
          }],
          isError: true,
        };
      }
    }
  );
}
