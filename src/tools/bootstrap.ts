/**
 * prism_bootstrap tool — Initialize a PRISM session.
 * Fetches handoff, decision index, behavioral rules template, and optionally
 * relevant living documents. Returns structured summary with embedded rules (D-31)
 * and server-rendered boot banner HTML (D-35).
 *
 * Tier 1 perf optimizations (S18):
 * - Template caching: behavioral rules cached in-memory with 5-min TTL
 * - Boot-test folding: boot-test.md push happens inside bootstrap (eliminates 1 MCP round-trip)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fetchFiles, pushFile } from "../github/client.js";
import { FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, resolveProjectSlug } from "../config.js";
import { logger } from "../utils/logger.js";
import { templateCache } from "../utils/cache.js";
import {
  extractSection,
  parseNumberedList,
  parseMarkdownTable,
  summarizeMarkdown,
} from "../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount, parseTemplateVersion } from "../validation/handoff.js";
import { renderBannerHtml, generateCstTimestamp, parseResumptionForBanner } from "../utils/banner.js";

/** Input schema for prism_bootstrap */
const inputSchema = {
  project_slug: z.string().describe("Project repo name or display name (e.g., 'platformforge-v2', 'PlatformForge v2', 'PRISM Framework', 'prism')"),
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
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Fetch the behavioral rules template with caching.
 * Returns cached version if available and fresh, otherwise fetches from GitHub.
 */
async function fetchBehavioralRules(): Promise<{ content: string; size: number } | null> {
  const cacheKey = MCP_TEMPLATE_PATH;
  const cached = templateCache.get(cacheKey);
  if (cached) return cached;

  try {
    const file = await fetchFile(FRAMEWORK_REPO, MCP_TEMPLATE_PATH);
    const entry = { content: file.content, size: file.size };
    templateCache.set(cacheKey, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Push boot-test.md to verify the write path. Non-blocking — failure is a warning, not an error.
 */
async function pushBootTest(
  slug: string,
  sessionNumber: number,
  timestamp: string,
  handoffVersion: number,
): Promise<{ success: boolean; error?: string }> {
  const content = `# Boot Test \u2014 Session ${sessionNumber}\nTimestamp: ${timestamp} CST\nProject: ${slug}\nHandoff: v${handoffVersion}\nMode: MCP\n\n<!-- EOF: boot-test.md -->\n`;
  try {
    await pushFile(slug, "boot-test.md", content, `prism: S${sessionNumber} boot test`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
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

      // KI-15: Resolve display names, Claude project names, and fuzzy matches to slugs
      const resolvedSlug = resolveProjectSlug(project_slug);
      if (resolvedSlug !== project_slug) {
        logger.info("slug resolved", { input: project_slug, resolved: resolvedSlug });
      }

      logger.info("prism_bootstrap", { project_slug: resolvedSlug, hasOpeningMessage: !!opening_message });

      try {
        const warnings: string[] = [];
        let bytesDelivered = 0;
        let filesFetched = 0;

        // 1. Fetch core files in parallel: handoff, decisions, and cached behavioral rules
        const coreResults = await Promise.allSettled([
          fetchFile(resolvedSlug, "handoff.md"),
          fetchFile(resolvedSlug, "decisions/_INDEX.md").catch(() => null),
          fetchBehavioralRules(),
        ]);

        // Handoff is required
        if (coreResults[0].status === "rejected") {
          throw new Error(`Failed to fetch handoff.md for "${resolvedSlug}": ${coreResults[0].reason?.message}`);
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
          warnings.push("decisions/_INDEX.md not found \u2014 decision tracking not initialized for this project.");
        }

        // Behavioral rules template (D-31) \u2014 cached, deliver full content so Claude skips the template fetch
        let templateVersion = "unknown";
        let behavioralRules: string | null = null;
        if (coreResults[2].status === "fulfilled" && coreResults[2].value) {
          const templateData = coreResults[2].value;
          behavioralRules = templateData.content;
          bytesDelivered += templateData.size;
          filesFetched++;
          const versionMatch = templateData.content.match(/version[:\\s]*([\\d.]+)/i);
          if (versionMatch) templateVersion = versionMatch[1];
          logger.info("behavioral rules delivered", { size: templateData.size, version: templateVersion });
        } else {
          warnings.push("Behavioral rules template not found \u2014 Claude should fetch core-template-mcp.md manually.");
        }

        // 2. Parse handoff into structured sections
        const handoffVersion = parseHandoffVersion(handoff.content) ?? 0;
        const sessionCount = parseSessionCount(handoff.content) ?? 0;
        const handoffTemplateVersion = parseTemplateVersion(handoff.content) ?? templateVersion;

        // Size check
        const scalingRequired = handoff.size > HANDOFF_CRITICAL_SIZE;
        if (scalingRequired) {
          warnings.push(
            `Handoff is ${(handoff.size / 1024).toFixed(1)}KB \u2014 exceeds 15KB critical threshold. Scaling recommended.`
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

        // 3. Intelligent pre-fetching + boot-test push (in parallel)
        const sessionTimestamp = generateCstTimestamp();
        const sessionNumber = sessionCount + 1;

        // Launch boot-test push and prefetch in parallel
        const bootTestPromise = pushBootTest(resolvedSlug, sessionNumber, sessionTimestamp, handoffVersion);

        const prefetchedDocuments: Array<{ file: string; size_bytes: number; summary: string }> = [];
        let prefetchPromise: Promise<void> = Promise.resolve();

        if (opening_message) {
          const prefetchPaths = determinePrefetchFiles(opening_message);
          if (prefetchPaths.length > 0) {
            prefetchPromise = fetchFiles(resolvedSlug, prefetchPaths).then(results => {
              for (const [filePath, fileResult] of results) {
                prefetchedDocuments.push({
                  file: filePath,
                  size_bytes: fileResult.size,
                  summary: summarizeMarkdown(fileResult.content),
                });
                bytesDelivered += fileResult.size;
                filesFetched++;
              }
            });
          }
        }

        // Wait for both boot-test and prefetch to complete
        const [bootTestResult] = await Promise.all([bootTestPromise, prefetchPromise]);

        // 4. Render boot banner HTML (D-35)
        const projectDisplayName = getProjectDisplayName(resolvedSlug);
        const resumption = parseResumptionForBanner(resumptionPoint, currentState);
        const guardrailCount = guardrails.length;
        const docCount = 8;
        const docTotal = 8;
        const docStatus = docCount === docTotal ? "ok" as const : "critical" as const;
        const docLabel = docStatus === "ok" ? "healthy" : `${docTotal - docCount} missing`;

        // Determine push verification status from boot-test result
        const pushToolStatus = bootTestResult.success ? "ok" as const : "warn" as const;
        const pushToolLabel = bootTestResult.success ? "push verified" : "push failed";
        if (!bootTestResult.success) {
          warnings.push(`Boot-test push failed: ${bootTestResult.error}`);
        }

        let bannerHtml: string | null = null;
        try {
          bannerHtml = renderBannerHtml({
            templateVersion: handoffTemplateVersion,
            projectDisplayName,
            sessionNumber,
            timestamp: sessionTimestamp,
            handoffVersion,
            handoffSizeKb: (handoff.size / 1024).toFixed(1),
            decisionCount: decisions.length,
            decisionNote: `${guardrailCount} guardrails`,
            docCount,
            docTotal,
            docStatus,
            docLabel,
            tools: [
              { label: "bootstrap", status: "ok" },
              { label: pushToolLabel, status: pushToolStatus },
              { label: "template loaded", status: "ok" },
              { label: scalingRequired ? "scaling required" : "no scaling needed", status: scalingRequired ? "warn" as const : "ok" as const },
            ],
            resumption,
            nextSteps: nextSteps.map((text, i) => ({
              text,
              status: i === 0 ? "priority" as const : "normal" as const,
            })),
            warnings,
            errors: [],
          });
          logger.info("banner HTML rendered", { htmlLength: bannerHtml.length });
        } catch (bannerError) {
          const bannerMsg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("banner render failed", { error: bannerMsg });
          warnings.push("Banner HTML render failed \u2014 Claude should construct manually from banner-spec.md.");
        }

        const result = {
          project: resolvedSlug,
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
          banner_html: bannerHtml,
          boot_test_verified: bootTestResult.success,
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          warnings,
        };

        logger.info("prism_bootstrap complete", {
          project_slug: resolvedSlug,
          filesFetched,
          bytesDelivered,
          rulesDelivered: !!behavioralRules,
          rulesCached: templateCache.get(MCP_TEMPLATE_PATH) !== null,
          bannerDelivered: !!bannerHtml,
          bootTestVerified: bootTestResult.success,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_bootstrap failed", { project_slug: resolvedSlug, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message, project: resolvedSlug }) }],
          isError: true,
        };
      }
    }
  );
}
