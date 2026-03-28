/**
 * prism_scale_handoff tool — Execute handoff scaling protocol server-side.
 * Identifies sections that can be redistributed to living documents and
 * optionally executes the scaling operation.
 *
 * Supports three modes:
 *  - "analyze": return a scaling plan without executing (fast, <10s)
 *  - "execute": run a plan from a previous analyze call
 *  - "full": attempt the complete operation in one call (default)
 *
 * Sends MCP progress notifications during full/execute to reset the client's
 * 60-second timeout (via resetTimeoutOnProgress: true in the SDK).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { fetchFile, fetchFiles, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { extractSection } from "../utils/summarizer.js";

/** Maximum wall-clock time before returning a partial result (ms). */
const SAFETY_TIMEOUT_MS = 50_000;

/** Total number of stages in a full/execute scaling operation. */
const TOTAL_STAGES = 6;

// ── Types ────────────────────────────────────────────────────────────────────

interface ScaleAction {
  description: string;
  source_section: string;
  destination_file: string;
  bytes_moved: number;
  executed: boolean;
  content_to_move?: string;
}

/** The serializable plan returned by "analyze" and consumed by "execute". */
const ScalePlanSchema = z.object({
  project_slug: z.string(),
  before_size_bytes: z.number(),
  actions: z.array(
    z.object({
      description: z.string(),
      source_section: z.string(),
      destination_file: z.string(),
      bytes_moved: z.number(),
      content_to_move: z.string().optional(),
    })
  ),
});

type ScalePlan = z.infer<typeof ScalePlanSchema>;

// ── Progress helper ──────────────────────────────────────────────────────────

/**
 * Send an MCP progress notification if the client provided a progressToken.
 * Silently no-ops when the token is absent.
 */
async function sendProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  progressToken: string | number | undefined,
  stage: number,
  message: string,
): Promise<void> {
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: stage,
        total: TOTAL_STAGES,
        message,
      },
    });
  } catch {
    // Best-effort — don't let notification failures break the operation.
  }
}

// ── Content analysis ─────────────────────────────────────────────────────────

/**
 * Identify content in handoff that can be moved to living documents.
 */
