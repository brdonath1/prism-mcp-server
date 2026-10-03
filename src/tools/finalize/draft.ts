/**
 * prism_finalize — draft phase.
 *
 * Extracted verbatim from `src/tools/finalize.ts` (D-FINALIZE-SPLIT F1): the
 * draft timeout/deadline resolvers, the compose/projection helpers and
 * `draftPhase` (including its draft-state persist). Imports bridge.ts; never
 * imports ../finalize.js (no cycles).
 */

import { listCommits, pushFile } from "../../github/client.js";
import {
  CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS,
  FINALIZE_COMPOSE_HANDOFF_MAX_BYTES,
  FINALIZE_DRAFT_DEADLINE_CC_MS,
  FINALIZE_DRAFT_DEADLINE_MS,
  FINALIZE_DRAFT_STATE_PATH,
  FINALIZE_DRAFT_TIMEOUT_MS,
  LIVING_DOCUMENT_NAMES,
  SYNTHESIS_ENABLED,
  SYNTHESIS_MAX_OUTPUT_TOKENS,
  isWidgetChannelItem,
  resolveFinalizeComposeMode,
} from "../../config.js";
import { resolveDocFiles } from "../../utils/doc-resolver.js";
import { logger } from "../../utils/logger.js";
import { extractSection, parseNumberedList } from "../../utils/summarizer.js";
import { parseHandoffVersion, parseTemplateVersion } from "../../validation/handoff.js";
import { validateFile } from "../../validation/index.js";
import { DiagnosticsCollector } from "../../utils/diagnostics.js";
import { extractJSON } from "../../utils/extract-json.js";
import { FINALIZATION_DRAFT_PROMPT, buildFinalizationComposePrompt, buildFinalizationDraftMessage } from "../../ai/prompts.js";
import { boundSynthesisInput, buildSynthesisDocManifest, renderSynthesisInputManifest } from "../../ai/input-budget.js";
import { synthesize } from "../../ai/client.js";
import { bridgeDraftSections, type DraftBridgeResult } from "./bridge.js";

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

/** brief-s202b T8: outcome of composing complete finalization files from a
 *  files-mode draft. `ok: false` carries the fallback reason for the
 *  FINALIZE_COMPOSE_FALLBACK warn (D-275 §4.5 pattern). */
export interface ComposeDraftOutcome {
  ok: boolean;
  fallback_reason?: "validation_failed" | "compose_failed";
  /** Per-file gate failures (validator errors + compose size contracts). */
  gate_failures?: Array<{ path: string; errors: string[] }>;
  /** Complete, validated files ready for commit (bare living-doc names). */
  files?: Array<{ path: string; content: string }>;
  /** Non-blocking validation warnings (e.g. HANDOFF_ITEM_OVERSIZE — T5). */
  warnings?: Array<{ path: string; warnings: string[] }>;
  /** Bridge report for the session-log / task-queue mutations. */
  bridge?: DraftBridgeResult;
}

/**
 * Compose COMPLETE finalization files from a files-mode draft (brief-s202b
 * T8 / D-275 F-1) and run the quality gate.
 *
 * - handoff.md comes whole from the model's `handoff_md` key (full HANDOFF
 *   schema demanded by the prompt contract).
 * - session-log.md / task-queue.md are composed SERVER-SIDE by the
 *   production-tested fullPhase bridge (bridgeDraftSections) from the legacy
 *   contract keys — the model emits an entry + deltas, never whole copies of
 *   those docs.
 *
 * Quality gate = fallback trigger: every composed file must pass the same
 * validators that gate every finalize commit (validateFile → handoff schema,
 * EOF sentinel, anti-patterns), PLUS the T8 hard size contracts on the
 * handoff (file ≤ FINALIZE_COMPOSE_HANDOFF_MAX_BYTES; Critical Context ≤ 5
 * items). Per-item byte budget stays WARN-only (T5's explicit calibration).
 * Any gate failure → the caller returns the legacy 6-key draft response.
 *
 * Pure (no I/O) and exported for direct unit testing.
 */
