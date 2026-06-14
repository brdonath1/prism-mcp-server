/**
 * prism_scale_handoff tool — Execute handoff scaling protocol server-side.
 * Analyzes handoff content, extracts redistributable sections to living
 * documents, condenses verbose sections, and composes a lean handoff.
 *
 * Supports three modes:
 *  - "analyze": return a scaling plan without executing (fast, <10s)
 *  - "execute": run a plan from a previous analyze call
 *  - "full": attempt the complete operation in one call (default)
 *
 * Sends MCP progress notifications during full/execute to reset the client's
 * 60-second timeout (via resetTimeoutOnProgress: true in the SDK).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  pushFile,
  createAtomicCommit,
  getHeadSha,
} from "../github/client.js";
import { logger } from "../utils/logger.js";
import { extractSection } from "../utils/summarizer.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { detectMostRecentAtFromNumbers } from "../utils/archive.js";
import { SCALE_WALL_CLOCK_DEADLINE_MS } from "../config.js";

/** Maximum wall-clock time before returning a partial result (ms). */
const SAFETY_TIMEOUT_MS = 50_000;

/** Sentinel resolved by the prism_scale_handoff wall-clock deadline (SRV-64).
 *  The cooperative SAFETY_TIMEOUT_MS checks only fire between stages; this is
 *  the hard backstop that races the whole operation, mirroring push.ts. */
const SCALE_DEADLINE_SENTINEL = Symbol("scale.deadline");

/** Total number of stages in a full/execute scaling operation. */
const TOTAL_STAGES = 6;

// ── Section name sets for dispatching ───────────────────────────────────────

const DECISION_SECTIONS = new Set([
  "Active Decisions", "Decisions", "Key Decisions", "Decision Log",
]);
const SESSION_SECTIONS = new Set([
  "Session History", "Recent Sessions", "Session Log",
]);
const ARTIFACT_SECTIONS = new Set(["Artifacts Registry", "Artifacts"]);
const ARCH_SECTIONS = new Set([
  "Architecture", "Technical Architecture", "Stack",
]);
const GUARDRAIL_SECTIONS = new Set([
  "Guardrails", "Eliminated Approaches", "What Not To Do",
]);
const STRATEGIC_SECTIONS = new Set(["Strategic Direction", "Strategy"]);
const WHERE_SECTIONS = new Set(["Where We Are", "Current State"]);

// ── Types ────────────────────────────────────────────────────────────────────

interface ScaleAction {
  description: string;
  source_section: string;
  destination_file: string;
  bytes_moved: number;
  executed: boolean;
  content_to_move?: string;
}

/** The serializable plan returned by "analyze" and consumed by "execute". */
const ScalePlanSchema = z.object({
  project_slug: z.string(),
  before_size_bytes: z.number(),
  actions: z.array(
    z.object({
      description: z.string(),
      source_section: z.string(),
      destination_file: z.string(),
      bytes_moved: z.number(),
      content_to_move: z.string().optional(),
    })
  ),
});

type ScalePlan = z.infer<typeof ScalePlanSchema>;

interface ParsedDecision {
  id: string;
  title: string;
  domain: string;
  status: string;
  session: string;
  fullText: string;
}

// ── Progress helper ──────────────────────────────────────────────────────────

/**
 * Send an MCP progress notification if the client provided a progressToken.
 * Silently no-ops when the token is absent.
 */
async function sendProgress(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  progressToken: string | number | undefined,
  stage: number,
  message: string,
): Promise<void> {
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: stage,
        total: TOTAL_STAGES,
        message,
      },
    });
  } catch {
    // Best-effort — don't let notification failures break the operation.
  }
}

// ── String & section helpers ────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace a markdown section's body content in the document.
 * Finds the section by header name (case-insensitive includes match on header text)
 * and replaces everything from after the header to the next same-or-higher-level header.
 * If newBody is null, removes the section entirely (header + body).
 */
function replaceSection(content: string, sectionName: string, newBody: string | null): string {
  const lines = content.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let headerLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      if (sectionStart >= 0 && level <= headerLevel) {
        sectionEnd = i;
        break;
      }

      if (sectionStart < 0 && title.toLowerCase().includes(sectionName.toLowerCase())) {
        sectionStart = i;
        headerLevel = level;
      }
    }
  }

  if (sectionStart < 0) return content;

  const before = lines.slice(0, sectionStart);
  const after = lines.slice(sectionEnd);

  if (newBody === null) {
    return [...before, ...after].join("\n");
  }

  const header = lines[sectionStart];
  return [...before, header, newBody, "", ...after].join("\n");
}

/**
 * Ensure exactly one EOF sentinel at the end of the handoff.
 */
function ensureSingleEof(content: string): string {
  const eofSentinel = "<!-- EOF: handoff.md -->";
  const cleaned = content.replace(new RegExp(escapeRegex(eofSentinel), "g"), "");
  return cleaned.trimEnd() + "\n\n" + eofSentinel + "\n";
}

// ── Decision parsing & formatting ───────────────────────────────────────────

/**
 * Parse D-N decision entries from a section body.
 */
function parseDecisionEntries(sectionBody: string): ParsedDecision[] {
  const entries: ParsedDecision[] = [];
  const pattern = /^###?\s+(D-\d+)[:\s]*([^\n]*)/gm;
  const positions: { index: number; id: string; title: string }[] = [];

  let match;
  while ((match = pattern.exec(sectionBody)) !== null) {
    positions.push({ index: match.index, id: match[1], title: match[2].trim() });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : sectionBody.length;
    const fullText = sectionBody.slice(start, end).trim();
    const body = fullText.split("\n").slice(1).join("\n");

    const statusMatch = body.match(/Status\W+(\w+)/i);
    const domainMatch = body.match(/Domain\W+(.+?)$/im);
    const sessionMatch = body.match(/Session\W+(\d+)/i);

    entries.push({
      id: positions[i].id,
      title: positions[i].title || "(untitled)",
      domain: domainMatch ? domainMatch[1].trim() : "General",
      status: statusMatch ? statusMatch[1].trim().toUpperCase() : "SETTLED",
      session: sessionMatch ? sessionMatch[1] : "-",
      fullText,
    });
  }

  return entries;
}

/**
 * Build a compact summary table of the last N decisions for the handoff.
 */
function buildDecisionSummaryTable(decisions: ParsedDecision[], showLast = 5): string {
  const lastN = decisions.slice(-showLast);
  const rows = lastN.map(
    (d) => `| ${d.id} | ${d.title} | ${d.domain} | ${d.status} | ${d.session} |`,
  );

  return [
    "| ID | Title | Domain | Status | Session |",
    "|----|-------|--------|--------|---------|",
    ...rows,
    "",
    `*${decisions.length} total decisions -- full index: decisions/_INDEX.md*`,
  ].join("\n");
}

