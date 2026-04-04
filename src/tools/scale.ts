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
import { fetchFile, fetchFiles, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";
import { extractSection } from "../utils/summarizer.js";

/** Maximum wall-clock time before returning a partial result (ms). */
const SAFETY_TIMEOUT_MS = 50_000;

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
 * Merge parsed decisions into an existing _INDEX.md, avoiding duplicate IDs.
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

  if (hasTable) {
    if (existingContent.includes(eofSentinel)) {
      return existingContent.replace(eofSentinel, newRows + "\n" + eofSentinel);
    }
    return existingContent.trimEnd() + "\n" + newRows + "\n";
  }

  // No existing table — create one
  const tableHeader =
    "| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|---------|";
  if (existingContent.includes(eofSentinel)) {
    return existingContent.replace(
      eofSentinel,
      "\n" + tableHeader + "\n" + newRows + "\n\n" + eofSentinel,
    );
  }
  return existingContent.trimEnd() + "\n\n" + tableHeader + "\n" + newRows + "\n";
}

// ── Session history helpers ─────────────────────────────────────────────────

/**
 * Condense session history: keep last 3 as 1-line summaries, archive older entries.
 */
function condenseSessionHistory(sectionBody: string): { lean: string; archive: string } {
  const sessionPattern = /^###?\s+Session\s+(\d+)/gm;
  const positions: { index: number; num: number }[] = [];

  let match;
  while ((match = sessionPattern.exec(sectionBody)) !== null) {
    positions.push({ index: match.index, num: parseInt(match[1]) });
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

  const toArchive = sessions.slice(0, -3);
  const toKeep = sessions.slice(-3);

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
  pushResults: Array<{ path: string; success: boolean }>;
  timed_out: boolean;
}> {
  let updatedHandoff = handoffContent;
  const pushResults: Array<{ path: string; success: boolean }> = [];
  const destinationContent = new Map<string, string[]>();
  const decisionMerges = new Map<string, ParsedDecision[]>();

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
      continue;
    }
  }

  // Ensure exactly one EOF sentinel
  updatedHandoff = ensureSingleEof(updatedHandoff);

  // Clean up excessive blank lines
  updatedHandoff = updatedHandoff.replace(/\n{3,}/g, "\n\n");

  // Check safety timeout before network I/O
  if (Date.now() - startTime > SAFETY_TIMEOUT_MS) {
    return { updatedHandoff, pushResults, timed_out: true };
  }

  // ── Stage 5: Push destination files ──
  await sendProgress(extra, progressToken, 5, "Pushing redistributed files...");
  logger.info("scale: stage 5 — push redistributed files", {
    elapsed_ms: Date.now() - startTime,
  });

  const allDestPaths = new Set([...destinationContent.keys(), ...decisionMerges.keys()]);
  const destPaths = [...allDestPaths].filter((p) => p !== "(remove)");

  if (destPaths.length > 0) {
    const destFiles = await fetchFiles(projectSlug, destPaths);

    const pushPromises = destPaths.map(async (destPath) => {
      const destFile = destFiles.get(destPath);
      const fileName = destPath.split("/").pop() || destPath;
      const eofSentinel = `<!-- EOF: ${fileName} -->`;

      let destContent: string;

      if (decisionMerges.has(destPath)) {
        // Decision merge: special table-aware logic
        const decisions = decisionMerges.get(destPath)!;
        if (destFile) {
          destContent = mergeDecisionsIntoIndex(decisions, destFile.content);
        } else {
          const tableHeader =
            "# Decision Index\n\n| ID | Title | Domain | Status | Session |\n|----|-------|--------|--------|---------|";
          const rows = decisions
            .map((d) => `| ${d.id} | ${d.title} | ${d.domain} | ${d.status} | ${d.session} |`)
            .join("\n");
          destContent = `${tableHeader}\n${rows}\n\n${eofSentinel}\n`;
        }
      } else if (destFile) {
        const parts = destinationContent.get(destPath) || [];
        const newContent = parts.join("\n\n");
        destContent = destFile.content;
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

      const result = await pushFile(
        projectSlug, destPath, destContent,
        `prism: extract ${fileName}`,
      );
      return { path: destPath, success: result.success };
    });

    const outcomes = await Promise.allSettled(pushPromises);
    for (const outcome of outcomes) {
      pushResults.push(
        outcome.status === "fulfilled"
          ? outcome.value
          : { path: "unknown", success: false },
      );
    }
  }

  return { updatedHandoff, pushResults, timed_out: false };
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
      const progressToken = extra._meta?.progressToken;

      logger.info("prism_scale_handoff", {
        project_slug, action,
        hasProgressToken: progressToken !== undefined,
      });

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

          const handoff = await fetchFile(project_slug, "handoff.md");

          await sendProgress(extra, progressToken, 2, "Preparing scaling actions from plan...");
          logger.info("scale: stage 2 — prepare actions from plan", { elapsed_ms: Date.now() - startTime });

          const scaleActions: ScaleAction[] = plan.actions.map((a) => ({
            ...a,
            executed: false,
          }));

          await sendProgress(extra, progressToken, 3, "Fetching target living documents...");
          logger.info("scale: stage 3 — fetch targets (execute)", { elapsed_ms: Date.now() - startTime });

          const { updatedHandoff, pushResults, timed_out } = await executeScaling(
            project_slug, handoff.content, scaleActions, extra, progressToken, startTime,
          );

          // ── Stage 6: Push updated handoff ──
          await sendProgress(extra, progressToken, 6, "Pushing updated handoff...");
          logger.info("scale: stage 6 — push handoff", { elapsed_ms: Date.now() - startTime });

          const handoffPush = await pushFile(
            project_slug, "handoff.md", updatedHandoff, "prism: scale handoff",
          );
          pushResults.push({ path: "handoff.md", success: handoffPush.success });

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
          if (timed_out) {
            warnings.push(
              "Operation exceeded 50s safety timeout. Some actions may not have executed. Consider running again with remaining actions.",
            );
          }
          if (afterSize > 8192) {
            warnings.push(
              `Handoff is still ${(afterSize / 1024).toFixed(1)}KB (>${(8192 / 1024).toFixed(0)}KB target). Further manual intervention may be needed.`,
            );
          }

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
              }, null, 2),
            }],
          };
        }

        // ── Shared first stages for "analyze" and "full" ──

        // Stage 1: Fetch handoff
        await sendProgress(extra, progressToken, 1, "Fetching handoff...");
        logger.info("scale: stage 1 — fetch handoff", { elapsed_ms: Date.now() - startTime });

        const handoff = await fetchFile(project_slug, "handoff.md");
        const beforeSize = handoff.size;

        // Stage 2: Analyze sections
        await sendProgress(extra, progressToken, 2, "Analyzing handoff sections...");
        logger.info("scale: stage 2 — analyze sections", { elapsed_ms: Date.now() - startTime });

        // Stage 3: Fetch living documents for reference
        await sendProgress(extra, progressToken, 3, "Fetching living documents for reference...");
        logger.info("scale: stage 3 — fetch living docs", { elapsed_ms: Date.now() - startTime });

        const livingDocMap = await fetchFiles(project_slug, [
          "session-log.md",
          "decisions/_INDEX.md",
          "eliminated.md",
          "architecture.md",
        ]);

        const livingDocContents = new Map<string, string>();
        for (const [path, result] of livingDocMap) {
          livingDocContents.set(path, result.content);
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
              content_to_move: a.content_to_move,
            })),
          };

          const totalMs = Date.now() - startTime;
          logger.info("scale: analyze complete", {
            project_slug,
            actionsFound: actions.length,
            potentialReduction: `${reductionPercent}%`,
            ms: totalMs,
          });

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
              content_to_move: a.content_to_move,
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

        // Execute the scaling
        const { updatedHandoff, pushResults, timed_out } = await executeScaling(
          project_slug, handoff.content, actions, extra, progressToken, startTime,
        );

        // Stage 6: Push updated handoff
        await sendProgress(extra, progressToken, 6, "Pushing updated handoff...");
        logger.info("scale: stage 6 — push handoff", { elapsed_ms: Date.now() - startTime });

        const handoffPush = await pushFile(
          project_slug, "handoff.md", updatedHandoff, "prism: scale handoff",
        );
        pushResults.push({ path: "handoff.md", success: handoffPush.success });

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
        if (timed_out) {
          warnings.push(
            "Operation exceeded 50s safety timeout. Some actions may not have executed. Re-run to complete remaining actions.",
          );
        }
        if (afterSize > 8192) {
          warnings.push(
            `Handoff is still ${(afterSize / 1024).toFixed(1)}KB (>${(8192 / 1024).toFixed(0)}KB target). Further manual intervention may be needed.`,
          );
        }

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
            }, null, 2),
          }],
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
    },
  );
}
