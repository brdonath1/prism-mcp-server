/**
 * prism_finalize — audit phase and living-document classification.
 *
 * Extracted verbatim from `src/tools/finalize.ts` (S203 audit R27 / F-C1-11,
 * F-A2-13): a pure-ish seam whose only I/O is the GitHub read fan-out, split
 * out so the 3 300-line finalize module stops hiding the audit contract.
 * `commitPhase` deliberately stays in finalize.ts (the 6-way split is
 * Deferred). No behavior change — imports were re-pointed, nothing else.
 *
 * `classifyUnfetchedDoc` is exported for the log_decision / log_insight
 * recreate guard (S203 audit R21 / F-C1-2), which needs the same
 * confirmed-absent test before it may write a starter file.
 */

import { fetchFile, listDirectory, listCommits, getCommit } from "../../github/client.js";
import { DOC_ROOT, LIVING_DOCUMENT_NAMES } from "../../config.js";
import { resolveDocPath } from "../../utils/doc-resolver.js";
import { logger } from "../../utils/logger.js";
import {
  extractHeaders,
  extractSection,
  parseNumberedList,
  parseMarkdownTable,
} from "../../utils/summarizer.js";
import { parseHandoffVersion } from "../../validation/handoff.js";
import { computeCurrencyWarning, type CurrencyWarning } from "../../utils/doc-currency.js";
import { DiagnosticsCollector } from "../../utils/diagnostics.js";

/**
 * Numeric-aware newest-first comparator for `handoff_v{N}_{date}.md` backup
 * names (brief-459 / SRV-05). Plain `localeCompare` is lexicographic — v100+
 * sorted BELOW v9x, so the prune deleted the previous session's backup while
 * pinning 6-week-old v97-v99 snapshots, and the drift baseline read a stale
 * handoff for ~70 sessions. Ties (same version) fall back to name order.
 */
