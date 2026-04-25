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
} from "../github/client.js";
import { safeMutation } from "../utils/safe-mutation.js";
import {
  LIVING_DOCUMENTS,
  LIVING_DOCUMENT_NAMES,
  SYNTHESIS_ENABLED,
  SERVER_VERSION,
  FRAMEWORK_REPO,
  MCP_SAFE_TIMEOUT,
  FINALIZE_COMMIT_DEADLINE_MS,
  FINALIZE_DRAFT_TIMEOUT_MS,
  FINALIZE_DRAFT_DEADLINE_MS,
  DOC_ROOT,
} from "../config.js";
import { splitForArchive, type ArchiveConfig } from "../utils/archive.js";

/** Sentinel used to signal that the finalize-commit deadline fired (S40 C4). */
const FINALIZE_COMMIT_DEADLINE_SENTINEL = Symbol("finalize.commit.deadline");

/** Sentinel used to signal that the finalize-draft deadline fired (S41). */
const FINALIZE_DRAFT_DEADLINE_SENTINEL = Symbol("finalize.draft.deadline");

/** Archive lifecycle configs (S40 FINDING-14). Applied during commitPhase
 *  before the atomic commit so live + archive changes land together. */
const SESSION_LOG_ARCHIVE_CONFIG: ArchiveConfig = {
  thresholdBytes: 15_000,
  retentionCount: 20,
  entryMarker: /^### Session (\d+)/m,
  archiveHeader:
    "# Session Log Archive — PRISM Framework\n\n" +
    "> Archived sessions moved here during finalization when session-log.md exceeds 15KB.\n" +
    "> Archives are NEVER read by synthesis.\n",
  mostRecentAt: "top",
};

const INSIGHTS_ARCHIVE_CONFIG: ArchiveConfig = {
  thresholdBytes: 20_000,
  retentionCount: 15,
  entryMarker: /^### INS-(\d+):/m,
  protectedMarkers: ["STANDING RULE"],
  activeSection: "## Active",
  archiveHeader:
    "# Insights Archive — PRISM Framework\n\n" +
    "> Archived insights moved here during finalization when insights.md exceeds 20KB.\n" +
    "> Only non-STANDING-RULE insights are archived.\n" +
    "> Archives are NEVER read by synthesis.\n\n" +
    "## Archived\n",
  mostRecentAt: "bottom",
};

/** Suffix identifying archive files. Used to exclude archives from synthesis input. */
export const ARCHIVE_FILE_SUFFIX = "-archive.md";

/**
 * Documents included in the draft-phase synthesis input.
 *
 * Invariant: archives MUST NOT be synthesis input. They are cold storage.
 * Synthesis cost scales with input size (S40 FINDING-14) — adding archive
 * files here would regress the whole reason archiving exists.
 */
export const DRAFT_RELEVANT_DOCS = LIVING_DOCUMENT_NAMES.filter(
  d =>
    d !== "architecture.md" &&
    d !== "glossary.md" &&
    d !== "intelligence-brief.md" &&
    !d.endsWith(ARCHIVE_FILE_SUFFIX),
);
import { resolveDocPath, resolveDocPushPath, resolveDocFiles } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { logger } from "../utils/logger.js";
import { extractHeaders, extractSection, parseNumberedList } from "../utils/summarizer.js";
import { parseHandoffVersion } from "../validation/handoff.js";
import { validateFile } from "../validation/index.js";
import { parseMarkdownTable } from "../utils/summarizer.js";
import { generateIntelligenceBrief } from "../ai/synthesize.js";
import { escapeHtml, stripMarkdown, formatResumptionHtml, toolIcon, generateCstTimestamp } from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";

/**
 * Robust JSON extraction from AI responses (B.8).
 * Tries multiple strategies: direct parse, fence stripping, brace extraction.
 */
