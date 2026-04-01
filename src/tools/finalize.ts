/**
 * prism_finalize tool — Execute PRISM finalization in 2 tool calls instead of 13-16.
 * Phase 1 (audit): Fetch all living documents, detect drift, audit session work products.
 * Phase 2 (commit): Backup handoff, validate, push all files, verify.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
  fetchFiles,
  pushFile,
  listDirectory,
  listCommits,
  getCommit,
  deleteFile,
} from "../github/client.js";
import { LIVING_DOCUMENTS, SYNTHESIS_ENABLED } from "../config.js";
import { logger } from "../utils/logger.js";
import { extractHeaders, extractSection, parseNumberedList } from "../utils/summarizer.js";
import { parseHandoffVersion } from "../validation/handoff.js";
import { validateFile } from "../validation/index.js";
import { parseMarkdownTable } from "../utils/summarizer.js";
import { generateIntelligenceBrief } from "../ai/synthesize.js";
import { FINALIZATION_DRAFT_PROMPT, buildFinalizationDraftMessage } from "../ai/prompts.js";
import { synthesize } from "../ai/client.js";

/**
 * Audit phase — fetch all living documents and return structured audit data.
 */
async function auditPhase(projectSlug: string, sessionNumber: number) {
  const warnings: string[] = [];

  // 1. Fetch all 8 living documents in parallel
  const docMap = await fetchFiles(projectSlug, [...LIVING_DOCUMENTS]);

  const livingDocuments = LIVING_DOCUMENTS.map((doc) => {
    const fileResult = docMap.get(doc);
    if (!fileResult) {
      return {
        file: doc,
        exists: false,
        size_bytes: 0,
        header_line: "",
        eof_valid: false,
        section_headers: [] as string[],
        needs_creation: true,
      };
    }

    const lines = fileResult.content.split("\n");
    const headerLine = lines[0] ?? "";
    // Files ending with trailing newline (standard) produce empty last element.
    // trimEnd() before splitting ensures we check the actual last content line.
    const lastLine = fileResult.content.trimEnd().split("\n").pop()?.trim() ?? "";
    const filename = doc.split("/").pop() ?? doc;
    const eofValid = lastLine === `<!-- EOF: ${filename} -->`;
    const sectionHeaders = extractHeaders(fileResult.content);

    return {
      file: doc,
      exists: true,
      size_bytes: fileResult.size,
      header_line: headerLine,
      eof_valid: eofValid,
      section_headers: sectionHeaders,
      needs_creation: false,
    };
  });

  // 2. Drift detection — compare current handoff with previous version
  let driftDetection = {
    critical_context_changed: false,
    changed_items: [] as string[],
    decision_count_current: 0,
    decision_count_previous: 0,
    new_decisions_detected: [] as string[],
  };

  const handoffResult = docMap.get("handoff.md");
  const currentCriticalContext = handoffResult
    ? parseNumberedList(extractSection(handoffResult.content, "Critical Context") ?? "")
    : [];

  // Count current decisions
  const decisionResult = docMap.get("decisions/_INDEX.md");
  if (decisionResult) {
    const rows = parseMarkdownTable(decisionResult.content);
    driftDetection.decision_count_current = rows.length;
  }

  // Try to fetch previous handoff from handoff-history/
  try {
    const historyEntries = await listDirectory(projectSlug, "handoff-history");
    const handoffFiles = historyEntries
      .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (handoffFiles.length > 0) {
      const previousHandoff = await fetchFile(projectSlug, handoffFiles[0].path);
      const previousCriticalContext = parseNumberedList(
        extractSection(previousHandoff.content, "Critical Context") ?? ""
      );

      // Compare critical context items
      const currentSet = new Set(currentCriticalContext);
      const previousSet = new Set(previousCriticalContext);

      for (const item of previousCriticalContext) {
        if (!currentSet.has(item)) {
          driftDetection.changed_items.push(`Removed: ${item}`);
          driftDetection.critical_context_changed = true;
        }
      }
      for (const item of currentCriticalContext) {
        if (!previousSet.has(item)) {
          driftDetection.changed_items.push(`Added: ${item}`);
          driftDetection.critical_context_changed = true;
        }
      }

      // Count previous decisions
      const previousDecisionSection = extractSection(previousHandoff.content, "Decision");
      if (previousDecisionSection) {
        const prevDecisionRefs = previousDecisionSection.match(/D-\d+/g) ?? [];
        driftDetection.decision_count_previous = new Set(prevDecisionRefs).size;
      }
    }
  } catch {
    warnings.push("Could not fetch handoff history for drift detection.");
  }

  // Detect new decisions by comparing counts
  if (decisionResult && driftDetection.decision_count_previous > 0) {
    const rows = parseMarkdownTable(decisionResult.content);
    const idKey = Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "id") ?? "ID";
    const sessionKey =
      Object.keys(rows[0] ?? {}).find((k) => k.toLowerCase() === "session") ?? "Session";

    for (const row of rows) {
      const sessionVal = parseInt(row[sessionKey] ?? "0", 10);
      if (sessionVal >= sessionNumber) {
        driftDetection.new_decisions_detected.push(row[idKey] ?? "");
      }
    }
  }

  // 3. Session work products — commits since last finalization
  let sessionWorkProducts = {
    files_pushed_this_session: [] as string[],
    commit_count: 0,
  };

  try {
    const commits = await listCommits(projectSlug, { per_page: 50 });

    // Find commits since last finalization
    const sessionCommits: typeof commits = [];
    for (const commit of commits) {
      if (commit.message.startsWith("prism: finalize session")) {
        break; // Hit the previous finalization
      }
      sessionCommits.push(commit);
    }

    // Need to fetch individual commits for file details since list endpoint doesn't include them
    const filesSet = new Set<string>();
    await Promise.allSettled(
      sessionCommits.slice(0, 20).map(async (c) => {
        try {
          const detail = await getCommit(projectSlug, c.sha);
          for (const f of detail.files) {
            filesSet.add(f);
          }
        } catch {
          // Skip commits we can't fetch details for
        }
      })
    );

    sessionWorkProducts = {
      files_pushed_this_session: Array.from(filesSet),
      commit_count: sessionCommits.length,
    };
  } catch {
    warnings.push("Could not fetch commit history for session work product audit.");
  }

  // 4. Check if handoff backup exists
  let handoffBackupExists = false;
  const currentVersion = handoffResult ? (parseHandoffVersion(handoffResult.content) ?? 0) : 0;

  try {
    const historyEntries = await listDirectory(projectSlug, "handoff-history");
    handoffBackupExists = historyEntries.some(
      (e) => e.name.includes(`handoff_v${currentVersion}`)
    );
  } catch {
    // handoff-history directory may not exist
  }

  return {
    project: projectSlug,
    session_number: sessionNumber,
    audit: {
      living_documents: livingDocuments,
      drift_detection: driftDetection,
      session_work_products: sessionWorkProducts,
      handoff_backup_exists: handoffBackupExists,
      current_handoff_version: currentVersion,
      warnings,
    },
  };
}

