/**
 * Pending Doc-Updates auto-apply (brief-422 Piece 1).
 *
 * Reads `.prism/pending-doc-updates.md`, parses each `### Proposed:` /
 * `### Add term:` subsection grouped under `## architecture.md` /
 * `## glossary.md` / `## insights.md`, and applies any proposal that carries
 * an explicit `**Apply via prism_patch <op> on <section>:**` instruction
 * (architecture / insights — section-level append/replace) or `**Body:**`
 * fenced block (glossary — table-row insertion).
 *
 * On success, overwrites pending-doc-updates.md with a cleared marker so the
 * next session sees a fresh file. Errors and skips are non-fatal — the caller
 * surfaces them in the response but the commit primary path is unaffected.
 *
 * Proposals lacking an actionable instruction (e.g. narrative-only bodies)
 * are surfaced in `skipped` with a reason. They remain in the next-session
 * synthesis input via the project's living docs, so nothing is lost.
 */

import { pushFile } from "../github/client.js";
import { applyPatch, validateIntegrity } from "./markdown-sections.js";
import { resolveDocPath, resolveDocPushPath } from "./doc-resolver.js";
import { sanitizeContent } from "./sanitize-content.js";
import { logger } from "./logger.js";

/** Files this utility knows how to apply proposals against. */
const SUPPORTED_TARGETS = new Set(["architecture.md", "glossary.md", "insights.md"]);

export type PduOperation = "append" | "replace" | "glossary_row";

export interface PduProposal {
  /** Target file (e.g. "architecture.md"). One of SUPPORTED_TARGETS. */
  targetFile: string;
  /** Subsection title from the `### Proposed: ...` / `### Add term: ...` heading. */
  title: string;
  /** Decoded operation. `glossary_row` is the table-row-insertion path. */
  operation: PduOperation | null;
  /** Section header to target inside `targetFile` (architecture/insights only). */
  section: string | null;
  /** Content payload to apply (markdown body for section ops, table row for glossary). */
  content: string | null;
  /** Reason a proposal could not be turned into an action — set when operation is null. */
  unparsedReason?: string;
}

export interface ApplyPduResult {
  /** Titles of proposals that landed on disk. */
  applied: string[];
  /** Proposals deliberately not applied (no instruction, missing section, etc). */
  skipped: Array<{ title: string; reason: string }>;
  /** Proposals where the apply attempt errored (network, write failure, etc). */
  errors: Array<{ title: string; error: string }>;
  /** Proposals whose AI-synthesized body was mutated by the KI-26 sanitizer
   *  before applying (brief-460 / SRV-46). This is the unattended channel —
   *  no operator watches the apply — so every mutation is surfaced here and
   *  in the finalize response (`pdu_sanitized`), never silent. */
  sanitized: Array<{ title: string; lines: Array<{ line: number; header: string }> }>;
  /** True iff the PDU file was overwritten with the cleared template. */
  cleared: boolean;
  /** True iff the consumed batch was archived to pending-doc-updates-archive.md
   *  with applied/rejected provenance (brief-444 / D-240 Phase B). */
  archived: boolean;
}

/** Archive doc name for consumed PDU batches (brief-444 / D-240 Phase B). */
export const PDU_ARCHIVE_DOC = "pending-doc-updates-archive.md";

const APPLY_INSTRUCTION_RE =
  /\*\*Apply via\s+`?prism_patch\s+(append|replace|prepend)`?\s+on\s+`([^`\n]+)`:\*\*/i;
const BODY_INSTRUCTION_RE = /\*\*Body:\*\*/i;
const FENCED_BLOCK_RE = /```[^\n]*\n([\s\S]*?)\n```/;
const FILE_GROUP_HEADER_RE = /^##\s+([A-Za-z0-9_./-]+\.md)\s*$/gm;
const LAST_SYNTHESIZED_RE = /^>\s*Last synthesized:\s*S(\d+)/m;

/**
 * Returns true when the PDU body has zero proposal subsections of any
 * recognized form — i.e. the synthesis run produced nothing to consume.
 * Cleared / freshly-templated files fall in this bucket.
 *
 * brief-456 (SRV-10): insights housekeeping forms (`### Re-tier:` /
 * `### Consolidate:` / `### Mark dormant:`) count as proposals — a
 * housekeeping-only batch must flow through consume/archive/clear instead
 * of silently accreting forever.
 */