/**
 * Header of the details section that preserves scaled-out decision rationale
 * in decisions/_INDEX.md (brief-460 / SRV-09). Exported for tests.
 */
export const SCALED_DETAILS_HEADER = "## Decision Details (scaled from handoff)";

/**
 * Build the full-rationale blocks for decisions being merged. fullText is
 * each entry verbatim as it stood in the handoff (header + body) — fidelity
 * is the point: scaling REDISTRIBUTES context, it must not delete it.
 */
function buildDecisionDetailsBlocks(decisions: ParsedDecision[]): string {
  return decisions.map((d) => d.fullText.trim()).join("\n\n");
}

/**
 * Append decision-rationale blocks under the SCALED_DETAILS_HEADER section,
 * creating the section (always BELOW the registry table) when absent.
 */
function appendDecisionDetails(content: string, blocks: string): string {
  const eofSentinel = "<!-- EOF: _INDEX.md -->";
  const payload = content.includes(SCALED_DETAILS_HEADER)
    ? blocks
    : `${SCALED_DETAILS_HEADER}\n\n` +
      `> Full rationale preserved by prism_scale_handoff (SRV-09). The summary table above is the registry; these blocks carry the reasoning that was scaled out of handoff.md.\n\n` +
      blocks;
  if (content.includes(eofSentinel)) {
    return content.replace(eofSentinel, payload + "\n\n" + eofSentinel);
  }
  return content.trimEnd() + "\n\n" + payload + "\n";
}

/**
 * Merge parsed decisions into an existing _INDEX.md, avoiding duplicate IDs.
 *
 * brief-460 / SRV-09: in addition to the one-line registry rows, each new
 * decision's fullText (the rationale prose extracted out of the handoff) is
 * appended under SCALED_DETAILS_HEADER — previously fullText had no consumer
 * and scaling silently deleted the rationale from the live corpus. New table
 * rows are inserted ABOVE the details section so the registry table never
 * gets split by previously-merged detail blocks.
 */
function mergeDecisionsIntoIndex(decisions: ParsedDecision[], existingContent: string): string {
  const existingIds = new Set<string>();
  const idPattern = /\|\s*(D-\d+)\s*\|/g;
  let m;
  while ((m = idPattern.exec(existingContent)) !== null) {
    existingIds.add(m[1]);
  }

  const newDecisions = decisions.filter((d) => !existingIds.has(d.id));
  if (newDecisions.length === 0) return existingContent;

  const newRows = newDecisions
    .map((d) => `| ${d.id} | ${d.title} | ${d.domain} | ${d.status} | ${d.session} |`)
    .join("\n");

  const hasTable = existingContent.includes("|---");
  const eofSentinel = "<!-- EOF: _INDEX.md -->";
  const detailsIdx = existingContent.indexOf(SCALED_DETAILS_HEADER);

  let content: string;
  if (hasTable) {
    if (detailsIdx !== -1) {
      content =
        existingContent.slice(0, detailsIdx) + newRows + "\n\n" + existingContent.slice(detailsIdx);
    } else if (existingContent.includes(eofSentinel)) {
      content = existingContent.replace(eofSentinel, newRows + "\n" + eofSentinel);
    } else {
      content = existingContent.trimEnd() + "\n" + newRows + "\n";
    }
  } else {
    // No existing table — create one
    const tableHeader =
      "| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|---------|";
    if (detailsIdx !== -1) {
      content =
        existingContent.slice(0, detailsIdx) +
        tableHeader + "\n" + newRows + "\n\n" +
        existingContent.slice(detailsIdx);
    } else if (existingContent.includes(eofSentinel)) {
      content = existingContent.replace(
        eofSentinel,
        "\n" + tableHeader + "\n" + newRows + "\n\n" + eofSentinel,
      );
    } else {
      content = existingContent.trimEnd() + "\n\n" + tableHeader + "\n" + newRows + "\n";
    }
  }

  return appendDecisionDetails(content, buildDecisionDetailsBlocks(newDecisions));
}

// ── Session history helpers ─────────────────────────────────────────────────

/**
 * Condense session history: keep the 3 MOST RECENT sessions as 1-line
 * summaries, archive older entries.
 *
 * brief-459 / SRV-22: "most recent" is resolved from the parsed session
 * numbers (archive.ts's "auto" heuristic — newest-first vs chronological is
 * per-project, the S165/INS-316 bug class), not from document order. The old
 * `slice(-3)` kept the LAST three in document order, which on newest-first
 * handoffs were the three OLDEST sessions.
 *
 * Exported for tests (brief-459).
 */
export function condenseSessionHistory(sectionBody: string): { lean: string; archive: string } {
  const sessionPattern = /^###?\s+Session\s+(\d+)/gm;
  const positions: { index: number; num: number }[] = [];

  let match;
  while ((match = sessionPattern.exec(sectionBody)) !== null) {
    positions.push({ index: match.index, num: parseInt(match[1], 10) });
  }

  if (positions.length <= 3) {
    return { lean: sectionBody, archive: "" };
  }

  const sessions: { num: number; text: string }[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : sectionBody.length;
    sessions.push({ num: positions[i].num, text: sectionBody.slice(start, end).trim() });
  }

  const orientation = detectMostRecentAtFromNumbers(sessions.map((s) => s.num));
  const toArchive = orientation === "top" ? sessions.slice(3) : sessions.slice(0, -3);
  const toKeep = orientation === "top" ? sessions.slice(0, 3) : sessions.slice(-3);

  const condensedLines = toKeep
    .map((s) => {
      const lines = s.text.split("\n").filter((l) => l.trim().length > 0);
      const firstContentLine = lines.find((l) => !l.startsWith("#")) || "";
      const summary =
        firstContentLine.length > 100
          ? firstContentLine.slice(0, 100).trim() + "..."
          : firstContentLine;
      return `- **Session ${s.num}:** ${summary}`;
    })
    .join("\n");

  const lean =
    condensedLines + "\n\n" +
    `*${sessions.length} total sessions -- full log: session-log.md*`;

  const archive = toArchive.map((s) => s.text).join("\n\n");

  return { lean, archive };
}

/**
 * Drop session blocks from an archive fragment whose session numbers already
 * exist in the destination document (brief-459 / SRV-22): re-running a scale
 * (or scaling a handoff whose Session History overlaps session-log.md) used
 * to append duplicate `### Session N` entries to the log.
 *
 * Returns the fragment unchanged when nothing collides; returns "" when every
 * block is a duplicate. Exported for tests (brief-459).
 */