export function composeDraftFiles(
  drafts: Record<string, unknown>,
  current: { sessionLog?: string; taskQueue?: string },
): ComposeDraftOutcome {
  const handoffMd = drafts.handoff_md;
  if (typeof handoffMd !== "string" || handoffMd.trim().length === 0) {
    return {
      ok: false,
      fallback_reason: "validation_failed",
      gate_failures: [{ path: "handoff.md", errors: ["draft is missing the handoff_md key (or it is empty)"] }],
    };
  }

  let bridge: DraftBridgeResult;
  try {
    bridge = bridgeDraftSections(drafts, current);
  } catch (err) {
    return {
      ok: false,
      fallback_reason: "compose_failed",
      gate_failures: [
        { path: "session-log.md/task-queue.md", errors: [err instanceof Error ? err.message : String(err)] },
      ],
    };
  }

  const composedFiles: Array<{ path: string; content: string }> = [
    { path: "handoff.md", content: handoffMd },
    ...bridge.files,
  ];

  const encoder = new TextEncoder();
  const gateFailures: Array<{ path: string; errors: string[] }> = [];
  const gateWarnings: Array<{ path: string; warnings: string[] }> = [];
  for (const file of composedFiles) {
    const validation = validateFile(file.path, file.content);
    const errors = [...validation.errors];
    if (file.path === "handoff.md") {
      const bytes = encoder.encode(file.content).length;
      if (bytes > FINALIZE_COMPOSE_HANDOFF_MAX_BYTES) {
        errors.push(
          `composed handoff is ${bytes}B — over the ${FINALIZE_COMPOSE_HANDOFF_MAX_BYTES}B compose size contract`,
        );
      }
      const items = parseNumberedList(extractSection(file.content, "Critical Context") ?? "");
      // S208 widget_channel binding: the `widget_channel:` flag is a machine
      // signal the boot kernel keys on, not one of the five substantive facts
      // the cap exists to ration. Counting it forced a handoff at cap to give
      // up a real item to report a broken render channel. Exempt it here (cap
      // is effectively 5 + flag); scale.ts's condensation carries the mirror
      // exemption so a later condensation pass cannot delete it either.
      const substantiveItems = items.filter((item) => !isWidgetChannelItem(item));
      if (substantiveItems.length > 5) {
        errors.push(`composed handoff has ${substantiveItems.length} Critical Context items — the compose contract caps at 5`);
      }
    }
    if (errors.length > 0) gateFailures.push({ path: file.path, errors });
    if (validation.warnings.length > 0) gateWarnings.push({ path: file.path, warnings: validation.warnings });
  }

  if (gateFailures.length > 0) {
    return { ok: false, fallback_reason: "validation_failed", gate_failures: gateFailures, bridge };
  }
  return { ok: true, files: composedFiles, warnings: gateWarnings, bridge };
}

/** brief-s202b T8: hard cap for the chat-review digest (1.5KB). */
export const DRAFT_SUMMARY_MAX_BYTES = 1_536;

/** Clamp the model's draft_summary to the 1.5KB contract; when the model
 *  omitted it, build a deterministic server-side digest so the review flow
 *  never dies on a missing optional key. */
export function resolveDraftSummary(
  drafts: Record<string, unknown>,
  composedFiles: Array<{ path: string; content: string }>,
): string {
  const encoder = new TextEncoder();
  const supplied = typeof drafts.draft_summary === "string" ? drafts.draft_summary.trim() : "";
  if (supplied.length > 0) {
    if (encoder.encode(supplied).length <= DRAFT_SUMMARY_MAX_BYTES) return supplied;
    let keep = supplied.slice(0, DRAFT_SUMMARY_MAX_BYTES);
    while (keep.length > 0 && encoder.encode(keep).length > DRAFT_SUMMARY_MAX_BYTES - 3) {
      keep = keep.slice(0, -1);
    }
    return `${keep}…`;
  }
  const handoff = composedFiles.find(f => f.path === "handoff.md");
  const entry = typeof drafts.session_log_entry === "string" ? drafts.session_log_entry : "";
  const completed = Array.isArray(drafts.task_queue_completed) ? drafts.task_queue_completed.length : 0;
  const added = Array.isArray(drafts.task_queue_new) ? drafts.task_queue_new.length : 0;
  return [
    `handoff.md composed (${handoff ? encoder.encode(handoff.content).length : 0}B)`,
    `session-log entry: ${entry.split("\n")[0] ?? "(none)"}`,
    `task-queue: ${completed} completed, ${added} added`,
  ].join(" | ");
}

/** brief-s202b T8: reviewable projection of the composed files for the draft
 *  response. handoff.md ships FULL (it is wholly new each session, ≤10KB by
 *  contract); session-log/task-queue ship their DELTA (the entry / the task
 *  flips) — the full composed copies are persisted server-side and returning
 *  them would regress the response ~10-15K tokens against the very
 *  chat-context economics this feature exists for (INS-178). `full_bytes`
 *  always states the persisted file's true size. */
