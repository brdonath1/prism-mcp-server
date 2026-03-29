/**
 * prism_bootstrap tool — Initialize a PRISM session.
 * Fetches handoff, decision index, behavioral rules template, and optionally
 * relevant living documents. Returns structured summary with embedded rules (D-31)
 * and server-rendered boot banner SVG (D-34).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fetchFiles } from "../github/client.js";
import { FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  extractSection,
  parseNumberedList,
  parseMarkdownTable,
  summarizeMarkdown,
} from "../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount, parseTemplateVersion } from "../validation/handoff.js";
import { renderBannerSvg, generateCstTimestamp, parseResumptionForBanner } from "../utils/banner.js";

/** Input schema for prism_bootstrap */
const inputSchema = {
  project_slug: z.string().describe("Project repo name (e.g., 'platformforge', 'prism', 'snapquote')"),
  opening_message: z.string().optional().describe("User's opening message. Enables intelligent pre-fetching of relevant living documents."),
};

/**
 * Determine which living documents to pre-fetch based on keywords in the opening message.
 */
function determinePrefetchFiles(openingMessage: string): string[] {
  const lower = openingMessage.toLowerCase();
  const filesToFetch = new Set<string>();

  for (const [keyword, file] of Object.entries(PREFETCH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      filesToFetch.add(file);
    }
  }

  return Array.from(filesToFetch);
}

/**
 * Parse decisions from the _INDEX.md table content.
 */
function parseDecisions(content: string): Array<{ id: string; title: string; status: string }> {
  const rows = parseMarkdownTable(content);
  return rows.map(row => {
    const idKey = Object.keys(row).find(k => k.toLowerCase() === "id") ?? "ID";
    const titleKey = Object.keys(row).find(k => k.toLowerCase() === "title") ?? "Title";
    const statusKey = Object.keys(row).find(k => k.toLowerCase() === "status") ?? "Status";
    return {
      id: row[idKey] ?? "",
      title: row[titleKey] ?? "",
      status: row[statusKey] ?? "",
    };
  }).filter(d => d.id.length > 0);
}

/**
 * Derive a human-readable project display name from the slug.
 */
