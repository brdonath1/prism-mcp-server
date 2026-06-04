/**
 * prism_finalize tool — Execute PRISM finalization in 2 tool calls instead of 13-16.
 * Phase 1 (audit): Fetch all living documents, detect drift, audit session work products.
 * Phase 2 (commit): Backup handoff, validate, push all files, verify.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
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
  FRAMEWORK_REPO,
  FINALIZE_COMMIT_DEADLINE_MS,
  FINALIZE_DRAFT_TIMEOUT_MS,
  FINALIZE_DRAFT_DEADLINE_MS,
  FINALIZE_DRAFT_DEADLINE_CC_MS,
  CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS,
  DOC_ROOT,
} from "../config.js";
import { splitForArchive, type ArchiveConfig } from "../utils/archive.js";

/** Sentinel used to signal that the finalize-commit deadline fired (S40 C4). */
const FINALIZE_COMMIT_DEADLINE_SENTINEL = Symbol("finalize.commit.deadline");

/** Sentinel used to signal that the finalize-draft deadline fired (S41). */
const FINALIZE_DRAFT_DEADLINE_SENTINEL = Symbol("finalize.draft.deadline");

/** Resolve the per-attempt timeout for draftPhase based on transport.
 *  cc_subprocess runs through the Agent SDK subprocess which has higher
 *  overhead; use the cc_subprocess-specific timeout for that transport,
 *  otherwise fall back to the standard FINALIZE_DRAFT_TIMEOUT_MS. */
export function resolveDraftTimeout(transport: string | undefined): number {
  return transport === "cc_subprocess"
    ? CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS
    : FINALIZE_DRAFT_TIMEOUT_MS;
}

/** Resolve the fullPhase draft-deadline race ceiling based on transport.
 *  cc_subprocess drafts run 130–240s (observed), so the standard 180s
 *  deadline would abort most runs. Use the wider cc_subprocess-specific
 *  deadline for that transport, otherwise the standard deadline. */
export function resolveDraftDeadline(transport: string | undefined): number {
  return transport === "cc_subprocess"
    ? FINALIZE_DRAFT_DEADLINE_CC_MS
    : FINALIZE_DRAFT_DEADLINE_MS;
}

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