export function compareHandoffBackupsNewestFirst(
  a: { name: string },
  b: { name: string },
): number {
  const versionOf = (name: string): number => {
    const m = name.match(/^handoff_v(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  };
  const delta = versionOf(b.name) - versionOf(a.name);
  if (delta !== 0) return delta;
  return b.name.localeCompare(a.name);
}

/**
 * Per-doc entry in the audit's living-document inventory (INS-360).
 *
 * Healthy and confirmed-missing entries keep the pre-INS-360 field set
 * EXACTLY (no new keys), so the serialized audit output is byte-compatible
 * for every doc whose fetch succeeds or whose absence is confirmed. The
 * `status` / `fetch_error` fields appear ONLY on `unverified` docs.
 */
export interface LivingDocumentAuditEntry {
  file: string;
  exists: boolean;
  size_bytes: number;
  header_line: string;
  eof_valid: boolean;
  section_headers: string[];
  needs_creation: boolean;
  /** Present only when the doc's state could not be verified (INS-360). */
  status?: "unverified";
  /** Underlying fetch/classification error for unverified docs (INS-360). */
  fetch_error?: string;
}

/** Classification outcome for a living doc whose content fetch failed (INS-360). */
export type UnfetchedDocClassification =
  | { classification: "needs_creation" }
  | { classification: "unverified"; reason: string };

/**
 * INS-360 (brief-s201c): decide whether a living doc whose content fetch
 * FAILED is confirmed absent (`needs_creation`) or merely `unverified`.
 *
 * A doc may be classified `needs_creation` ONLY when its absence is
 * CONFIRMED: the content fetch rejected with a definitive GitHub 404
 * ("Not found" — i.e. BOTH the `.prism/` and legacy-root reads 404'd inside
 * resolveDocPath) AND a path-filtered commit-history probe
 * (`GET /repos/{owner}/{repo}/commits?path=<doc-path>&per_page=1`) returns
 * zero commits for the path at BOTH layouts.
 *
 * Every other failure shape — network error, timeout, 5xx, rate limit,
 * auth blip (INS-311), a 404 for a path that HAS commit history (deletion
 * or content-API flake), or a failed history probe — yields `unverified`:
 * the doc counts as neither healthy nor missing, and draft/commit must
 * never recreate it from scratch. This is the S191/S192 session-log.md
 * overwrite fix: the old path collapsed every fetch failure into
 * `needs_creation: true` (see docs/rca/ins-360-finalize-audit-false-negative.md).
 */
export async function classifyUnfetchedDoc(
  projectSlug: string,
  docName: string,
  fetchError: unknown,
): Promise<UnfetchedDocClassification> {
  const fetchMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
  if (!/Not found/i.test(fetchMsg)) {
    return { classification: "unverified", reason: fetchMsg };
  }
  try {
    const [prismHistory, rootHistory] = await Promise.all([
      listCommits(projectSlug, { path: `${DOC_ROOT}/${docName}`, per_page: 1 }),
      listCommits(projectSlug, { path: docName, per_page: 1 }),
    ]);
    if (prismHistory.length === 0 && rootHistory.length === 0) {
      return { classification: "needs_creation" };
    }
    return {
      classification: "unverified",
      reason:
        "fetch returned 404 but the path has commit history — transient read " +
        `failure or deletion, not a never-created doc (${fetchMsg})`,
    };
  } catch (historyError) {
    const historyMsg =
      historyError instanceof Error ? historyError.message : String(historyError);
    return {
      classification: "unverified",
      reason: `absence unconfirmed — commit-history probe failed: ${historyMsg} (content fetch: ${fetchMsg})`,
    };
  }
}

/**
 * Audit phase — fetch all living documents and return structured audit data.
 */
export async function auditPhase(
  projectSlug: string,
  sessionNumber: number,
  diagnostics: DiagnosticsCollector = new DiagnosticsCollector(),
) {
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

  // 1. Fetch all 10 living documents in parallel with backward-compatible
  //    resolution. Outcome-preserving fan-out (INS-360): resolveDocFiles'
  //    fulfilled-only loop silently discarded rejections, collapsing every
  //    operational fetch failure (5xx, timeout, INS-311 auth blip, …) into
  //    `needs_creation: true` — the S191/S192 session-log.md overwrite.
  //    Rejections are kept per-doc and classified below instead.
  const docOutcomes = await Promise.allSettled(
    LIVING_DOCUMENT_NAMES.map((docName) => resolveDocPath(projectSlug, docName)),
  );
  const docMap = new Map<string, { content: string; sha: string; size: number }>();
  const docFetchErrors = new Map<string, unknown>();
  LIVING_DOCUMENT_NAMES.forEach((docName, idx) => {
    const outcome = docOutcomes[idx];
    if (outcome.status === "fulfilled") {
      docMap.set(docName, {
        content: outcome.value.content,
        sha: outcome.value.sha,
        size: outcome.value.content.length,
      });
    } else {
      docFetchErrors.set(docName, outcome.reason);
    }
  });

  // INS-360: classify every unfetched doc BEFORE building the inventory.
  // `needs_creation` requires confirmed absence (definitive 404 + zero commit
  // history); anything else is `unverified` and must never be recreated.
  const unfetchedClassifications = new Map<string, UnfetchedDocClassification>();
  await Promise.all(
    Array.from(docFetchErrors.entries()).map(async ([docName, fetchError]) => {
      unfetchedClassifications.set(
        docName,
        await classifyUnfetchedDoc(projectSlug, docName, fetchError),
      );
    }),
  );

  const livingDocuments: LivingDocumentAuditEntry[] = LIVING_DOCUMENT_NAMES.map((doc) => {
    const fileResult = docMap.get(doc);
    if (!fileResult) {
      const classification = unfetchedClassifications.get(doc);
      if (classification?.classification === "unverified") {
        diagnostics.warn(
          "FINALIZE_AUDIT_UNVERIFIED_DOC",
          `${doc}: content fetch failed and absence could not be confirmed — classified unverified (neither healthy nor missing). Do NOT compose or commit a from-scratch replacement. Underlying error: ${classification.reason}`,
          { doc, error: classification.reason },
        );
        logger.warn("finalize audit: living doc unverified (INS-360)", {
          projectSlug,
          doc,
          error: classification.reason,
        });
        return {
          file: doc,
          exists: false,
          size_bytes: 0,
          header_line: "",
          eof_valid: false,
          section_headers: [] as string[],
          needs_creation: false,
          status: "unverified" as const,
          fetch_error: classification.reason,
        };
      }
      // Confirmed absent: definitive 404 AND zero commit history at both
      // layouts (INS-360) — the only state that may be created from scratch.
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
      .sort(compareHandoffBackupsNewestFirst);

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
    // brief-459 / SRV-31: anchored to the `handoff_v{N}_{date}.md` filename
    // format — the old substring match let handoff_v174 count as a backup
    // for version 17 (and v97-v99 for version 9).
    handoffBackupExists = historyEntries.some(
      (e) => e.name.startsWith(`handoff_v${currentVersion}_`)
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
