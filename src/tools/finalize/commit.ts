/**
 * prism_finalize — the commit phase (handoff + registry atomic writer).
 *
 * Extracted verbatim from `src/tools/finalize.ts` (D-FINALIZE-SPLIT F3):
 * `collectRegistryIdSets` + `commitPhase` (INS-360 recreate guard, SRV-48
 * validation-before-write ordering, SRV-42 caller-owned abort signal). The
 * deadline sentinels, `fullPhase` and the handler stay in finalize.ts and pass
 * the same AbortController signal in. Must not import finalize.ts.
 */

import { fetchFile, listDirectory } from "../../github/client.js";
import { safeMutation } from "../../utils/safe-mutation.js";
import { registerInflight } from "../../utils/inflight-registry.js";
import {
  LIVING_DOCUMENTS,
  LIVING_DOCUMENT_NAMES,
  SYNTHESIS_ENABLED,
  DOC_ROOT,
  STANDING_RULES_WARNING_SIZE,
} from "../../config.js";
import { splitForArchive, utf8ByteLength, type ArchiveConfig } from "../../utils/archive.js";
import { resolveDocPath, } from "../../utils/doc-resolver.js";
import { guardPushPath } from "../../utils/doc-guard.js";
import { logger } from "../../utils/logger.js";
import { extractSection, parseNumberedList } from "../../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount } from "../../validation/handoff.js";
import { validateFile } from "../../validation/index.js";
import { assembleSynthesisBundle, generateIntelligenceBrief, generatePendingDocUpdates, type SynthesisBundle } from "../../ai/synthesize.js";
import { DiagnosticsCollector } from "../../utils/diagnostics.js";
import { classifySession, injectPersistedRecommendation } from "../../utils/session-classifier.js";
import { classifyUnfetchedDoc, compareHandoffBackupsNewestFirst } from "./audit.js";
import {
  countLivingDocumentsUpdated,
} from "./banner.js";
import {
  INSIGHTS_ARCHIVE_CONFIG,
  SESSION_LOG_ARCHIVE_CONFIG,
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
} from "./lifecycle.js";
import { applyPendingDocUpdates, type ApplyPduResult } from "../../utils/apply-pdu.js";
import { detectZwsHeaders } from "../../utils/sanitize-content.js";
import { findUnloggedIds } from "../../utils/unlogged-ids.js";
import { parseExistingDecisionIds } from "../log-decision.js";
import { parseExistingInsightIds } from "../log-insight.js";


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
export async function collectRegistryIdSets(
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
export async function commitPhase(
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