export function isPduEmpty(content: string): boolean {
  return !/^###\s+(?:Proposed:|Add term:|Re-tier:|Consolidate:|Mark dormant:)/m.test(content);
}

/** Extract the synthesized session number from `> Last synthesized: S<N>`. */
export function parseLastSynthesizedSession(content: string): number | null {
  const m = content.match(LAST_SYNTHESIZED_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Insights housekeeping markers (brief-456 / SRV-10): parser-VISIBLE but
 *  never auto-applied — surfaced as skipped with an operator-review reason
 *  and archived with provenance. */
const HOUSEKEEPING_MARKERS = new Set(["Re-tier:", "Consolidate:", "Mark dormant:"]);

/**
 * Parse a PDU file body into structured proposals.
 *
 * ═══ THE PDU PROMPT↔PARSER CONTRACT (brief-456 / SRV-10) ═══
 * This grammar is one half of a written contract with
 * PENDING_DOC_UPDATES_PROMPT (src/ai/prompts.ts) — the prompt MUST elicit
 * exactly these shapes, and tests/pdu-prompt-parser-contract.test.ts pins
 * both sides. Editing either side alone silently returns auto-apply to its
 * historical 100%-rejection state.
 *
 * Recognized proposal shapes, grouped under `## <filename>.md` H2 headers
 * (`## No Updates Needed` / unknown files end or are excluded from the
 * proposal region):
 *
 *   1. Section op (architecture.md / insights.md):
 *        ### Proposed: <title>
 *        **Apply via `prism_patch <append|replace|prepend>` on `<section>`:**
 *        ```<lang?>
 *        <payload>
 *        ```
 *      → { operation: append|replace|prepend, section, content: payload }
 *
 *   2. Glossary row (glossary.md):
 *        ### Add term: <term>
 *        **Body:**
 *        ```<lang?>
 *        | cell | cell | ... |
 *        ```
 *      → { operation: "glossary_row", content: the single table row }
 *
 *   3. Insights housekeeping (operator-review, never auto-applied):
 *        ### Re-tier: ... | ### Consolidate: ... | ### Mark dormant: ...
 *      → { operation: null, unparsedReason: operator-review } — visible in
 *        `skipped` and archived with provenance (previously invisible,
 *        which made housekeeping-only batches accrete forever).
 *
 * Proposals that lack an actionable instruction are returned with
 * `operation: null` and a populated `unparsedReason` so the caller can
 * surface them in the skipped list rather than silently dropping them.
 */
export function parseProposals(content: string): PduProposal[] {
  const proposals: PduProposal[] = [];

  const groups: Array<{ file: string; start: number; end: number }> = [];
  const matches = [...content.matchAll(FILE_GROUP_HEADER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const file = m[1];
    const start = m.index! + m[0].length;
    const end = matches[i + 1]?.index ?? content.length;
    if (!SUPPORTED_TARGETS.has(file)) continue;
    groups.push({ file, start, end });
  }

  for (const group of groups) {
    const groupBody = content.slice(group.start, group.end);
    const proposalMarkers: Array<{
      marker: string;
      title: string;
      headingStart: number;
      bodyStart: number;
    }> = [];
    const lineRe = /^###\s+(Proposed:|Add term:|Re-tier:|Consolidate:|Mark dormant:)\s*(.+)$/gm;
    for (const m of groupBody.matchAll(lineRe)) {
      proposalMarkers.push({
        marker: m[1],
        title: m[2].trim(),
        headingStart: m.index!,
        bodyStart: m.index! + m[0].length,
      });
    }

    for (let i = 0; i < proposalMarkers.length; i++) {
      const marker = proposalMarkers[i];
      const bodyEnd = proposalMarkers[i + 1]?.headingStart ?? groupBody.length;
      const body = groupBody.slice(marker.bodyStart, bodyEnd);

      if (HOUSEKEEPING_MARKERS.has(marker.marker)) {
        // Contract shape 3: visible, operator-actioned, never auto-applied.
        // Title keeps the marker prefix so the provenance archive records
        // WHICH housekeeping action was proposed.
        proposals.push({
          targetFile: group.file,
          title: `${marker.marker} ${marker.title}`,
          operation: null,
          section: null,
          content: null,
          unparsedReason: "insights housekeeping proposal — operator review required (not auto-applied)",
        });
      } else if (group.file === "glossary.md") {
        proposals.push(parseGlossaryProposal(group.file, marker.title, body));
      } else {
        proposals.push(parseSectionProposal(group.file, marker.title, body));
      }
    }
  }

  return proposals;
}

function parseSectionProposal(file: string, title: string, body: string): PduProposal {
  const inst = body.match(APPLY_INSTRUCTION_RE);
  if (!inst) {
    return {
      targetFile: file,
      title,
      operation: null,
      section: null,
      content: null,
      unparsedReason: "no Apply instruction in proposal body",
    };
  }
  const opRaw = inst[1].toLowerCase();
  const operation: PduOperation =
    opRaw === "append" || opRaw === "replace" || opRaw === "prepend" ? (opRaw as PduOperation) : "append";
  const section = inst[2].trim();

  const afterInstruction = body.slice(inst.index! + inst[0].length);
  const fence = afterInstruction.match(FENCED_BLOCK_RE);
  if (!fence) {
    return {
      targetFile: file,
      title,
      operation: null,
      section: null,
      content: null,
      unparsedReason: "Apply instruction present but no fenced code block follows",
    };
  }

  return {
    targetFile: file,
    title,
    operation,
    section,
    content: fence[1],
  };
}

function parseGlossaryProposal(file: string, title: string, body: string): PduProposal {
  const inst = body.match(BODY_INSTRUCTION_RE);
  if (!inst) {
    return {
      targetFile: file,
      title,
      operation: null,
      section: null,
      content: null,
      unparsedReason: "no Body instruction for glossary term",
    };
  }
  const after = body.slice(inst.index! + inst[0].length);
  const fence = after.match(FENCED_BLOCK_RE);
  if (!fence) {
    return {
      targetFile: file,
      title,
      operation: null,
      section: null,
      content: null,
      unparsedReason: "Body present but no fenced code block follows",
    };
  }
  const row = fence[1].trim();
  if (!row.startsWith("|")) {
    return {
      targetFile: file,
      title,
      operation: null,
      section: null,
      content: null,
      unparsedReason: "glossary content does not look like a markdown table row",
    };
  }
  return {
    targetFile: file,
    title,
    operation: "glossary_row",
    section: null,
    content: row,
  };
}

/**
 * Insert a glossary table row immediately above the closing
 * `<!-- EOF: glossary.md -->` sentinel. The sentinel is mandatory; if it is
 * missing, throws so the caller routes the proposal through the error path
 * rather than silently corrupting the file.
 */
export function insertGlossaryRow(content: string, row: string): string {
  const eofRe = /<!--\s*EOF:\s*glossary\.md\s*-->\s*$/m;
  const m = content.match(eofRe);
  if (!m) {
    throw new Error("glossary.md is missing its EOF sentinel — cannot insert row safely");
  }
  const head = content.slice(0, m.index!).replace(/\s+$/, "");
  const tail = content.slice(m.index!);
  return `${head}\n${row}\n\n${tail}`;
}

/**
 * Build the cleared-state PDU body. Stamps the apply session + date so the
 * next session bootstrap can see when the cleanup ran. When `outcome` is
 * provided (brief-444), the body records the consumed batch's applied/
 * rejected split and points at the provenance archive instead of claiming
 * everything was applied.
 */
export function buildClearedPdu(
  projectSlug: string,
  syntheszedAt: string,
  appliedAtSession: number,
  appliedAtDate: string,
  outcome?: { applied: number; rejected: number },
): string {
  const summaryLine = outcome
    ? `Prior synthesis batch consumed at S${appliedAtSession} — ${outcome.applied} applied, ${outcome.rejected} rejected/skipped. Provenance: ${PDU_ARCHIVE_DOC}.`
    : "All proposals from the prior synthesis run were applied at finalize.";
  return `# Pending Doc Updates — ${projectSlug}

> Auto-generated proposals. Operator review required before applying via \`prism_patch\`.
> Last synthesized: ${syntheszedAt}
> Last applied: S${appliedAtSession} (${appliedAtDate})

## No Updates Needed

${summaryLine}

<!-- EOF: pending-doc-updates.md -->
`;
}

/**
 * Render one archive entry for a consumed PDU batch (brief-444). Pure —
 * exported for direct unit testing. The entry is a `## Batch:` section with
 * per-proposal applied/rejected provenance; empty subsections are omitted.
 */
export function buildPduArchiveEntry(input: {
  sessionNumber: number;
  date: string;
  synthesizedAt: string;
  applied: Array<{ title: string; targetFile: string }>;
  rejected: Array<{ title: string; targetFile: string | null; reason: string }>;
}): string {
  const lines: string[] = [
    `## Batch: consumed S${input.sessionNumber} (${input.date})`,
    "",
    `> Synthesized: ${input.synthesizedAt}`,
    `> Outcome: ${input.applied.length} applied, ${input.rejected.length} rejected/skipped`,
    "",
  ];
  if (input.applied.length > 0) {
    lines.push("### Applied");
    for (const a of input.applied) {
      lines.push(`- ${a.title} → ${a.targetFile}`);
    }
    lines.push("");
  }
  if (input.rejected.length > 0) {
    lines.push("### Rejected / Skipped");
    for (const r of input.rejected) {
      lines.push(`- ${r.title}${r.targetFile ? ` (${r.targetFile})` : ""} — ${r.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Insert a batch entry into the PDU archive, newest first (brief-444).
 * Pure — exported for direct unit testing. `existing === null` starts a
 * fresh archive with the standard preamble + EOF sentinel; otherwise the
 * entry lands before the first `## Batch:` header (falling back to just
 * above the EOF sentinel, then to plain append for malformed files).
 */
export function upsertPduArchive(
  existing: string | null,
  projectSlug: string,
  entry: string,
): string {
  const eof = `<!-- EOF: ${PDU_ARCHIVE_DOC} -->`;
  const block = `${entry.trimEnd()}\n\n`;
  if (existing === null) {
    return (
      `# Pending Doc Updates Archive — ${projectSlug}\n\n` +
      `> Consumed pending-doc-updates batches with applied/rejected provenance (D-240 Phase B / brief-444).\n` +
      `> Newest batch first. Archives are NEVER read by synthesis.\n\n` +
      `${block}${eof}\n`
    );
  }
  const firstBatch = existing.search(/^## Batch:/m);
  if (firstBatch !== -1) {
    return existing.slice(0, firstBatch) + block + existing.slice(firstBatch);
  }
  const eofIdx = existing.indexOf(eof);
  if (eofIdx !== -1) {
    return existing.slice(0, eofIdx) + block + existing.slice(eofIdx);
  }
  return `${existing.trimEnd()}\n\n${block}${eof}\n`;
}

/**
 * Group parsed proposals by target file. Preserves document order so
 * sequential applies land in the order the synthesis emitted them — that
 * matters for architecture.md where two proposals may target the same
 * section (replace then append, etc).
 */
function groupByTarget(proposals: PduProposal[]): Map<string, PduProposal[]> {
  const grouped = new Map<string, PduProposal[]>();
  for (const p of proposals) {
    if (!grouped.has(p.targetFile)) grouped.set(p.targetFile, []);
    grouped.get(p.targetFile)!.push(p);
  }
  return grouped;
}

/**
 * Apply pending-doc-updates proposals for a project.
 *
 * Returns a structured summary suitable for surfacing in the finalize
 * response. Errors are caught and reported per-proposal — the function
 * never throws. PDU-file-missing returns an all-empty result with
 * `cleared: false`.
 */
export async function applyPendingDocUpdates(
  projectSlug: string,
  sessionNumber: number,
): Promise<ApplyPduResult> {
  const result: ApplyPduResult = {
    applied: [],
    skipped: [],
    errors: [],
    sanitized: [],
    cleared: false,
    archived: false,
  };

  let pdu: { content: string; sha: string };
  try {
    const resolved = await resolveDocPath(projectSlug, "pending-doc-updates.md");
    pdu = { content: resolved.content, sha: resolved.sha };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not found")) {
      logger.debug("apply-pdu: PDU file not found, nothing to apply", { projectSlug });
      return result;
    }
    logger.warn("apply-pdu: PDU fetch failed", { projectSlug, error: msg });
    result.errors.push({ title: "(fetch pending-doc-updates.md)", error: msg });
    return result;
  }

  if (isPduEmpty(pdu.content)) {
    logger.debug("apply-pdu: PDU file has no proposals", { projectSlug });
    return result;
  }

  const proposals = parseProposals(pdu.content);
  if (proposals.length === 0) {
    logger.debug("apply-pdu: parser returned zero proposals", { projectSlug });
    return result;
  }

  // Track unparsable proposals up-front so the summary captures them even if
  // none of the actionable proposals land.
  const actionable: PduProposal[] = [];
  for (const p of proposals) {
    if (p.operation === null) {
      result.skipped.push({ title: p.title, reason: p.unparsedReason ?? "unparsable" });
    } else {
      actionable.push(p);
    }
  }

  if (actionable.length === 0) {
    // brief-444: all-unparsable batches no longer return early. They flow to
    // the consume path below — archived as rejected with reasons, then
    // cleared — so pending-doc-updates.md stops silently accreting stale
    // proposals that can never apply.
    logger.info("apply-pdu: no actionable proposals — consuming batch as rejected", {
      projectSlug,
      skipped: result.skipped.length,
    });
  }

  const grouped = groupByTarget(actionable);

  // Apply proposals one target file at a time. Fetch fresh content per file
  // so any concurrent prism_patch the operator ran in the same session is
  // respected by the rebuilt body.
  for (const [targetFile, fileProposals] of grouped) {
    let resolved;
    try {
      resolved = await resolveDocPath(projectSlug, targetFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("apply-pdu: target file fetch failed", { projectSlug, targetFile, error: msg });
      for (const p of fileProposals) {
        result.errors.push({ title: p.title, error: `fetch ${targetFile} failed: ${msg}` });
      }
      continue;
    }

    let workingContent = resolved.content;
    const successfulInThisFile: string[] = [];
    for (const p of fileProposals) {
      try {
        // brief-460 / SRV-46: this is the UNATTENDED write channel —
        // p.content is Opus-synthesized text applied during finalize with
        // nobody watching. Run it through the same level/fence-aware KI-26
        // sanitizer prism_patch uses: headers that could escape the target
        // section's boundary (level <= the section's level) are neutralized,
        // deeper sub-structure and fenced content survive. Glossary rows are
        // sanitized at full depth — a table row legitimately contains no
        // headers at any level. Mutations land in result.sanitized.
        const recordSanitized = (lines: Array<{ line: number; header: string }>) => {
          if (lines.length === 0) return;
          result.sanitized.push({ title: p.title, lines });
          logger.warn("apply-pdu: synthesized content sanitized (KI-26)", {
            projectSlug,
            targetFile,
            title: p.title,
            neutralized: lines.map((l) => l.header),
          });
        };
        if (p.operation === "glossary_row") {
          const outcome = sanitizeContent(p.content!);
          recordSanitized(outcome.neutralized);
          workingContent = insertGlossaryRow(workingContent, outcome.text);
        } else {
          const levelMatch = p.section!.trim().match(/^(#{1,6})\s/);
          const targetLevel = levelMatch ? levelMatch[1].length : 6;
          const outcome = sanitizeContent(p.content!, { targetLevel });
          recordSanitized(outcome.neutralized);
          workingContent = applyPatch(
            workingContent,
            p.section!,
            p.operation as "append" | "replace" | "prepend",
            outcome.text,
          );
        }
        successfulInThisFile.push(p.title);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Section not found|missing its EOF sentinel/i.test(msg)) {
          result.skipped.push({ title: p.title, reason: msg });
        } else {
          result.errors.push({ title: p.title, error: msg });
        }
      }
    }

    // Skip the push if every proposal for this file was skipped/errored —
    // there's nothing to write.
    if (successfulInThisFile.length === 0) continue;
    if (workingContent === resolved.content) continue;

    // brief-460 / SRV-46: integrity gate before the push — the sibling
    // section-level writer (patch.ts) refuses to write a document that fails
    // validateIntegrity; the unattended channel gets the same protection.
    // Failures route to result.errors, so the batch stays un-consumed (PDU
    // file left in place) for an operator-visible re-run.
    const integrity = validateIntegrity(workingContent);
    if (!integrity.valid) {
      const issueSummary = integrity.issues
        .filter((i) => i.type === "duplicate_header")
        .map((i) => i.details)
        .join("; ");
      logger.warn("apply-pdu: post-apply integrity check failed — not pushing", {
        projectSlug,
        targetFile,
        issues: issueSummary,
      });
      for (const title of successfulInThisFile) {
        result.errors.push({
          title,
          error: `post-apply integrity check failed for ${targetFile}: ${issueSummary}`,
        });
      }
      continue;
    }

    try {
      const pushPath = await resolveDocPushPath(projectSlug, targetFile);
      const applyPush = await pushFile(
        projectSlug,
        pushPath,
        workingContent,
        `prism: S${sessionNumber} apply pending-doc-updates → ${targetFile}`,
      );
      // pushFile reports HTTP failures as a result shape, not a throw —
      // route them through the same error path as thrown failures so a
      // failed apply is never recorded as applied (SRV-02). Mirrors the
      // archive-push check below.
      if (!applyPush.success) {
        throw new Error(applyPush.error ?? "apply push failed");
      }
      result.applied.push(...successfulInThisFile);
      logger.info("apply-pdu: applied proposals", {
        projectSlug,
        targetFile,
        applied: successfulInThisFile.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("apply-pdu: push failed", { projectSlug, targetFile, error: msg });
      for (const title of successfulInThisFile) {
        result.errors.push({ title, error: `push ${targetFile} failed: ${msg}` });
      }
    }
  }

  // brief-444 (PDU provenance): a batch is CONSUMED when processing finished
  // without errors — whether proposals applied or every one was rejected/
  // skipped. Consumed batches are archived to pending-doc-updates-archive.md
  // with per-proposal provenance BEFORE the PDU file is cleared, so the file
  // stops accreting stale proposals without erasing the record. Error runs
  // leave the PDU in place (and unarchived) so the operator can re-run.
  const consumed =
    result.errors.length === 0 &&
    (result.applied.length > 0 || result.skipped.length > 0);

  if (consumed) {
    const lastSynth = pdu.content.match(/^>\s*Last synthesized:.*$/m)?.[0]?.replace(/^>\s*Last synthesized:\s*/, "")
      ?? "unknown";
    const today = new Date().toISOString().split("T")[0];

    // 1. Archive the consumed batch with applied/rejected provenance.
    try {
      const targetByTitle = new Map<string, string>();
      for (const p of proposals) {
        if (!targetByTitle.has(p.title)) targetByTitle.set(p.title, p.targetFile);
      }
      const entry = buildPduArchiveEntry({
        sessionNumber,
        date: today,
        synthesizedAt: lastSynth,
        applied: result.applied.map((title) => ({
          title,
          targetFile: targetByTitle.get(title) ?? "unknown",
        })),
        rejected: result.skipped.map((s) => ({
          title: s.title,
          targetFile: targetByTitle.get(s.title) ?? null,
          reason: s.reason,
        })),
      });

      let existingArchive: string | null = null;
      try {
        const resolved = await resolveDocPath(projectSlug, PDU_ARCHIVE_DOC);
        existingArchive = resolved.content;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "Not found" = first-time archive; anything else is operational and
        // routes to the error path below (PDU stays in place, no clear).
        if (!msg.includes("Not found")) throw err;
      }

      // Idempotency (brief-444 review): if a prior run archived this batch
      // but failed on the subsequent PDU clear, the re-run would otherwise
      // prepend the same batch a second time. The batch header carries the
      // session + date, so its presence marks the batch as already archived
      // — skip straight to the clear.
      const batchHeader = `## Batch: consumed S${sessionNumber} (${today})`;
      if (existingArchive?.includes(batchHeader)) {
        result.archived = true;
        logger.info("apply-pdu: batch already archived — skipping duplicate entry", {
          projectSlug,
          batchHeader,
        });
      } else {
        const archiveContent = upsertPduArchive(existingArchive, projectSlug, entry);
        const archivePushPath = await resolveDocPushPath(projectSlug, PDU_ARCHIVE_DOC);
        const archivePush = await pushFile(
          projectSlug,
          archivePushPath,
          archiveContent,
          `prism: S${sessionNumber} archive consumed pending-doc-updates batch`,
        );
        if (!archivePush.success) {
          throw new Error(archivePush.error ?? "archive push failed");
        }
        result.archived = true;
        logger.info("apply-pdu: consumed batch archived", {
          projectSlug,
          applied: result.applied.length,
          rejected: result.skipped.length,
          path: archivePushPath,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("apply-pdu: archive push failed — leaving PDU in place", {
        projectSlug,
        error: msg,
      });
      result.errors.push({ title: `(archive ${PDU_ARCHIVE_DOC})`, error: msg });
    }

    // 2. Clear the PDU file — only after the archive landed (provenance
    //    before erasure). An archive failure above leaves the batch intact
    //    for a re-run, exactly like an apply error.
    if (result.archived) {
      try {
        const cleared = buildClearedPdu(projectSlug, lastSynth, sessionNumber, today, {
          applied: result.applied.length,
          rejected: result.skipped.length,
        });
        const pushPath = await resolveDocPushPath(projectSlug, "pending-doc-updates.md");
        const clearPush = await pushFile(
          projectSlug,
          pushPath,
          cleared,
          `prism: S${sessionNumber} clear pending-doc-updates after auto-apply`,
        );
        // Result-shaped HTTP failure must not report cleared:true — the PDU
        // is still on disk and the next run must see it (SRV-02).
        if (!clearPush.success) {
          throw new Error(clearPush.error ?? "clear push failed");
        }
        result.cleared = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("apply-pdu: PDU clear push failed", { projectSlug, error: msg });
        result.errors.push({ title: "(clear pending-doc-updates.md)", error: msg });
      }
    }
  }

  return result;
}