/**
 * Draft phase — use Opus 4.6 to generate finalization file drafts.
 * Returns structured content for Claude to review before commit.
 */
async function draftPhase(projectSlug: string, sessionNumber: number) {
  if (!SYNTHESIS_ENABLED) {
    return {
      success: false,
      error: "Draft generation requires ANTHROPIC_API_KEY — synthesis disabled on server.",
      fallback: "Compose finalization files manually.",
    };
  }

  // 1. Fetch all living documents
  const docMap = await fetchFiles(projectSlug, [...LIVING_DOCUMENTS]);

  // 2. Collect commit history for this session
  const sessionCommits: string[] = [];
  try {
    const commits = await listCommits(projectSlug, { per_page: 50 });
    for (const commit of commits) {
      if (commit.message.startsWith("prism: finalize session")) break;
      sessionCommits.push(commit.message);
    }
  } catch {
    // Non-critical — drafts will be less informed but still useful
  }

  // 3. Build prompt and call Opus 4.6
  const userMessage = buildFinalizationDraftMessage(
    projectSlug,
    sessionNumber,
    docMap,
    sessionCommits
  );

  logger.info("Finalization draft: calling Opus", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
  });

  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096);

  if (!result) {
    return {
      success: false,
      error: "Opus API call failed or returned null.",
      fallback: "Compose finalization files manually.",
    };
  }

  // 4. Parse response — expect JSON
  try {
    const clean = result.content.replace(/```json\n?|```\n?/g, "").trim();
    const drafts = JSON.parse(clean);

    return {
      success: true,
      drafts,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      review_instructions: "Review each draft section. Edit as needed, then include in your commit files. These are drafts — you have full editorial control.",
    };
  } catch {
    return {
      success: true,
      raw_content: result.content,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      parse_warning: "Could not parse structured JSON — raw content included for manual extraction.",
    };
  }
}