export function stripDuplicateSessionEntries(
  archiveText: string,
  destinationContent: string,
): string {
  const headerPattern = /^###?\s+Session\s+(\d+)/gm;
  const existingNums = new Set<number>();
  let match;
  while ((match = headerPattern.exec(destinationContent)) !== null) {
    existingNums.add(parseInt(match[1], 10));
  }
  if (existingNums.size === 0) return archiveText;

  const blockPattern = /^###?\s+Session\s+(\d+)/gm;
  const positions: { index: number; num: number }[] = [];
  while ((match = blockPattern.exec(archiveText)) !== null) {
    positions.push({ index: match.index, num: parseInt(match[1], 10) });
  }
  if (positions.length === 0) return archiveText;

  const keptBlocks: string[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : archiveText.length;
    if (!existingNums.has(positions[i].num)) {
      keptBlocks.push(archiveText.slice(start, end).trim());
    }
  }
  if (keptBlocks.length === positions.length) return archiveText;
  return keptBlocks.join("\n\n");
}

// ── Condensation helpers ────────────────────────────────────────────────────

/**
 * Keep only the first N list items (numbered or bulleted).
 */
function condenseToMaxItems(body: string, maxItems: number): string {
  const lines = body.split("\n");
  const result: string[] = [];
  let itemCount = 0;

  for (const line of lines) {
    if (/^\s*(\d+\.|-|\*)\s+/.test(line)) {
      itemCount++;
      if (itemCount <= maxItems) {
        result.push(line);
      }
    } else if (itemCount <= maxItems) {
      result.push(line);
    }
  }

  return result.join("\n").trim();
}

/**
 * Keep only the first N sentences.
 */
function condenseToSentences(body: string, maxSentences: number): string {
  const sentences = body.match(/[^.!?\n]+[.!?]+/g);
  if (!sentences || sentences.length === 0) {
    return body.split("\n")[0].trim();
  }
  return sentences.slice(0, maxSentences).join(" ").trim();
}

/**
 * Keep only the first paragraph (text before the first double-newline).
 */
function condenseToFirstParagraph(body: string): string {
  const paragraphs = body.split(/\n\n+/);
  return paragraphs[0].trim();
}

/**
 * Remove all [x] checked items from a checklist section.
 */
function removeCheckedItems(body: string): string {
  const lines = body.split("\n");
  return lines.filter((line) => !/^\s*-\s*\[x\]/i.test(line)).join("\n").trim();
}

// ── Content analysis ─────────────────────────────────────────────────────────

/**
 * Identify content in handoff that can be moved to living documents.
 * Returns a list of scaling actions with estimated bytes to move.
 */
