/**
 * prism_log_insight — Log an insight to insights.md with STANDING RULE support.
 * Eliminates full-file roundtrips for insight capture.
 *
 * R2-B (D-240 Phase B): entries with `standing_rule: true` land in the
 * standing-rule registry (`.prism/standing-rules.md`, created from a fresh
 * starter when absent); everything else still goes to insights.md. INS-N is
 * ONE shared sequence across both files, so the dedup guard scans both.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { guardPushPath } from "../utils/doc-guard.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { safeMutation } from "../utils/safe-mutation.js";
import { sanitizeContentField } from "../utils/sanitize-content.js";
import { parseTitleDecorations } from "../utils/standing-rules.js";

/** Legal shape for a single topic keyword — matches what prism_load_rules'
 *  comma-split topic parser can round-trip (hyphens/underscores legal,
 *  commas and markup are not). */
const TOPIC_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse existing insight IDs from an insights.md content string.
 *
 * Scans for `### INS-N:` section headers and captures the accompanying title
 * (excluding the " — STANDING RULE" suffix if present) for the rejection
 * message. Mirrors {@link parseExistingDecisionIds} in shape so the dedup
 * guard reads the same on both log-decision and log-insight paths.
 */
export function parseExistingInsightIds(content: string): Map<string, string> {
  const ids = new Map<string, string>();
  // Canonical entry header: `### INS-N: Title` with optional " — STANDING RULE"
  // suffix. The regex captures the ID and title separately; we strip the
  // standing-rule marker from the title before storing for a cleaner message.
  const headerPattern = /^###\s+(INS-\d+)\s*:\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(content)) !== null) {
    const id = match[1];
    // brief-459: strip the full trailing decoration run (suffix + tier tag,
    // either order) through the shared grammar so dedup messages stay clean.
    const rawTitle = parseTitleDecorations(match[2]).cleanTitle;
    if (!ids.has(id)) {
      ids.set(id, rawTitle);
    }
  }
  return ids;
}

/**
 * Internal sentinel thrown from inside `computeMutation` when a duplicate
 * insight ID is detected on a freshly-read rule source (insights.md or
 * standing-rules.md — INS-N is one shared sequence per R2-B). Caught at the
 * tool boundary to surface the existing duplicate response shape unchanged.
 */
class InsightDedupError extends Error {
  readonly duplicate = true as const;
  constructor(
    readonly id: string,
    readonly existingTitle: string,
    message: string,
  ) {
    super(message);
    this.name = "InsightDedupError";
  }
}