/**
 * Commit phase — backup handoff, validate, push all files, verify.
 */
async function commitPhase(
  projectSlug: string,
  sessionNumber: number,
  handoffVersion: number,
  files: Array<{ path: string; content: string }>
) {
  const warnings: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // 1. Backup current handoff to handoff-history/
  let backupPath = "";
  try {
    const currentHandoff = await fetchFile(projectSlug, "handoff.md");
    const currentVersion = parseHandoffVersion(currentHandoff.content) ?? handoffVersion - 1;
    backupPath = `handoff-history/handoff_v${currentVersion}_${today}.md`;

    await pushFile(
      projectSlug,
      backupPath,
      currentHandoff.content,
      `prism: handoff-backup v${currentVersion}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!msg.includes("Not found")) {
      warnings.push(`Failed to backup current handoff: ${msg}`);
    }
  }

  // 2. Prune handoff-history to keep only last 3 versions
  try {
    const historyEntries = await listDirectory(projectSlug, "handoff-history");
    const handoffFiles = historyEntries
      .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (handoffFiles.length > 3) {
      const toDelete = handoffFiles.slice(3);
      await Promise.allSettled(
        toDelete.map((f) =>
          deleteFile(projectSlug, f.path, `chore: prune old handoff backup ${f.name}`)
        )
      );
    }
  } catch {
    // handoff-history may not exist or pruning failed — non-critical
  }

  // 3. Validate all files
  const validationResults = files.map((file) => {
    const result = validateFile(file.path, file.content);
    return { path: file.path, ...result };
  });

  const hasValidationErrors = validationResults.some((r) => r.errors.length > 0);
  if (hasValidationErrors) {
    return {
      project: projectSlug,
      session_number: sessionNumber,
      handoff_version: handoffVersion,
      backup_created: backupPath,
      results: validationResults.map((r) => ({
        path: r.path,
        success: false,
        size_bytes: 0,
        verified: false,
        validation_errors: r.errors,
      })),
      living_documents_updated: 0,
      all_succeeded: false,
      confirmation: `Session ${sessionNumber} finalization FAILED — validation errors detected.`,
    };
  }

  // 4. Push all files in parallel
  const pushResults = await Promise.allSettled(
    files.map(async (file) => {
      const message = file.path === "handoff.md"
        ? `prism: finalize session ${sessionNumber} [${today}]`
        : `prism: artifact ${file.path.split("/").pop()}`;

      const result = await pushFile(projectSlug, file.path, file.content, message);

      // 5. Verify push
      let verified = false;
      if (result.success) {
        try {
          const verifyResult = await fetchFile(projectSlug, file.path);
          verified = verifyResult.sha === result.sha;
        } catch {
          verified = false;
        }
      }

      return {
        path: file.path,
        success: result.success,
        size_bytes: result.size,
        verified,
        validation_errors: [] as string[],
      };
    })
  );

  const results = pushResults.map((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    return {
      path: files[idx].path,
      success: false,
      size_bytes: 0,
      verified: false,
      validation_errors: [outcome.reason?.message ?? "Unknown push error"],
    };
  });

  const succeeded = results.filter((r) => r.success);
  const livingDocsUpdated = results.filter((r) =>
    r.success && LIVING_DOCUMENTS.some((ld) => r.path === ld || r.path.endsWith(ld))
  ).length;

  const allSucceeded = succeeded.length === files.length;

  // Fire-and-forget synthesis after successful commit (D-44 Track 2)
  if (allSucceeded && SYNTHESIS_ENABLED) {
    generateIntelligenceBrief(projectSlug, sessionNumber)
      .then(synthResult => {
        logger.info("Post-finalization synthesis complete", {
          projectSlug,
          sessionNumber,
          success: synthResult.success,
          tokens: synthResult.input_tokens,
        });
      })
      .catch(err => {
        logger.error("Post-finalization synthesis failed", {
          projectSlug,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return {
    project: projectSlug,
    session_number: sessionNumber,
    handoff_version: handoffVersion,
    backup_created: backupPath,
    results,
    living_documents_updated: livingDocsUpdated,
    all_succeeded: allSucceeded,
    synthesis_triggered: allSucceeded && SYNTHESIS_ENABLED,
    confirmation: allSucceeded
      ? `Session ${sessionNumber} finalized. Handoff v${handoffVersion} pushed and verified. ${livingDocsUpdated}/${LIVING_DOCUMENTS.length} living documents updated.`
      : `Session ${sessionNumber} finalization partially failed. ${succeeded.length}/${files.length} files pushed.`,
  };
}

/**
 * Register the prism_finalize tool on an MCP server instance.
 */
export function registerFinalize(server: McpServer): void {
  // Use a discriminated union via z.union for the two phases
  const auditSchema = {
    project_slug: z.string().describe("Project repo name"),
    action: z.literal("audit").describe("Phase 1: audit living documents and detect drift"),
    session_number: z.number().describe("Current session number for staleness detection"),
  };

  const commitSchema = {
    project_slug: z.string().describe("Project repo name"),
    action: z.literal("commit").describe("Phase 2: push all finalization files"),
    session_number: z.number().describe("Current session number"),
    handoff_version: z.number().optional().describe("New handoff version number"),
    files: z
      .array(
        z.object({
          path: z.string().describe("File path relative to repo root"),
          content: z.string().describe("File content to push"),
        })
      )
      .optional()
      .describe("All files to push — handoff, session-log, task-queue, and any others updated"),
  };

  // Register with combined schema supporting both phases
  server.tool(
    "prism_finalize",
    'Execute PRISM finalization. Use action:"audit" to fetch all living documents and detect drift. Use action:"commit" to push all composed content with backup and validation.',
    {
      project_slug: z.string().describe("Project repo name"),
      action: z.enum(["audit", "draft", "commit"]).describe("Finalization phase: 'audit' for document inventory, 'draft' for AI-generated file drafts, 'commit' to push final files"),
      session_number: z.number().describe("Current session number"),
      handoff_version: z.number().optional().describe("New handoff version (commit phase only)"),
      files: z
        .array(
          z.object({
            path: z.string().describe("File path relative to repo root"),
            content: z.string().describe("File content to push"),
          })
        )
        .optional()
        .describe("Files to push (commit phase only)"),
    },
    async ({ project_slug, action, session_number, handoff_version, files }) => {
      const start = Date.now();
      logger.info("prism_finalize", { project_slug, action, session_number });

      try {
        if (action === "audit") {
          const result = await auditPhase(project_slug, session_number);
          logger.info("prism_finalize audit complete", {
            project_slug,
            ms: Date.now() - start,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        if (action === "draft") {
          const result = await draftPhase(project_slug, session_number);
          logger.info("prism_finalize draft complete", {
            project_slug,
            success: result.success,
            ms: Date.now() - start,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Commit phase
        if (!files || files.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Commit phase requires files array with at least one file.",
                  project: project_slug,
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await commitPhase(
          project_slug,
          session_number,
          handoff_version ?? 1,
          files
        );

        logger.info("prism_finalize commit complete", {
          project_slug,
          allSucceeded: result.all_succeeded,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_finalize failed", { project_slug, action, error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, project: project_slug }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