function identifyScalableContent(
  handoffContent: string,
  _livingDocs: Map<string, string>,
): ScaleAction[] {
  const actions: ScaleAction[] = [];
  const encoder = new TextEncoder();

  // 1. Inline decisions (>8 entries → extract all to _INDEX.md)
  for (const name of DECISION_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const decisions = parseDecisionEntries(section);
    if (decisions.length > 8) {
      actions.push({
        description: `Extract ${decisions.length} inline decisions to decisions/_INDEX.md — keep summary table in handoff`,
        source_section: name,
        destination_file: "decisions/_INDEX.md",
        bytes_moved: encoder.encode(section).length,
        executed: false,
        content_to_move: section,
      });
    }
    break;
  }

  // 2. Session History (>3 entries → archive older to session-log.md)
  for (const name of SESSION_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sessionEntries = section.match(/^###?\s+Session\s+\d+/gm) || [];
    if (sessionEntries.length > 3) {
      const entriesToArchive = sessionEntries.length - 3;
      actions.push({
        description: `Archive ${entriesToArchive} old session entries to session-log.md — keep last 3 condensed`,
        source_section: name,
        destination_file: "session-log.md",
        bytes_moved: Math.round(
          encoder.encode(section).length * (entriesToArchive / sessionEntries.length),
        ),
        executed: false,
        content_to_move: section,
      });
    }
    break;
  }

  // 3. Artifacts Registry (>2KB → extract to architecture.md)
  for (const name of ARTIFACT_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sectionBytes = encoder.encode(section).length;
    if (sectionBytes > 2048) {
      actions.push({
        description: "Move Artifacts Registry to architecture.md — keep pointer in handoff",
        source_section: name,
        destination_file: "architecture.md",
        bytes_moved: sectionBytes,
        executed: false,
        content_to_move: section,
      });
    }
    break;
  }

  // 4. Open Questions (checked [x] items → remove them)
  const openQuestions = extractSection(handoffContent, "Open Questions");
  if (openQuestions) {
    const checkedItems = openQuestions
      .split("\n")
      .filter((l) => /^\s*-\s*\[x\]/i.test(l));
    if (checkedItems.length > 0) {
      actions.push({
        description: `Remove ${checkedItems.length} resolved open questions`,
        source_section: "Open Questions",
        destination_file: "(remove)",
        bytes_moved: encoder.encode(checkedItems.join("\n")).length,
        executed: false,
        content_to_move: checkedItems.join("\n"),
      });
    }
  }

  // 5. Critical Context (>5 items → condense to 5)
  const criticalContext = extractSection(handoffContent, "Critical Context");
  if (criticalContext) {
    const items = criticalContext
      .split("\n")
      .filter((l) => /^\s*(\d+\.|-|\*)\s+/.test(l));
    if (items.length > 5) {
      const excess = items.slice(5);
      actions.push({
        description: `Condense Critical Context from ${items.length} to 5 items`,
        source_section: "Critical Context",
        destination_file: "(remove)",
        bytes_moved: encoder.encode(excess.join("\n")).length,
        executed: false,
        content_to_move: excess.join("\n"),
      });
    }
  }

  // 6. Strategic Direction (>500 bytes → truncate to first paragraph)
  for (const name of STRATEGIC_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sectionBytes = encoder.encode(section).length;
    if (sectionBytes > 500) {
      const condensed = condenseToFirstParagraph(section);
      const savings = sectionBytes - encoder.encode(condensed).length;
      if (savings > 100) {
        actions.push({
          description: "Truncate Strategic Direction to first paragraph",
          source_section: name,
          destination_file: "(remove)",
          bytes_moved: savings,
          executed: false,
          content_to_move: section,
        });
      }
    }
    break;
  }

  // 7. Where We Are (>500 bytes → condense to 2-3 sentences)
  for (const name of WHERE_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sectionBytes = encoder.encode(section).length;
    if (sectionBytes > 500) {
      const condensed = condenseToSentences(section, 3);
      const savings = sectionBytes - encoder.encode(condensed).length;
      if (savings > 100) {
        actions.push({
          description: "Condense 'Where We Are' to 2-3 sentences",
          source_section: name,
          destination_file: "(remove)",
          bytes_moved: savings,
          executed: false,
          content_to_move: section,
        });
      }
    }
    break;
  }

  // 8. Guardrails (>2KB → extract to eliminated.md)
  for (const name of GUARDRAIL_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sectionBytes = encoder.encode(section).length;
    if (sectionBytes > 2048) {
      actions.push({
        description: "Move verbose guardrails to eliminated.md — keep summary in handoff",
        source_section: name,
        destination_file: "eliminated.md",
        bytes_moved: sectionBytes,
        executed: false,
        content_to_move: section,
      });
    }
    break;
  }

  // 9. Architecture (>2KB → extract to architecture.md)
  for (const name of ARCH_SECTIONS) {
    const section = extractSection(handoffContent, name);
    if (!section) continue;

    const sectionBytes = encoder.encode(section).length;
    if (sectionBytes > 2048) {
      actions.push({
        description: "Move verbose architecture details to architecture.md — keep pointer in handoff",
        source_section: name,
        destination_file: "architecture.md",
        bytes_moved: sectionBytes,
        executed: false,
        content_to_move: section,
      });
    }
    break;
  }

  // 10. Duplicate EOF sentinels
  const eofMatches = handoffContent.match(/<!-- EOF: handoff\.md -->/g);
  if (eofMatches && eofMatches.length > 1) {
    actions.push({
      description: `Remove ${eofMatches.length - 1} duplicate EOF sentinel(s)`,
      source_section: "Duplicate EOF",
      destination_file: "(remove)",
      bytes_moved: (eofMatches.length - 1) * "<!-- EOF: handoff.md -->".length,
      executed: false,
    });
  }

  return actions;
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Execute scaling actions — modifies handoff content by replacing sections
 * with lean versions, and pushes extracted content to living documents.
 * Returns the composed lean handoff and push results.
 */
async function executeScaling(
  projectSlug: string,
  handoffContent: string,
  actions: ScaleAction[],
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  progressToken: string | number | undefined,
  startTime: number,
): Promise<{
  updatedHandoff: string;
  destFiles: Array<{ path: string; content: string }>;
  timed_out: boolean;
}> {
  let updatedHandoff = handoffContent;
  const destinationContent = new Map<string, string[]>();
  const decisionMerges = new Map<string, ParsedDecision[]>();
  // brief-459 / SRV-22: session-history fragments are deduped against the
  // destination's existing session numbers at append time — track which
  // parts are session archives.
  const sessionArchiveParts = new Set<string>();

  // ── Stage 4: Compose redistributed content ──
  await sendProgress(extra, progressToken, 4, "Composing redistributed content...");
  logger.info("scale: stage 4 — compose redistributed content", {
    elapsed_ms: Date.now() - startTime,
  });

  for (const action of actions) {
    const sectionName = action.source_section;

    // ── Decision extraction ──
    if (DECISION_SECTIONS.has(sectionName)) {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        const decisions = parseDecisionEntries(sectionBody);
        if (decisions.length > 0) {
          const summary = buildDecisionSummaryTable(decisions);
          updatedHandoff = replaceSection(updatedHandoff, sectionName, summary);
          decisionMerges.set(action.destination_file, decisions);
        }
      }
      action.executed = true;
      continue;
    }

    // ── Session history extraction ──
    if (SESSION_SECTIONS.has(sectionName)) {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        const { lean, archive } = condenseSessionHistory(sectionBody);
        updatedHandoff = replaceSection(updatedHandoff, sectionName, lean);
        if (archive) {
          const parts = destinationContent.get(action.destination_file) ?? [];
          parts.push(archive);
          destinationContent.set(action.destination_file, parts);
          sessionArchiveParts.add(archive);
        }
      }
      action.executed = true;
      continue;
    }

    // ── Artifact extraction ──
    if (ARTIFACT_SECTIONS.has(sectionName)) {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          `*Full artifacts registry in ${action.destination_file}*`,
        );
        const parts = destinationContent.get(action.destination_file) ?? [];
        parts.push(`## Artifacts Registry\n\n${sectionBody}`);
        destinationContent.set(action.destination_file, parts);
      }
      action.executed = true;
      continue;
    }

    // ── Architecture extraction ──
    if (ARCH_SECTIONS.has(sectionName) && action.destination_file === "architecture.md") {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          "*Full architecture details in architecture.md*",
        );
        const parts = destinationContent.get(action.destination_file) ?? [];
        parts.push(sectionBody);
        destinationContent.set(action.destination_file, parts);
      }
      action.executed = true;
      continue;
    }

    // ── Guardrail extraction ──
    if (GUARDRAIL_SECTIONS.has(sectionName) && action.destination_file === "eliminated.md") {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        const guardrailHeaders = sectionBody.match(/###?\s+(G-\d+)[:\s]*([^\n]*)/g) || [];
        const summary = guardrailHeaders.length > 0
          ? guardrailHeaders.map((g) => `- ${g.replace(/^#+\s+/, "")}`).join("\n") +
            "\n\n*Full details in eliminated.md*"
          : "*Full guardrails in eliminated.md*";
        updatedHandoff = replaceSection(updatedHandoff, sectionName, summary);
        const parts = destinationContent.get(action.destination_file) ?? [];
        parts.push(sectionBody);
        destinationContent.set(action.destination_file, parts);
      }
      action.executed = true;
      continue;
    }

    // ── Open Questions cleanup ──
    if (sectionName === "Open Questions" && action.destination_file === "(remove)") {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          removeCheckedItems(sectionBody),
        );
      }
      action.executed = true;
      continue;
    }

    // ── Critical Context condensation ──
    if (sectionName === "Critical Context") {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          condenseToMaxItems(sectionBody, 5),
        );
      }
      action.executed = true;
      continue;
    }

    // ── Where We Are condensation ──
    if (WHERE_SECTIONS.has(sectionName)) {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          condenseToSentences(sectionBody, 3),
        );
      }
      action.executed = true;
      continue;
    }

    // ── Strategic Direction condensation ──
    if (STRATEGIC_SECTIONS.has(sectionName)) {
      const sectionBody = extractSection(updatedHandoff, sectionName);
      if (sectionBody) {
        updatedHandoff = replaceSection(
          updatedHandoff, sectionName,
          condenseToFirstParagraph(sectionBody),
        );
      }
      action.executed = true;
      continue;
    }

    // ── Duplicate EOF removal ──
    if (sectionName === "Duplicate EOF") {
      action.executed = true;
    }
  }

  // Ensure exactly one EOF sentinel
  updatedHandoff = ensureSingleEof(updatedHandoff);

  // Clean up excessive blank lines
  updatedHandoff = updatedHandoff.replace(/\n{3,}/g, "\n\n");

  // Check safety timeout before network I/O
  if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
    return { updatedHandoff, destFiles: [], timed_out: true };
  }

  // ── Stage 5: Materialize destination file contents (no push yet — A-6) ──
  //
  // Pre-S47 this stage pushed destination files in parallel via Promise.all,
  // and the handoff was pushed separately by the caller. A partial failure
  // (some destinations succeeded, handoff push then succeeded) left content
  // extracted from the handoff pointing at destinations that had no row yet
  // — the classic partial-state data-loss hazard the audit flagged.
  //
  // Now we build the full `destFiles` list and hand it back to the caller,
  // which bundles it with the reduced handoff into a single atomic commit.
  await sendProgress(extra, progressToken, 5, "Composing destination file contents...");
  logger.info("scale: stage 5 — compose destination file contents", {
    elapsed_ms: Date.now() - startTime,
  });

  const destFiles: Array<{ path: string; content: string }> = [];
  const allDestPaths = new Set([...destinationContent.keys(), ...decisionMerges.keys()]);
  const destPaths = [...allDestPaths].filter((p) => p !== "(remove)");

  if (destPaths.length > 0) {
    // D-67: Resolve dest file paths with backward-compatible fallback
    const destFileResolved = await Promise.allSettled(
      destPaths.map(async (destPath) => {
        try {
          const resolved = await resolveDocPath(projectSlug, destPath);
          return { destPath, content: resolved.content, resolvedPath: resolved.path };
        } catch {
          return { destPath, content: null, resolvedPath: await resolveDocPushPath(projectSlug, destPath) };
        }
      })
    );
    const destFileMap = new Map<string, { content: string | null; resolvedPath: string }>();
    for (const outcome of destFileResolved) {
      if (outcome.status === "fulfilled") {
        destFileMap.set(outcome.value.destPath, { content: outcome.value.content, resolvedPath: outcome.value.resolvedPath });
      }
    }

    for (const destPath of destPaths) {
      const destInfo = destFileMap.get(destPath);
      const resolvedPushPath = destInfo?.resolvedPath ?? destPath;
      const destFileContent = destInfo?.content ?? null;
      const fileName = destPath.split("/").pop() || destPath;
      const eofSentinel = `<!-- EOF: ${fileName} -->`;

      let destContent: string;

      if (decisionMerges.has(destPath)) {
        // Decision merge: special table-aware logic
        const decisions = decisionMerges.get(destPath)!;
        if (destFileContent) {
          destContent = mergeDecisionsIntoIndex(decisions, destFileContent);
        } else {
          const tableHeader =
            "# Decision Index\n\n| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|---------|";
          const rows = decisions
            .map((d) => `| ${d.id} | ${d.title} | ${d.domain} | ${d.status} | ${d.session} |`)
            .join("\n");
          // brief-460 / SRV-09: the fresh index carries the full rationale
          // blocks too — the rows alone would silently delete the reasoning
          // scaled out of the handoff.
          const details =
            `${SCALED_DETAILS_HEADER}\n\n` +
            `> Full rationale preserved by prism_scale_handoff (SRV-09). The summary table above is the registry; these blocks carry the reasoning that was scaled out of handoff.md.\n\n` +
            buildDecisionDetailsBlocks(decisions);
          destContent = `${tableHeader}\n${rows}\n\n${details}\n\n${eofSentinel}\n`;
        }
      } else if (destFileContent) {
        // brief-459 / SRV-22: dedupe session-history fragments against the
        // session numbers already recorded in the destination — re-scaled
        // handoffs used to append duplicate `### Session N` entries.
        const parts = (destinationContent.get(destPath) || [])
          .map((p) =>
            sessionArchiveParts.has(p)
              ? stripDuplicateSessionEntries(p, destFileContent)
              : p,
          )
          .filter((p) => p.trim().length > 0);
        if (parts.length === 0) {
          continue; // everything deduped away — destination unchanged
        }
        const newContent = parts.join("\n\n");
        destContent = destFileContent;
        if (destContent.includes(eofSentinel)) {
          destContent = destContent.replace(eofSentinel, newContent + "\n\n" + eofSentinel);
        } else {
          destContent = destContent.trimEnd() + "\n\n" + newContent + "\n";
        }
      } else {
        const parts = destinationContent.get(destPath) || [];
        const title = fileName.replace(".md", "").replace(/_/g, " ");
        destContent = `# ${title}\n\n${parts.join("\n\n")}\n\n${eofSentinel}\n`;
      }

      destFiles.push({ path: resolvedPushPath, content: destContent });
    }
  }

  return { updatedHandoff, destFiles, timed_out: false };
}