function identifyScalableContent(
  handoffContent: string,
  _livingDocs: Map<string, string>,
): ScaleAction[] {
  const actions: ScaleAction[] = [];

  // 1. Session History entries older than last 3 sessions → archive to session-log.md
  const sessionHistory =
    extractSection(handoffContent, "Session History") ??
    extractSection(handoffContent, "Recent Sessions") ??
    extractSection(handoffContent, "Session Log");

  if (sessionHistory) {
    const sessionEntries = sessionHistory.split(/(?=###?\s+Session\s+\d+)/i);
    if (sessionEntries.length > 3) {
      const oldEntries = sessionEntries.slice(0, -3);
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
  const decisionsSection =
    extractSection(handoffContent, "Decisions") ??
    extractSection(handoffContent, "Key Decisions") ??
    extractSection(handoffContent, "Decision Log");

  if (decisionsSection) {
    const fullEntryPattern = /###?\s+D-\d+.*?\n[\s\S]*?(?=###?\s+D-\d+|$)/g;
    const fullEntries = decisionsSection.match(fullEntryPattern) ?? [];
    if (fullEntries.length > 0) {
      const entriesWithReasoning = fullEntries.filter(
        (e) =>
          e.includes("Reasoning") ||
          e.includes("Rationale") ||
          e.includes("Context") ||
          e.length > 200,
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
  const guardrailsSection =
    extractSection(handoffContent, "Guardrails") ??
    extractSection(handoffContent, "Eliminated Approaches") ??
    extractSection(handoffContent, "What Not To Do");

  if (guardrailsSection) {
    const fullGuardrails =
      guardrailsSection.match(/###?\s+G-\d+.*?\n[\s\S]*?(?=###?\s+G-\d+|$)/g) ?? [];
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
    const questionLines = openQuestions.split("\n").filter((l) => l.trim().length > 0);
    const resolvedQuestions = questionLines.filter(
      (q) =>
        /^\s*-\s*\[x\]/i.test(q) ||
        q.toLowerCase().includes("resolved") ||
        q.toLowerCase().includes("done") ||
        q.toLowerCase().includes("answered") ||
        q.toLowerCase().includes("closed") ||
        q.toLowerCase().includes("n/a") ||
        q.toLowerCase().includes("no longer"),
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
  const archSection =
    extractSection(handoffContent, "Architecture") ??
    extractSection(handoffContent, "Technical Architecture") ??
    extractSection(handoffContent, "Stack");

  if (archSection && new TextEncoder().encode(archSection).length > 500) {
    actions.push({
      description:
        "Move verbose architecture details to architecture.md — keep summary pointer in handoff",
      source_section: "Architecture",
      destination_file: "architecture.md",
      bytes_moved: new TextEncoder().encode(archSection).length,
      executed: false,
      content_to_move: archSection,
    });
  }

  // 6. Artifacts Registry → move to task-queue.md
  const artifactsSection =
    extractSection(handoffContent, "Artifacts Registry") ??
    extractSection(handoffContent, "Artifacts");
  if (artifactsSection && new TextEncoder().encode(artifactsSection).length > 500) {
    actions.push({
      description:
        "Move Artifacts Registry table to task-queue.md (Recently Completed) — keep pointer in handoff",
      source_section: "Artifacts Registry",
      destination_file: "task-queue.md",
      bytes_moved: new TextEncoder().encode(artifactsSection).length,
      executed: false,
      content_to_move: artifactsSection,
    });
  }

  // 7. Verbose "Where We Are" section (>1KB) → trim to essentials
  const whereWeAre =
    extractSection(handoffContent, "Where We Are") ??
    extractSection(handoffContent, "Current State");
  if (whereWeAre && new TextEncoder().encode(whereWeAre).length > 1000) {
    const excess = new TextEncoder().encode(whereWeAre).length - 500;
    actions.push({
      description:
        "Trim verbose 'Where We Are' section — move detailed context to session-log.md, keep 2-3 sentence summary in handoff",
      source_section: "Where We Are",
      destination_file: "session-log.md",
      bytes_moved: excess,
      executed: false,
      content_to_move: whereWeAre,
    });
  }

  // 8. Verbose "Strategic Direction" section (>1KB) → move to architecture.md
  const strategicSection =
    extractSection(handoffContent, "Strategic Direction") ??
    extractSection(handoffContent, "Strategy");
  if (strategicSection && new TextEncoder().encode(strategicSection).length > 1000) {
    const excess = new TextEncoder().encode(strategicSection).length - 300;
    actions.push({
      description:
        "Move verbose Strategic Direction to architecture.md — keep 1-2 sentence summary in handoff",
      source_section: "Strategic Direction",
      destination_file: "architecture.md",
      bytes_moved: excess,
      executed: false,
      content_to_move: strategicSection,
    });
  }

  // 9. Critical Context bloat (>10 items or >2KB) → flag for manual review
  const criticalContext = extractSection(handoffContent, "Critical Context");
  if (criticalContext) {
    const items = criticalContext
      .split("\n")
      .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "));
    const contextBytes = new TextEncoder().encode(criticalContext).length;
    if (items.length > 10 || contextBytes > 2000) {
      const operationalPatterns = [
        /secret/i, /token/i, /key.*replit/i, /prisma.*version/i, /flag/i,
        /git.*push/i, /git.*commit/i, /git.*auto/i, /pexels/i,
        /subscription/i, /authenticated/i, /scoped/i,
      ];
      const operationalItems = items.filter((item) =>
        operationalPatterns.some((p) => p.test(item)),
      );
      if (operationalItems.length > 0) {
        const contentToMove = operationalItems.join("\n").trim();
        actions.push({
          description: `Move ${operationalItems.length} operational items from Critical Context to known-issues.md — keep only truly critical constraints in handoff`,
          source_section: "Critical Context",
          destination_file: "known-issues.md",
          bytes_moved: new TextEncoder().encode(contentToMove).length,
          executed: false,
          content_to_move: contentToMove,
        });
      }
    }
  }

  // 10. Duplicate EOF sentinels → flag as warning
  const eofMatches = handoffContent.match(/<!-- EOF: handoff\.md -->/g);
  if (eofMatches && eofMatches.length > 1) {
    const firstEofIdx = handoffContent.indexOf("<!-- EOF: handoff.md -->");
    const lastEofIdx = handoffContent.lastIndexOf("<!-- EOF: handoff.md -->");
    if (firstEofIdx !== lastEofIdx) {
      const orphanedContent = handoffContent
        .slice(firstEofIdx + "<!-- EOF: handoff.md -->".length, lastEofIdx)
        .trim();
      if (orphanedContent.length > 0) {
        actions.push({
          description: `Remove ${new TextEncoder().encode(orphanedContent).length} bytes of orphaned content between duplicate EOF sentinels`,
          source_section: "Orphaned (after first EOF)",
          destination_file: "(remove)",
          bytes_moved: new TextEncoder().encode(orphanedContent).length,
          executed: false,
          content_to_move: orphanedContent,
        });
      }
    }
  }

  return actions;
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Execute scaling actions — modifies handoff and pushes to living documents.
 * All destination fetches and pushes are parallelized via Promise.allSettled.
 */
async function executeScaling(
  projectSlug: string,
  handoffContent: string,
  actions: ScaleAction[],
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  progressToken: string | number | undefined,
  startTime: number,
): Promise<{
  updatedHandoff: string;
  pushResults: Array<{ path: string; success: boolean }>;
  timed_out: boolean;
}> {
  let updatedHandoff = handoffContent;
  const pushResults: Array<{ path: string; success: boolean }> = [];

  // Separate removal actions from push actions
  const removeActions = actions.filter((a) => a.destination_file === "(remove)");
  const pushActions = actions.filter((a) => a.destination_file !== "(remove)");

  // ── Stage 4: Process removals (local string ops, fast) ──
  await sendProgress(extra, progressToken, 4, "Composing redistributed content...");
  logger.info("scale: stage 4 — compose redistributed content", { elapsed_ms: Date.now() - startTime });

  for (const action of removeActions) {
    if (!action.content_to_move) continue;
    for (const line of action.content_to_move.split("\n")) {
      const trimmedLine = line.trim();
      if (trimmedLine.length > 0) {
        updatedHandoff = updatedHandoff.replace(
          new RegExp(`\\d+\\.\\s+${escapeRegex(trimmedLine)}\\n?`, "g"),
          "",
        );
      }
    }
    action.executed = true;
  }

  // Check safety timeout before starting network I/O
  if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
    return { updatedHandoff, pushResults, timed_out: true };
  }

  // ── Stage 5: Fetch destinations + push in parallel ──
  await sendProgress(extra, progressToken, 5, "Pushing redistributed files...");
  logger.info("scale: stage 5 — push redistributed files", { elapsed_ms: Date.now() - startTime });

  // Group push actions by destination file to avoid conflicting writes
  const byDest = new Map<string, ScaleAction[]>();
  for (const action of pushActions) {
    if (!action.content_to_move) continue;
    const existing = byDest.get(action.destination_file) ?? [];
    existing.push(action);
    byDest.set(action.destination_file, existing);
  }

  // Fetch all destination files in parallel
  const destPaths = [...byDest.keys()];
  const destFiles = await fetchFiles(projectSlug, destPaths);

  // Push all destinations in parallel
  const pushPromises = destPaths.map(async (destPath) => {
    const destActions = byDest.get(destPath)!;
    const destFile = destFiles.get(destPath);
    if (!destFile) {
      return { path: destPath, success: false };
    }

    const eofSentinel = `<!-- EOF: ${destPath.split("/").pop()} -->`;
    let destContent = destFile.content;

    // Append all actions' content for this destination
    for (const action of destActions) {
      if (!action.content_to_move) continue;
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
    }

    const result = await pushFile(
      projectSlug,
      destPath,
      destContent,
      `prism: extract ${destPath.split("/").pop()}`,
    );

    if (result.success) {
      for (const action of destActions) action.executed = true;
    }

    return { path: destPath, success: result.success };
  });

  const pushOutcomes = await Promise.allSettled(pushPromises);
  for (const outcome of pushOutcomes) {
    if (outcome.status === "fulfilled") {
      pushResults.push(outcome.value);
    } else {
      pushResults.push({ path: "unknown", success: false });
    }
  }

  return { updatedHandoff, pushResults, timed_out: false };
}

// ── Tool registration ────────────────────────────────────────────────────────

/**
 * Register the prism_scale_handoff tool on an MCP server instance.
 */
export function registerScaleHandoff(server: McpServer): void {
  server.tool(
    "prism_scale_handoff",
    "Execute handoff scaling protocol. Reduces handoff size by redistributing content to living documents. " +
      "Three modes: 'full' (default) runs complete scaling in one call. " +
      "'analyze' returns a plan without executing — use for large handoffs or previewing. " +
      "'execute' runs a plan from a previous 'analyze' call.",
    {
      project_slug: z.string().describe("Project repo name"),
      action: z
        .enum(["full", "analyze", "execute"])
        .default("full")
        .describe(
          "'full' runs complete scaling (default). 'analyze' returns a plan without executing. 'execute' runs a plan from a previous analyze call.",
        ),
      plan: ScalePlanSchema.optional().describe(
        "Required for action='execute'. The plan object returned by a previous 'analyze' call.",
      ),
    },
    async ({ project_slug, action, plan }, extra) => {
      const startTime = Date.now();
      const progressToken = extra._meta?.progressToken;

      logger.info("prism_scale_handoff", { project_slug, action, hasProgressToken: progressToken !== undefined });

      try {
        // ── action: "execute" — run a previously-generated plan ──
        if (action === "execute") {
          if (!plan) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "Missing 'plan' parameter. Run with action='analyze' first to get a plan.",
                  project: project_slug,
                }),
              }],
              isError: true,
            };
          }

          // Validate plan matches project
          if (plan.project_slug !== project_slug) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Plan project_slug '${plan.project_slug}' does not match request project_slug '${project_slug}'.`,
                  project: project_slug,
                }),
              }],
              isError: true,
            };
          }

          await sendProgress(extra, progressToken, 1, "Fetching current handoff...");
          logger.info("scale: stage 1 — fetch handoff (execute)", { elapsed_ms: Date.now() - startTime });

          const handoff = await fetchFile(project_slug, "handoff.md");

          await sendProgress(extra, progressToken, 2, "Preparing scaling actions from plan...");
          logger.info("scale: stage 2 — prepare actions from plan", { elapsed_ms: Date.now() - startTime });

          // Convert plan actions back to ScaleAction[]
          const actions: ScaleAction[] = plan.actions.map((a) => ({
            ...a,
            executed: false,
          }));

          await sendProgress(extra, progressToken, 3, "Fetching target living documents...");
          logger.info("scale: stage 3 — fetch targets (execute)", { elapsed_ms: Date.now() - startTime });

          const { updatedHandoff, pushResults, timed_out } = await executeScaling(
            project_slug,
            handoff.content,
            actions,
            extra,
            progressToken,
            startTime,
          );

          // ── Stage 6: Push updated handoff ──
          await sendProgress(extra, progressToken, 6, "Pushing updated handoff...");
          logger.info("scale: stage 6 — push handoff", { elapsed_ms: Date.now() - startTime });

          const handoffPush = await pushFile(
            project_slug,
            "handoff.md",
            updatedHandoff,
            "prism: scale handoff",
          );
          pushResults.push({ path: "handoff.md", success: handoffPush.success });

          const afterSize = new TextEncoder().encode(updatedHandoff).length;
          const beforeSize = plan.before_size_bytes;
          const reductionPercent =
            beforeSize > 0 ? Math.round(((beforeSize - afterSize) / beforeSize) * 100) : 0;

          const totalMs = Date.now() - startTime;
          logger.info("scale: execute complete", {
            project_slug,
            beforeKB: (beforeSize / 1024).toFixed(1),
            afterKB: (afterSize / 1024).toFixed(1),
            reductionPercent,
            ms: totalMs,
          });

          const warnings = pushResults
            .filter((r) => !r.success)
            .map((r) => `Failed to push ${r.path}`);
          if (timed_out) {
            warnings.push(
              "Operation exceeded 50s safety timeout. Some actions may not have executed. Consider running again with remaining actions.",
            );
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  project: project_slug,
                  action: "execute",
                  before_size_bytes: beforeSize,
                  after_size_bytes: afterSize,
                  reduction_percent: reductionPercent,
                  actions_executed: actions.filter((a) => a.executed).length,
                  actions_total: actions.length,
                  push_results: pushResults,
                  elapsed_ms: totalMs,
                  timed_out,
                  warnings,
                },
                null,
                2,
              ),
            }],
          };
        }

        // ── Shared first stages for "analyze" and "full" ──

        // Stage 1: Fetch handoff
        await sendProgress(extra, progressToken, 1, "Fetching handoff...");
        logger.info("scale: stage 1 — fetch handoff", { elapsed_ms: Date.now() - startTime });

        const handoff = await fetchFile(project_slug, "handoff.md");
        const beforeSize = handoff.size;

        // Stage 2: Analyze sections
        await sendProgress(extra, progressToken, 2, "Analyzing handoff sections...");
        logger.info("scale: stage 2 — analyze sections", { elapsed_ms: Date.now() - startTime });

        // Stage 3: Fetch living documents for reference
        await sendProgress(extra, progressToken, 3, "Fetching living documents for reference...");
        logger.info("scale: stage 3 — fetch living docs", { elapsed_ms: Date.now() - startTime });

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

        const actions = identifyScalableContent(handoff.content, livingDocContents);

        // ── action: "analyze" — return plan without executing ──
        if (action === "analyze") {
          const totalBytesMovable = actions.reduce((sum, a) => sum + a.bytes_moved, 0);
          const afterSize = beforeSize - totalBytesMovable;
          const reductionPercent =
            beforeSize > 0 ? Math.round((totalBytesMovable / beforeSize) * 100) : 0;

          const planOutput: ScalePlan = {
            project_slug,
            before_size_bytes: beforeSize,
            actions: actions.map((a) => ({
              description: a.description,
              source_section: a.source_section,
              destination_file: a.destination_file,
              bytes_moved: a.bytes_moved,
              content_to_move: a.content_to_move,
            })),
          };

          const totalMs = Date.now() - startTime;
          logger.info("scale: analyze complete", {
            project_slug,
            actionsFound: actions.length,
            potentialReduction: `${reductionPercent}%`,
            ms: totalMs,
          });

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  project: project_slug,
                  action: "analyze",
                  before_size_bytes: beforeSize,
                  estimated_after_size_bytes: Math.max(0, afterSize),
                  reduction_percent: reductionPercent,
                  actions_count: actions.length,
                  plan: planOutput,
                  elapsed_ms: totalMs,
                  warnings:
                    actions.length === 0
                      ? ["No scalable content identified. Handoff may already be optimally sized."]
                      : [],
                },
                null,
                2,
              ),
            }],
          };
        }

        // ── action: "full" — analyze + execute in one call ──

        // Check safety timeout before committing to execution
        if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
          const totalBytesMovable = actions.reduce((sum, a) => sum + a.bytes_moved, 0);
          const reductionPercent =
            beforeSize > 0 ? Math.round((totalBytesMovable / beforeSize) * 100) : 0;

          // Return the plan so the caller can use analyze+execute instead
          const planOutput: ScalePlan = {
            project_slug,
            before_size_bytes: beforeSize,
            actions: actions.map((a) => ({
              description: a.description,
              source_section: a.source_section,
              destination_file: a.destination_file,
              bytes_moved: a.bytes_moved,
              content_to_move: a.content_to_move,
            })),
          };

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Scale operation exceeded 50s safety timeout during analysis phase.",
                  stage: "analyze",
                  elapsed_ms: Date.now() - startTime,
                  detail:
                    "The handoff is too large for a single 'full' call. Use the analyze+execute pattern instead.",
                  plan: planOutput,
                  before_size_bytes: beforeSize,
                  reduction_percent: reductionPercent,
                },
                null,
                2,
              ),
            }],
            isError: true,
          };
        }

        if (actions.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(
                {
                  project: project_slug,
                  action: "full",
                  before_size_bytes: beforeSize,
                  after_size_bytes: beforeSize,
                  reduction_percent: 0,
                  actions_executed: 0,
                  actions_total: 0,
                  elapsed_ms: Date.now() - startTime,
                  timed_out: false,
                  warnings: [
                    "No scalable content identified. Handoff may already be optimally sized.",
                  ],
                },
                null,
                2,
              ),
            }],
          };
        }

        // Execute the scaling
        const { updatedHandoff, pushResults, timed_out } = await executeScaling(
          project_slug,
          handoff.content,
          actions,
          extra,
          progressToken,
          startTime,
        );

        // Stage 6: Push updated handoff
        await sendProgress(extra, progressToken, 6, "Pushing updated handoff...");
        logger.info("scale: stage 6 — push handoff", { elapsed_ms: Date.now() - startTime });

        const handoffPush = await pushFile(
          project_slug,
          "handoff.md",
          updatedHandoff,
          "prism: scale handoff",
        );
        pushResults.push({ path: "handoff.md", success: handoffPush.success });

        const afterSize = new TextEncoder().encode(updatedHandoff).length;
        const reductionPercent =
          beforeSize > 0 ? Math.round(((beforeSize - afterSize) / beforeSize) * 100) : 0;

        const totalMs = Date.now() - startTime;
        logger.info("scale: full complete", {
          project_slug,
          beforeKB: (beforeSize / 1024).toFixed(1),
          afterKB: (afterSize / 1024).toFixed(1),
          reductionPercent,
          ms: totalMs,
        });

        const warnings = pushResults
          .filter((r) => !r.success)
          .map((r) => `Failed to push ${r.path}`);
        if (timed_out) {
          warnings.push(
            "Operation exceeded 50s safety timeout. Some actions may not have executed. Re-run to complete remaining actions.",
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                project: project_slug,
                action: "full",
                before_size_bytes: beforeSize,
                after_size_bytes: afterSize,
                reduction_percent: reductionPercent,
                actions_executed: actions.filter((a) => a.executed).length,
                actions_total: actions.length,
                push_results: pushResults,
                elapsed_ms: totalMs,
                timed_out,
                warnings,
              },
              null,
              2,
            ),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const totalMs = Date.now() - startTime;

        // Determine which stage failed based on elapsed time and action
        let stage = "unknown";
        if (totalMs < 5000) stage = "fetch_handoff";
        else if (totalMs < 15000) stage = "analyze_sections";
        else if (totalMs < 30000) stage = "fetch_living_documents";
        else stage = "push_files";

        logger.error("prism_scale_handoff failed", {
          project_slug,
          action,
          error: message,
          stage,
          elapsed_ms: totalMs,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Scale operation failed",
              stage,
              elapsed_ms: totalMs,
              detail: message,
              project: project_slug,
              action,
              partial_results: null,
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
