/**
 * prism_finalize tool — Execute PRISM finalization in 2 tool calls instead of 13-16.
 * Phase 1 (audit): Fetch all living documents, detect drift, audit session work products.
 * Phase 2 (commit): Backup handoff, validate, push all files, verify.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  fetchFile,
} from "../github/client.js";
import { preparePublishedCheckpointProjection } from "../utils/published-checkpoint-projection.js";
import {
  LIVING_DOCUMENT_NAMES,
  FRAMEWORK_REPO,
  FINALIZE_COMMIT_DEADLINE_MS,
  FINALIZE_DRAFT_ACTION_DEADLINE_MS,
  FINALIZE_AUDIT_ACTION_DEADLINE_MS,
  FINALIZE_FULL_AUDIT_DEADLINE_MS,
  DOC_ROOT,
  resolveFinalizeBanner,
} from "../config.js";

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
import { logger } from "../utils/logger.js";
import {
  BANNER_SPEC_VERSION,
  parseTemplateBannerSpecVersion,
  renderFinalizationBannerHtml,
} from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
// S203 audit R27 (F-C1-11 / F-A2-13): the audit + banner seams now live in
// src/tools/finalize/ (commitPhase moved there in D-FINALIZE-SPLIT F3).
import {
  auditPhase,
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
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
} from "./finalize/lifecycle.js";

export {
  TASK_QUEUE_RECENTLY_COMPLETED_CAP,
  pruneRecentlyCompleted,
  updateArchitectureMetadata,
};
// D-FINALIZE-SPLIT F3: collectRegistryIdSets + commitPhase (the handoff/registry
// atomic writer) now live in src/tools/finalize/commit.ts. The commit-deadline
// sentinel, fullPhase and the handler stay here and hand the same
// AbortController signal to commitPhase.
import { commitPhase } from "./finalize/commit.js";

// Robust JSON extraction (B.8) — implementation moved to
// src/utils/extract-json.ts (brief-s196c) so the openrouter quality gates can
// use it without a module cycle; re-exported here for existing importers.
export { extractJSON } from "../utils/extract-json.js";
import {
  FINALIZE_DRAFT_STATE_PATH,
} from "../config.js";

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