export function extractJSON(text: string): unknown {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch { /* continue */ }
  // Strip markdown fences
  const fenceStripped = text.replace(/```(?:json)?\s*\n?/g, "").trim();
  try { return JSON.parse(fenceStripped); } catch { /* continue */ }
  // Find first { and last }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* continue */ }
  }
  // Try array extraction
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.slice(firstBracket, lastBracket + 1)); } catch { /* continue */ }
  }
  throw new Error("Failed to extract JSON from AI response");
}
import { FINALIZATION_DRAFT_PROMPT, buildFinalizationDraftMessage } from "../ai/prompts.js";
import { synthesize } from "../ai/client.js";

/**
 * Audit phase — fetch all living documents and return structured audit data.
 */
async function auditPhase(projectSlug: string, sessionNumber: number) {
  const warnings: string[] = [];

  // Cache handoff-history listing — used by both drift detection and backup check
  let cachedHistoryEntries: Awaited<ReturnType<typeof listDirectory>> | null = null;
  async function getHistoryEntries(): Promise<Awaited<ReturnType<typeof listDirectory>>> {
    if (cachedHistoryEntries !== null) return cachedHistoryEntries;
    cachedHistoryEntries = await listDirectory(projectSlug, ".prism/handoff-history");
    if (cachedHistoryEntries.length === 0) {
      cachedHistoryEntries = await listDirectory(projectSlug, "handoff-history");
    }
    return cachedHistoryEntries;
  }

  // 1. Fetch all 10 living documents in parallel with backward-compatible resolution
  const docMap = await resolveDocFiles(projectSlug, [...LIVING_DOCUMENT_NAMES]);

  const livingDocuments = LIVING_DOCUMENT_NAMES.map((doc) => {
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

  // Try to fetch previous handoff from handoff-history/ (D-67: check .prism/ first)
  try {
    const historyEntries = await getHistoryEntries();
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
      sessionCommits.slice(0, 5).map(async (c) => {
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
    const historyEntries = await getHistoryEntries();
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

  // 1. Fetch only draft-relevant living documents (skip architecture.md and glossary.md —
  //    they're large and irrelevant to session log / handoff / task queue drafting).
  //    Archive files are also excluded — synthesis must never read cold storage (FINDING-14).
  const docMap = await resolveDocFiles(projectSlug, [...DRAFT_RELEVANT_DOCS]);

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

  // Calculate total doc size for timeout scaling
  let totalDocBytes = 0;
  for (const [, doc] of docMap) {
    totalDocBytes += new TextEncoder().encode(doc.content).length;
  }

  // S41 — single env-configurable timeout. The prior size-branching was
  // vestigial (both branches aimed under a 50s MCP_SAFE_TIMEOUT ceiling that
  // no longer matches empirical client timeout behavior).
  const draftTimeoutMs = FINALIZE_DRAFT_TIMEOUT_MS;

  logger.info("Finalization draft: calling Opus", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
    totalDocKB: (totalDocBytes / 1024).toFixed(1),
    timeoutMs: draftTimeoutMs,
  });

  const result = await synthesize(
    FINALIZATION_DRAFT_PROMPT,
    userMessage,
    4096,
    draftTimeoutMs,
    0, // maxRetries — retry storms on draft are worse than fast failure (S41)
  );

  if (!result.success) {
    return {
      success: false,
      error: `Opus API call failed: ${result.error} (${result.error_code})`,
      fallback: "Compose finalization files manually.",
    };
  }

  // 4. Parse response — expect JSON (B.8: robust extraction)
  try {
    const drafts = extractJSON(result.content);

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
  files: Array<{ path: string; content: string }>,
  skipSynthesis: boolean = false,
  diagnostics: DiagnosticsCollector = new DiagnosticsCollector(),
) {
  const warnings: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // 1 & 2. Backup current handoff and prune old versions — run in parallel
  const [backupOutcome, pruneOutcome] = await Promise.allSettled([
    // 1. Backup
    (async () => {
      try {
        const currentHandoff = await resolveDocPath(projectSlug, "handoff.md");
        const currentVersion = parseHandoffVersion(currentHandoff.content) ?? handoffVersion - 1;

        // Skip auto-backup if operator already provided one for this version.
        // Prevents duplicate backup files when the operator crafts their own
        // handoff-history entry in the files array.
        const operatorBackupRe = new RegExp(
          `handoff-history/handoff_v${currentVersion}_.*\\.md$`,
        );
        if (files.some(f => operatorBackupRe.test(f.path))) {
          logger.info("auto-backup skipped — operator provided backup in files array", {
            projectSlug,
            outgoingVersion: currentVersion,
          });
          return "";
        }

        const historyBase = currentHandoff.legacy ? "handoff-history" : ".prism/handoff-history";
        const rawBackupPath = `${historyBase}/handoff_v${currentVersion}_${today}.md`;
        const guardedBackup = await guardPushPath(projectSlug, rawBackupPath);
        const backupPath = guardedBackup.path;

        // Replace EOF sentinel to match destination filename (INS-14).
        // The source handoff ends with <!-- EOF: handoff.md --> but the backup
        // file has a versioned name, so the sentinel must be rewritten.
        const backupBasename = backupPath.split("/").pop() ?? backupPath;
        const backupContent = currentHandoff.content.replace(
          /<!-- EOF: handoff\.md -->\s*$/,
          `<!-- EOF: ${backupBasename} -->`,
        );

        await pushFile(
          projectSlug,
          backupPath,
          backupContent,
          `prism: handoff-backup v${currentVersion}`
        );
        return backupPath;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("Not found")) {
          warnings.push(`Failed to backup current handoff: ${msg}`);
        }
        return "";
      }
    })(),

    // 2. Prune handoff-history to keep only last 3 versions.
    //    Migrated to safeMutation per S62 audit (Phase 1 Brief 1, Change 5):
    //    a single atomic commit with `deletes` replaces the parallel
    //    Contents-API DELETE loop that previously raced HEAD on every
    //    successful delete. Failures are emitted as DELETE_FILE_FAILED
    //    instead of being silently swallowed; pruning is still non-fatal.
    (async () => {
      let historyEntries: Awaited<ReturnType<typeof listDirectory>>;
      try {
        historyEntries = await listDirectory(projectSlug, ".prism/handoff-history");
        if (historyEntries.length === 0) {
          historyEntries = await listDirectory(projectSlug, "handoff-history");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          "DELETE_FILE_FAILED",
          `Failed to list handoff-history for pruning: ${msg}`,
          { phase: "list" },
        );
        return;
      }

      const handoffFiles = historyEntries
        .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
        .sort((a, b) => b.name.localeCompare(a.name));

      if (handoffFiles.length <= 3) return;

      const toDelete = handoffFiles.slice(3);
      const pruneResult = await safeMutation({
        repo: projectSlug,
        commitMessage: `chore: prune ${toDelete.length} old handoff backup${toDelete.length === 1 ? "" : "s"}`,
        readPaths: [],
        diagnostics,
        computeMutation: () => ({
          writes: [],
          deletes: toDelete.map((f) => f.path),
        }),
      });

      if (!pruneResult.ok) {
        diagnostics.warn(
          "DELETE_FILE_FAILED",
          `Failed to prune handoff-history: ${pruneResult.error}`,
          { code: pruneResult.code, pathCount: toDelete.length },
        );
      }
    })(),
  ]);

  const backupPath = backupOutcome.status === "fulfilled" ? backupOutcome.value : "";

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

  // 3b. Archive lifecycle (S40 FINDING-14).
  // Apply size-triggered archiving to session-log.md and insights.md BEFORE the
  // atomic commit so live + archive changes land in a single commit. Fail-open:
  // any error is logged and skipped — a finalize that commits the live docs
  // without archiving is still a success.
  async function applyArchive(
    liveFileName: string,
    archiveFileName: string,
    config: ArchiveConfig,
  ): Promise<void> {
    try {
      const liveIdx = files.findIndex(
        f => f.path === liveFileName || f.path === `${DOC_ROOT}/${liveFileName}`,
      );
      if (liveIdx === -1) return; // Not being written this session — nothing to do

      let existingArchive: string | null = null;
      try {
        const archivePath = `${DOC_ROOT}/${archiveFileName}`;
        const fetched = await fetchFile(projectSlug, archivePath);
        existingArchive = fetched.content;
      } catch {
        existingArchive = null; // First-time archive
      }

      const result = splitForArchive(files[liveIdx].content, existingArchive, config);

      if (result.archiveContent !== null && result.archivedCount > 0) {
        files[liveIdx] = { ...files[liveIdx], content: result.liveContent };
        files.push({
          path: `${DOC_ROOT}/${archiveFileName}`,
          content: result.archiveContent,
        });
        logger.info("archive applied", {
          projectSlug,
          live: liveFileName,
          archive: archiveFileName,
          archivedCount: result.archivedCount,
          liveSizeBytes: result.liveContent.length,
        });
      } else if (result.skipReason) {
        logger.debug("archive skipped", {
          projectSlug,
          live: liveFileName,
          reason: result.skipReason,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("archive processing failed — continuing without archiving", {
        projectSlug,
        live: liveFileName,
        archive: archiveFileName,
        err: msg,
      });
    }
  }

  await applyArchive("session-log.md", "session-log-archive.md", SESSION_LOG_ARCHIVE_CONFIG);
  await applyArchive("insights.md", "insights-archive.md", INSIGHTS_ARCHIVE_CONFIG);

  // 4. Guard all paths against root-level duplication (D-67 addendum)
  const guardResults = await Promise.all(
    files.map(file => guardPushPath(projectSlug, file.path))
  );

  // 5. Push all files via safeMutation (S64 Phase 1 Brief 1.5).
  //    safeMutation handles: HEAD snapshot, atomic Git Trees commit, 409
  //    retry with refreshed content, null-safe HEAD comparison.
  //    Atomic-only by design (S62 audit Verdict C).
  const guardedFiles = files.map((file, idx) => ({
    path: guardResults[idx].path,
    content: file.content,
  }));

  const isHandoff = files.some(f => f.path === "handoff.md" || f.path === ".prism/handoff.md");
  const commitMessage = isHandoff
    ? `prism: finalize session ${sessionNumber} [${today}]`
    : `prism: session ${sessionNumber} artifacts`;

  const safeMutationResult = await safeMutation({
    repo: projectSlug,
    commitMessage,
    readPaths: [],
    diagnostics,
    computeMutation: () => ({ writes: guardedFiles }),
  });

  let results: Array<{
    path: string;
    success: boolean;
    size_bytes: number;
    verified: boolean;
    validation_errors: string[];
  }>;

  if (safeMutationResult.ok) {
    results = guardedFiles.map(f => ({
      path: f.path,
      success: true,
      size_bytes: new TextEncoder().encode(f.content).length,
      verified: true,
      validation_errors: [],
    }));
  } else {
    warnings.push(`Atomic commit failed: ${safeMutationResult.error}`);
    results = guardedFiles.map(f => ({
      path: f.path,
      success: false,
      size_bytes: 0,
      verified: false,
      validation_errors: ["Atomic commit failed", safeMutationResult.error],
    }));
  }

  const succeeded = results.filter((r) => r.success);
  const livingDocsUpdated = results.filter((r) =>
    r.success && LIVING_DOCUMENTS.some((ld) => r.path === ld || r.path.endsWith(ld))
  ).length;

  const allSucceeded = succeeded.length === files.length;

  // Synthesis after successful commit (D-78, FINDING-5) — fire-and-forget.
  // Synthesis takes 60-100s on mature projects, which exceeds the MCP client timeout
  // (~60s). Blocking the commit response on synthesis caused apparent hangs in the
  // claude.ai UI. We now return immediately and let synthesis complete in the
  // background; operators check status via `prism_synthesize mode=status` or see
  // the refreshed brief on the next bootstrap.
  let synthesisOutcome: "completed" | "timed_out" | "skipped" | "background";
  let synthesisStatusHint: string | null = null;

  if (skipSynthesis) {
    synthesisOutcome = "skipped";
    logger.info("Synthesis: skipped", { projectSlug });
  } else if (allSucceeded && SYNTHESIS_ENABLED) {
    synthesisOutcome = "background";
    synthesisStatusHint =
      "Synthesis running in background. Check via prism_synthesize mode=status or wait for next session bootstrap.";
    const synthStart = Date.now();
    // Fire synthesis in background; do not await. Failures are logged but do not
    // affect the commit response (which has already been constructed by the time
    // this resolves).
    void generateIntelligenceBrief(projectSlug, sessionNumber)
      .then((result) => {
        logger.info("background synthesis complete", {
          projectSlug,
          sessionNumber,
          success: result.success ?? false,
          durationMs: Date.now() - synthStart,
        });
      })
      .catch((err) => {
        logger.error("background synthesis failed", {
          projectSlug,
          sessionNumber,
          err: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - synthStart,
        });
      });
  } else {
    // Commit did not fully succeed, or synthesis is disabled on this server.
    synthesisOutcome = "skipped";
  }

  return {
    project: projectSlug,
    session_number: sessionNumber,
    handoff_version: handoffVersion,
    backup_created: backupPath,
    results,
    living_documents_updated: livingDocsUpdated,
    all_succeeded: allSucceeded,
    synthesis_outcome: synthesisOutcome,
    synthesis_banner_html: null as string | null,
    synthesis_warning: null as string | null,
    synthesis_status_hint: synthesisStatusHint,
    confirmation: allSucceeded
      ? `Session ${sessionNumber} finalized. Handoff v${handoffVersion} pushed and verified. ${livingDocsUpdated}/${LIVING_DOCUMENTS.length} living documents updated.${synthesisOutcome === "background" ? " Intelligence brief synthesizing in background." : synthesisOutcome === "skipped" ? " Synthesis skipped." : ""}`
      : `Session ${sessionNumber} finalization partially failed. ${succeeded.length}/${files.length} files pushed.`,
  };
}

/**
 * Render a finalization banner as self-contained HTML+CSS.
 * Mirrors boot banner architecture (D-35) with red accent and commit-specific data.
 */
function renderFinalizationBanner(data: {
  version: string;
  session: number;
  timestamp: string;
  handoff_version: number;
  handoff_status: "ok" | "warn";
  handoff_label: string;
  docs_updated: number;
  docs_total: number;
  decisions_count: number;
  decisions_note: string;
  steps: Array<{ label: string; status: "ok" | "warn" | "critical" }>;
  resumption: string;
  deliverables: Array<{ text: string; status: "ok" | "warn" }>;
  warnings: string[];
  errors: string[];
}): string {
  const e = (s: string) => escapeHtml(stripMarkdown(s));

  const resumptionHtml = formatResumptionHtml(data.resumption);

  const stepsHtml = data.steps
    .map((s) => {
      const cls = s.status !== "ok" ? ` ${s.status}` : "";
      return `<div class="bn-tool${cls}">${toolIcon(s.status)} ${e(s.label)}</div>`;
    })
    .join("\n      ");

  const deliverablesHtml = data.deliverables
    .map((d) => {
      const cls = d.status === "warn" ? " warn" : "";
      return `<div class="bn-step${cls}">\u25b8 ${e(d.text)}</div>`;
    })
    .join("\n        ");

  const warningsHtml = data.warnings
    .map((w) => `<div class="bn-alert warn">\u26a0 ${e(w)}</div>`)
    .join("\n    ");

  const errorsHtml = data.errors
    .map((err) => `<div class="bn-alert critical">\u2717 ${e(err)}</div>`)
    .join("\n    ");

  return `<style>
:root {
  --bn-bg: #1e1e2e;
  --bn-surface: #2a2a3e;
  --bn-border: #3a3a4e;
  --bn-text: #eee;
  --bn-text-muted: #aaa;
  --bn-accent-start: #dc2626;
  --bn-accent-end: #ef4444;
  --bn-ok: #22c55e;
  --bn-warn: #eab308;
  --bn-critical: #ef4444;
  --bn-info: #60a5fa;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
.bn { font-family: system-ui, -apple-system, sans-serif; background: var(--bn-bg); border-radius: 12px; border: 1px solid var(--bn-border); overflow: hidden; color: var(--bn-text); }
.bn-header { background: linear-gradient(90deg, var(--bn-accent-start), var(--bn-accent-end)); padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
.bn-header-text { display: flex; flex-direction: column; gap: 4px; }
.bn-version { font-size: 11px; font-weight: 600; letter-spacing: 1.5px; opacity: 0.8; color: white; }
.bn-title { font-size: 18px; font-weight: 700; color: white; }
.bn-badge { background: rgba(255,255,255,0.2); border-radius: 12px; padding: 4px 14px; font-size: 11px; font-weight: 600; color: white; white-space: nowrap; }
.bn-body { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.bn-timestamp { font-size: 12px; color: var(--bn-text-muted); }
.bn-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.bn-card { background: var(--bn-surface); border: 0.5px solid var(--bn-border); border-radius: 8px; padding: 12px 14px; }
.bn-card-label { font-size: 10px; font-weight: 500; color: var(--bn-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.bn-card-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.bn-card-sub { font-size: 12px; font-weight: 400; color: var(--bn-text-muted); margin-left: 4px; }
.bn-card-sub.ok { color: var(--bn-ok); font-weight: 600; }
.bn-card-sub.warn { color: var(--bn-warn); font-weight: 600; }
.bn-card-sub.critical { color: var(--bn-critical); font-weight: 600; }
.bn-toolbar { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--bn-surface); border-radius: 8px; overflow: hidden; }
.bn-tool { text-align: center; font-size: 12px; font-weight: 500; padding: 9px 8px; color: var(--bn-ok); border-right: 0.5px solid var(--bn-border); }
.bn-tool:last-child { border-right: none; }
.bn-tool.warn { color: var(--bn-warn); }
.bn-tool.critical { color: var(--bn-critical); }
.bn-section-label { font-size: 11px; font-weight: 600; letter-spacing: 1px; color: var(--bn-text-muted); text-transform: uppercase; margin-bottom: 6px; }
.bn-resumption { background: var(--bn-surface); border-radius: 8px; padding: 14px 18px; font-size: 12px; line-height: 1.7; color: var(--bn-text-muted); }
.bn-steps { display: flex; flex-direction: column; gap: 6px; }
.bn-step { font-size: 12px; line-height: 1.6; color: var(--bn-text); padding-left: 4px; }
.bn-step.warn { color: var(--bn-warn); }
.bn-alert { display: flex; align-items: flex-start; gap: 10px; border-radius: 8px; padding: 9px 16px; font-size: 12px; font-weight: 500; line-height: 1.5; }
.bn-alert.warn { background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); color: var(--bn-warn); }
.bn-alert.critical { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: var(--bn-critical); }
</style>

<div class="bn">
  <div class="bn-header">
    <div class="bn-header-text">
      <div class="bn-version">PRISM v${e(data.version)}</div>
      <div class="bn-title">Session ${data.session} \u2014 Finalized</div>
    </div>
    <div class="bn-badge">COMMITTED \u2713</div>
  </div>
  <div class="bn-body">
    <div class="bn-timestamp">${e(data.timestamp)} CST</div>
    <div class="bn-metrics">
      <div class="bn-card">
        <div class="bn-card-label">Session</div>
        <div class="bn-card-value">${data.session}</div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Handoff</div>
        <div class="bn-card-value">v${data.handoff_version} <span class="bn-card-sub ${data.handoff_status}">${e(data.handoff_label)}</span></div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Docs updated</div>
        <div class="bn-card-value">${data.docs_updated}/${data.docs_total}</div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Decisions</div>
        <div class="bn-card-value">${data.decisions_count} <span class="bn-card-sub">(${e(data.decisions_note)})</span></div>
      </div>
    </div>
    <div class="bn-toolbar">
      ${stepsHtml}
    </div>
    <div>
      <div class="bn-section-label">Resumption point</div>
      <div class="bn-resumption">${resumptionHtml}</div>
    </div>
    <div>
      <div class="bn-section-label">Deliverables</div>
      <div class="bn-steps">
        ${deliverablesHtml}
      </div>
    </div>
    ${warningsHtml}
    ${errorsHtml}
  </div>
</div>`;
}

/**
 * Register the prism_finalize tool on an MCP server instance.
 */
export function registerFinalize(server: McpServer): void {
  server.tool(
    "prism_finalize",
    "PRISM finalization. Actions: audit (document inventory + drift), draft (AI-generated files), commit (backup + push + validate).",
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
      skip_synthesis: z.boolean().optional().describe("Skip post-finalization synthesis (default: false)"),
      banner_data: z.object({
        deliverables: z.array(z.object({
          text: z.string(),
          status: z.enum(["ok", "warn"]),
        })).optional(),
        decisions_note: z.string().optional(),
        step_statuses: z.object({
          audit: z.enum(["ok", "warn", "critical"]).optional(),
          draft: z.enum(["ok", "warn", "critical"]).optional(),
          commit: z.enum(["ok", "warn", "critical"]).optional(),
          verified: z.enum(["ok", "warn", "critical"]).optional(),
        }).optional(),
      }).optional().describe("Optional banner customization data (commit phase only)"),
    },
    async ({ project_slug, action, session_number, handoff_version, files, skip_synthesis, banner_data }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_finalize", { project_slug, action, session_number });

      try {
        if (action === "audit") {
          const phaseStart = Date.now();
          const result = await auditPhase(project_slug, session_number);
          logger.info("prism_finalize audit timing", {
            projectSlug: project_slug,
            ms: Date.now() - phaseStart,
          });

          // ME-4: Fetch and prepend session-end rules (Rules 10-14)
          let sessionEndRules: string | null = null;
          try {
            const rulesFile = await fetchFile(FRAMEWORK_REPO, "_templates/rules-session-end.md");
            sessionEndRules = rulesFile.content;
          } catch {
            logger.warn("Could not fetch rules-session-end.md — session-end rules not delivered");
          }

          logger.info("prism_finalize audit complete", {
            project_slug,
            sessionEndRulesDelivered: !!sessionEndRules,
            ms: Date.now() - start,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ...result, session_end_rules: sessionEndRules, diagnostics: diagnostics.list() }) }],
          };
        }

        if (action === "draft") {
          const phaseStart = Date.now();

          let draftDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const draftDeadlinePromise = new Promise<typeof FINALIZE_DRAFT_DEADLINE_SENTINEL>((resolve) => {
            draftDeadlineTimer = setTimeout(
              () => resolve(FINALIZE_DRAFT_DEADLINE_SENTINEL),
              FINALIZE_DRAFT_DEADLINE_MS,
            );
          });
          const draftWork = draftPhase(project_slug, session_number);
          const raced = await Promise.race([draftWork, draftDeadlinePromise]);
          if (draftDeadlineTimer) clearTimeout(draftDeadlineTimer);

          if (raced === FINALIZE_DRAFT_DEADLINE_SENTINEL) {
            const deadlineSec = Math.round(FINALIZE_DRAFT_DEADLINE_MS / 1000);
            logger.error("prism_finalize draft deadline exceeded", {
              project_slug,
              deadlineMs: FINALIZE_DRAFT_DEADLINE_MS,
              elapsedMs: Date.now() - phaseStart,
            });
            diagnostics.error("SYNTHESIS_TIMEOUT", `Draft deadline exceeded (${deadlineSec}s)`, { deadlineMs: FINALIZE_DRAFT_DEADLINE_MS });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    project: project_slug,
                    action: "draft",
                    error: `prism_finalize draft deadline exceeded (${deadlineSec}s)`,
                    fallback: "Compose finalization files manually.",
                    diagnostics: diagnostics.list(),
                  }),
                },
              ],
              isError: true,
            };
          }
          const result = raced;

          logger.info("prism_finalize draft timing", {
            projectSlug: project_slug,
            ms: Date.now() - phaseStart,
          });
          logger.info("prism_finalize draft complete", {
            project_slug,
            success: result.success,
            ms: Date.now() - start,
          });
          if (!result.success) {
            diagnostics.warn("SYNTHESIS_SKIPPED", `Draft generation failed: ${(result as any).error ?? "unknown"}`, {});
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ...result, diagnostics: diagnostics.list() }) }],
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

        const phaseStart = Date.now();
        const skipSynthesis = skip_synthesis ?? false;

        // S40 C4 — Tool-level wall-clock deadline on the commit phase.
        // commitPhase does the GitHub I/O (backup, prune, atomic commit,
        // optional fallback pushes). If it hangs past the deadline, return
        // a structured error instead of waiting for the MCP client timeout.
        let commitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const commitDeadlinePromise = new Promise<typeof FINALIZE_COMMIT_DEADLINE_SENTINEL>((resolve) => {
          commitDeadlineTimer = setTimeout(
            () => resolve(FINALIZE_COMMIT_DEADLINE_SENTINEL),
            FINALIZE_COMMIT_DEADLINE_MS,
          );
        });
        const commitWork = commitPhase(
          project_slug,
          session_number,
          handoff_version ?? 1,
          files,
          skipSynthesis,
          diagnostics,
        );
        const raced = await Promise.race([commitWork, commitDeadlinePromise]);
        if (commitDeadlineTimer) clearTimeout(commitDeadlineTimer);

        if (raced === FINALIZE_COMMIT_DEADLINE_SENTINEL) {
          const deadlineSec = Math.round(FINALIZE_COMMIT_DEADLINE_MS / 1000);
          logger.error("prism_finalize commit deadline exceeded", {
            project_slug,
            deadlineMs: FINALIZE_COMMIT_DEADLINE_MS,
            elapsedMs: Date.now() - phaseStart,
          });
          diagnostics.error("SYNTHESIS_TIMEOUT", `Commit deadline exceeded (${deadlineSec}s)`, { deadlineMs: FINALIZE_COMMIT_DEADLINE_MS });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  project: project_slug,
                  action: "commit",
                  error: `prism_finalize commit deadline exceeded (${deadlineSec}s)`,
                  partial_state_warning:
                    "Atomic commit may have partially succeeded — verify repo state manually",
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }
        const result = raced;
        logger.info("prism_finalize commit timing", {
          projectSlug: project_slug,
          ms: Date.now() - phaseStart,
        });

        // Render finalization banner (D-46)
        let finalization_banner_html: string | null = null;
        try {
          // Count living docs updated from the files array
          const livingDocPatterns = [...LIVING_DOCUMENTS, "decisions/"];
          const docsUpdated = result.results.filter((r) =>
            r.success && livingDocPatterns.some((ld) => r.path === ld || r.path.startsWith(ld))
          ).length;

          // Extract resumption from handoff.md content in files array
          const handoffFile = files.find((f) => f.path === "handoff.md");
          let resumption = "See handoff.md for resumption point.";
          if (handoffFile) {
            const whereWeAre = extractSection(handoffFile.content, "Where We Are")
              ?? extractSection(handoffFile.content, "Current State")
              ?? "";
            if (whereWeAre.trim()) {
              // Grab first paragraph
              const firstParagraph = whereWeAre.split("\n\n")[0]?.trim();
              if (firstParagraph) resumption = firstParagraph;
            }
          }

          // Determine handoff push status
          const handoffResult = result.results.find((r) => r.path === "handoff.md");
          let handoffStatus: "ok" | "warn" = "ok";
          let handoffLabel = "pushed";
          if (!handoffResult?.success) {
            handoffStatus = "warn";
            handoffLabel = "push failed";
          } else if (handoffResult && !handoffResult.verified) {
            handoffStatus = "warn";
            handoffLabel = "unverified";
          }

          // Count decisions from _INDEX.md in files array
          let decisionsCount = 0;
          const indexFile = files.find((f) => f.path === "decisions/_INDEX.md");
          if (indexFile) {
            const rows = parseMarkdownTable(indexFile.content);
            decisionsCount = rows.length;
          }

          // Build deliverables
          const deliverables = banner_data?.deliverables ?? [
            { text: `\u2713 ${result.results.filter((r) => r.success).length} files pushed`, status: "ok" as const },
          ];

          // Build steps toolbar
          const stepStatuses = banner_data?.step_statuses ?? {};
          const allVerified = result.results.every((r) => r.success && r.verified);
          const steps: Array<{ label: string; status: "ok" | "warn" | "critical" }> = [
            { label: "audit", status: stepStatuses.audit ?? "ok" },
            { label: "draft", status: stepStatuses.draft ?? "ok" },
            { label: "commit", status: stepStatuses.commit ?? (result.all_succeeded ? "ok" : "critical") },
            { label: "verified", status: stepStatuses.verified ?? (allVerified ? "ok" : "warn") },
          ];

          finalization_banner_html = renderFinalizationBanner({
            version: SERVER_VERSION,
            session: session_number,
            timestamp: generateCstTimestamp(),
            handoff_version: handoff_version ?? 1,
            handoff_status: handoffStatus,
            handoff_label: handoffLabel,
            docs_updated: docsUpdated,
            docs_total: 10,
            decisions_count: decisionsCount,
            decisions_note: banner_data?.decisions_note ?? "see index",
            steps,
            resumption,
            deliverables,
            warnings: result.results
              .filter((r) => !r.success)
              .map((r) => `Push failed: ${r.path}`),
            errors: [],
          });

          logger.info("finalization banner rendered", { htmlLength: finalization_banner_html.length });
        } catch (bannerError) {
          const bannerMsg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("finalization banner render failed", { error: bannerMsg });
        }

        // Surface diagnostics for partial commits and synthesis outcomes
        if (!result.all_succeeded) {
          const failedPaths = result.results.filter(r => !r.success).map(r => r.path);
          diagnostics.error("PARTIAL_COMMIT", `${failedPaths.length} file(s) failed to push`, { failedPaths });
        }
        if (result.synthesis_outcome === "skipped" && !skip_synthesis) {
          diagnostics.warn("SYNTHESIS_SKIPPED", "Post-finalization synthesis was skipped (commit not fully successful or synthesis disabled)");
        }

        logger.info("prism_finalize commit complete", {
          project_slug,
          allSucceeded: result.all_succeeded,
          bannerRendered: !!finalization_banner_html,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, finalization_banner_html, diagnostics: diagnostics.list() }) }],
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
