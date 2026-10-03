/**
 * prism_finalize tool — Execute PRISM finalization in 2 tool calls instead of 13-16.
 * Phase 1 (audit): Fetch all living documents, detect drift, audit session work products.
 * Phase 2 (commit): Backup handoff, validate, push all files, verify.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
  listDirectory,
} from "../github/client.js";
import { safeMutation } from "../utils/safe-mutation.js";
import { preparePublishedCheckpointProjection } from "../utils/published-checkpoint-projection.js";
import { registerInflight } from "../utils/inflight-registry.js";
import {
  LIVING_DOCUMENTS,
  LIVING_DOCUMENT_NAMES,
  SYNTHESIS_ENABLED,
  FRAMEWORK_REPO,
  FINALIZE_COMMIT_DEADLINE_MS,
  FINALIZE_DRAFT_ACTION_DEADLINE_MS,
  FINALIZE_AUDIT_ACTION_DEADLINE_MS,
  FINALIZE_FULL_AUDIT_DEADLINE_MS,
  DOC_ROOT,
  STANDING_RULES_WARNING_SIZE,
  resolveFinalizeBanner,
} from "../config.js";
import { splitForArchive, utf8ByteLength, type ArchiveConfig } from "../utils/archive.js";

/** Sentinel used to signal that the finalize-commit deadline fired (S40 C4). */
const FINALIZE_COMMIT_DEADLINE_SENTINEL = Symbol("finalize.commit.deadline");

/** Sentinel used to signal that the finalize-draft deadline fired (S41). */
const FINALIZE_DRAFT_DEADLINE_SENTINEL = Symbol("finalize.draft.deadline");

/** Sentinel for the S208 MCP-1 audit deadlines -- the standalone action=audit
 *  bound and fullPhase's internal anti-hang bound both race against it. */
const FINALIZE_AUDIT_DEADLINE_SENTINEL = Symbol("finalize.audit.deadline");

/** S208 MCP-19: the render-failure diagnostic code emitted when a banner or
 *  widget render throws. These catches used to be log-only, so a finalization
 *  that shipped `finalization_banner_html: null` looked identical to one where
 *  the operator had switched the widget off. */
const BANNER_RENDER_FAILED = "BANNER_RENDER_FAILED";

import { resolveDocPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { logger } from "../utils/logger.js";
import { extractSection, parseNumberedList } from "../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount } from "../validation/handoff.js";
import { validateFile } from "../validation/index.js";
import { assembleSynthesisBundle, generateIntelligenceBrief, generatePendingDocUpdates, type SynthesisBundle } from "../ai/synthesize.js";
import {
  BANNER_SPEC_VERSION,
  parseTemplateBannerSpecVersion,
  renderFinalizationBannerHtml,
} from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { classifySession, injectPersistedRecommendation } from "../utils/session-classifier.js";
// S203 audit R27 (F-C1-11 / F-A2-13): the audit + banner seams now live in
// src/tools/finalize/. commitPhase deliberately stays here.
import {
  auditPhase,
  classifyUnfetchedDoc,
  compareHandoffBackupsNewestFirst,
} from "./finalize/audit.js";
import {
  FINALIZE_RENDER_CONTRACT,
  assembleFinalizeBanner,
  assembleFinalizeErrorBannerFields,
  countLivingDocumentsUpdated,
  type FinalizeBannerData,
} from "./finalize/banner.js";

export { countLivingDocumentsUpdated };
// D-FINALIZE-SPLIT F1: the draft + bridge seams now live in src/tools/finalize/.
// Every symbol finalize.ts exported before is re-exported here (public surface
// is pinned by tests/finalize-public-surface.test.ts).
import { bridgeDraftSections, type DraftBridgeResult } from "./finalize/bridge.js";
import {
  ARCHIVE_FILE_SUFFIX,
  DRAFT_RELEVANT_DOCS,
  DRAFT_SUMMARY_MAX_BYTES,
  buildDraftFilesProjection,
  composeDraftFiles,
  draftPhase,
  resolveDraftDeadline,
  resolveDraftSummary,
  resolveDraftTimeout,
  type ComposeDraftOutcome,
  type FinalizeDraftState,
} from "./finalize/draft.js";

export {
  ARCHIVE_FILE_SUFFIX,
  DRAFT_RELEVANT_DOCS,
  DRAFT_SUMMARY_MAX_BYTES,
  bridgeDraftSections,
  buildDraftFilesProjection,
  composeDraftFiles,
  resolveDraftDeadline,
  resolveDraftSummary,
  resolveDraftTimeout,
};
export type { ComposeDraftOutcome, DraftBridgeResult, FinalizeDraftState };
// D-FINALIZE-SPLIT F2: the archive / prune / architecture-metadata helpers now
// live in src/tools/finalize/lifecycle.ts. Every previously exported symbol is
// re-exported here (pinned by tests/finalize-public-surface.test.ts).
import {
  INSIGHTS_ARCHIVE_CONFIG,
  SESSION_LOG_ARCHIVE_CONFIG,
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
} from "./finalize/lifecycle.js";

export {
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
};
import { applyPendingDocUpdates, type ApplyPduResult } from "../utils/apply-pdu.js";
import { detectZwsHeaders } from "../utils/sanitize-content.js";
import { findUnloggedIds } from "../utils/unlogged-ids.js";
import { parseExistingDecisionIds } from "./log-decision.js";
import { parseExistingInsightIds } from "./log-insight.js";

// Robust JSON extraction (B.8) — implementation moved to
// src/utils/extract-json.ts (brief-s196c) so the openrouter quality gates can
// use it without a module cycle; re-exported here for existing importers.
export { extractJSON } from "../utils/extract-json.js";
import {
  FINALIZE_DRAFT_STATE_PATH,
} from "../config.js";


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
): Promise<{ decisionIds: Set<string> | null; insightIds: Set<string> | null; standingRulesBytes: number | null }> {
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

  // SRV-69: surface the standing-rules registry byte size so the commit path
  // can fire a finalize-time oversize tripwire (the registry has no archival
  // lifecycle). Measured from the source we already loaded — no extra fetch.
  const standingRulesBytes =
    standingRulesOutcome.ok && standingRulesOutcome.content !== null
      ? new TextEncoder().encode(standingRulesOutcome.content).length
      : null;

  return { decisionIds, insightIds, standingRulesBytes };
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
  // SRV-42 (brief-461): caller-owned cancellation. prism_finalize's commit
  // Promise.race aborts this on deadline so the in-flight atomic commit is
  // cancelled rather than abandoned (and left to land after the error turn).
  signal?: AbortSignal,
) {
  const warnings: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // 1 & 2. Backup current handoff and prune old versions — ONE shared tree
  // mutation (brief-460 / S170 post-mortem). The previous shape ran a
  // pushFile backup commit and a safeMutation prune commit in PARALLEL;
  // the two commits raced each other into MUTATION_CONFLICT retries
  // (observed live S170, backup pair 12:34:34–36Z). A single commit cannot
  // race itself, and safeMutation's 409-retry still covers external
  // writers. The plan reads (handoff fetch, history listing) stay parallel
  // and fail independently — backup-plan failure does not block pruning
  // and vice versa; both remain non-fatal to the finalize.
  const [backupPlan, prunePlan] = await Promise.all([
    // 1. Plan the backup write.
    (async (): Promise<{ path: string; content: string; version: number } | null> => {
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
          return null;
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
        return { path: backupPath, content: backupContent, version: currentVersion };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("Not found")) {
          warnings.push(`Failed to backup current handoff: ${msg}`);
        }
        return null;
      }
    })(),

    // 2. Plan the prune deletes (keep only the 3 newest existing versions).
    //    safeMutation with `deletes` per S62 audit (Phase 1 Brief 1,
    //    Change 5); numeric-aware sort per SRV-05.
    (async (): Promise<string[]> => {
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
        return [];
      }

      const handoffFiles = historyEntries
        .filter((e) => e.name.startsWith("handoff_v") && e.name.endsWith(".md"))
        .sort(compareHandoffBackupsNewestFirst);

      if (handoffFiles.length <= 3) return [];
      return handoffFiles.slice(3).map((f) => f.path);
    })(),
  ]);

  // SRV-48 (brief-461): the backup + prune WRITE is deferred into this closure
  // and only invoked AFTER validation passes. Previously it committed before
  // validation, so a validation-failed finalize had already mutated the repo
  // (the atomic-commit primitive had already run via safeMutation). Defining it
  // here keeps backupPlan / prunePlan in closure scope; the call site is below
  // the validation gate.
  let backupPath = "";
  const writeBackupAndPrune = async (): Promise<void> => {
    if (backupPlan === null && prunePlan.length === 0) return;
    const pruneSuffix = prunePlan.length > 0
      ? ` + prune ${prunePlan.length} old backup${prunePlan.length === 1 ? "" : "s"}`
      : "";
    const commitMessage = backupPlan !== null
      ? `prism: handoff-backup v${backupPlan.version}${pruneSuffix}`
      : `chore: prune ${prunePlan.length} old handoff backup${prunePlan.length === 1 ? "" : "s"}`;

    const backupMutation = await safeMutation({
      repo: projectSlug,
      commitMessage,
      readPaths: [],
      diagnostics,
      signal,
      computeMutation: () => ({
        writes: backupPlan !== null
          ? [{ path: backupPlan.path, content: backupPlan.content }]
          : [],
        deletes: prunePlan,
      }),
    });

    if (backupMutation.ok) {
      // backup_created must not name a path for a backup that was never
      // written (SRV-18) — only a committed mutation sets it.
      backupPath = backupPlan?.path ?? "";
    } else {
      if (backupPlan !== null) {
        warnings.push(
          `Failed to backup current handoff: ${backupMutation.error ?? "commit failed"}`,
        );
      }
      if (prunePlan.length > 0) {
        diagnostics.warn(
          "DELETE_FILE_FAILED",
          `Failed to prune handoff-history: ${backupMutation.error}`,
          { code: backupMutation.code, pathCount: prunePlan.length },
        );
      }
    }
  };

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
          diagnostics.warn(
            "HANDOFF_SCHEMA_MISSING",
            "Supplied handoff.md has a '## Meta' header but its body did not match the expected schema (Handoff Version / Session Count / Template Version / Status) — persisted session recommendation was NOT injected; next boot shows the previous recommendation.",
            { section: "## Meta", consequence: "recommendation_not_injected" },
          );
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
      // brief-460 / S170 post-mortem: this was a logger-only (silent)
      // failure discovered live when the phased commit ran with operator-
      // built handoff content. The commit phase REQUIRES the handoff schema
      // ('## Meta' + '## Where We Are', see tool description) — surface the
      // gap as an operator-visible diagnostic, not just a Railway log line.
      logger.warn("persisted recommendation skipped — no ## Meta section in handoff", {
        projectSlug,
        sessionNumber,
      });
      diagnostics.warn(
        "HANDOFF_SCHEMA_MISSING",
        "Supplied handoff.md content has no '## Meta' section (Handoff Version / Session Count / Template Version / Status). The commit phase requires the handoff schema: validation will reject the file, and the persisted session recommendation cannot be injected.",
        { section: "## Meta", consequence: "recommendation_not_injected; validation_will_reject" },
      );
    }

    // brief-460 / S170 post-mortem: '## Where We Are' is the other half of
    // the phased-commit schema requirement — validation rejects when it is
    // absent, and the finalization banner's resumption line silently
    // degrades to a generic pointer when it is empty. Name it explicitly.
    const whereWeAreBody = extractSection(handoffFile.content, "Where We Are")
      ?? extractSection(handoffFile.content, "Current State");
    if (whereWeAreBody === null || whereWeAreBody.trim() === "") {
      diagnostics.warn(
        "HANDOFF_SCHEMA_MISSING",
        "Supplied handoff.md content has no non-empty '## Where We Are' section. The commit phase requires it: validation will reject the file, and the finalization banner cannot derive a resumption point.",
        { section: "## Where We Are", consequence: "banner_resumption_degraded; validation_will_reject" },
      );
    }
  }

  // SRV-48 (brief-461): validation MOVED below the archive + task-queue prune
  // mutations (see step 3, after ZWS detection) so it covers the FINAL files[]
  // — including injected archive files and pruned content — instead of the
  // pre-mutation form. No repo writes happen before that validation gate.

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

      // brief-459 / SRV-06: inject the archive filename so splitForArchive
      // emits/repairs the trailing EOF sentinel — single-sourced from this
      // call's own archiveFileName argument.
      const result = splitForArchive(liveContent, existingArchive, {
        ...config,
        archiveFileName,
      });

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
          // SRV-30: log the same unit the threshold is measured in.
          liveSizeBytes: utf8ByteLength(result.liveContent),
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

  // 3c. brief-460 / SRV-78: ZWS contamination detection. Finalize is a
  // full-document channel (intentionally unsanitized — the files ARE the
  // document structure), and no read path strips U+200B, so headers
  // neutralized by the pre-brief-460 sanitizer flow back in here forever.
  // Detect the signature and surface it; repairing the bytes is M-041
  // (operator-driven, prism repo) — this commit writes them as supplied.
  for (const file of files) {
    const contaminated = detectZwsHeaders(file.content);
    if (contaminated.length > 0) {
      diagnostics.warn(
        "ZWS_CONTAMINATION_DETECTED",
        `${file.path} contains ${contaminated.length} ZWS-neutralized header(s) — invisible corruption from a pre-brief-460 sanitizer write (repair: M-041). First: "${contaminated[0].header}" (line ${contaminated[0].line}).`,
        {
          path: file.path,
          lines: contaminated.slice(0, 20).map((c) => ({ line: c.line, header: c.header })),
          total: contaminated.length,
        },
      );
    }
  }

  // 3d. Validate the FINAL files[] — AFTER all in-memory mutations
  //     (recommendation injection, archive lifecycle, task-queue prune) so the
  //     committed bytes, including injected archive files and pruned content,
  //     are exactly what is validated (SRV-48). Crucially, NO repo write has
  //     happened yet: a validation failure here returns with the repo
  //     untouched (no backup, no prune, no atomic commit).
  const validationResults = files.map((file) => {
    const result = validateFile(file.path, file.content);
    return { path: file.path, ...result };
  });

  // SRV-59: cross-check the committed handoff's Meta against the call params.
  // A silent mismatch means the next boot reads a version/session that does
  // not match what was finalized. Warning-level — never blocks the commit.
  const committedHandoff = files.find(
    (f) => f.path === "handoff.md" || f.path === `${DOC_ROOT}/handoff.md`,
  );
  if (committedHandoff) {
    const metaVersion = parseHandoffVersion(committedHandoff.content);
    const metaSession = parseSessionCount(committedHandoff.content);
    if (metaVersion !== null && metaVersion !== handoffVersion) {
      diagnostics.warn(
        "HANDOFF_VERSION_MISMATCH",
        `Committed handoff Meta 'Handoff Version: ${metaVersion}' does not match finalize handoff_version=${handoffVersion}; the next boot will read ${metaVersion}.`,
        { metaVersion, paramVersion: handoffVersion },
      );
    }
    if (metaSession !== null && metaSession !== sessionNumber) {
      diagnostics.warn(
        "HANDOFF_SESSION_MISMATCH",
        `Committed handoff Meta 'Session Count: ${metaSession}' does not match finalize session_number=${sessionNumber}.`,
        { metaSession, paramSession: sessionNumber },
      );
    }
  }

  const hasValidationErrors = validationResults.some((r) => r.errors.length > 0);
  if (hasValidationErrors) {
    return {
      project: projectSlug,
      session_number: sessionNumber,
      handoff_version: handoffVersion,
      // SRV-48: "" — no backup/prune write happened before the validation gate.
      backup_created: backupPath,
      results: validationResults.map((r) => ({
        path: r.path,
        success: false,
        size_bytes: 0,
        verified: false,
        validation_errors: r.errors,
        validation_warnings: r.warnings, // SRV-20
      })),
      living_documents_updated: 0,
      all_succeeded: false,
      diagnostics: diagnostics.list(),
      confirmation: `Session ${sessionNumber} finalization FAILED — validation errors detected.`,
    };
  }

  // 3e. INS-360 recreate guard (brief-s201c) — before ANY repo write, verify
  // the current state of every mandatory living document in files[]. A doc
  // that resolves is a normal update (behavior unchanged). A doc that does
  // NOT resolve may be created ONLY when its absence is CONFIRMED (definitive
  // 404 + zero commit history at both layouts, via classifyUnfetchedDoc); any
  // unverifiable state refuses the whole commit — pushing operator/draft
  // content over a doc the server cannot currently read is the S191/S192
  // history-overwrite class. Atomic-only philosophy (S62 Verdict C): refusal
  // blocks the entire commit rather than tearing the finalize.
  const recreateBlocks = new Map<string, string>();
  {
    const seen = new Set<string>();
    const guardCandidates: Array<{ suppliedPath: string; bareName: string }> = [];
    for (const file of files) {
      const bareName = file.path.startsWith(`${DOC_ROOT}/`)
        ? file.path.slice(DOC_ROOT.length + 1)
        : file.path;
      if (!(LIVING_DOCUMENT_NAMES as readonly string[]).includes(bareName)) continue;
      if (seen.has(bareName)) continue;
      seen.add(bareName);
      guardCandidates.push({ suppliedPath: file.path, bareName });
    }
    await Promise.all(
      guardCandidates.map(async ({ suppliedPath, bareName }) => {
        try {
          await resolveDocPath(projectSlug, bareName);
          return; // Doc exists — this push is an update, not a recreation.
        } catch (fetchError) {
          const outcome = await classifyUnfetchedDoc(projectSlug, bareName, fetchError);
          if (outcome.classification === "needs_creation") {
            return; // Confirmed absent — creating the missing doc is allowed.
          }
          recreateBlocks.set(
            suppliedPath,
            `FINALIZE_RECREATE_BLOCKED: ${bareName} is in an unverified state (${outcome.reason}) — refusing to push a from-scratch replacement for a mandatory living document (INS-360).`,
          );
          diagnostics.error(
            "FINALIZE_RECREATE_BLOCKED",
            `${bareName}: current state could not be verified (${outcome.reason}) — commit refused. Creation is allowed only after a confirmed 404 with zero commit history; retry when GitHub reads recover (INS-360).`,
            { doc: bareName, path: suppliedPath, error: outcome.reason },
          );
          logger.error("finalize commit: recreate guard blocked living-doc push (INS-360)", {
            projectSlug,
            doc: bareName,
            error: outcome.reason,
          });
        }
      }),
    );
  }
  if (recreateBlocks.size > 0) {
    return {
      project: projectSlug,
      session_number: sessionNumber,
      handoff_version: handoffVersion,
      // No repo write has happened — the guard sits above writeBackupAndPrune.
      backup_created: backupPath,
      results: files.map((file, idx) => ({
        path: file.path,
        success: false,
        size_bytes: 0,
        verified: false,
        validation_errors: recreateBlocks.has(file.path)
          ? [recreateBlocks.get(file.path)!]
          : [],
        validation_warnings: validationResults[idx]?.warnings ?? [],
      })),
      living_documents_updated: 0,
      all_succeeded: false,
      diagnostics: diagnostics.list(),
      confirmation: `Session ${sessionNumber} finalization REFUSED — ${recreateBlocks.size} living document(s) in an unverified state; nothing was pushed (INS-360 recreate guard).`,
    };
  }

  // SRV-48: validation passed — perform the deferred backup + prune write now.
  // Every repo write is below this gate (and below the INS-360 recreate guard),
  // so a validation-failed or recreate-refused finalize never mutates the repo.
  await writeBackupAndPrune();

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
    signal,
    computeMutation: () => ({ writes: guardedFiles }),
  });

  let results: Array<{
    path: string;
    success: boolean;
    size_bytes: number;
    verified: boolean;
    validation_errors: string[];
    validation_warnings: string[];
  }>;

  if (safeMutationResult.ok) {
    // SRV-20: carry per-file validation_warnings through the success path
    // (index-aligned: guardedFiles, files, and validationResults share order).
    results = guardedFiles.map((f, idx) => ({
      path: f.path,
      success: true,
      size_bytes: new TextEncoder().encode(f.content).length,
      verified: true,
      validation_errors: [],
      validation_warnings: validationResults[idx]?.warnings ?? [],
    }));
  } else {
    warnings.push(`Atomic commit failed: ${safeMutationResult.error}`);
    results = guardedFiles.map((f, idx) => ({
      path: f.path,
      success: false,
      size_bytes: 0,
      verified: false,
      validation_errors: ["Atomic commit failed", safeMutationResult.error],
      validation_warnings: validationResults[idx]?.warnings ?? [],
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
    // SRV-69: finalize-time standing-rules registry oversize tripwire. The
    // registry is on three hot read paths but had no size lifecycle; warn the
    // operator past the threshold (mirrors handoff.md's size warning). Surface
    // only — curation is the operator's call (Tier A has no lazy-load recovery).
    if (
      registry.standingRulesBytes !== null &&
      registry.standingRulesBytes > STANDING_RULES_WARNING_SIZE
    ) {
      diagnostics.warn(
        "STANDING_RULES_OVERSIZE",
        `standing-rules.md is ${(registry.standingRulesBytes / 1024).toFixed(1)}KB — over the ${(STANDING_RULES_WARNING_SIZE / 1024).toFixed(0)}KB registry tripwire. It is on three hot read paths (boot/load_rules/synthesis) with no archival lifecycle — consider retiring superseded/expired rules (operator-curated; Tier A has no lazy-load recovery).`,
        { standing_rules_bytes: registry.standingRulesBytes, threshold_bytes: STANDING_RULES_WARNING_SIZE },
      );
      logger.warn("standing-rules registry oversize at finalize", {
        projectSlug,
        sessionNumber,
        standingRulesBytes: registry.standingRulesBytes,
      });
    }
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
        pduResult = await applyPendingDocUpdates(projectSlug, sessionNumber, signal);
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
        pduResult = { applied: [], skipped: [], errors: [{ title: "(applyPendingDocUpdates)", error: msg }], sanitized: [], cleared: false, archived: false };
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
    // Registered so the shutdown drain awaits this leg on deploy (R26 /
    // F-C1-10) — this is the promise a Railway SIGTERM previously killed
    // mid-flight, unlogged.
    void registerInflight((async () => {
      // brief-465 / SRV-73: assemble the synthesis input bundle ONCE and share
      // it across BOTH calls — the brief and PDU bundles are byte-identical
      // (~103K tokens), and were previously fetched + assembled + sent twice per
      // finalize. If the shared assembly fails, each call falls back to building
      // its own (the pre-brief-465 behavior), preserving resilience.
      let bundle: SynthesisBundle | undefined;
      try {
        bundle = await assembleSynthesisBundle(projectSlug, sessionNumber);
      } catch (err) {
        logger.warn("shared synthesis bundle assembly failed — each call assembles independently", {
          projectSlug,
          sessionNumber,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return Promise.allSettled([
        generateIntelligenceBrief(projectSlug, sessionNumber, bundle),
        pduResult && pduResult.errors.length > 0
          ? Promise.resolve({ success: false, error: "Pending updates retained for reconciliation; automatic replacement skipped" })
          : generatePendingDocUpdates(projectSlug, sessionNumber, bundle),
      ]);
    })()
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
      }), "finalize_post_commit_synthesis");
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
    synthesis_status_hint: synthesisStatusHint,
    // brief-422: surface non-fatal post-commit sweep outcomes so the operator
    // can see what landed beyond the main commit. Null when sweeps did not run
    // (skip_synthesis, commit failure, or synthesis disabled). Populated arrays
    // even when empty are still informative — they confirm the sweeps ran.
    pdu_applied: pduResult?.applied ?? null,
    pdu_skipped: pduResult?.skipped ?? null,
    pdu_errors: pduResult?.errors ?? null,
    // brief-460 / SRV-46: sanitizer mutations on the unattended auto-apply
    // channel — visible here because nobody watches the apply itself.
    pdu_sanitized: pduResult?.sanitized ?? null,
    pdu_cleared: pduResult?.cleared ?? null,
    pdu_archived: pduResult?.archived ?? null,   // brief-444: consumed-batch provenance archived
    architecture_updated: architectureResult?.updated ?? null,
    architecture_update_reason: architectureResult?.reason ?? null,
    task_queue_pruned: taskQueuePruned,
    // SRV-18: non-fatal commit-phase warnings (failed handoff backup, atomic
    // commit failure detail) were previously collected and then discarded —
    // surface them so the operator can see what didn't land.
    warnings,
    confirmation: allSucceeded
      ? `Session ${sessionNumber} finalized. Handoff v${handoffVersion} pushed and verified. ${livingDocsUpdated}/${LIVING_DOCUMENTS.length} living documents updated.${synthesisOutcome === "background" ? " Intelligence brief synthesizing in background." : synthesisOutcome === "skipped" ? " Synthesis skipped." : ""}`
      : `Session ${sessionNumber} finalization partially failed. ${succeeded.length}/${files.length} files pushed.`,
  };
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
  bannerData?: FinalizeBannerData,
) {
  const diagnostics = new DiagnosticsCollector();

  // Step 1 — Audit.
  //
  // S208 MCP-1d: the audit fans out ten repo reads plus a commit-history probe
  // per unfetched doc, and it ran here with NO bound at all — a single hung
  // read stalled the whole background finalize indefinitely. Race it against
  // FINALIZE_FULL_AUDIT_DEADLINE_MS (a hang breaker, deliberately far wider
  // than the interactive action bound). The losing promise is left to settle
  // with its rejection swallowed; the timer is unref'd and cleared in a
  // finally block (the push.ts:73-75/:307 pattern).
  let auditResult: Awaited<ReturnType<typeof auditPhase>> | null = null;
  let auditTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const auditWork = auditPhase(projectSlug, sessionNumber, diagnostics);
    auditWork.catch(() => {});
    const auditDeadline = new Promise<typeof FINALIZE_AUDIT_DEADLINE_SENTINEL>((resolve) => {
      auditTimer = setTimeout(
        () => resolve(FINALIZE_AUDIT_DEADLINE_SENTINEL),
        FINALIZE_FULL_AUDIT_DEADLINE_MS,
      );
      auditTimer.unref?.();
    });
    const racedAudit = await Promise.race([auditWork, auditDeadline]);
    if (racedAudit !== FINALIZE_AUDIT_DEADLINE_SENTINEL) auditResult = racedAudit;
  } finally {
    if (auditTimer) clearTimeout(auditTimer);
  }

  const auditExpired = auditResult === null;
  if (auditExpired) {
    const deadlineSec = Math.round(FINALIZE_FULL_AUDIT_DEADLINE_MS / 1000);
    logger.error("fullPhase audit deadline exceeded", {
      projectSlug,
      deadlineMs: FINALIZE_FULL_AUDIT_DEADLINE_MS,
    });
    diagnostics.error(
      "FINALIZE_AUDIT_DEADLINE_EXCEEDED",
      `Audit deadline exceeded (${deadlineSec}s) — finalization continues FAIL-CLOSED: every living document counts unverified, so no from-scratch file draft may be committed over live history (INS-360). The bridged section keys (session_log_entry, task_queue_*) are unaffected and still commit.`,
      { deadlineMs: FINALIZE_FULL_AUDIT_DEADLINE_MS, degradation: "all_docs_unverified" },
    );
  }

  const auditStatus = auditExpired
    ? "warn"
    : auditResult!.audit.living_documents.some(d => !d.exists) ? "warn" : "ok";
  const auditWarnings = auditExpired
    ? [`Audit deadline exceeded (${Math.round(FINALIZE_FULL_AUDIT_DEADLINE_MS / 1000)}s) — living-document inventory unverified.`]
    : auditResult!.audit.warnings;
  // MCP-2: the count the audit already parsed, handed to the banner so the
  // finalization banner needs no repo read of its own on this path.
  const auditDecisionCount = auditExpired ? null : auditResult!.decision_count;

  // INS-360 recreate guard (audit-coupled half): docs whose state the audit
  // could not verify must never receive a from-scratch full-file draft — the
  // `.md` pass-through below would otherwise push a model-generated
  // replacement over live history (the S192 incident shape).
  //
  // MCP-1d fail-closed: an EXPIRED audit verified nothing, so every living
  // document goes into this set. The guard then drops file-shaped draft keys
  // (FINALIZE_RECREATE_BLOCKED) while the brief-456 BRIDGED keys — which do
  // not consult this set — still commit. That is the whole degradation.
  const unverifiedDocs = new Set(
    auditExpired
      ? (LIVING_DOCUMENT_NAMES as readonly string[])
      : auditResult!.audit.living_documents
          .filter((d) => d.status === "unverified")
          .map((d) => d.file),
  );

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
  // brief-s202b T8: fullPhase pins composeMode=legacy — it already composes
  // server-side via the bridge below and needs no persistence round-trip.
  const draftWork = draftPhase(projectSlug, sessionNumber, { composeMode: "legacy", diagnostics });
  const raced = await Promise.race([draftWork, draftDeadlinePromise]);
  if (draftDeadlineTimer) clearTimeout(draftDeadlineTimer);

  if (raced === FINALIZE_DRAFT_DEADLINE_SENTINEL) {
    draftStatus = "warn";
    draftResult = null;
    logger.warn("fullPhase draft deadline exceeded", { projectSlug, deadlineMs: draftDeadlineMs });
    // brief-456 (SRV-19 visibility): deadline overruns were log-only —
    // surface them in the response diagnostics too.
    diagnostics.warn(
      "DRAFT_DEADLINE_EXCEEDED",
      `fullPhase draft deadline exceeded (${draftDeadlineMs}ms) — committing without draft`,
      { deadlineMs: draftDeadlineMs },
    );
  } else {
    draftResult = raced;
    draftStatus = draftResult.success === false ? "warn" : "ok";
    if (draftResult.success === false) {
      diagnostics.warn(
        "DRAFT_FAILED",
        `draft generation failed: ${("error" in draftResult && draftResult.error) || "unknown error"}`,
        {},
      );
    }
  }

  // Step 3 — Assemble files[]
  const files: Array<{path: string; content: string}> = [
    { path: "handoff.md", content: handoffContent },
  ];

  let draftBridge: DraftBridgeResult | null = null;
  if (draftResult?.success && "drafts" in draftResult && draftResult.drafts && typeof draftResult.drafts === "object") {
    const draftsObj = draftResult.drafts as Record<string, unknown>;
    for (const [key, value] of Object.entries(draftsObj)) {
      if (typeof value !== "string") continue;
      if (key === "handoff.md") continue; // operator-supplied takes precedence
      if (key.endsWith(".md") || (DRAFT_RELEVANT_DOCS as readonly string[]).includes(key)) {
        // INS-360 recreate guard: never commit a from-scratch draft for a doc
        // the audit classified `unverified` (fetch failed, absence unconfirmed).
        const bareKey = key.startsWith(`${DOC_ROOT}/`)
          ? key.slice(DOC_ROOT.length + 1)
          : key;
        if (unverifiedDocs.has(bareKey)) {
          diagnostics.warn(
            "FINALIZE_RECREATE_BLOCKED",
            `draft key ${key} dropped — ${bareKey} is unverified (the audit could not confirm its current state); a from-scratch draft replacement risks overwriting live history (INS-360)`,
            { key, doc: bareKey },
          );
          continue;
        }
        files.push({ path: key, content: value });
      }
    }

    // brief-456 (SRV-19): the FINALIZATION_DRAFT_PROMPT contract emits
    // section-shaped keys (session_log_entry, task_queue_*) — none end in
    // .md, so the pass-through above discarded the entire draft and full
    // finalization committed ONLY handoff.md. Translate the contract keys
    // into real doc mutations. Fetch only the docs the draft targets; a
    // fetch failure skips that key with a visible diagnostic — it never
    // aborts the finalize.
    const wantsSessionLog =
      typeof draftsObj.session_log_entry === "string" &&
      draftsObj.session_log_entry.trim().length > 0;
    const wantsTaskQueue =
      (Array.isArray(draftsObj.task_queue_completed) && draftsObj.task_queue_completed.length > 0) ||
      (Array.isArray(draftsObj.task_queue_new) && draftsObj.task_queue_new.length > 0);
    const currentDocs: { sessionLog?: string; taskQueue?: string } = {};
    if (wantsSessionLog) {
      try {
        currentDocs.sessionLog = (await resolveDocPath(projectSlug, "session-log.md")).content;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          "DRAFT_BRIDGE_FETCH_FAILED",
          `session-log.md fetch failed — session_log_entry not bridged: ${msg}`,
          { doc: "session-log.md" },
        );
      }
    }
    if (wantsTaskQueue) {
      try {
        currentDocs.taskQueue = (await resolveDocPath(projectSlug, "task-queue.md")).content;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        diagnostics.warn(
          "DRAFT_BRIDGE_FETCH_FAILED",
          `task-queue.md fetch failed — task-queue mutations not bridged: ${msg}`,
          { doc: "task-queue.md" },
        );
      }
    }
    draftBridge = bridgeDraftSections(draftsObj, currentDocs);
    for (const bridged of draftBridge.files) {
      // A file-shaped draft key for the same doc wins — don't double-add.
      if (!files.some((existing) => existing.path === bridged.path)) {
        files.push(bridged);
      }
    }
    for (const skip of draftBridge.skipped) {
      diagnostics.info("DRAFT_KEY_SKIPPED", `draft key ${skip.key} not bridged: ${skip.reason}`, {
        key: skip.key,
        reason: skip.reason,
      });
    }
  }

  // Step 4 — Commit. SRV-58 (brief-461): fullPhase previously called
  // commitPhase directly with NO deadline, while the commit action wrapped the
  // identical call in the FINALIZE_COMMIT_DEADLINE race. Apply the same race +
  // AbortController-cancellation here so action=full's commit step is bounded
  // and a timed-out commit is cancelled, not abandoned.
  const fullCommitAbort = new AbortController();
  let fullCommitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const fullCommitDeadlinePromise = new Promise<typeof FINALIZE_COMMIT_DEADLINE_SENTINEL>((resolve) => {
    fullCommitDeadlineTimer = setTimeout(() => {
      fullCommitAbort.abort();
      resolve(FINALIZE_COMMIT_DEADLINE_SENTINEL);
    }, FINALIZE_COMMIT_DEADLINE_MS);
  });
  const fullCommitRaced = await Promise.race([
    commitPhase(
      projectSlug,
      sessionNumber,
      handoffVersion,
      files,
      skipSynthesis,
      diagnostics,
      fullCommitAbort.signal,
    ),
    fullCommitDeadlinePromise,
  ]);
  if (fullCommitDeadlineTimer) clearTimeout(fullCommitDeadlineTimer);

  if (fullCommitRaced === FINALIZE_COMMIT_DEADLINE_SENTINEL) {
    const deadlineSec = Math.round(FINALIZE_COMMIT_DEADLINE_MS / 1000);
    logger.error("fullPhase commit deadline exceeded", {
      projectSlug,
      deadlineMs: FINALIZE_COMMIT_DEADLINE_MS,
    });
    diagnostics.error(
      "SYNTHESIS_TIMEOUT",
      `Commit deadline exceeded (${deadlineSec}s)`,
      { deadlineMs: FINALIZE_COMMIT_DEADLINE_MS },
    );
    return {
      action: "full" as const,
      project: projectSlug,
      session_number: sessionNumber,
      handoff_version: handoffVersion,
      all_succeeded: false,
      error: `prism_finalize full commit deadline exceeded (${deadlineSec}s)`,
      // SRV-49: describe the real partial surface (see the commit action).
      partial_state_warning:
        "Commit deadline exceeded. The final doc commit is atomic (all-or-nothing) and was signaled to abort — verify the repo HEAD before retrying. Pre-commit steps (handoff backup, history prune) may already have committed; a retry does not duplicate archived entries (SRV-47).",
      phases: {
        audit: { status: auditStatus, warnings: auditWarnings },
        draft: { status: draftStatus },
        commit: { all_succeeded: false },
      },
      ...assembleFinalizeErrorBannerFields(sessionNumber, handoffVersion),
      finalize_render_contract: FINALIZE_RENDER_CONTRACT,
      diagnostics: diagnostics.list(),
    };
  }
  const commitResult = fullCommitRaced;

  // Step 5 — Finalization banner (brief-439 / R8 + brief-447 / D-249).
  // fullPhase previously returned no banner at all; the unified generator now
  // serves all finalize surfaces. Real audit/draft outcomes feed the step row;
  // operator-supplied step_statuses still win. assembleFinalizeBanner returns
  // both the text banner and a structured htmlInput — fullPhase emits the HTML
  // widget too (D-249 follow-up), matching the commit surface (below).
  const { text: bannerText, htmlInput } = await assembleFinalizeBanner(
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
    diagnostics, // R19: BANNER_DELIVERABLES_TRUNCATED rides out on the response
    auditDecisionCount, // MCP-2: reuse the audit's count, no extra repo read
  );

  // brief-447 / D-249: populate finalization_banner_html from the same
  // finalize data. Wrapped so an HTML render failure (or a null htmlInput
  // from the text fallback path) leaves the field null — banner_text is the
  // genuine fallback. Mirrors the commit surface's render block.
  // OPS-2 (S208): FINALIZE_BANNER=off skips the render entirely and ships
  // null; banner_text is deliberately untouched by the knob.
  let finalization_banner_html: string | null = null;
  if (htmlInput && resolveFinalizeBanner() === "html") {
    try {
      finalization_banner_html = renderFinalizationBannerHtml(htmlInput);
    } catch (htmlErr) {
      const msg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
      logger.warn("finalization HTML widget render failed — leaving null (banner_text fallback)", {
        project_slug: projectSlug,
        error: msg,
      });
      // MCP-19: this catch was log-only, so a null widget field was
      // indistinguishable from the knob being off.
      diagnostics.warn(
        BANNER_RENDER_FAILED,
        `finalization_banner_html render failed — the field is null and banner_text carries the banner: ${msg}`,
        { surface: "finalization_banner_html", error: msg },
      );
    }
  }

  // brief-456 (SRV-19): a generated draft must never be silently discarded
  // on downstream failure — when the commit did not fully succeed, return
  // the raw drafts so the operator can apply them manually.
  //
  // S203 audit R22 (F-C1-3): an UNPARSEABLE draft rides out regardless of the
  // commit outcome. Nothing bridged from it, so a fully-succeeded commit is
  // exactly the case where the model's output would otherwise vanish.
  const parsedDrafts =
    draftResult?.success &&
    "drafts" in draftResult &&
    draftResult.drafts &&
    typeof draftResult.drafts === "object"
      ? (draftResult.drafts as Record<string, unknown>)
      : null;
  const unparsedDraftText =
    draftResult && "raw_content" in draftResult && typeof draftResult.raw_content === "string"
      ? draftResult.raw_content
      : null;
  const draftRecovery: Record<string, unknown> | null =
    unparsedDraftText !== null
      ? { raw_content: unparsedDraftText }
      : !commitResult.all_succeeded && parsedDrafts
        ? parsedDrafts
        : null;
  if (draftRecovery) {
    diagnostics.warn(
      "DRAFT_NOT_COMMITTED",
      unparsedDraftText !== null
        ? "draft output could not be parsed as JSON — raw model text preserved in draft_recovery for manual application"
        : "commit did not fully succeed — generated draft preserved in draft_recovery for manual application",
      {},
    );
  }

  // Step 6 — Return combined result.
  // Note: commitResult already contains project, session_number, handoff_version etc.
  // action and phases are unique to fullPhase; diagnostics overrides the one inside commitResult.
  return {
    action: "full" as const,
    phases: {
      audit: { status: auditStatus, warnings: auditWarnings },
      draft: {
        status: draftStatus,
        input_tokens: draftResult && "input_tokens" in draftResult ? draftResult.input_tokens : 0,
        output_tokens: draftResult && "output_tokens" in draftResult ? draftResult.output_tokens : 0,
      },
      commit: { all_succeeded: commitResult.all_succeeded, living_documents_updated: commitResult.living_documents_updated },
    },
    ...commitResult,
    // brief-456 (SRV-19): bridge visibility + draft preservation.
    draft_bridge: draftBridge
      ? { bridged: draftBridge.bridged, skipped: draftBridge.skipped }
      : null,
    draft_recovery: draftRecovery,
    banner_text: bannerText,                    // brief-439 / R8: unified generator output
    banner_spec_version: BANNER_SPEC_VERSION,   // brief-439 / R8: banner contract version this server emits
    finalization_banner_html,                   // brief-447 / D-249: HTML widget now emitted on the full surface too (matching the commit surface; null on render failure — banner_text is the fallback)
    finalize_render_contract: FINALIZE_RENDER_CONTRACT, // S203 audit R11 (F-A2-3/F-D3)
    diagnostics: diagnostics.list(),
  };
}

/**
 * Register the prism_finalize tool on an MCP server instance.
 */
export function registerFinalize(server: McpServer): void {
  server.tool(
    "prism_finalize",
    "PRISM finalization. Actions: prepare_checkpoint (read-only: derive a native compatibility handoff from an already-published, revision-pinned dated checkpoint; returns a candidate, never commits or finalizes), audit (document inventory + drift), draft (AI-generated files; in compose mode returns validated draft_files + a review digest and persists them server-side), commit (backup + push + validate; use_draft_files: true commits the persisted draft so chat approves instead of regenerating), full (single call: audit + draft + commit). Phased commit (action=commit with operator-built files): handoff.md content MUST carry the handoff schema — '## Meta' (Handoff Version / Session Count / Template Version / Status), '## Critical Context' (>=1 numbered item), and a non-empty '## Where We Are' — validation rejects it otherwise, and recommendation injection + banner resumption read the same sections (HANDOFF_SCHEMA_MISSING diagnostic names any gap). Deadlines: action=audit is bounded at the ~50s MCP client ceiling and returns a structured FINALIZE_AUDIT_DEADLINE_EXCEEDED response rather than hanging; the INTERACTIVE action=draft race is bounded the same way, so a large-project draft that needs longer belongs on action=full. action=full is intended for the Trigger / Claude Code caller, which drives this server WITHOUT the ~60s client turn ceiling: its draft step runs as a background phase on the wider 180s (300s under SYNTHESIS_DRAFT_TRANSPORT=cc_subprocess) deadline, its internal audit carries a 120s anti-hang bound that degrades fail-closed (unverified docs are never recreated from a draft), and worst-case it can run several minutes. A chat client CAN call action=full - the action enum cannot prevent it - but that turn is bounded by the chat client's own ceiling, so the chat path should run the phased audit -> draft -> commit sequence instead. Every commit and full response also carries finalize_render_contract: the RENDER + FALLBACK + CONFIRM obligations for the returned banner, which are NOT to be memorized from boot.",
    {
      project_slug: z.string().describe("Project repo name"),
      action: z.enum(["audit", "draft", "commit", "full", "prepare_checkpoint"]).describe("Finalization phase: 'prepare_checkpoint' for read-only compatibility preparation, 'audit' for document inventory, 'draft' for AI-generated file drafts, 'commit' to push final files, 'full' (single call: audit + draft + commit)"),
      session_number: z.number().describe("Current session number"),
      handoff_version: z.number().optional().describe("New handoff version (commit or prepare_checkpoint; required for preparation)"),
      files: z
        .array(
          z.object({
            path: z.string().describe("File path relative to repo root"),
            content: z.string().describe("File content to push"),
          })
        )
        .optional()
        .describe("Files to push (commit phase only). With use_draft_files: true, entries here OVERRIDE the persisted draft file with the same path (per-file accept/override)."),
      use_draft_files: z
        .boolean()
        .optional()
        .describe("Commit phase only (brief-s202b F-1): commit the server-persisted draft files from the last action=draft (validated at draft time and re-validated here) instead of regenerating file content in chat. files[] entries override by path."),
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
        llm_usage: z.array(z.unknown()).optional(),
      }).optional().describe("Optional banner customization data (commit phase only)"),
      expected_published_handoff: z.object({
        ref: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i),
        path: z.string().regex(/^docs\/handoffs\/handoff-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/),
        sha: z.string().regex(/^[0-9a-f]{40}$/i),
      }).optional().describe("Required for prepare_checkpoint only: reviewed current main commit, canonical handoff path and blob SHA. Publication and historical freshness checks remain the caller's responsibility."),
      handoff_content: z.string().optional().describe("Complete handoff.md content (full action only)"),
    },
    async ({ project_slug, action, session_number, handoff_version, files, use_draft_files, skip_synthesis, banner_data, handoff_content, expected_published_handoff }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_finalize", { project_slug, action, session_number });

      try {
        if (expected_published_handoff && action !== "prepare_checkpoint") {
          throw new Error("expected_published_handoff is accepted only by read-only prepare_checkpoint; it does not guard a commit.");
        }
        if (action === "prepare_checkpoint") {
          if (!expected_published_handoff || handoff_version === undefined) {
            throw new Error("prepare_checkpoint requires expected_published_handoff and handoff_version.");
          }
          if (files !== undefined || use_draft_files !== undefined || handoff_content !== undefined) {
            throw new Error("prepare_checkpoint does not accept files, drafts or independently authored handoff content.");
          }
          const prepared = await preparePublishedCheckpointProjection(
            project_slug, expected_published_handoff,
            { sessionNumber: session_number, handoffVersion: handoff_version },
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              project: project_slug,
              action,
              ...prepared,
              writes_performed: false,
              finalized: false,
              publication_required: true,
              next_action: "Review the candidate against the complete canonical handoff. Reconcile historical freshness and reverify source before using the existing authorized publication path; preparation grants no write or lifecycle authorization.",
            }) }],
          };
        }
        if (action === "audit") {
          const phaseStart = Date.now();
          // INS-360: the shared collector carries FINALIZE_AUDIT_UNVERIFIED_DOC
          // diagnostics from the audit into this action's response.
          //
          // S208 MCP-1c: bound the INTERACTIVE audit at
          // FINALIZE_AUDIT_ACTION_DEADLINE_MS (MCP_SAFE_TIMEOUT by default).
          // This was the last finalize action with no deadline at all: the
          // ten-doc fan-out plus a commit-history probe per unfetched doc held
          // the client connection to the ~60s transport timeout with no
          // structured error, and the operator's retry started the fan-out
          // again. Same sentinel / Promise.race / clearTimeout shape as
          // prism_push (push.ts:73-75, :307).
          let auditDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
          let auditRaced: Awaited<ReturnType<typeof auditPhase>> | typeof FINALIZE_AUDIT_DEADLINE_SENTINEL;
          try {
            const auditWork = auditPhase(project_slug, session_number, diagnostics);
            auditWork.catch(() => {}); // the losing promise must never go unhandled
            const auditDeadline = new Promise<typeof FINALIZE_AUDIT_DEADLINE_SENTINEL>((resolve) => {
              auditDeadlineTimer = setTimeout(
                () => resolve(FINALIZE_AUDIT_DEADLINE_SENTINEL),
                FINALIZE_AUDIT_ACTION_DEADLINE_MS,
              );
              auditDeadlineTimer.unref?.();
            });
            auditRaced = await Promise.race([auditWork, auditDeadline]);
          } finally {
            if (auditDeadlineTimer) clearTimeout(auditDeadlineTimer);
          }

          if (auditRaced === FINALIZE_AUDIT_DEADLINE_SENTINEL) {
            const deadlineSec = Math.round(FINALIZE_AUDIT_ACTION_DEADLINE_MS / 1000);
            logger.error("prism_finalize audit deadline exceeded", {
              project_slug,
              deadlineMs: FINALIZE_AUDIT_ACTION_DEADLINE_MS,
              elapsedMs: Date.now() - phaseStart,
            });
            diagnostics.error(
              "FINALIZE_AUDIT_DEADLINE_EXCEEDED",
              `prism_finalize audit deadline exceeded (${deadlineSec}s) — the living-document fan-out did not settle. Nothing was written; re-run the audit, or proceed via the phased draft/commit path if the repo is known-healthy.`,
              { deadlineMs: FINALIZE_AUDIT_ACTION_DEADLINE_MS },
            );
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                project: project_slug,
                action: "audit",
                error: `prism_finalize audit deadline exceeded (${deadlineSec}s)`,
                // The audit is read-only — no partial-write surface to warn about.
                writes_performed: false,
                // MCP-3: action=audit never receives a handoff_version, so the
                // banner reports it as unknown rather than fabricating v1.
                ...assembleFinalizeErrorBannerFields(session_number, null),
                finalize_render_contract: FINALIZE_RENDER_CONTRACT,
                diagnostics: diagnostics.list(),
              }) }],
              isError: true,
            };
          }
          const result = auditRaced;
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
          // consumer; the background `full` action is. S203 audit R32
          // (F-C1-7): FINALIZE_DRAFT_DEADLINE_MS (180s) is 3x that ceiling, so
          // the structured timeout below could never be delivered — the client
          // gave up first and the retry started a second synthesis. The action
          // deadline defaults to MCP_SAFE_TIMEOUT; an explicitly env-set
          // FINALIZE_DRAFT_DEADLINE_MS still wins (the R32 rollback lever).
          let draftDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const draftDeadlinePromise = new Promise<typeof FINALIZE_DRAFT_DEADLINE_SENTINEL>((resolve) => {
            draftDeadlineTimer = setTimeout(
              () => resolve(FINALIZE_DRAFT_DEADLINE_SENTINEL),
              FINALIZE_DRAFT_ACTION_DEADLINE_MS,
            );
          });
          const draftWork = draftPhase(project_slug, session_number, { diagnostics });
          const raced = await Promise.race([draftWork, draftDeadlinePromise]);
          if (draftDeadlineTimer) clearTimeout(draftDeadlineTimer);

          if (raced === FINALIZE_DRAFT_DEADLINE_SENTINEL) {
            const deadlineSec = Math.round(FINALIZE_DRAFT_ACTION_DEADLINE_MS / 1000);
            logger.error("prism_finalize draft deadline exceeded", {
              project_slug,
              deadlineMs: FINALIZE_DRAFT_ACTION_DEADLINE_MS,
              elapsedMs: Date.now() - phaseStart,
            });
            diagnostics.error("SYNTHESIS_TIMEOUT", `Draft deadline exceeded (${deadlineSec}s)`, { deadlineMs: FINALIZE_DRAFT_ACTION_DEADLINE_MS });
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
          // brief-s202b T8: in the compose-offload happy path, the legacy
          // 6-key `drafts` object duplicates content already carried by
          // draft_files/the persisted state — strip it from the RESPONSE
          // (draft_files + draft_summary are the review surface). It stays in
          // the internal return for fullPhase recovery.
          const draftResponse: Record<string, unknown> = { ...result };
          if ((result as Record<string, unknown>).compose_mode === "files") {
            delete draftResponse.drafts;
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ...draftResponse, diagnostics: diagnostics.list() }) }],
          };
        }

        if (action === "full") {
          if (!handoff_content) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: "Full action requires handoff_content — the complete handoff.md content for this session.",
                project: project_slug,
                action: "full",
                ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                finalize_render_contract: FINALIZE_RENDER_CONTRACT,
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
        // brief-s202b T8 (F-1): use_draft_files — recover the validated
        // draft persisted by action=draft (the stateless-server bridge) and
        // commit it, so chat approves instead of regenerating file content
        // (~0.2K output tokens instead of the INS-178-walled ~1.7K+).
        // Supplied files[] entries override the draft per-path; extra
        // supplied files are appended. Everything still runs through the
        // FULL commit pipeline below (recommendation injection, archive
        // lifecycle, validators, INS-360 recreate guard) — approval is not a
        // validation bypass.
        let effectiveFiles = files;
        let effectiveHandoffVersion = handoff_version;
        if (use_draft_files) {
          let draftState: FinalizeDraftState;
          try {
            const stateFile = await fetchFile(project_slug, FINALIZE_DRAFT_STATE_PATH);
            draftState = JSON.parse(stateFile.content) as FinalizeDraftState;
          } catch (stateErr) {
            const msg = stateErr instanceof Error ? stateErr.message : String(stateErr);
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: `use_draft_files: no usable persisted draft at ${FINALIZE_DRAFT_STATE_PATH} (${msg}). Run action=draft first (compose mode), or supply files[] without use_draft_files.`,
                project: project_slug,
                action: "commit",
                ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                finalize_render_contract: FINALIZE_RENDER_CONTRACT,
              }) }],
              isError: true,
            };
          }
          if (!Array.isArray(draftState.files) || draftState.files.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: `use_draft_files: persisted draft at ${FINALIZE_DRAFT_STATE_PATH} carries no files. Run action=draft again.`,
                project: project_slug,
                action: "commit",
                ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                finalize_render_contract: FINALIZE_RENDER_CONTRACT,
              }) }],
              isError: true,
            };
          }
          if (draftState.session_number !== session_number) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: `use_draft_files: persisted draft is for session ${draftState.session_number}, not ${session_number} — stale drafts are never committed. Run action=draft for this session.`,
                project: project_slug,
                action: "commit",
                draft_session: draftState.session_number,
                ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                finalize_render_contract: FINALIZE_RENDER_CONTRACT,
              }) }],
              isError: true,
            };
          }
          const bareName = (p: string): string =>
            p.startsWith(`${DOC_ROOT}/`) ? p.slice(DOC_ROOT.length + 1) : p;
          const merged: Array<{ path: string; content: string }> = draftState.files.map(f => ({ ...f }));
          const overridden: string[] = [];
          for (const supplied of files ?? []) {
            const idx = merged.findIndex(m => bareName(m.path) === bareName(supplied.path));
            if (idx !== -1) {
              merged[idx] = { path: merged[idx].path, content: supplied.content };
              overridden.push(merged[idx].path);
            } else {
              merged.push(supplied);
            }
          }
          effectiveFiles = merged;
          effectiveHandoffVersion = handoff_version ?? draftState.handoff_version;
          diagnostics.info(
            "FINALIZE_DRAFT_FILES_USED",
            `Committing ${merged.length} persisted draft file(s) from ${FINALIZE_DRAFT_STATE_PATH}${overridden.length > 0 ? ` (${overridden.length} overridden by files[]: ${overridden.join(", ")})` : ""}`,
            {
              draft_files: draftState.files.map(f => f.path),
              overridden,
              draft_handoff_version: draftState.handoff_version,
            },
          );
        }

        if (!effectiveFiles || effectiveFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Commit phase requires files array with at least one file (or use_draft_files: true after a compose-mode draft).",
                  project: project_slug,
                  action: "commit",
                  ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                  finalize_render_contract: FINALIZE_RENDER_CONTRACT,
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
        // SRV-42: the deadline aborts an AbortController threaded through
        // commitPhase into the safeMutation primitive (which cancels the
        // in-flight atomic commit), so a timed-out commit is CANCELLED rather
        // than abandoned (and left to land after the error turn). The
        // Promise.race still produces the structured response; the abort stops
        // the in-flight work.
        const commitAbort = new AbortController();
        let commitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const commitDeadlinePromise = new Promise<typeof FINALIZE_COMMIT_DEADLINE_SENTINEL>((resolve) => {
          commitDeadlineTimer = setTimeout(() => {
            commitAbort.abort();
            resolve(FINALIZE_COMMIT_DEADLINE_SENTINEL);
          }, FINALIZE_COMMIT_DEADLINE_MS);
        });
        const commitWork = commitPhase(
          project_slug,
          session_number,
          effectiveHandoffVersion ?? 1,
          effectiveFiles,
          skipSynthesis,
          diagnostics,
          commitAbort.signal,
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
                  // SRV-49: describe the actual partial surface. The final doc
                  // commit is atomic (all-or-nothing) and was signaled to
                  // abort, so it may or may not have landed; pre-commit steps
                  // (handoff backup, history prune) may already have committed.
                  // A retry is archive-idempotent (SRV-47).
                  partial_state_warning:
                    "Commit deadline exceeded. The final doc commit is atomic (all-or-nothing) and was signaled to abort — verify the repo HEAD before retrying. Pre-commit steps (handoff backup, history prune) may already have committed; a retry does not duplicate archived entries (SRV-47).",
                  backup_created: "",
                  ...assembleFinalizeErrorBannerFields(session_number, effectiveHandoffVersion ?? null),
                  finalize_render_contract: FINALIZE_RENDER_CONTRACT,
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

        // brief-439 / R8 + brief-447 / D-249: finalization banner via the
        // unified generator (the single code path shared with prism_bootstrap)
        // PLUS the restored HTML widget. assembleFinalizeBanner returns both the
        // text banner and a structured htmlInput built from the same data.
        const { text: bannerText, htmlInput } = await assembleFinalizeBanner(
          project_slug,
          session_number,
          effectiveHandoffVersion ?? 1,
          effectiveFiles,
          result.results,
          result.all_succeeded,
          banner_data,
          diagnostics, // R19: BANNER_DELIVERABLES_TRUNCATED rides out on the response
        );

        // brief-447 / D-249: populate finalization_banner_html from the same
        // finalize data. Wrapped so an HTML render failure (or a null htmlInput
        // from the text fallback path) leaves the field null — banner_text is
        // the genuine fallback, and the outer try/catch nulls the field on any
        // hard error.
        // OPS-2 (S208): FINALIZE_BANNER=off ships a null widget; banner_text
        // is deliberately unaffected by the knob.
        let finalization_banner_html: string | null = null;
        if (htmlInput && resolveFinalizeBanner() === "html") {
          try {
            finalization_banner_html = renderFinalizationBannerHtml(htmlInput);
          } catch (htmlErr) {
            const msg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
            logger.warn("finalization HTML widget render failed — leaving null (banner_text fallback)", {
              project_slug,
              error: msg,
            });
            // MCP-19: was log-only; a null field is now explained.
            diagnostics.warn(
              BANNER_RENDER_FAILED,
              `finalization_banner_html render failed — the field is null and banner_text carries the banner: ${msg}`,
              { surface: "finalization_banner_html", error: msg },
            );
          }
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
          bannerTextBytes: bannerText.length,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            ...result,
            banner_text: bannerText,                    // brief-439 / R8: unified generator output
            banner_spec_version: BANNER_SPEC_VERSION,   // brief-439 / R8: banner contract version this server emits
            finalization_banner_html,                   // brief-447 / D-249: restored HTML widget (null on render failure — banner_text is the fallback)
            finalize_render_contract: FINALIZE_RENDER_CONTRACT, // S203 audit R11 (F-A2-3/F-D3): the render obligation used to ship only on action=audit
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
              // SRV-49: a finalize that errors mid-turn previously dropped the
              // diagnostics entirely, leaving the operator unable to tell what
              // landed (INS-314). Include them — they may carry DELETE_FILE_FAILED
              // / MUTATION_* / HANDOFF_SCHEMA_MISSING events from work that ran
              // before the throw — plus a pointer to verify via the repo HEAD.
              text: JSON.stringify({
                error: message,
                project: project_slug,
                action,
                ...(action === "prepare_checkpoint" || expected_published_handoff
                  ? { writes_performed: false, finalized: false }
                  : { partial_state_warning:
                    "Finalize errored mid-turn. Doc commits are atomic, but pre-commit steps (handoff backup, history prune) may already have landed — verify the repo HEAD. A retry does not duplicate archived entries (SRV-47)." }),
                ...(action === "commit" || action === "full"
                  ? {
                      ...assembleFinalizeErrorBannerFields(session_number, handoff_version ?? null),
                      finalize_render_contract: FINALIZE_RENDER_CONTRACT,
                    }
                  : {}),
                diagnostics: diagnostics.list(),
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