/** Default cap for the `## Recently Completed` section in task-queue.md (brief-422 Piece 4). */
export const TASK_QUEUE_RECENTLY_COMPLETED_CAP = 15;

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
import { resolveDocPath, resolveDocFiles, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { logger } from "../utils/logger.js";
import { extractHeaders, extractSection, parseNumberedList } from "../utils/summarizer.js";
import { parseHandoffVersion, parseTemplateVersion } from "../validation/handoff.js";
import { validateFile } from "../validation/index.js";
import { parseMarkdownTable } from "../utils/summarizer.js";
import { generateIntelligenceBrief, generatePendingDocUpdates } from "../ai/synthesize.js";
import { computeCurrencyWarning, type CurrencyWarning } from "../utils/doc-currency.js";
import {
  BANNER_SPEC_VERSION,
  generateCstTimestamp,
  parseTemplateBannerSpecVersion,
  renderBannerFallback,
  renderUnifiedBanner,
  type BannerStatusEntry,
} from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { classifySession, injectPersistedRecommendation, type SessionRecommendation } from "../utils/session-classifier.js";
import { applyPendingDocUpdates, type ApplyPduResult } from "../utils/apply-pdu.js";
import { findUnloggedIds } from "../utils/unlogged-ids.js";
import { parseExistingDecisionIds } from "./log-decision.js";
import { parseExistingInsightIds } from "./log-insight.js";

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
  const driftDetection = {
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

  // 5. Doc-currency check (D-156 §3.7 / D-155). Computed from already-fetched
  //    docs — no extra GitHub round-trips. Narrative docs are architecture.md
  //    and glossary.md per the brief; missing markers fall back to null
  //    (warning is non-fatal — operator-side advisory only).
  const NARRATIVE_DOCS = ["architecture.md", "glossary.md"] as const;
  const indexBody = decisionResult?.content ?? "";
  const currencyWarnings: CurrencyWarning[] = NARRATIVE_DOCS.map((docName) => {
    const docResult = docMap.get(docName);
    return computeCurrencyWarning({
      path: docName,
      docBody: docResult?.content ?? "",
      indexBody,
      currentSession: sessionNumber,
    });
  });

  return {
    project: projectSlug,
    session_number: sessionNumber,
    audit: {
      living_documents: livingDocuments,
      drift_detection: driftDetection,
      session_work_products: sessionWorkProducts,
      handoff_backup_exists: handoffBackupExists,
      current_handoff_version: currentVersion,
      currency_warnings: currencyWarnings,
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
  // Transport-aware: cc_subprocess runs through Agent SDK with higher
  // overhead, so use CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS for that transport.
  const draftTransport = process.env.SYNTHESIS_DRAFT_TRANSPORT;
  const draftTimeoutMs = resolveDraftTimeout(draftTransport);

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
    true, // thinking: true — Phase 3b CS-1 adaptive-thinking flag (D-159 successor)
    "draft", // brief-420 Phase 5a: per-call-site routing (SYNTHESIS_DRAFT_* env vars)
    projectSlug, // brief-420 Phase 5a: project tag for observation surfacing (brief-419)
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
 * Prune `## Recently Completed` in task-queue.md to keep at most `maxEntries`
 * `### ` entries (brief-422 Piece 4). The section is reverse-chronological —
 * newest entries at the top — so excess entries are dropped from the bottom.
 *
 * Header rewrite: when the section header carries a `(last N sessions)`
 * decoration (e.g. `## Recently Completed (last 10 sessions)`), update it to
 * `(last {maxEntries} sessions)` so the displayed cap matches the enforced
 * cap. A header without the decoration is left untouched — operators may
 * have intentionally omitted the count.
 *
 * Returns the modified content, or `null` when the section is missing or
 * already within cap (no-op signal — the caller skips the write).
 */
export function pruneRecentlyCompleted(
  content: string,
  maxEntries: number = TASK_QUEUE_RECENTLY_COMPLETED_CAP,
): string | null {
  const sectionRe = /^##\s+Recently Completed[^\n]*$/m;
  const sectionMatch = content.match(sectionRe);
  if (!sectionMatch) return null;

  const sectionStart = sectionMatch.index!;
  const headerLine = sectionMatch[0];
  const headerEnd = sectionStart + headerLine.length;

  // Find the next top-level (## ) heading or EOF sentinel — that's where the
  // Recently Completed body ends.
  const tail = content.slice(headerEnd);
  const nextH2 = tail.match(/\n##\s+\S/);
  const nextEof = tail.match(/\n<!--\s*EOF:/);
  let bodyEndOffset: number;
  if (nextH2 && (!nextEof || nextH2.index! < nextEof.index!)) {
    bodyEndOffset = nextH2.index! + 1; // +1 to consume leading \n
  } else if (nextEof) {
    bodyEndOffset = nextEof.index! + 1;
  } else {
    bodyEndOffset = tail.length;
  }
  const bodyEnd = headerEnd + bodyEndOffset;
  const body = content.slice(headerEnd, bodyEnd);

  // Enumerate `### ` entry start positions inside the section body.
  const entryStarts: number[] = [];
  for (const m of body.matchAll(/^###\s+/gm)) {
    entryStarts.push(m.index!);
  }
  if (entryStarts.length <= maxEntries) return null;

  const dropFromOffset = entryStarts[maxEntries];
  const trimmedBody = body.slice(0, dropFromOffset).replace(/\s+$/, "") + "\n\n";

  // Update the displayed cap when the header carries a `(last N sessions)`
  // decoration. Match `(last 10 sessions)`, `(last 15 sessions)`, etc.
  const newHeader = headerLine.replace(
    /\(last\s+\d+\s+sessions?\)/i,
    `(last ${maxEntries} sessions)`,
  );

  return (
    content.slice(0, sectionStart) +
    newHeader +
    trimmedBody +
    content.slice(bodyEnd)
  );
}

/**
 * Update architecture.md metadata (brief-422 Piece 3).
 *
 * Behavior:
 *   - Gates on `auto_update_architecture: true` in the project's
 *     `.prism/config.yaml`. Skip silently otherwise so projects opt in
 *     deliberately.
 *   - Refreshes the `> Updated: S{N} ({date})` preamble line via regex.
 *     Skips silently when the pattern is not found (defensive contract for
 *     legacy / non-PRISM-style architecture.md files).
 *   - When the file carries the `**MCP server:**` Stack bullet, refreshes
 *     its parenthetical to the prism-mcp-server version read from
 *     `prism-mcp-server/package.json`. No-op when the version is already
 *     present.
 *
 * All errors are returned in the result, never thrown — the caller surfaces
 * them in the response but commit success is unaffected.
 */
export async function updateArchitectureMetadata(
  projectSlug: string,
  sessionNumber: number,
  sessionDate: string,
): Promise<{ updated: boolean; reason?: string; version?: string }> {
  // 1. Config gate — must explicitly opt in via `.prism/config.yaml`.
  let configEnabled = false;
  try {
    const config = await fetchFile(projectSlug, ".prism/config.yaml");
    configEnabled = /^\s*auto_update_architecture:\s*true\s*$/im.test(config.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Not found")) {
      logger.debug("architecture metadata: config fetch failed", { projectSlug, error: msg });
    }
  }
  if (!configEnabled) {
    return { updated: false, reason: "auto_update_architecture not enabled" };
  }

  // 2. Fetch architecture.md.
  let arch: { content: string; sha: string };
  try {
    const resolved = await resolveDocPath(projectSlug, "architecture.md");
    arch = { content: resolved.content, sha: resolved.sha };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, reason: `architecture.md fetch failed: ${msg}` };
  }

  // 3. Preamble pattern — defensive contract: only process files that
  //    already carry the canonical `> Updated: S{N} ({date})` line.
  const preambleRe = /^>\s*Updated:\s*S\d+\s*\([^)]+\)/m;
  if (!preambleRe.test(arch.content)) {
    return { updated: false, reason: "preamble pattern not found" };
  }

  let newContent = arch.content.replace(
    preambleRe,
    `> Updated: S${sessionNumber} (${sessionDate})`,
  );

  // 4. Stack bullet refresh — best-effort. Reads version from
  //    prism-mcp-server's package.json (the ground-truth source per brief).
  let version: string | undefined;
  try {
    const pkg = await fetchFile("prism-mcp-server", "package.json");
    const versionMatch = pkg.content.match(/"version"\s*:\s*"([^"]+)"/);
    if (versionMatch) {
      version = versionMatch[1];
      const bulletRe = /^(\s*-\s+\*\*MCP server:\*\*\s+Node\.js\/TypeScript on Railway)\s*\(([^)]*)\)\s*$/m;
      newContent = newContent.replace(bulletRe, (match, prefix, parens) => {
        if (parens.includes(`v${version}`)) return match;
        return `${prefix} (v${version})`;
      });
    }
  } catch (err) {
    logger.debug("architecture metadata: package.json read failed", {
      projectSlug,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (newContent === arch.content) {
    return { updated: false, reason: "no change required" };
  }

  // 5. Push.
  try {
    const pushPath = await resolveDocPushPath(projectSlug, "architecture.md");
    await pushFile(
      projectSlug,
      pushPath,
      newContent,
      `prism: S${sessionNumber} architecture.md preamble refresh`,
    );
    return { updated: true, version };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { updated: false, reason: `architecture.md push failed: ${msg}` };
  }
}

/**
 * brief-444 (optional sub-change): assemble the registry ID sets for the
 * unlogged-ID reference check. Committed file versions take precedence over
 * repo state — a finalize commit that itself adds the D-N row to
 * decisions/_INDEX.md counts as logged. Per family:
 *   - D-N:   decisions/_INDEX.md (the canonical registry — never compressed)
 *   - INS-N: insights.md + standing-rules.md + insights-archive.md (INS-N is
 *            one shared sequence per R2-B, and archived insights were logged
 *            once — scanning the archive avoids false positives)
 * "Not found" = source genuinely absent (contributes nothing, family stays
 * known). Any operational fetch error = family unknown → null, and the
 * caller skips that family entirely (fail-open, no false positives).
 */
async function collectRegistryIdSets(
  projectSlug: string,
  files: Array<{ path: string; content: string }>,
): Promise<{ decisionIds: Set<string> | null; insightIds: Set<string> | null }> {
  const committed = (docName: string): string | null => {
    const f = files.find(
      (x) => x.path === docName || x.path === `${DOC_ROOT}/${docName}`,
    );
    return f ? f.content : null;
  };

  type SourceOutcome = { ok: true; content: string | null } | { ok: false };
  const loadSource = async (docName: string): Promise<SourceOutcome> => {
    const fromCommit = committed(docName);
    if (fromCommit !== null) return { ok: true, content: fromCommit };
    try {
      const resolved = await resolveDocPath(projectSlug, docName);
      return { ok: true, content: resolved.content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Not found")) return { ok: true, content: null };
      return { ok: false };
    }
  };

  const [indexOutcome, insightsOutcome, standingRulesOutcome, insightsArchiveOutcome] =
    await Promise.all([
      loadSource("decisions/_INDEX.md"),
      loadSource("insights.md"),
      loadSource("standing-rules.md"),
      loadSource("insights-archive.md"),
    ]);

  const decisionIds = indexOutcome.ok
    ? new Set(
        indexOutcome.content !== null
          ? parseExistingDecisionIds(indexOutcome.content).keys()
          : [],
      )
    : null;

  let insightIds: Set<string> | null = null;
  if (insightsOutcome.ok && standingRulesOutcome.ok && insightsArchiveOutcome.ok) {
    insightIds = new Set<string>();
    for (const outcome of [insightsOutcome, standingRulesOutcome, insightsArchiveOutcome]) {
      if (outcome.content !== null) {
        for (const id of parseExistingInsightIds(outcome.content).keys()) {
          insightIds.add(id);
        }
      }
    }
  }

  return { decisionIds, insightIds };
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
  const [backupOutcome, _pruneOutcome] = await Promise.allSettled([
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

  // 2b. brief-411 / D-193 Piece 1 — persist the model+thinking recommendation
  //     into handoff.md as a structured markdown block. Bootstrap reads this
  //     block instead of reclassifying with a different input bundle, which
  //     was the root cause of the S107→S108 banner discrepancy. Mutation
  //     MUST precede validation so EOF/structural checks run against the
  //     final on-disk form.
  const handoffIdx = files.findIndex(
    (f) => f.path === "handoff.md" || f.path === `${DOC_ROOT}/handoff.md`,
  );
  if (handoffIdx !== -1) {
    const handoffFile = files[handoffIdx];
    if (/^## Meta\s*$/m.test(handoffFile.content)) {
      try {
        const nextStepsForRecommendation = parseNumberedList(
          extractSection(handoffFile.content, "Next Steps")
            ?? extractSection(handoffFile.content, "Immediate Next")
            ?? "",
        );
        const recommendation = classifySession({
          next_steps: nextStepsForRecommendation,
        });
        const mutated = injectPersistedRecommendation(handoffFile.content, recommendation);
        if (mutated !== null) {
          files[handoffIdx] = { ...handoffFile, content: mutated };
          logger.info("persisted recommendation injected into handoff", {
            projectSlug,
            sessionNumber,
            category: recommendation.category,
            display: recommendation.display,
          });
        } else {
          // Anchor regex did not find a usable Meta section even though the
          // existence check passed (e.g. malformed body). Proceed without
          // injection rather than risk corrupting the file.
          logger.warn("persisted recommendation injection skipped — anchor unmatched", {
            projectSlug,
            sessionNumber,
          });
        }
      } catch (classifyErr) {
        logger.warn("persisted recommendation classifier failed", {
          projectSlug,
          sessionNumber,
          error: classifyErr instanceof Error ? classifyErr.message : String(classifyErr),
        });
      }
    } else {
      // Defensive contract per brief-411 A.1: do not invent a Meta section.
      logger.warn("persisted recommendation skipped — no ## Meta section in handoff", {
        projectSlug,
        sessionNumber,
      });
    }
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

  // 3b. Archive lifecycle (S40 FINDING-14).
  // Apply size-triggered archiving to session-log.md and insights.md BEFORE the
  // atomic commit so live + archive changes land in a single commit. Fail-open:
  // any error is logged and skipped — a finalize that commits the live docs
  // without archiving is still a success.
  //
  // brief-435 (D-240 Phase B R2-A): archival is decoupled from the files[]
  // array. Docs committed out-of-band during the session (e.g. insights.md via
  // prism_log_insight push-immediately) are absent from files[] at finalize
  // time — previously applyArchive bailed on liveIdx === -1, so D-80 retention
  // never fired for them. Now the live doc is fetched from the repo instead;
  // when archiving occurs, the pruned live doc + archive are injected into
  // files[] so both land in the same atomic finalize commit.
  async function applyArchive(
    liveFileName: string,
    archiveFileName: string,
    config: ArchiveConfig,
  ): Promise<void> {
    try {
      const liveIdx = files.findIndex(
        f => f.path === liveFileName || f.path === `${DOC_ROOT}/${liveFileName}`,
      );

      // In-array docs (e.g. session-log.md riding the finalize commit) use
      // their files[] content; out-of-band docs are fetched from the repo.
      // Fetch failure → skip: the doc doesn't exist, genuinely nothing to
      // archive (fail-open). Note the asymmetry with the findIndex above:
      // the fetch targets the standard `${DOC_ROOT}/` layout only, so a
      // legacy root-resident doc absent from files[] skips archival — same
      // as pre-brief-435 behavior (no regression).
      let liveContent: string;
      if (liveIdx !== -1) {
        liveContent = files[liveIdx].content;
      } else {
        try {
          const fetched = await fetchFile(projectSlug, `${DOC_ROOT}/${liveFileName}`);
          liveContent = fetched.content;
        } catch {
          return;
        }
      }

      let existingArchive: string | null = null;
      try {
        const archivePath = `${DOC_ROOT}/${archiveFileName}`;
        const fetched = await fetchFile(projectSlug, archivePath);
        existingArchive = fetched.content;
      } catch {
        existingArchive = null; // First-time archive
      }

      const result = splitForArchive(liveContent, existingArchive, config);

      if (result.archiveContent !== null && result.archivedCount > 0) {
        if (liveIdx !== -1) {
          files[liveIdx] = { ...files[liveIdx], content: result.liveContent };
        } else {
          // Fetched out-of-band — add the pruned live doc to files[] so it
          // lands in the same atomic commit as the archive file.
          files.push({
            path: `${DOC_ROOT}/${liveFileName}`,
            content: result.liveContent,
          });
        }
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

  // brief-422 Piece 4: cap `## Recently Completed` in task-queue.md at 15
  // entries (TASK_QUEUE_RECENTLY_COMPLETED_CAP). Pruning runs against the
  // operator-supplied content so the cap is enforced in the same atomic
  // commit as the rest of the finalization. Fail-open: any error is logged
  // and skipped — finalize success does not depend on the prune.
  let taskQueuePruned = false;
  try {
    const tqIdx = files.findIndex(
      f => f.path === "task-queue.md" || f.path === `${DOC_ROOT}/task-queue.md`,
    );
    if (tqIdx !== -1) {
      const pruned = pruneRecentlyCompleted(files[tqIdx].content, TASK_QUEUE_RECENTLY_COMPLETED_CAP);
      if (pruned !== null) {
        files[tqIdx] = { ...files[tqIdx], content: pruned };
        taskQueuePruned = true;
        logger.info("task-queue Recently Completed pruned", {
          projectSlug,
          cap: TASK_QUEUE_RECENTLY_COMPLETED_CAP,
        });
      }
    }
  } catch (err) {
    logger.warn("task-queue prune skipped — error", {
      projectSlug,
      err: err instanceof Error ? err.message : String(err),
    });
  }

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
  const livingDocsUpdated = countLivingDocumentsUpdated(results);

  const allSucceeded = succeeded.length === files.length;

  // brief-444 (optional sub-change): unlogged-ID reference warning.
  // Scans the committed session text for D-N / INS-N references that exist
  // in no registry source — the operator mentioned an ID in prose but never
  // logged it via prism_log_decision / prism_log_insight, so the registry
  // silently lacks the entry. Diagnostics-only and fail-open: it never
  // affects the commit result, and an operational fetch error skips the
  // affected ID family rather than risking false positives.
  try {
    const registry = await collectRegistryIdSets(projectSlug, files);
    const unlogged = findUnloggedIds(files, registry);
    if (unlogged.decisions.length > 0 || unlogged.insights.length > 0) {
      const allIds = [...unlogged.decisions, ...unlogged.insights];
      const display =
        allIds.slice(0, 15).join(", ") +
        (allIds.length > 15 ? `, … (+${allIds.length - 15} more)` : "");
      diagnostics.warn(
        "UNLOGGED_ID_REFERENCED",
        `Session text references ${allIds.length} ID(s) never logged via prism_log_decision / prism_log_insight: ${display}`,
        { decisions: unlogged.decisions, insights: unlogged.insights },
      );
      logger.warn("unlogged ID references detected at finalize", {
        projectSlug,
        sessionNumber,
        decisions: unlogged.decisions,
        insights: unlogged.insights,
      });
    }
  } catch (err) {
    logger.warn("unlogged-ID check failed — skipping (non-blocking)", {
      projectSlug,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // brief-422 Piece 1 + Piece 3: post-commit, pre-synthesis sweeps.
  // PDU auto-apply runs only when synthesis is enabled (the PDU file is
  // produced by synthesis — applying nonexistent proposals is a no-op).
  // Architecture metadata refresh runs whenever the commit succeeded —
  // it's mechanical and independent of synthesis. Both are gated off
  // `skipSynthesis` so an operator opt-out covers all post-commit work.
  let pduResult: ApplyPduResult | null = null;
  let architectureResult: { updated: boolean; reason?: string; version?: string } | null = null;
  if (allSucceeded && !skipSynthesis) {
    if (SYNTHESIS_ENABLED) {
      try {
        pduResult = await applyPendingDocUpdates(projectSlug, sessionNumber);
        if (pduResult.applied.length > 0) {
          logger.info("PDU auto-apply complete", {
            projectSlug,
            applied: pduResult.applied.length,
            skipped: pduResult.skipped.length,
            errors: pduResult.errors.length,
            cleared: pduResult.cleared,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("PDU auto-apply threw — continuing", { projectSlug, err: msg });
        pduResult = { applied: [], skipped: [], errors: [{ title: "(applyPendingDocUpdates)", error: msg }], cleared: false, archived: false };
      }
    }
    try {
      architectureResult = await updateArchitectureMetadata(projectSlug, sessionNumber, today);
      if (architectureResult.updated) {
        logger.info("architecture.md preamble refreshed", {
          projectSlug,
          sessionNumber,
          version: architectureResult.version,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("architecture metadata update threw — continuing", { projectSlug, err: msg });
      architectureResult = { updated: false, reason: msg };
    }
  }

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
    // Fire BOTH synthesis functions in background via Promise.allSettled so the
    // slower of the two does not block the other (D-156 §3.6 / D-155). Both
    // remain fire-and-forget per INS-178 — commit response is already built.
    const synthesisLabels = ["intelligence_brief", "pending_updates"] as const;
    void Promise.allSettled([
      generateIntelligenceBrief(projectSlug, sessionNumber),
      generatePendingDocUpdates(projectSlug, sessionNumber),
    ])
      .then((results) => {
        results.forEach((r, idx) => {
          const label = synthesisLabels[idx];
          if (r.status === "fulfilled") {
            logger.info("background synthesis complete", {
              projectSlug,
              sessionNumber,
              synthesis_kind: label,
              success: r.value?.success ?? false,
              durationMs: Date.now() - synthStart,
            });
          } else {
            logger.error("background synthesis failed", {
              projectSlug,
              sessionNumber,
              synthesis_kind: label,
              err: r.reason instanceof Error ? r.reason.message : String(r.reason),
              durationMs: Date.now() - synthStart,
            });
          }
        });
      })
      .catch((err) => {
        // Defensive — Promise.allSettled itself never rejects, so this catches
        // synchronous throws from the .then callback (e.g. logger failures).
        logger.error("background synthesis dispatch failed", {
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
    // brief-422: surface non-fatal post-commit sweep outcomes so the operator
    // can see what landed beyond the main commit. Null when sweeps did not run
    // (skip_synthesis, commit failure, or synthesis disabled). Populated arrays
    // even when empty are still informative — they confirm the sweeps ran.
    pdu_applied: pduResult?.applied ?? null,
    pdu_skipped: pduResult?.skipped ?? null,
    pdu_errors: pduResult?.errors ?? null,
    pdu_cleared: pduResult?.cleared ?? null,
    pdu_archived: pduResult?.archived ?? null,   // brief-444: consumed-batch provenance archived
    architecture_updated: architectureResult?.updated ?? null,
    architecture_update_reason: architectureResult?.reason ?? null,
    task_queue_pruned: taskQueuePruned,
    confirmation: allSucceeded
      ? `Session ${sessionNumber} finalized. Handoff v${handoffVersion} pushed and verified. ${livingDocsUpdated}/${LIVING_DOCUMENTS.length} living documents updated.${synthesisOutcome === "background" ? " Intelligence brief synthesizing in background." : synthesisOutcome === "skipped" ? " Synthesis skipped." : ""}`
      : `Session ${sessionNumber} finalization partially failed. ${succeeded.length}/${files.length} files pushed.`,
  };
}

/**
 * Count living documents successfully committed, normalized across both
 * repo layouts (.prism/ and legacy root-level — the pre-R8 counters missed
 * the legacy form and reported 0 for unmigrated repos).
 *
 * Counts ONLY the 10 mandatory living documents: domain decision files
 * (decisions/{domain}.md) are not living documents — decisions/_INDEX.md is
 * the registry entry in the 10-doc list. Distinct paths only, so the result
 * is bounded by LIVING_DOCUMENTS.length by construction. Used by BOTH the
 * commit confirmation (`living_documents_updated`) and the finalization
 * banner so the two never disagree (brief-439 review finding).
 */
export function countLivingDocumentsUpdated(
  results: Array<{ path: string; success: boolean }>,
): number {
  const matched = new Set<string>();
  for (const r of results) {
    if (!r.success) continue;
    const bare = r.path.startsWith(`${DOC_ROOT}/`)
      ? r.path.slice(DOC_ROOT.length + 1)
      : r.path;
    if ((LIVING_DOCUMENTS as readonly string[]).includes(`${DOC_ROOT}/${bare}`)) {
      matched.add(bare);
    }
  }
  return matched.size;
}

/**
 * Assemble the finalization banner via the unified generator (brief-439 / R8).
 *
 * Shares the single banner code path with prism_bootstrap — boot and
 * finalization banners are byte-consistent by construction. Replaces the
 * deprecated HTML finalization widget (D-46, consumed by Rule 11 Step 6 /
 * D-84): `finalization_banner_html` stays null for backward compatibility
 * and `banner_text` carries this output instead. Contract: docs/banner-spec.md.
 *
 * Never throws — render failure falls back to the Rule 2 single-line format.
 */
async function assembleFinalizeBannerText(
  projectSlug: string,
  sessionNumber: number,
  handoffVersion: number,
  files: Array<{ path: string; content: string }>,
  results: Array<{ path: string; success: boolean; verified: boolean }>,
  allSucceeded: boolean,
  bannerData?: {
    deliverables?: Array<{ text: string; status: "ok" | "warn" }>;
    decisions_note?: string;
    step_statuses?: {
      audit?: "ok" | "warn" | "critical";
      draft?: "ok" | "warn" | "critical";
      commit?: "ok" | "warn" | "critical";
      verified?: "ok" | "warn" | "critical";
    };
  },
): Promise<string> {
  const docsTotal = LIVING_DOCUMENTS.length;

  try {
    // Same normalized count the commit confirmation uses — banner L2 and
    // the confirmation sentence agree by construction, and {C} ≤ {T}.
    const docsUpdated = countLivingDocumentsUpdated(results);

    // Extract resumption + next steps from the handoff content in the commit
    const handoffFile = files.find(
      (f) => f.path === "handoff.md" || f.path === `${DOC_ROOT}/handoff.md`,
    );
    let resumption = "See handoff.md for resumption point.";
    let nextStepsForRecommendation: string[] = [];
    if (handoffFile) {
      const whereWeAre = extractSection(handoffFile.content, "Where We Are")
        ?? extractSection(handoffFile.content, "Current State")
        ?? "";
      if (whereWeAre.trim()) {
        const firstParagraph = whereWeAre.split("\n\n")[0]?.trim();
        if (firstParagraph) resumption = firstParagraph;
      }
      // brief-405 / D-191: parse next_steps for the classifier. The
      // finalization banner is the primary pre-boot signal —
      // handoff_next_steps is the canonical source.
      nextStepsForRecommendation = parseNumberedList(
        extractSection(handoffFile.content, "Next Steps")
          ?? extractSection(handoffFile.content, "Immediate Next")
          ?? ""
      );
    }

    // Banner line 1 version segment: the framework template version the
    // handoff declares — the same semantic the boot banner renders. Falls
    // back to "unknown" exactly like boot when unparseable.
    const templateVersion = handoffFile
      ? (parseTemplateVersion(handoffFile.content) ?? "unknown")
      : "unknown";

    // brief-405 / D-191: classify the next session. Pure function, no I/O.
    // Failure is non-fatal — the banner renders without the Suggested line.
    let recommendation: SessionRecommendation | null = null;
    try {
      recommendation = classifySession({
        next_steps: nextStepsForRecommendation,
      });
    } catch (classifyErr) {
      logger.warn("session classifier failed (finalize)", {
        error: classifyErr instanceof Error ? classifyErr.message : String(classifyErr),
      });
    }

    // Handoff push status → line 2 parenthetical
    const handoffResult = results.find(
      (r) => r.path === "handoff.md" || r.path === `${DOC_ROOT}/handoff.md`,
    );
    let handoffNote = "pushed";
    if (!handoffResult?.success) {
      handoffNote = "push failed";
    } else if (handoffResult && !handoffResult.verified) {
      handoffNote = "unverified";
    }

    // Count decisions from the repo index, falling back to the commit files
    // array (handles legacy paths and unmigrated repos).
    let decisionsCount = 0;
    try {
      const indexDoc = await resolveDocPath(projectSlug, "decisions/_INDEX.md");
      decisionsCount = parseMarkdownTable(indexDoc.content).length;
    } catch {
      const indexFile = files.find(
        (f) =>
          f.path === "decisions/_INDEX.md" ||
          f.path === `${DOC_ROOT}/decisions/_INDEX.md`,
      );
      if (indexFile) {
        decisionsCount = parseMarkdownTable(indexFile.content).length;
      }
    }

    // Deliverables list — operator-supplied via banner_data, or a default
    // push-count line. Per-item status is no longer rendered (push failures
    // already surface as warning lines); the field is still accepted for
    // backward compatibility.
    const succeededCount = results.filter((r) => r.success).length;
    const listItems = (
      bannerData?.deliverables ?? [
        { text: `${succeededCount} file${succeededCount === 1 ? "" : "s"} pushed`, status: "ok" as const },
      ]
    ).map((d) => d.text);

    // Step row — operator overrides win; otherwise derived from the commit
    const stepStatuses = bannerData?.step_statuses ?? {};
    const allVerified = results.every((r) => r.success && r.verified);
    const statusRow: BannerStatusEntry[] = [
      { label: "audit", status: stepStatuses.audit ?? "ok" },
      { label: "draft", status: stepStatuses.draft ?? "ok" },
      { label: "commit", status: stepStatuses.commit ?? (allSucceeded ? "ok" : "critical") },
      { label: "verified", status: stepStatuses.verified ?? (allVerified ? "ok" : "warn") },
    ];

    const bannerText = renderUnifiedBanner({
      surface: "finalize",
      templateVersion,
      sessionNumber,
      timestamp: generateCstTimestamp(),
      handoffVersion,
      handoffNote,
      decisionCount: decisionsCount,
      decisionNote: bannerData?.decisions_note ?? null,
      docCount: docsUpdated,
      docTotal: docsTotal,
      statusRow,
      suggested: recommendation
        ? { display: recommendation.display, rationale: recommendation.rationale }
        : null,
      resumption,
      listItems,
      warnings: results
        .filter((r) => !r.success)
        .map((r) => `Push failed: ${r.path}`),
    });

    logger.info("finalization banner text rendered", { textLength: bannerText.length });
    return bannerText;
  } catch (bannerError) {
    const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
    logger.warn("finalization banner render failed — using single-line fallback", { error: msg });
    const docsUpdatedFallback = results.filter((r) => r.success).length;
    return renderBannerFallback({
      sessionNumber,
      handoffVersion,
      docCount: Math.min(docsUpdatedFallback, docsTotal),
      docTotal: docsTotal,
    });
  }
}

/**
 * Full phase — run audit + draft + commit atomically in a single tool call.
 * Enables Trigger-driven finalization without inter-call state management.
 */
async function fullPhase(
  projectSlug: string,
  sessionNumber: number,
  handoffVersion: number,
  handoffContent: string,
  skipSynthesis: boolean,
  bannerData?: { deliverables?: Array<{text: string; status: "ok"|"warn"}>; decisions_note?: string; step_statuses?: { audit?: "ok"|"warn"|"critical"; draft?: "ok"|"warn"|"critical"; commit?: "ok"|"warn"|"critical"; verified?: "ok"|"warn"|"critical" } },
) {
  // Step 1 — Audit
  const auditResult = await auditPhase(projectSlug, sessionNumber);
  const auditStatus = auditResult.audit.living_documents.some(d => !d.exists) ? "warn" : "ok";

  // Step 2 — Draft (CS-1): race with a transport-aware deadline.
  // cc_subprocess drafts run longer (130–240s observed) so use the wider
  // FINALIZE_DRAFT_DEADLINE_CC_MS when that transport is active.
  let draftStatus: "ok" | "warn" = "warn";
  let draftResult: Awaited<ReturnType<typeof draftPhase>> | null = null;
  const draftDeadlineMs = resolveDraftDeadline(process.env.SYNTHESIS_DRAFT_TRANSPORT);

  let draftDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const draftDeadlinePromise = new Promise<typeof FINALIZE_DRAFT_DEADLINE_SENTINEL>((resolve) => {
    draftDeadlineTimer = setTimeout(
      () => resolve(FINALIZE_DRAFT_DEADLINE_SENTINEL),
      draftDeadlineMs,
    );
  });
  const draftWork = draftPhase(projectSlug, sessionNumber);
  const raced = await Promise.race([draftWork, draftDeadlinePromise]);
  if (draftDeadlineTimer) clearTimeout(draftDeadlineTimer);

  if (raced === FINALIZE_DRAFT_DEADLINE_SENTINEL) {
    draftStatus = "warn";
    draftResult = null;
    logger.warn("fullPhase draft deadline exceeded", { projectSlug, deadlineMs: draftDeadlineMs });
  } else {
    draftResult = raced;
    draftStatus = draftResult.success === false ? "warn" : "ok";
  }

  // Step 3 — Assemble files[]
  const files: Array<{path: string; content: string}> = [
    { path: "handoff.md", content: handoffContent },
  ];

  if (draftResult?.success && "drafts" in draftResult && draftResult.drafts && typeof draftResult.drafts === "object") {
    const draftsObj = draftResult.drafts as Record<string, unknown>;
    for (const [key, value] of Object.entries(draftsObj)) {
      if (typeof value !== "string") continue;
      if (key === "handoff.md") continue; // operator-supplied takes precedence
      if (key.endsWith(".md") || (DRAFT_RELEVANT_DOCS as readonly string[]).includes(key)) {
        files.push({ path: key, content: value });
      }
    }
  }

  // Step 4 — Commit
  const diagnostics = new DiagnosticsCollector();
  const commitResult = await commitPhase(
    projectSlug,
    sessionNumber,
    handoffVersion,
    files,
    skipSynthesis,
    diagnostics,
  );

  // Step 5 — Finalization banner (brief-439 / R8). fullPhase previously
  // returned no banner at all; the unified generator now serves all finalize
  // surfaces. Real audit/draft outcomes feed the step row; operator-supplied
  // step_statuses still win.
  const bannerText = await assembleFinalizeBannerText(
    projectSlug,
    sessionNumber,
    handoffVersion,
    files,
    commitResult.results,
    commitResult.all_succeeded,
    {
      ...bannerData,
      step_statuses: {
        audit: auditStatus,
        draft: draftStatus,
        ...bannerData?.step_statuses,
      },
    },
  );

  // Step 6 — Return combined result.
  // Note: commitResult already contains project, session_number, handoff_version etc.
  // action and phases are unique to fullPhase; diagnostics overrides the one inside commitResult.
  return {
    action: "full" as const,
    phases: {
      audit: { status: auditStatus, warnings: auditResult.audit.warnings },
      draft: {
        status: draftStatus,
        input_tokens: draftResult && "input_tokens" in draftResult ? draftResult.input_tokens : 0,
        output_tokens: draftResult && "output_tokens" in draftResult ? draftResult.output_tokens : 0,
      },
      commit: { all_succeeded: commitResult.all_succeeded, living_documents_updated: commitResult.living_documents_updated },
    },
    ...commitResult,
    banner_text: bannerText,                    // brief-439 / R8: unified generator output
    banner_spec_version: BANNER_SPEC_VERSION,   // brief-439 / R8: banner contract version this server emits
    finalization_banner_html: null,             // brief-439 / R8: HTML widget deprecated — always null
    diagnostics: diagnostics.list(),
  };
}

/**
 * Register the prism_finalize tool on an MCP server instance.
 */
export function registerFinalize(server: McpServer): void {
  server.tool(
    "prism_finalize",
    "PRISM finalization. Actions: audit (document inventory + drift), draft (AI-generated files), commit (backup + push + validate), full (single call: audit + draft + commit).",
    {
      project_slug: z.string().describe("Project repo name"),
      action: z.enum(["audit", "draft", "commit", "full"]).describe("Finalization phase: 'audit' for document inventory, 'draft' for AI-generated file drafts, 'commit' to push final files, 'full' (single call: audit + draft + commit)"),
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
      handoff_content: z.string().optional().describe("Complete handoff.md content (full action only)"),
    },
    async ({ project_slug, action, session_number, handoff_version, files, skip_synthesis, banner_data, handoff_content }) => {
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

          // brief-439 / R8: banner_spec_version handshake on the finalize
          // side. Rule 11 Step 6 (D-84) — the finalization banner consumer —
          // lives in rules-session-end.md, so its declared Banner-Spec-Version
          // is compared here. Mismatch logs a BANNER_DRIFT warn diagnostic —
          // visibility only, never blocking. No declaration = pre-handshake
          // template = not drift. Contract: docs/banner-spec.md.
          let templateBannerSpecVersion: string | null = null;
          if (sessionEndRules) {
            templateBannerSpecVersion = parseTemplateBannerSpecVersion(sessionEndRules);
            if (
              templateBannerSpecVersion !== null &&
              templateBannerSpecVersion !== BANNER_SPEC_VERSION
            ) {
              diagnostics.warn(
                "BANNER_DRIFT",
                `Session-end rules template declares banner spec ${templateBannerSpecVersion}; server emits ${BANNER_SPEC_VERSION}. Align rules-session-end.md with docs/banner-spec.md.`,
                {
                  template_declared: templateBannerSpecVersion,
                  server_emitted: BANNER_SPEC_VERSION,
                },
              );
              logger.warn("banner spec drift detected (finalize audit)", {
                template_declared: templateBannerSpecVersion,
                server_emitted: BANNER_SPEC_VERSION,
              });
            }
          }

          logger.info("prism_finalize audit complete", {
            project_slug,
            sessionEndRulesDelivered: !!sessionEndRules,
            ms: Date.now() - start,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              ...result,
              session_end_rules: sessionEndRules,
              banner_spec_version: BANNER_SPEC_VERSION,                   // brief-439 / R8
              template_banner_spec_version: templateBannerSpecVersion,    // brief-439 / R8 (null = pre-handshake template)
              diagnostics: diagnostics.list(),
            }) }],
          };
        }

        if (action === "draft") {
          const phaseStart = Date.now();

          // The interactive draft action stays bounded by the MCP client
          // response ceiling (~60s) and is not the intended cc_subprocess-draft
          // consumer; the background `full` action is.
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

        if (action === "full") {
          if (!handoff_content) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "Full action requires handoff_content — the complete handoff.md content for this session.",
                project: project_slug,
              })}],
              isError: true,
            };
          }
          const result = await fullPhase(
            project_slug,
            session_number,
            handoff_version ?? 1,
            handoff_content,
            skip_synthesis ?? false,
            banner_data,
          );

          logger.info("prism_finalize full complete", {
            project_slug,
            session_number,
            phases: result.phases,
            allSucceeded: result.all_succeeded,
            ms: Date.now() - start,
          });

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
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

        // brief-439 / R8: finalization banner via the unified generator —
        // the single code path shared with prism_bootstrap. The HTML widget
        // (D-46) is deprecated: finalization_banner_html is always null
        // (kept for backward compatibility with Rule 11 Step 6 consumers,
        // whose null path falls back to the minimal text confirmation) and
        // banner_text carries the banner. Contract: docs/banner-spec.md.
        const bannerText = await assembleFinalizeBannerText(
          project_slug,
          session_number,
          handoff_version ?? 1,
          files,
          result.results,
          result.all_succeeded,
          banner_data,
        );

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
          bannerTextBytes: bannerText.length,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            ...result,
            banner_text: bannerText,                    // brief-439 / R8: unified generator output
            banner_spec_version: BANNER_SPEC_VERSION,   // brief-439 / R8: banner contract version this server emits
            finalization_banner_html: null,             // brief-439 / R8: HTML widget deprecated — always null
            diagnostics: diagnostics.list(),
          }) }],
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