/**
 * Push the reduced handoff + destination files as a single atomic commit,
 * with the push.ts-style HEAD-SHA guard and sequential fallback (A-6 / S47 P2.2).
 *
 * Returns a pushResults array in the same shape as the pre-S47 code so the
 * response contract downstream is unchanged. `partial_state` fires on the
 * HEAD-moved branch; callers surface it as a warning.
 *
 * brief-460 / SRV-25 + SRV-43 — fallback data-safety ordering:
 *
 *  - The sequential fallback pushes DESTINATIONS FIRST and the reduced
 *    handoff ONLY when every destination landed. The pre-460 loop pushed
 *    the reduced handoff even after a destination push failed, leaving the
 *    extracted content in neither the handoff nor the destination — the
 *    exact partial-state data-loss hazard the atomic path was built to
 *    prevent. An aborted fallback leaves the handoff at FULL size: nothing
 *    is lost, the scale just hasn't happened.
 *
 *  - The fallback is REFUSED outright (`fallback_aborted: "head_unknown"`)
 *    when the HEAD position cannot be verified — headShaBefore or
 *    headShaAfter unavailable. The pre-460 code defaulted headChanged to
 *    false in that case, running sequential pushes over a possibly-moved
 *    HEAD and risking a clobber of concurrent writes.
 *
 * Exported for tests (brief-460).
 */
