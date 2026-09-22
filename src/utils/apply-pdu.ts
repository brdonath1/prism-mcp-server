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

import { applyPatch, validateIntegrity } from "./markdown-sections.js";
import { resolveDocPath } from "./doc-resolver.js";
import { safeMutation } from "./safe-mutation.js";
import { DiagnosticsCollector } from "./diagnostics.js";
import { DOC_ROOT } from "../config.js";
import { createHash } from "node:crypto";
import { sanitizeContent } from "./sanitize-content.js";

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
export const PDU_TRANSACTION_MARKER = "<!-- prism-pdu-transaction: v1 -->";

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
  sourceDigest?: string,
): string {
  const summaryLine = outcome
    ? `Prior synthesis batch consumed at S${appliedAtSession} — ${outcome.applied} applied, ${outcome.rejected} rejected/skipped. Provenance: ${PDU_ARCHIVE_DOC}.`
    : "All proposals from the prior synthesis run were applied at finalize.";
  return `# Pending Doc Updates — ${projectSlug}

> Auto-generated proposals. Operator review required before applying via \`prism_patch\`.
> Last synthesized: ${syntheszedAt}
> Last applied: S${appliedAtSession} (${appliedAtDate})

## No Updates Needed

${summaryLine}${sourceDigest ? `\n> Source SHA-256: ${sourceDigest}` : ""}

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
function pduDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function archiveSource(entry: string, pdu: string, digest: string, snapshotSha: string): string {
  return `${entry}\n\n> Source SHA-256: ${digest}\n> Source snapshot: ${snapshotSha}\n\n### Source pending-doc-updates.md (verbatim)\n\`\`\`\`markdown\n${pdu}\n\`\`\`\``;
}

class PduNoop extends Error {}

class PduPlanError extends Error {
  constructor(readonly outcome: ApplyPduResult) {
    super("PDU batch cannot be atomically committed");
  }
}

/**
 * Apply and consume one PDU batch in a single atomic commit.
 *
 * The plan is rebuilt inside safeMutation after its HEAD snapshot, and again
 * after a conflict. No target update is published unless its provenance
 * archive entry and cleared source PDU are in that same commit.
 */