function getProjectDisplayName(slug: string): string {
  if (PROJECT_DISPLAY_NAMES[slug]) return PROJECT_DISPLAY_NAMES[slug];
  // Fallback: title-case the slug, replacing hyphens with spaces
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Register the prism_bootstrap tool on an MCP server instance.
 */
export function registerBootstrap(server: McpServer): void {
  server.tool(
    "prism_bootstrap",
    "Initialize a PRISM session. Fetches handoff, decision index, and optionally relevant living documents based on opening message keywords. Returns structured summary.",
    inputSchema,
    async ({ project_slug, opening_message }) => {
      const start = Date.now();
      logger.info("prism_bootstrap", { project_slug, hasOpeningMessage: !!opening_message });

      try {
        const warnings: string[] = [];
        let bytesDelivered = 0;
        let filesFetched = 0;

        // 1. Fetch core files in parallel: handoff, decisions, and MCP behavioral rules template
        const coreResults = await Promise.allSettled([
          fetchFile(project_slug, "handoff.md"),
          fetchFile(project_slug, "decisions/_INDEX.md").catch(() => null),
          fetchFile(FRAMEWORK_REPO, MCP_TEMPLATE_PATH).catch(() => null),
        ]);

        // Handoff is required
        if (coreResults[0].status === "rejected") {
          throw new Error(`Failed to fetch handoff.md for "${project_slug}": ${coreResults[0].reason?.message}`);
        }

        const handoff = coreResults[0].value;
        bytesDelivered += handoff.size;
        filesFetched++;

        // Decision index is optional
        let decisions: Array<{ id: string; title: string; status: string }> = [];
        if (coreResults[1].status === "fulfilled" && coreResults[1].value) {
          const decisionFile = coreResults[1].value;
          decisions = parseDecisions(decisionFile.content);
          bytesDelivered += decisionFile.size;
          filesFetched++;
        } else {
          warnings.push("decisions/_INDEX.md not found — decision tracking not initialized for this project.");
        }

        // Behavioral rules template (D-31) — deliver full content so Claude skips the template fetch
        let templateVersion = "unknown";
        let behavioralRules: string | null = null;
        if (coreResults[2].status === "fulfilled" && coreResults[2].value) {
          const templateFile = coreResults[2].value;
          behavioralRules = templateFile.content;
          bytesDelivered += templateFile.size;
          filesFetched++;
          // Extract version from template content
          const versionMatch = templateFile.content.match(/version[:\s]*([\d.]+)/i);
          if (versionMatch) templateVersion = versionMatch[1];
          logger.info("behavioral rules delivered", { size: templateFile.size, version: templateVersion });
        } else {
          warnings.push("Behavioral rules template not found — Claude should fetch core-template-mcp.md manually.");
        }

        // 2. Parse handoff into structured sections
        const handoffVersion = parseHandoffVersion(handoff.content) ?? 0;
        const sessionCount = parseSessionCount(handoff.content) ?? 0;
        const handoffTemplateVersion = parseTemplateVersion(handoff.content) ?? templateVersion;

        // Size check
        const scalingRequired = handoff.size > HANDOFF_CRITICAL_SIZE;
        if (scalingRequired) {
          warnings.push(
            `Handoff is ${(handoff.size / 1024).toFixed(1)}KB — exceeds 15KB critical threshold. Scaling recommended.`
          );
        }

        // Extract structured sections
        const criticalContext = parseNumberedList(
          extractSection(handoff.content, "Critical Context") ?? ""
        );
        const currentState = extractSection(handoff.content, "Where We Are") ?? "";
        const resumptionPoint = extractSection(handoff.content, "Resumption Point")
          ?? extractSection(handoff.content, "Next Action")
          ?? "";
        const nextSteps = parseNumberedList(
          extractSection(handoff.content, "Next Steps")
            ?? extractSection(handoff.content, "Immediate Next")
            ?? ""
        );
        const openQuestions = parseNumberedList(
          extractSection(handoff.content, "Open Questions") ?? ""
        );

        // Parse guardrails from decisions
        const guardrails = decisions
          .filter(d => d.status.toUpperCase() === "SETTLED")
          .slice(0, 10)
          .map(d => ({ id: d.id, summary: d.title }));

        // Recent decisions (last 5)
        const recentDecisions = decisions.slice(-5);

        // 3. Intelligent pre-fetching
        const prefetchedDocuments: Array<{ file: string; size_bytes: number; summary: string }> = [];

        if (opening_message) {
          const prefetchPaths = determinePrefetchFiles(opening_message);
          if (prefetchPaths.length > 0) {
            const prefetchResults = await fetchFiles(project_slug, prefetchPaths);
            for (const [filePath, fileResult] of prefetchResults) {
              prefetchedDocuments.push({
                file: filePath,
                size_bytes: fileResult.size,
                summary: summarizeMarkdown(fileResult.content),
              });
              bytesDelivered += fileResult.size;
              filesFetched++;
            }
          }
        }

        // 4. Render boot banner SVG (D-34)
        const sessionTimestamp = generateCstTimestamp();
        const sessionNumber = sessionCount + 1;
        const projectDisplayName = getProjectDisplayName(project_slug);
        const resumptionLines = parseResumptionForBanner(resumptionPoint, currentState);
        const guardrailCount = guardrails.length;

        let bannerSvg: string | null = null;
        try {
          bannerSvg = renderBannerSvg({
            templateVersion: handoffTemplateVersion,
            projectDisplayName,
            sessionNumber,
            timestamp: sessionTimestamp,
            handoffVersion,
            handoffSizeKb: (handoff.size / 1024).toFixed(1),
            decisionCount: decisions.length,
            decisionNote: `${guardrailCount} guardrails`,
            docCount: 8,
            docTotal: 8,
            docHealthy: true,
            scalingRequired,
            resumptionLines,
            nextSteps,
            warnings,
          });
          logger.info("banner SVG rendered", { svgLength: bannerSvg.length });
        } catch (bannerError) {
          const bannerMsg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("banner render failed", { error: bannerMsg });
          warnings.push("Banner SVG render failed — Claude should construct manually from banner-spec.md.");
        }

        const result = {
          project: project_slug,
          handoff_version: handoffVersion,
          template_version: handoffTemplateVersion,
          session_count: sessionCount,
          session_number: sessionNumber,
          session_timestamp: sessionTimestamp,
          handoff_size_bytes: handoff.size,
          scaling_required: scalingRequired,
          critical_context: criticalContext,
          current_state: currentState,
          resumption_point: resumptionPoint,
          recent_decisions: recentDecisions,
          guardrails,
          next_steps: nextSteps,
          open_questions: openQuestions,
          prefetched_documents: prefetchedDocuments,
          behavioral_rules: behavioralRules,
          banner_svg: bannerSvg,
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          warnings,
        };

        logger.info("prism_bootstrap complete", {
          project_slug,
          filesFetched,
          bytesDelivered,
          rulesDelivered: !!behavioralRules,
          bannerDelivered: !!bannerSvg,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_bootstrap failed", { project_slug, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message, project: project_slug }) }],
          isError: true,
        };
      }
    }
  );
}