export async function atomicCommitScaled(
  projectSlug: string,
  handoffPath: string,
  updatedHandoff: string,
  destFiles: Array<{ path: string; content: string }>,
  commitMessage: string,
): Promise<{
  pushResults: Array<{ path: string; success: boolean }>;
  partial_state: boolean;
  atomic_error?: string;
  fallback_aborted?: "destination_failure" | "head_unknown";
}> {
  const allFiles = [
    ...destFiles,
    { path: handoffPath, content: updatedHandoff },
  ];

  const headShaBefore = await getHeadSha(projectSlug);
  const atomicResult = await createAtomicCommit(
    projectSlug,
    allFiles,
    commitMessage,
  );

  if (atomicResult.success) {
    return {
      pushResults: allFiles.map((f) => ({ path: f.path, success: true })),
      partial_state: false,
    };
  }

  // Atomic failed — mirror push.ts's HEAD-SHA guard + sequential fallback.
  const headShaAfter = headShaBefore ? await getHeadSha(projectSlug) : undefined;
  if (!headShaBefore || !headShaAfter) {
    logger.error(
      "prism_scale_handoff atomic commit failed and HEAD position is unknown — refusing sequential fallback",
      {
        project_slug: projectSlug,
        atomicError: atomicResult.error,
        headShaBefore: headShaBefore ?? null,
        headShaAfter: headShaAfter ?? null,
      },
    );
    return {
      pushResults: allFiles.map((f) => ({ path: f.path, success: false })),
      partial_state: false,
      atomic_error: atomicResult.error,
      fallback_aborted: "head_unknown",
    };
  }

  if (headShaAfter !== headShaBefore) {
    logger.error(
      "prism_scale_handoff atomic commit failed with HEAD changed — partial state",
      { project_slug: projectSlug, atomicError: atomicResult.error },
    );
    return {
      pushResults: allFiles.map((f) => ({ path: f.path, success: false })),
      partial_state: true,
      atomic_error: atomicResult.error,
    };
  }

  logger.warn(
    "prism_scale_handoff atomic failed; falling back to sequential pushFile (destinations first)",
    { project_slug: projectSlug, atomicError: atomicResult.error },
  );
  const pushResults: Array<{ path: string; success: boolean }> = [];
  let destinationFailed = false;
  for (const file of destFiles) {
    const fileName = file.path.split("/").pop() || file.path;
    const result = await pushFile(projectSlug, file.path, file.content, `prism: extract ${fileName}`);
    pushResults.push({ path: file.path, success: result.success });
    if (!result.success) destinationFailed = true;
  }

  if (destinationFailed) {
    logger.error(
      "prism_scale_handoff fallback aborted before handoff push — destination push failed; handoff NOT reduced",
      { project_slug: projectSlug, atomicError: atomicResult.error },
    );
    pushResults.push({ path: handoffPath, success: false });
    return {
      pushResults,
      partial_state: false,
      atomic_error: atomicResult.error,
      fallback_aborted: "destination_failure",
    };
  }

  const handoffResult = await pushFile(projectSlug, handoffPath, updatedHandoff, commitMessage);
  pushResults.push({ path: handoffPath, success: handoffResult.success });
  return { pushResults, partial_state: false, atomic_error: atomicResult.error };
}

// ── Tool registration ────────────────────────────────────────────────────────

/**
 * Register the prism_scale_handoff tool on an MCP server instance.
 */