export function buildDraftFilesProjection(
  drafts: Record<string, unknown>,
  composedFiles: Array<{ path: string; content: string }>,
): Array<{ path: string; delivery: "full" | "delta"; content: string; full_bytes: number }> {
  const encoder = new TextEncoder();
  return composedFiles.map(file => {
    const fullBytes = encoder.encode(file.content).length;
    if (file.path === "handoff.md") {
      return { path: file.path, delivery: "full" as const, content: file.content, full_bytes: fullBytes };
    }
    if (file.path === "session-log.md") {
      const entry = typeof drafts.session_log_entry === "string" ? drafts.session_log_entry : "";
      return { path: file.path, delivery: "delta" as const, content: entry, full_bytes: fullBytes };
    }
    const completed = Array.isArray(drafts.task_queue_completed)
      ? drafts.task_queue_completed.filter((t): t is string => typeof t === "string")
      : [];
    const added = Array.isArray(drafts.task_queue_new)
      ? drafts.task_queue_new.filter((t): t is string => typeof t === "string")
      : [];
    const delta = [...completed.map(t => `[x] ${t}`), ...added.map(t => `[+] ${t}`)].join("\n");
    return { path: file.path, delivery: "delta" as const, content: delta, full_bytes: fullBytes };
  });
}

/** brief-s202b T8: shape of the persisted `.prism/finalize-draft.json`
 *  artifact — the stateless-server bridge between action=draft and
 *  action=commit use_draft_files (same GitHub-persistence rationale as
 *  dispatch state, D-123). */
export interface FinalizeDraftState {
  version: 1;
  project: string;
  session_number: number;
  handoff_version: number;
  created_at: string;
  files: Array<{ path: string; content: string }>;
  draft_summary: string;
}

/**
 * Draft phase — use the configured synthesis model (SYNTHESIS_MODEL_ID, the
 * registry single-switch per D-254) to generate finalization file drafts.
 * Returns structured content for Claude to review before commit.
 *
 * brief-s202b T8 (F-1): in FINALIZE_COMPOSE_MODE=files (the default) the
 * CS-1 prompt additionally emits the COMPLETE handoff.md + a ≤1.5KB review
 * digest; the server composes session-log/task-queue via the fullPhase
 * bridge, validates EVERYTHING with the standard commit validators, persists
 * the validated set to `.prism/finalize-draft.json`, and returns
 * `draft_files` + `draft_summary` so chat approves instead of regenerating
 * (commit via `use_draft_files: true`). ANY gate failure transparently falls
 * back to the legacy 6-key response with a FINALIZE_COMPOSE_FALLBACK warn.
 * `options.composeMode` lets fullPhase pin legacy (it composes server-side
 * already and needs no persistence round-trip).
 */