export function registerLogInsight(server: McpServer): void {
  server.tool(
    "prism_log_insight",
    "Log an insight. Standing rules (standing_rule: true) land in .prism/standing-rules.md and are auto-loaded at bootstrap; other insights go to insights.md.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().regex(/^INS-\d{1,4}$/, "Insight ID must match INS-N format (e.g., 'INS-12')").describe("Insight ID (e.g., 'INS-12')"),
      title: z.string().min(1).max(200).describe("Insight title"),
      category: z.string().min(1).max(50).describe("Category (e.g., 'pattern', 'gotcha', 'preference', 'exploration', 'operations')"),
      description: z.string().describe("Full description of the insight"),
      session: z.number().describe("Session number where insight was discovered"),
      standing_rule: z.boolean().optional().describe("Whether this is a STANDING RULE (auto-loaded at bootstrap via D-44 Track 1)"),
      procedure: z.string().optional().describe("Standing procedure steps (required if standing_rule is true). Use numbered steps."),
      tier: z.enum(["A", "B", "C"]).optional().describe("Standing-rule tier (D-156): A=always-load, B=topic-load, C=reference-only. Only valid with standing_rule: true. Composes the canonical trailing `[TIER:X]` tag; omitted (and no tag embedded in the title) → the rule parses at the documented Tier A default (brief-459)."),
      topics: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/, "Topics must match [A-Za-z0-9_-]+")).optional().describe("Topic keywords for Tier B/C lazy-load matching via prism_load_rules (written as a `<!-- topics: ... -->` comment). Only valid with standing_rule: true."),
    },
    async ({ project_slug, id, title, category, description, session, standing_rule, procedure, tier, topics }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_log_insight", { project_slug, id, standing_rule, tier, topics });

      try {
        // Validate: standing rules must have procedures
        if (standing_rule && !procedure) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "standing_rule entries require a procedure field" }) }],
            isError: true,
          };
        }

        // brief-459 / SRV-01: tier + topics shape the standing-rule grammar —
        // they have no meaning on plain insights and are rejected explicitly
        // rather than silently dropped.
        if (!standing_rule && (tier !== undefined || topics !== undefined)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "tier and topics are only valid when standing_rule is true" }) }],
            isError: true,
          };
        }

        // Defense-in-depth mirror of the zod topic regex — a comma or markup
        // inside a topic would corrupt the comma-split `<!-- topics: ... -->`
        // round-trip silently.
        if (topics) {
          const badTopic = topics.find((t) => !TOPIC_SHAPE.test(t));
          if (badTopic !== undefined) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `invalid topic "${badTopic}" — topics must match [A-Za-z0-9_-]+` }) }],
              isError: true,
            };
          }
        }

        // 1. Resolve both rule-source paths in parallel. R2-B: INS-N is ONE
        //    shared sequence across insights.md and standing-rules.md, so the
        //    dedup guard must scan both regardless of which file this entry
        //    targets. A rejected resolution means the file doesn't exist.
        const [insightsResolution, standingRulesResolution] = await Promise.allSettled([
          resolveDocPath(project_slug, "insights.md"),
          resolveDocPath(project_slug, "standing-rules.md"),
        ]);
        const insightsResolvedPath =
          insightsResolution.status === "fulfilled" ? insightsResolution.value.path : null;
        const standingRulesResolvedPath =
          standingRulesResolution.status === "fulfilled" ? standingRulesResolution.value.path : null;

        // 2. Pick the target file: standing rules land in the registry
        //    (.prism/standing-rules.md per R2-B); everything else stays in
        //    insights.md. If the target doesn't exist yet we use the
        //    doc-resolver's push-path resolution and create it from a fresh
        //    starter inside computeMutation.
        const targetDocName = standing_rule ? "standing-rules.md" : "insights.md";
        const resolvedTargetPath = standing_rule ? standingRulesResolvedPath : insightsResolvedPath;
        const targetExisted = resolvedTargetPath !== null;
        let targetPath: string;
        if (resolvedTargetPath !== null) {
          targetPath = resolvedTargetPath;
        } else {
          const basePushPath = await resolveDocPushPath(project_slug, targetDocName);
          const guarded = await guardPushPath(project_slug, basePushPath);
          targetPath = guarded.path;
        }

        // 3. Build the entry (does not depend on existing file content).
        //
        // brief-459 / SRV-01: compose the header through the SAME grammar the
        // parser consumes (parseTitleDecorations). The old composer appended
        // " — STANDING RULE" after whatever the operator supplied, so a title
        // ending in `[TIER:B]` minted the one ordering the brief-451 parser
        // could not read (the INS-316 drift). Now: any decoration run already
        // on the title is parsed off, the explicit `tier` parameter wins over
        // a title-embedded tag, and the canonical
        // `### ID: Title — STANDING RULE [TIER:X]` form is emitted. No tier
        // anywhere → no tag → the rule parses at the documented Tier A
        // default (INS-328).
        //
        // KI-26 (brief-444 R5-c): neutralize embedded markdown headers in the
        // user-supplied fields before they are written. Matches the write-time
        // U+200B sanitization already live in prism_log_decision and
        // prism_patch — without it, a description containing a line that
        // starts with `## ` would parse as a real section header on the next
        // read, breaking the section tree silently (validateIntegrity only
        // flags duplicate headers, not novel ones). The commit message below
        // keeps the RAW title — Git plain text is a non-markdown channel and
        // ZWS injection there would only hurt readability.
        const titleDecor = parseTitleDecorations(title);
        const effectiveTier = standing_rule ? (tier ?? titleDecor.tier) : undefined;
        const safeTitle = sanitizeContentField(standing_rule ? titleDecor.cleanTitle : title);
        const safeDescription = sanitizeContentField(description);
        const safeProcedure = procedure ? sanitizeContentField(procedure) : undefined;

        const standingTag = standing_rule
          ? ` — STANDING RULE${effectiveTier ? ` [TIER:${effectiveTier}]` : ""}`
          : "";
        const categoryTag = standing_rule ? `${category} — **STANDING RULE**` : category;

        const entryLines = [
          `### ${id}: ${safeTitle}${standingTag}`,
          `- Category: ${categoryTag}`,
          `- Discovered: Session ${session}`,
          `- Description: ${safeDescription}`,
        ];
        // Topics ride a metadata comment BEFORE the procedure marker — the
        // procedure extractor takes everything after the marker, so a comment
        // placed below it would be swallowed into the procedure text.
        if (standing_rule && topics && topics.length > 0) {
          entryLines.push(`<!-- topics: ${topics.join(", ")} -->`);
        }
        if (standing_rule && safeProcedure) {
          entryLines.push(`- **Standing procedure:** ${safeProcedure}`);
        }
        const entry = entryLines.join("\n");

        const formalizedMarker = "## Formalized";
        const eofSentinel = `<!-- EOF: ${targetDocName} -->`;

        const freshStarter = standing_rule
          ? `# Standing Rules — ${project_slug}\n\n` +
            `> Standing-rule registry (D-240 R2-B). Rules here are auto-loaded at bootstrap by tier (D-156) and lazy-loaded via prism_load_rules. Non-rule insights stay in insights.md.\n\n` +
            `## Active\n\n` +
            `## Formalized\n\n` +
            `${eofSentinel}\n`
          : `# Insights — ${project_slug}\n\n` +
            `> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).\n\n` +
            `## Active\n\n` +
            `## Formalized\n\n` +
            `${eofSentinel}\n`;

        // Every existing rule source is re-read on each safeMutation attempt
        // so the cross-file dedup always runs against fresh content.
        const dedupSources: Array<{ path: string; doc: string }> = [];
        if (insightsResolvedPath !== null) {
          dedupSources.push({ path: insightsResolvedPath, doc: "insights.md" });
        }
        if (standingRulesResolvedPath !== null) {
          dedupSources.push({ path: standingRulesResolvedPath, doc: "standing-rules.md" });
        }

        // 4. safeMutation handles HEAD snapshot, atomic commit, and 409 retry
        //    with re-read. The dedup check runs INSIDE computeMutation so
        //    fresh data is checked on every retry.
        const result = await safeMutation({
          repo: project_slug,
          commitMessage: `prism: ${id} ${title}`,
          readPaths: dedupSources.map(s => s.path),
          diagnostics,
          computeMutation: (files) => {
            // Dedup across BOTH rule sources — INS-N is one shared sequence.
            for (const source of dedupSources) {
              const sourceFile = files.get(source.path);
              if (!sourceFile) {
                throw new Error(
                  `safeMutation did not return ${source.path} content`,
                );
              }
              const existingIds = parseExistingInsightIds(sourceFile.content);
              if (existingIds.has(id)) {
                const existingTitle = existingIds.get(id) ?? "";
                const msg =
                  `Insight ID ${id} already exists in ${source.doc}` +
                  (existingTitle ? ` (title: "${existingTitle}")` : "") +
                  `. Use a different ID or update the existing entry via prism_patch.`;
                logger.warn("prism_log_insight duplicate rejected", {
                  project_slug,
                  id,
                  existingTitle,
                  file: source.doc,
                });
                diagnostics.warn(
                  "STANDING_RULE_DUPLICATE_ID",
                  `Insight ID ${id} already exists in ${source.doc}`,
                  { id, existingTitle, file: source.doc },
                );
                throw new InsightDedupError(id, existingTitle, msg);
              }
            }

            let content: string;
            if (targetExisted) {
              const targetFile = files.get(targetPath);
              if (!targetFile) {
                throw new Error(
                  `safeMutation did not return ${targetPath} content`,
                );
              }
              content = targetFile.content;
            } else {
              content = freshStarter;
            }

            // Insert into ## Active section (before ## Formalized or EOF).
            if (content.includes(formalizedMarker)) {
              content = content.replace(formalizedMarker, `${entry}\n\n${formalizedMarker}`);
            } else if (content.includes(eofSentinel)) {
              content = content.replace(eofSentinel, `${entry}\n\n${eofSentinel}`);
            } else {
              content = content.trimEnd() + `\n\n${entry}\n`;
            }

            return {
              writes: [{ path: targetPath, content }],
            };
          },
        });

        if (!result.ok) {
          logger.error("prism_log_insight safeMutation failed", {
            project_slug,
            id,
            file: targetPath,
            code: result.code,
            error: result.error,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: result.error,
                  code: result.code,
                  id,
                  title,
                  category,
                  standing_rule: !!standing_rule,
                  success: false,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }

        logger.info("prism_log_insight complete", {
          project_slug,
          id,
          standing_rule: !!standing_rule,
          file: targetPath,
          retried: result.retried,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id,
              title,
              category,
              standing_rule: !!standing_rule,
              file: targetPath,
              success: true,
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        if (error instanceof InsightDedupError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  duplicate: true,
                  id: error.id,
                  existing_title: error.existingTitle,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_log_insight failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