export function registerScaleHandoff(server: McpServer): void {
  server.tool(
    "prism_scale_handoff",
    "Handoff scaling — redistributes content to living documents. Modes: full (default), analyze (preview), execute (run plan).",
    {
      project_slug: z.string().describe("Project repo name"),
      action: z
        .enum(["full", "analyze", "execute"])
        .default("full")
        .describe(
          "'full' runs complete scaling (default). 'analyze' returns a plan without executing. 'execute' runs a plan from a previous analyze call.",
        ),
      plan: ScalePlanSchema.optional().describe(
        "Required for action='execute'. The plan object returned by a previous 'analyze' call.",
      ),
    },
    async ({ project_slug, action, plan }, extra) => {
      const startTime = Date.now();
      const diagnostics = new DiagnosticsCollector();
      const progressToken = extra._meta?.progressToken;

      logger.info("prism_scale_handoff", {
        project_slug, action,
        hasProgressToken: progressToken !== undefined,
      });

      // SRV-64: hard wall-clock backstop around the entire scale operation.
      // The cooperative SAFETY_TIMEOUT_MS checks only fire between stages; a
      // hung GitHub call inside a stage had no deadline. Race the whole body.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadlinePromise = new Promise<typeof SCALE_DEADLINE_SENTINEL>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(SCALE_DEADLINE_SENTINEL), SCALE_WALL_CLOCK_DEADLINE_MS);
      });

      const scaleWork = async () => {
       try {
        // ── action: "execute" — run a previously-generated plan ──
        if (action === "execute") {
          if (!plan) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "Missing 'plan' parameter. Run with action='analyze' first to get a plan.",
                  project: project_slug,
                }),
              }],
              isError: true,
            };
          }

          if (plan.project_slug !== project_slug) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Plan project_slug '${plan.project_slug}' does not match request project_slug '${project_slug}'.`,
                  project: project_slug,
                }),
              }],
              isError: true,
            };
          }

          await sendProgress(extra, progressToken, 1, "Fetching current handoff...");
          logger.info("scale: stage 1 — fetch handoff (execute)", { elapsed_ms: Date.now() - startTime });

          const handoffResolved = await resolveDocPath(project_slug, "handoff.md");
          const handoff = { content: handoffResolved.content, size: handoffResolved.content.length };

          await sendProgress(extra, progressToken, 2, "Preparing scaling actions from plan...");
          logger.info("scale: stage 2 — prepare actions from plan", { elapsed_ms: Date.now() - startTime });

          const scaleActions: ScaleAction[] = plan.actions.map((a) => ({
            ...a,
            executed: false,
          }));

          await sendProgress(extra, progressToken, 3, "Fetching target living documents...");
          logger.info("scale: stage 3 — fetch targets (execute)", { elapsed_ms: Date.now() - startTime });

          const { updatedHandoff, destFiles, timed_out } = await executeScaling(
            project_slug, handoff.content, scaleActions, extra, progressToken, startTime,
          );

          // ── Stage 6: Atomic commit destinations + handoff (A-6 / S47 P2.2) ──
          await sendProgress(extra, progressToken, 6, "Atomic commit of scaled content...");
          logger.info("scale: stage 6 — atomic commit", {
            elapsed_ms: Date.now() - startTime,
            file_count: destFiles.length + 1,
          });

          const { pushResults, partial_state, fallback_aborted } = await atomicCommitScaled(
            project_slug,
            handoffResolved.path,
            updatedHandoff,
            destFiles,
            "prism: scale handoff",
          );

          const afterSize = new TextEncoder().encode(updatedHandoff).length;
          const beforeSize = plan.before_size_bytes;
          const reductionPercent =
            beforeSize > 0 ? Math.round(((beforeSize - afterSize) / beforeSize) * 100) : 0;

          const totalMs = Date.now() - startTime;
          logger.info("scale: execute complete", {
            project_slug,
            beforeKB: (beforeSize / 1024).toFixed(1),
            afterKB: (afterSize / 1024).toFixed(1),
            reductionPercent,
            ms: totalMs,
          });

          const warnings: string[] = pushResults
            .filter((r) => !r.success)
            .map((r) => `Failed to push ${r.path}`);
          if (partial_state) {
            warnings.push(
              "Partial atomic commit — state may be inconsistent. HEAD moved mid-commit; inspect the repo before retrying.",
            );
            diagnostics.error("MIGRATION_FAILED", "Partial atomic commit — state may be inconsistent");
          }
          // brief-460 / SRV-25+43: aborted/refused fallbacks are truthful —
          // the handoff was NOT reduced, so no scaled-out content was lost.
          if (fallback_aborted === "destination_failure") {
            warnings.push(
              "Sequential fallback aborted before the handoff push — a destination push failed. The handoff was NOT reduced (no content lost); investigate the failed destination(s) and re-run scaling.",
            );
            diagnostics.error("MIGRATION_FAILED", "Fallback aborted before handoff push — destination failure; handoff not reduced");
          } else if (fallback_aborted === "head_unknown") {
            warnings.push(
              "Sequential fallback refused — HEAD position could not be verified after the atomic-commit failure. Nothing was pushed; re-run scaling.",
            );
            diagnostics.error("MIGRATION_FAILED", "Fallback refused — HEAD position unknown; nothing pushed");
          }
          if (timed_out) {
            warnings.push(
              "Operation exceeded 50s safety timeout. Some actions may not have executed. Consider running again with remaining actions.",
            );
            diagnostics.warn("SCALE_PLAN_INCOMPLETE", "Operation exceeded safety timeout — some actions may not have executed");
          }
          if (pushResults.filter((r) => !r.success).length > 0) {
            diagnostics.warn("MIGRATION_FAILED", `${pushResults.filter(r => !r.success).length} file(s) failed to push`);
          }
          if (afterSize > 8192) {
            warnings.push(
              `Handoff is still ${(afterSize / 1024).toFixed(1)}KB (>${(8192 / 1024).toFixed(0)}KB target). Further manual intervention may be needed.`,
            );
          }

          // SRV-76: surface partial/failed scaling as an MCP error rather than a
          // success-shaped envelope — partial_state, an aborted fallback, or any
          // failed push all mean the migration did not cleanly complete.
          const scaleFailed =
            partial_state ||
            Boolean(fallback_aborted) ||
            pushResults.some((r) => !r.success);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: project_slug,
                action: "execute",
                before_size_bytes: beforeSize,
                after_size_bytes: afterSize,
                reduction_percent: reductionPercent,
                actions_executed: scaleActions.filter((a) => a.executed).length,
                actions_total: scaleActions.length,
                push_results: pushResults,
                elapsed_ms: totalMs,
                timed_out,
                warnings,
                diagnostics: diagnostics.list(),
              }, null, 2),
            }],
            ...(scaleFailed ? { isError: true as const } : {}),
          };
        }

        // ── Shared first stages for "analyze" and "full" ──

        // Stage 1: Fetch handoff
        await sendProgress(extra, progressToken, 1, "Fetching handoff...");
        logger.info("scale: stage 1 — fetch handoff", { elapsed_ms: Date.now() - startTime });

        const handoffResolved2 = await resolveDocPath(project_slug, "handoff.md");
        const handoff = { content: handoffResolved2.content, size: handoffResolved2.content.length };
        const beforeSize = handoff.size;

        // Stage 2: Analyze sections
        await sendProgress(extra, progressToken, 2, "Analyzing handoff sections...");
        logger.info("scale: stage 2 — analyze sections", { elapsed_ms: Date.now() - startTime });

        // Stage 3: Fetch living documents for reference
        await sendProgress(extra, progressToken, 3, "Fetching living documents for reference...");
        logger.info("scale: stage 3 — fetch living docs", { elapsed_ms: Date.now() - startTime });

        const livingDocResolvedResults = await Promise.allSettled([
          resolveDocPath(project_slug, "session-log.md"),
          resolveDocPath(project_slug, "decisions/_INDEX.md"),
          resolveDocPath(project_slug, "eliminated.md"),
          resolveDocPath(project_slug, "architecture.md"),
        ]);
        const livingDocNames = ["session-log.md", "decisions/_INDEX.md", "eliminated.md", "architecture.md"];

        const livingDocContents = new Map<string, string>();
        for (let i = 0; i < livingDocResolvedResults.length; i++) {
          const outcome = livingDocResolvedResults[i];
          if (outcome.status === "fulfilled") {
            livingDocContents.set(livingDocNames[i], outcome.value.content);
          }
        }

        const actions = identifyScalableContent(handoff.content, livingDocContents);

        // ── action: "analyze" — return plan without executing ──
        if (action === "analyze") {
          const totalBytesMovable = actions.reduce((sum, a) => sum + a.bytes_moved, 0);
          const afterSize = beforeSize - totalBytesMovable;
          const reductionPercent =
            beforeSize > 0 ? Math.round((totalBytesMovable / beforeSize) * 100) : 0;

          const planOutput: ScalePlan = {
            project_slug,
            before_size_bytes: beforeSize,
            actions: actions.map((a) => ({
              description: a.description,
              source_section: a.source_section,
              destination_file: a.destination_file,
              bytes_moved: a.bytes_moved,
              // SRV-71: content_to_move is NOT emitted — executeScaling never
              // consumes it (it re-extracts each section from the freshly
              // fetched handoff), so shipping the near-full section bodies in
              // the analyze plan and echoing them back for execute round-tripped
              // the handoff body through model context twice. bytes_moved is
              // retained for reporting; the schema field stays optional for
              // back-compat with any client still echoing an old plan.
            })),
          };

          const totalMs = Date.now() - startTime;
          logger.info("scale: analyze complete", {
            project_slug,
            actionsFound: actions.length,
            potentialReduction: `${reductionPercent}%`,
            ms: totalMs,
          });

          if (actions.length === 0) {
            diagnostics.warn("SCALE_PLAN_INCOMPLETE", "No scalable content identified — handoff may already be optimally sized");
          }

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: project_slug,
                action: "analyze",
                before_size_bytes: beforeSize,
                estimated_after_size_bytes: Math.max(0, afterSize),
                reduction_percent: reductionPercent,
                actions_count: actions.length,
                plan: planOutput,
                elapsed_ms: totalMs,
                warnings: actions.length === 0
                  ? ["No scalable content identified. Handoff may already be optimally sized."]
                  : [],
                diagnostics: diagnostics.list(),
              }, null, 2),
            }],
          };
        }

        // ── action: "full" — analyze + execute in one call ──

        // Check safety timeout before committing to execution
        if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
          const totalBytesMovable = actions.reduce((sum, a) => sum + a.bytes_moved, 0);
          const reductionPercent =
            beforeSize > 0 ? Math.round((totalBytesMovable / beforeSize) * 100) : 0;

          const planOutput: ScalePlan = {
            project_slug,
            before_size_bytes: beforeSize,
            actions: actions.map((a) => ({
              description: a.description,
              source_section: a.source_section,
              destination_file: a.destination_file,
              bytes_moved: a.bytes_moved,
              // SRV-71: content_to_move is NOT emitted — executeScaling never
              // consumes it (it re-extracts each section from the freshly
              // fetched handoff), so shipping the near-full section bodies in
              // the analyze plan and echoing them back for execute round-tripped
              // the handoff body through model context twice. bytes_moved is
              // retained for reporting; the schema field stays optional for
              // back-compat with any client still echoing an old plan.
            })),
          };

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Scale operation exceeded 50s safety timeout during analysis phase.",
                stage: "analyze",
                elapsed_ms: Date.now() - startTime,
                detail: "The handoff is too large for a single 'full' call. Use the analyze+execute pattern instead.",
                plan: planOutput,
                before_size_bytes: beforeSize,
                reduction_percent: reductionPercent,
              }, null, 2),
            }],
            isError: true,
          };
        }

        if (actions.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: project_slug,
                action: "full",
                before_size_bytes: beforeSize,
                after_size_bytes: beforeSize,
                reduction_percent: 0,
                actions_executed: 0,
                actions_total: 0,
                elapsed_ms: Date.now() - startTime,
                timed_out: false,
                warnings: [
                  "No scalable content identified. Handoff may already be optimally sized.",
                ],
              }, null, 2),
            }],
          };
        }

        // Execute the scaling (materializes destFiles; no push yet)
        const { updatedHandoff, destFiles, timed_out } = await executeScaling(
          project_slug, handoff.content, actions, extra, progressToken, startTime,
        );

        // Stage 6: Atomic commit destinations + handoff (A-6 / S47 P2.2)
        await sendProgress(extra, progressToken, 6, "Atomic commit of scaled content...");
        logger.info("scale: stage 6 — atomic commit", {
          elapsed_ms: Date.now() - startTime,
          file_count: destFiles.length + 1,
        });

        const { pushResults, partial_state, fallback_aborted } = await atomicCommitScaled(
          project_slug,
          handoffResolved2.path,
          updatedHandoff,
          destFiles,
          "prism: scale handoff",
        );

        const afterSize = new TextEncoder().encode(updatedHandoff).length;
        const reductionPercent =
          beforeSize > 0 ? Math.round(((beforeSize - afterSize) / beforeSize) * 100) : 0;

        const totalMs = Date.now() - startTime;
        logger.info("scale: full complete", {
          project_slug,
          beforeKB: (beforeSize / 1024).toFixed(1),
          afterKB: (afterSize / 1024).toFixed(1),
          reductionPercent,
          ms: totalMs,
        });

        const warnings: string[] = pushResults
          .filter((r) => !r.success)
          .map((r) => `Failed to push ${r.path}`);
        if (partial_state) {
          warnings.push(
            "Partial atomic commit — state may be inconsistent. HEAD moved mid-commit; inspect the repo before retrying.",
          );
          diagnostics.error("MIGRATION_FAILED", "Partial atomic commit — state may be inconsistent");
        }
        // brief-460 / SRV-25+43: aborted/refused fallbacks are truthful —
        // the handoff was NOT reduced, so no scaled-out content was lost.
        if (fallback_aborted === "destination_failure") {
          warnings.push(
            "Sequential fallback aborted before the handoff push — a destination push failed. The handoff was NOT reduced (no content lost); investigate the failed destination(s) and re-run scaling.",
          );
          diagnostics.error("MIGRATION_FAILED", "Fallback aborted before handoff push — destination failure; handoff not reduced");
        } else if (fallback_aborted === "head_unknown") {
          warnings.push(
            "Sequential fallback refused — HEAD position could not be verified after the atomic-commit failure. Nothing was pushed; re-run scaling.",
          );
          diagnostics.error("MIGRATION_FAILED", "Fallback refused — HEAD position unknown; nothing pushed");
        }
        if (timed_out) {
          warnings.push(
            "Operation exceeded 50s safety timeout. Some actions may not have executed. Re-run to complete remaining actions.",
          );
          diagnostics.warn("SCALE_PLAN_INCOMPLETE", "Operation exceeded safety timeout — some actions may not have executed");
        }
        if (pushResults.filter((r) => !r.success).length > 0) {
          diagnostics.warn("MIGRATION_FAILED", `${pushResults.filter(r => !r.success).length} file(s) failed to push`);
        }
        if (afterSize > 8192) {
          warnings.push(
            `Handoff is still ${(afterSize / 1024).toFixed(1)}KB (>${(8192 / 1024).toFixed(0)}KB target). Further manual intervention may be needed.`,
          );
        }

        // SRV-76: same failure flagging as the execute path.
        const fullScaleFailed =
          partial_state ||
          Boolean(fallback_aborted) ||
          pushResults.some((r) => !r.success);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              project: project_slug,
              action: "full",
              before_size_bytes: beforeSize,
              after_size_bytes: afterSize,
              reduction_percent: reductionPercent,
              actions_executed: actions.filter((a) => a.executed).length,
              actions_total: actions.length,
              push_results: pushResults,
              elapsed_ms: totalMs,
              timed_out,
              warnings,
              diagnostics: diagnostics.list(),
            }, null, 2),
          }],
          ...(fullScaleFailed ? { isError: true as const } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const totalMs = Date.now() - startTime;

        let stage = "unknown";
        if (totalMs < 5000) stage = "fetch_handoff";
        else if (totalMs < 15000) stage = "analyze_sections";
        else if (totalMs < 30000) stage = "fetch_living_documents";
        else stage = "push_files";

        logger.error("prism_scale_handoff failed", {
          project_slug, action, error: message, stage, elapsed_ms: totalMs,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Scale operation failed",
              stage,
              elapsed_ms: totalMs,
              detail: message,
              project: project_slug,
              action,
              partial_results: null,
            }),
          }],
          isError: true,
        };
       }
      };

      // SRV-64: race the scale work against the hard wall-clock deadline.
      try {
        const raced = await Promise.race([scaleWork(), deadlinePromise]);
        if (raced === SCALE_DEADLINE_SENTINEL) {
          const deadlineSec = Math.round(SCALE_WALL_CLOCK_DEADLINE_MS / 1000);
          logger.error("prism_scale_handoff deadline exceeded", {
            project_slug,
            action,
            deadlineMs: SCALE_WALL_CLOCK_DEADLINE_MS,
            elapsed_ms: Date.now() - startTime,
          });
          diagnostics.warn(
            "SCALE_DEADLINE_EXCEEDED",
            `Scale deadline exceeded (${deadlineSec}s)`,
            { deadlineMs: SCALE_WALL_CLOCK_DEADLINE_MS },
          );
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: project_slug,
                action,
                error: `prism_scale_handoff deadline exceeded (${deadlineSec}s)`,
                partial_state_warning:
                  "Scaling may have partially committed (the reduced handoff and/or destination docs) — verify the repo HEAD before retrying. The final atomic commit is all-or-nothing, but a pre-commit step may already have landed.",
                diagnostics: diagnostics.list(),
              }),
            }],
            isError: true,
          };
        }
        return raced;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
    },
  );
}