export async function draftPhase(
  projectSlug: string,
  sessionNumber: number,
  options: { composeMode?: "files" | "legacy"; diagnostics?: DiagnosticsCollector } = {},
) {
  const diagnostics = options.diagnostics ?? new DiagnosticsCollector();
  const composeMode = options.composeMode ?? resolveFinalizeComposeMode();
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

  // 3. Bound the input (SRV-67), then build the prompt. draftPhase is the
  //    designated CS-1 timeout backstop (src/ai/input-budget.ts) yet pre-brief-465
  //    NEVER applied boundSynthesisInput — only the brief/PDU paths did. The
  //    draft concatenates ~7 unbounded living docs (decisions/_INDEX.md +
  //    insights.md can be tens of KB), so an unbounded assembly could exceed
  //    SYNTHESIS_INPUT_MAX_TOKENS and run into the very timeout this backstop
  //    exists to prevent. Measured through the SAME builder the model call uses,
  //    so the bound is enforced on exactly the assembled prompt.
  const bounded = boundSynthesisInput(docMap, (docs) =>
    buildFinalizationDraftMessage(projectSlug, sessionNumber, docs, sessionCommits),
  );

  // brief-s202b T9b/T9d (D-278): per-doc size manifest prepended to the CS-1
  // input (true sizes as the fact source) + one SYNTHESIS_INPUT_TRUNCATED
  // info line/diagnostic per truncated doc.
  const draftDocManifest = buildSynthesisDocManifest(docMap, bounded.docs);
  for (const row of draftDocManifest) {
    if (!row.truncated) continue;
    logger.info("SYNTHESIS_INPUT_TRUNCATED", {
      call_site: "synthesis_draft",
      projectSlug,
      sessionNumber,
      path: row.path,
      true_bytes: row.true_bytes,
      included_bytes: row.included_bytes,
    });
    diagnostics.info(
      "SYNTHESIS_INPUT_TRUNCATED",
      `${row.path} trimmed for the draft synthesis input: ${row.included_bytes} of ${row.true_bytes} true bytes included — never cite the truncated size as the file's size`,
      { call_site: "synthesis_draft", path: row.path, true_bytes: row.true_bytes, included_bytes: row.included_bytes },
    );
  }

  const userMessage = `${renderSynthesisInputManifest(draftDocManifest)}\n\n${buildFinalizationDraftMessage(
    projectSlug,
    sessionNumber,
    bounded.docs,
    sessionCommits
  )}`;
  if (bounded.trimmed) {
    logger.warn("SYNTHESIS_DRAFT_INPUT_TRIMMED — draft input exceeded the token ceiling and was priority-trimmed before the model call", {
      projectSlug,
      sessionNumber,
      pre_trim_tokens: bounded.pre_trim_tokens,
      post_trim_tokens: bounded.post_trim_tokens,
      trimmed_docs: bounded.trimmed_docs,
    });
  }

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

  // brief-s202b T8: files-mode prompt carries the exact target Meta values so
  // the composed handoff round-trips the commit-time HANDOFF_VERSION /
  // SESSION mismatch cross-checks (SRV-59) instead of guessing.
  const currentHandoffContent = docMap.get("handoff.md")?.content ?? null;
  const targetHandoffVersion =
    (currentHandoffContent ? parseHandoffVersion(currentHandoffContent) ?? 0 : 0) + 1;
  const handoffTemplateVersion =
    (currentHandoffContent ? parseTemplateVersion(currentHandoffContent) : null) ?? "unknown";
  const systemPrompt =
    composeMode === "files"
      ? buildFinalizationComposePrompt({
          targetHandoffVersion,
          sessionNumber,
          templateVersion: handoffTemplateVersion,
        })
      : FINALIZATION_DRAFT_PROMPT;
  // files mode emits a complete ≤10KB handoff on top of the legacy keys —
  // the legacy 4096 output budget would truncate it (stop_reason
  // max_tokens → parse failure), so use the synthesis-wide 8192 ceiling.
  const draftMaxTokens = composeMode === "files" ? SYNTHESIS_MAX_OUTPUT_TOKENS : 4096;

  logger.info("Finalization draft: calling synthesis model", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
    totalDocKB: (totalDocBytes / 1024).toFixed(1),
    timeoutMs: draftTimeoutMs,
    composeMode, // brief-s202b T8
  });

  const result = await synthesize(
    systemPrompt,
    userMessage,
    draftMaxTokens,
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

  // 4. Parse response — expect JSON (B.8: robust extraction).
  //    S203 audit R22 (F-C1-3/F-C1-6): ONLY the parse is guarded here. The
  //    compose/persist block below carries its own failure contract
  //    (FINALIZE_COMPOSE_FALLBACK); folding it into this catch reported a
  //    403 on the state push to the operator as "Could not parse structured
  //    JSON" with success: true.
  let drafts: unknown;
  try {
    drafts = extractJSON(result.content);
  } catch (parseError) {
    // A parse failure is a FAILED draft, not a successful one with a note:
    // success: true made draftStatus "ok", suppressed DRAFT_FAILED, and let
    // action=full commit handoff.md alone while dropping the model's output.
    const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
    logger.warn("finalize draft: could not parse structured JSON from the model response", {
      projectSlug,
      sessionNumber,
      error: parseMsg,
      contentBytes: result.content.length,
    });
    return {
      success: false,
      parse_failed: true as const,
      error: `Could not parse structured JSON from the draft response: ${parseMsg}`,
      // Response-shape contract (unchanged): the raw text always rides out so
      // the operator can extract it by hand.
      raw_content: result.content,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      parse_warning: "Could not parse structured JSON — raw content included for manual extraction.",
      fallback: "Extract the finalization sections from raw_content manually, or re-run action=draft.",
    };
  }

  // brief-s202b T8: compose-offload path. Compose complete files, gate them
  // with the standard commit validators, persist the validated set, and
  // return the review projection. ANY failure below falls through to the
  // legacy 6-key response with a FINALIZE_COMPOSE_FALLBACK warn — the
  // D-275 §4.5 gate-as-fallback-trigger pattern.
  if (composeMode === "files") {
    try {
      const compose = composeDraftFiles(drafts as Record<string, unknown>, {
        sessionLog: docMap.get("session-log.md")?.content,
        taskQueue: docMap.get("task-queue.md")?.content,
      });
      if (compose.ok && compose.files) {
        for (const warn of compose.warnings ?? []) {
          // T5 item-budget (and any other advisory validator output) —
          // surfaced, never gating.
          diagnostics.warn(
            "HANDOFF_ITEM_OVERSIZE",
            `${warn.path}: ${warn.warnings.join(" | ")}`,
            { path: warn.path, warnings: warn.warnings },
          );
        }
        const draftSummary = resolveDraftSummary(drafts as Record<string, unknown>, compose.files);
        const draftState: FinalizeDraftState = {
          version: 1,
          project: projectSlug,
          session_number: sessionNumber,
          handoff_version: targetHandoffVersion,
          created_at: new Date().toISOString(),
          files: compose.files,
          draft_summary: draftSummary,
        };
        const persist = await pushFile(
          projectSlug,
          FINALIZE_DRAFT_STATE_PATH,
          JSON.stringify(draftState, null, 2),
          `prism: finalize draft S${sessionNumber} compose artifact`,
        );
        if (persist.success) {
          logger.info("finalize compose-offload draft persisted", {
            projectSlug,
            sessionNumber,
            files: compose.files.map(f => f.path),
            statePath: FINALIZE_DRAFT_STATE_PATH,
          });
          return {
            success: true,
            compose_mode: "files" as const,
            drafts, // internal consumers (fullPhase recovery); the draft action strips this from its response
            draft_files: buildDraftFilesProjection(drafts as Record<string, unknown>, compose.files),
            draft_summary: draftSummary,
            draft_bridge: compose.bridge
              ? { bridged: compose.bridge.bridged, skipped: compose.bridge.skipped }
              : null,
            handoff_version: targetHandoffVersion,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            review_instructions:
              `Review draft_summary (and draft_files as needed). To approve, call prism_finalize action=commit with use_draft_files: true, session_number: ${sessionNumber}, handoff_version: ${targetHandoffVersion} — no files[] content needed. Override any single file by passing it in files[]; the server merges by path.`,
          };
        }
        // Persisted-state write failed — the commit side cannot recover the
        // files, so fall back to the legacy response (chat composes).
        diagnostics.warn(
          "FINALIZE_COMPOSE_FALLBACK",
          `Composed draft validated but could not be persisted to ${FINALIZE_DRAFT_STATE_PATH} (${persist.error ?? "push failed"}) — returning the legacy 6-key draft response`,
          { fallback_reason: "persist_failed", error: persist.error ?? "push failed" },
        );
        logger.warn("FINALIZE_COMPOSE_FALLBACK", {
          projectSlug,
          sessionNumber,
          fallback_reason: "persist_failed",
          error: persist.error ?? "push failed",
        });
      } else {
        diagnostics.warn(
          "FINALIZE_COMPOSE_FALLBACK",
          `Composed draft failed the validation gate — returning the legacy 6-key draft response (${(compose.gate_failures ?? [])
            .map(g => `${g.path}: ${g.errors.join("; ")}`)
            .join(" | ")})`,
          { fallback_reason: compose.fallback_reason ?? "validation_failed", gate_failures: compose.gate_failures },
        );
        logger.warn("FINALIZE_COMPOSE_FALLBACK", {
          projectSlug,
          sessionNumber,
          fallback_reason: compose.fallback_reason ?? "validation_failed",
          gate_failures: compose.gate_failures,
        });
      }
    } catch (composeError) {
      // A THROW out of compose/persist (transient GitHub failure, unexpected
      // validator input) is reported as what it is — same fallback surface as
      // the gate failures above, never as a parse failure (S203 audit R22).
      const composeMsg =
        composeError instanceof Error ? composeError.message : String(composeError);
      diagnostics.warn(
        "FINALIZE_COMPOSE_FALLBACK",
        `Compose/persist threw before the draft could be offloaded (${composeMsg}) — returning the legacy 6-key draft response`,
        { fallback_reason: "compose_threw", error: composeMsg },
      );
      logger.warn("FINALIZE_COMPOSE_FALLBACK", {
        projectSlug,
        sessionNumber,
        fallback_reason: "compose_threw",
        error: composeMsg,
      });
    }
  }

  return {
    success: true,
    drafts,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    review_instructions: "Review each draft section. Edit as needed, then include in your commit files. These are drafts — you have full editorial control.",
  };
}