export async function applyPendingDocUpdates(
  projectSlug: string,
  sessionNumber: number,
  signal?: AbortSignal,
): Promise<ApplyPduResult> {
  const empty = (): ApplyPduResult => ({
    applied: [], skipped: [], errors: [], sanitized: [], cleared: false, archived: false,
  });
  let planned: ApplyPduResult | undefined;

  try {
    const mutation = await safeMutation({
      repo: projectSlug,
      commitMessage: `prism: S${sessionNumber} consume pending-doc-updates atomically`,
      // Document paths are resolved inside the callback after safeMutation has
      // snapshotted HEAD. This permits legacy paths and a missing first archive.
      readPaths: [],
      diagnostics: new DiagnosticsCollector(),
      signal,
      computeMutation: async (_files, snapshotSha) => {
        const outcome = empty();
        const abortPlan = () => {
          if (signal?.aborted) {
            throw new PduPlanError({
              ...empty(),
              errors: [{ title: "(atomic PDU commit)", error: "PDU publication aborted" }],
            });
          }
        };
        abortPlan();
        let pdu: { path: string; content: string };
        try {
          const resolved = await resolveDocPath(projectSlug, "pending-doc-updates.md", snapshotSha);
          pdu = { path: resolved.path, content: resolved.content };
          abortPlan();
        } catch (err) {
          if (err instanceof PduPlanError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (/Not found/i.test(msg)) throw new PduNoop();
          outcome.errors.push({ title: "(fetch pending-doc-updates.md)", error: msg });
          throw new PduPlanError(outcome);
        }

        if (isPduEmpty(pdu.content)) throw new PduNoop();
        // Old sequential PDU publications could have landed target appends
        // before archive/clear failed. A nonempty unmarked source is therefore
        // unsafe to replay automatically: preserve it for manual reconciliation.
        if (!pdu.content.startsWith(`${PDU_TRANSACTION_MARKER}\n`)) {
          outcome.errors.push({
            title: "(legacy pending-doc-updates residue)",
            error: "legacy ambiguous residue; manual reconciliation required",
          });
          throw new PduPlanError(outcome);
        }
        const proposals = parseProposals(pdu.content);
        if (proposals.length === 0) throw new PduNoop();

        const appliedProvenance: Array<{ title: string; targetFile: string }> = [];
        const rejectedProvenance: Array<{ title: string; targetFile: string; reason: string }> = [];
        const recordSkipped = (proposal: PduProposal, reason: string) => {
          outcome.skipped.push({ title: proposal.title, reason });
          rejectedProvenance.push({ title: proposal.title, targetFile: proposal.targetFile, reason });
        };
        const actionable = proposals.filter((proposal) => {
          if (proposal.operation !== null) return true;
          recordSkipped(proposal, proposal.unparsedReason ?? "unparsable");
          return false;
        });
        const lastSynth = pdu.content.match(/^>\s*Last synthesized:.*$/m)?.[0]?.replace(/^>\s*Last synthesized:\s*/, "") ?? "unknown";
        const digest = pduDigest(pdu.content);
        let archive: { path: string; content: string | null };
        try {
          const resolved = await resolveDocPath(projectSlug, PDU_ARCHIVE_DOC, snapshotSha);
          archive = { path: resolved.path, content: resolved.content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/Not found/i.test(msg)) {
            outcome.errors.push({ title: `(archive ${PDU_ARCHIVE_DOC})`, error: msg });
            throw new PduPlanError(outcome);
          }
          archive = { path: `${DOC_ROOT}/${PDU_ARCHIVE_DOC}`, content: null };
        }
        const grouped = groupByTarget(actionable);
        const writes: Array<{ path: string; content: string }> = [];
        for (const [targetFile, fileProposals] of grouped) {
          let resolved: { path: string; content: string };
          try {
            const target = await resolveDocPath(projectSlug, targetFile, snapshotSha);
            resolved = { path: target.path, content: target.content };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            for (const proposal of fileProposals) {
              outcome.errors.push({ title: proposal.title, error: `fetch ${targetFile} failed: ${msg}` });
            }
            continue;
          }

          let content = resolved.content;
          const appliedForFile: PduProposal[] = [];
          for (const proposal of fileProposals) {
            try {
              const beforeProposal = content;
              const recordSanitized = (lines: Array<{ line: number; header: string }>) => {
                if (lines.length > 0) outcome.sanitized.push({ title: proposal.title, lines });
              };
              if (proposal.operation === "glossary_row") {
                const sanitized = sanitizeContent(proposal.content!);
                recordSanitized(sanitized.neutralized);
                // A synthesized glossary term can repeat a row already present
                // in the current HEAD. Treat that as a consumed no-op rather
                // than adding a duplicate or leaving the batch unconsumed.
                if (content.split("\n").some((line) => line.trim() === sanitized.text.trim())) {
                  recordSkipped(proposal, "proposal produced no content change");
                  continue;
                }
                content = insertGlossaryRow(content, sanitized.text);
              } else {
                const level = proposal.section!.trim().match(/^(#{1,6})\s/)?.[1].length ?? 6;
                const sanitized = sanitizeContent(proposal.content!, { targetLevel: level });
                recordSanitized(sanitized.neutralized);
                content = applyPatch(content, proposal.section!, proposal.operation as "append" | "replace" | "prepend", sanitized.text);
              }
              if (content === beforeProposal) {
                recordSkipped(proposal, "proposal produced no content change");
              } else {
                appliedForFile.push(proposal);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (/Section not found|missing its EOF sentinel/i.test(msg)) {
                recordSkipped(proposal, msg);
              } else {
                outcome.errors.push({ title: proposal.title, error: msg });
              }
            }
          }

          if (appliedForFile.length === 0 || content === resolved.content) continue;
          const integrity = validateIntegrity(content);
          if (!integrity.valid) {
            const detail = integrity.issues.filter((issue) => issue.type === "duplicate_header").map((issue) => issue.details).join("; ");
            for (const proposal of appliedForFile) {
              outcome.errors.push({ title: proposal.title, error: `post-apply integrity check failed for ${targetFile}: ${detail}` });
            }
            continue;
          }
          writes.push({ path: resolved.path, content });
          outcome.applied.push(...appliedForFile.map((proposal) => proposal.title));
          appliedProvenance.push(...appliedForFile.map((proposal) => ({ title: proposal.title, targetFile: proposal.targetFile })));
        }

        // A PDU is consumed only if every planned transform was valid. Unlike
        // the former sequential writer, an error cannot publish a subset.
        if (outcome.errors.length > 0 || (outcome.applied.length === 0 && outcome.skipped.length === 0)) {
          throw new PduPlanError(outcome);
        }

        const date = new Date().toISOString().split("T")[0];
        const entry = archiveSource(buildPduArchiveEntry({
          sessionNumber,
          date,
          synthesizedAt: lastSynth,
          applied: appliedProvenance,
          rejected: rejectedProvenance,
        }), pdu.content, digest, snapshotSha);

        writes.push({ path: archive.path, content: upsertPduArchive(archive.content, projectSlug, entry) });
        writes.push({
          path: pdu.path,
          content: buildClearedPdu(projectSlug, lastSynth, sessionNumber, date, {
            applied: outcome.applied.length,
            rejected: outcome.skipped.length,
          }, digest),
        });
        abortPlan();
        outcome.archived = true;
        outcome.cleared = true;
        planned = outcome;
        return { writes };
      },
    });

    if (!mutation.ok) {
      return { ...empty(), errors: [{ title: "(atomic PDU commit)", error: mutation.error }] };
    }
    return planned ?? empty();
  } catch (err) {
    if (err instanceof PduNoop) return empty();
    if (err instanceof PduPlanError) {
      // A plan error occurs before the atomic commit. Do not report any
      // earlier candidate target as applied when nothing was published.
      return {
        ...err.outcome,
        applied: [],
        archived: false,
        cleared: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ...empty(), errors: [{ title: "(apply pending-doc-updates)", error: msg }] };
  }
}
