/**
 * prism_bootstrap tool — Initialize a PRISM session.
 * Fetches handoff, decision index, behavioral rules template, and optionally
 * relevant living documents. Returns structured summary with embedded rules (D-31)
 * and server-rendered boot banner HTML (D-35).
 *
 * Tier 1 perf optimizations (S18):
 * - Template caching: behavioral rules cached in-memory with 5-min TTL
 * - Boot-test folding: boot-test.md push happens inside bootstrap (eliminates 1 MCP round-trip)
 *
 * Standard MCP tool response contract (L-5):
 * - Success: { content: [{ type: "text", text: JSON.stringify(result) }] }
 * - Error:   { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true }
 * - All tools return the same envelope shape. Consumer should JSON.parse the text field.
 * - Response size must stay under ~25K tokens (~100KB JSON). Monitor via responseBytes log.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, fetchFiles, pushFile, listRepos } from "../github/client.js";
import { DOC_ROOT, FRAMEWORK_REPO, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, resolveProjectSlug } from "../config.js";
import { resolveDocPath, resolveDocPushPath } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import { templateCache } from "../utils/cache.js";
import {
  extractSection,
  parseNumberedList,
  parseMarkdownTable,
  summarizeMarkdown,
} from "../utils/summarizer.js";
import { parseHandoffVersion, parseSessionCount, parseTemplateVersion } from "../validation/handoff.js";
import { generateCstTimestamp, parseResumptionForBanner, renderBannerHtml, renderBannerText, type BannerData, type BannerTextInput } from "../utils/banner.js";

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

/** Standing rule extracted from insights — procedure-only (D-47) */
export interface StandingRule {
  id: string;
  title: string;
  procedure: string; // D-47: procedure-only, not full content
}

/**
 * Extract standing rules from insights content, keeping only the procedure portion.
 * ME-3 (D-48): Excludes ARCHIVED RULE, DORMANT RULE, ARCHIVED STANDING RULE,
 * and DORMANT STANDING RULE entries from the active set.
 */
export function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    // D-48: Skip archived or dormant entries
    if (/archived\s+(standing\s+)?rule/i.test(section) || /dormant\s+(standing\s+)?rule/i.test(section)) {
      continue;
    }

    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        // D-47: Extract procedure-only — find "Standing procedure:" and take everything after
        let procedure = '';
        const procStart = section.search(/\*\*Standing procedure:\*\*/i);
        if (procStart !== -1) {
          procedure = section.slice(procStart)
            .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
            .trim();
        }

        rules.push({
          id: headerMatch[1],
          title: headerMatch[2].replace(/\s*—\s*STANDING RULE\s*/i, '').trim(),
          procedure,
        });
      }
    }
  }

  return rules;
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
    const bootTestPath = await resolveDocPushPath(slug, "boot-test.md");
    await pushFile(slug, bootTestPath, content, `prism: S${sessionNumber} boot test`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * D-68: Dynamic slug resolution — match project_slug against all repos
 * when static PROJECT_DISPLAY_NAMES map doesn't contain a match.
 * Uses normalized string comparison (strip hyphens, underscores, spaces, brackets).
 * Returns the matched repo name or null.
 */
async function resolveSlugDynamic(input: string): Promise<string | null> {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s\[\]()]/g, "");
  const normalizedInput = normalize(input);

  // Skip obvious placeholders
  if (normalizedInput === "yourprojectslug" || normalizedInput === "") {
    return null;
  }

  try {
    const allRepos = await listRepos();

    // Exact normalized match against repo names
    const match = allRepos.find(r => normalize(r) === normalizedInput);
    if (match) {
      logger.info("dynamic slug resolution: matched", { input, resolved: match });
      return match;
    }

    // Partial match: check if input contains a repo name or vice versa
    // (e.g., "Metaswarm Autonomous Coding Stack" → "metaswarm-autonomous-coding-stack")
    const inputWords = normalizedInput;
    const partialMatch = allRepos.find(r => {
      const normalizedRepo = normalize(r);
      return inputWords.includes(normalizedRepo) || normalizedRepo.includes(inputWords);
    });
    if (partialMatch) {
      logger.info("dynamic slug resolution: partial match", { input, resolved: partialMatch });
      return partialMatch;
    }

    return null;
  } catch (err) {
    logger.warn("dynamic slug resolution failed", { error: (err as Error).message });
    return null;
  }
}

/**
 * Register the prism_bootstrap tool on an MCP server instance.
 */
export function registerBootstrap(server: McpServer): void {
  server.tool(
    "prism_bootstrap",
    "Initialize a PRISM session. Returns handoff, decisions, behavioral rules, intelligence brief, standing rules, and pre-fetched docs in one call.",
    inputSchema,
    async ({ project_slug, opening_message }) => {
      const start = Date.now();

      // KI-15: Resolve display names, Claude project names, and fuzzy matches to slugs
      let resolvedSlug = resolveProjectSlug(project_slug);

      // D-68: If static resolution didn't find a known project, try dynamic matching
      // against all repos. This handles Claude project names, display names not in the
      // static map, and any other input that normalizes to a repo name.
      const knownSlugs = Object.keys(PROJECT_DISPLAY_NAMES);
      if (resolvedSlug === project_slug && !knownSlugs.includes(resolvedSlug)) {
        const dynamicMatch = await resolveSlugDynamic(project_slug);
        if (dynamicMatch) {
          resolvedSlug = dynamicMatch;
        }
      }

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
          resolveDocPath(resolvedSlug, "handoff.md"),
          resolveDocPath(resolvedSlug, "decisions/_INDEX.md").catch(() => null),
          fetchBehavioralRules(),
        ]);

        // Handoff is required
        if (coreResults[0].status === "rejected") {
          throw new Error(`Failed to fetch handoff.md for "${resolvedSlug}": ${coreResults[0].reason?.message}`);
        }

        const handoffResolved = coreResults[0].value;
        const handoff = { content: handoffResolved.content, sha: handoffResolved.sha, size: handoffResolved.content.length };
        bytesDelivered += handoff.size;
        filesFetched++;

        // Decision index is optional
        let decisions: Array<{ id: string; title: string; status: string }> = [];
        if (coreResults[1].status === "fulfilled" && coreResults[1].value) {
          const decisionResolved = coreResults[1].value as { content: string; sha: string };
          decisions = parseDecisions(decisionResolved.content);
          bytesDelivered += decisionResolved.content.length;
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
          const versionMatch = templateData.content.match(/version[:\s*]*([\d.]+)/i);
          if (versionMatch) templateVersion = versionMatch[1];
          logger.info("behavioral rules delivered", { size: templateData.size, version: templateVersion });
        } else {
          warnings.push("Behavioral rules template not found \u2014 Claude should fetch core-template-mcp.md manually.");
        }

        // 2. Parse handoff into structured sections
        const handoffVersion = parseHandoffVersion(handoff.content) ?? 0;
        const sessionCount = parseSessionCount(handoff.content) ?? 0;
        const handoffTemplateVersion = templateVersion !== "unknown" ? templateVersion : (parseTemplateVersion(handoff.content) ?? "unknown");

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

        // Enhanced prefetching: combine opening message keywords + next steps from handoff
        const prefetchSet = new Set<string>();

        if (opening_message) {
          for (const f of determinePrefetchFiles(opening_message)) {
            prefetchSet.add(f);
          }
        }

        // Also pre-fetch based on next steps content (always available from handoff)
        if (nextSteps.length > 0) {
          for (const f of determinePrefetchFiles(nextSteps.join(" "))) {
            prefetchSet.add(f);
          }
        }

        // QW-4 (PF-3): Hard cap of 2 documents per prefetch to prevent keyword-dense
        // opening messages from triggering excessive document fetches.
        const prefetchPaths = Array.from(prefetchSet).slice(0, 2);

        if (prefetchPaths.length > 0) {
          prefetchPromise = Promise.all(
            prefetchPaths.map(async (filePath) => {
              const docName = filePath.replace(`${DOC_ROOT}/`, "");
              try {
                const resolved = await resolveDocPath(resolvedSlug, docName);
                prefetchedDocuments.push({
                  file: filePath,
                  size_bytes: resolved.content.length,
                  summary: summarizeMarkdown(resolved.content),
                });
                bytesDelivered += resolved.content.length;
                filesFetched++;
              } catch {
                // Prefetch failure is non-critical
              }
            })
          ).then(() => {});
        }

        // Wait for both boot-test and prefetch to complete
        const [bootTestResult] = await Promise.all([bootTestPromise, prefetchPromise]);

        // 5. Intelligence brief + insights loaded in parallel (D.1 fix — was sequential)
        let intelligenceBrief: string | null = null;
        let intelligenceBriefFull: string | null = null;
        let insightsContent: string | null = null;

        const [briefOutcome, insightsOutcome] = await Promise.allSettled([
          resolveDocPath(resolvedSlug, "intelligence-brief.md"),
          resolveDocPath(resolvedSlug, "insights.md"),
        ]);

        if (briefOutcome.status === "fulfilled") {
          const briefFile = briefOutcome.value;
          intelligenceBriefFull = briefFile.content;
          filesFetched++;
          const briefSize = briefFile.content.length;
          logger.info("intelligence brief loaded", { size: briefSize });

          // D-47: Compact mode — extract only actionable sections
          const projectState = extractSection(briefFile.content, "Project State");
          const riskFlags = extractSection(briefFile.content, "Risk Flags");
          const qualityAudit = extractSection(briefFile.content, "Quality Audit");

          const compactParts: string[] = [];
          if (projectState) {
            const sentences = projectState.split(/(?<=[.!?])\s+/).slice(0, 3);
            compactParts.push(`**Project State (compact):** ${sentences.join(" ")}`);
          }
          if (riskFlags) compactParts.push(`## Risk Flags\n${riskFlags}`);
          if (qualityAudit) compactParts.push(`## Quality Audit\n${qualityAudit}`);

          intelligenceBrief = compactParts.length > 0 ? compactParts.join("\n\n") : null;

          if (intelligenceBrief) {
            bytesDelivered += intelligenceBrief.length;
            logger.info("intelligence brief compacted", {
              fullSize: briefSize,
              compactSize: intelligenceBrief.length,
              sectionsExtracted: compactParts.length,
            });
          }
        }

        // S30: Brief staleness detection — parse session number from intelligence brief header
        let briefAgeResult: number | null = null;
        if (intelligenceBriefFull) {
          const briefSessionMatch = intelligenceBriefFull.match(/Last synthesized:\s*S(\d+)/);
          if (briefSessionMatch) {
            const briefSession = parseInt(briefSessionMatch[1], 10);
            const briefAge = sessionCount - briefSession;
            briefAgeResult = briefAge;
            if (briefAge > 2) {
              warnings.push(`Intelligence brief is ${briefAge} sessions old (last synthesized S${briefSession}). Consider running prism_synthesize to refresh.`);
            }
          }
        }

        if (insightsOutcome.status === "fulfilled") {
          insightsContent = insightsOutcome.value.content;
        }

        const standingRules = extractStandingRules(insightsContent);
        if (standingRules.length > 0) {
          logger.info("standing rules extracted", { count: standingRules.length, ids: standingRules.map(r => r.id) });
        }

        // 6. Banner data + text rendering (ME-1: compact text replaces HTML)
        const projectDisplayName = getProjectDisplayName(resolvedSlug);
        const resumption = parseResumptionForBanner(resumptionPoint, currentState);
        const guardrailCount = guardrails.length;
        const docCount = LIVING_DOCUMENTS.length;
        const docTotal = LIVING_DOCUMENTS.length;
        const docStatus = docCount === docTotal ? "ok" as const : "critical" as const;
        const docLabel = docStatus === "ok" ? "healthy" : `${docTotal - docCount} missing`;

        // Determine push verification status from boot-test result
        const pushToolStatus = bootTestResult.success ? "ok" as const : "warn" as const;
        const pushToolLabel = bootTestResult.success ? "push verified" : "push failed";
        if (!bootTestResult.success) {
          warnings.push(`Boot-test push failed: ${bootTestResult.error}`);
        }

        const toolsList: Array<{ label: string; status: "ok" | "warn" | "critical" }> = [
          { label: "bootstrap", status: "ok" },
          { label: pushToolLabel, status: pushToolStatus },
          { label: "template loaded", status: "ok" },
          { label: scalingRequired ? "scaling required" : "no scaling needed", status: scalingRequired ? "warn" : "ok" },
        ];

        // ME-1: Render compact text banner instead of HTML
        let bannerText: string | null = null;
        try {
          const bannerTextInput: BannerTextInput = {
            templateVersion: handoffTemplateVersion,
            sessionNumber,
            timestamp: sessionTimestamp,
            handoffVersion,
            handoffSizeKb: (handoff.size / 1024).toFixed(1),
            decisionCount: decisions.length,
            guardrailCount,
            docCount,
            docTotal,
            tools: toolsList,
            resumption,
            nextSteps,
            warnings,
          };
          bannerText = renderBannerText(bannerTextInput);
          logger.info("boot banner text rendered", { textLength: bannerText.length });
        } catch (bannerError) {
          const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("boot banner text render failed", { error: msg });
        }

        // Build banner_data as fallback (only included when banner_text is null per QW-1)
        const bannerData = {
          template_version: handoffTemplateVersion,
          project: projectDisplayName,
          session: sessionNumber,
          timestamp: sessionTimestamp,
          handoff_version: handoffVersion,
          handoff_kb: (handoff.size / 1024).toFixed(1),
          decisions: decisions.length,
          guardrails: guardrailCount,
          docs: `${docCount}/${docTotal}`,
          doc_status: docStatus,
          doc_label: docLabel,
          tools: toolsList,
          resumption,
          next_steps: nextSteps.map((text, i) => ({
            text,
            priority: i === 0,
          })),
          warnings,
        };

        // ME-5: Context budget estimation
        const responseJson = JSON.stringify({
          project: resolvedSlug, handoff_version: handoffVersion,
          behavioral_rules: behavioralRules, standing_rules: standingRules,
          intelligence_brief: intelligenceBrief, banner_text: bannerText,
        });
        const bootstrapTokens = Math.round(responseJson.length / 3.5);
        const platformOverheadTokens = 5000;
        const toolSchemaTokens = 2500;
        const totalBootTokens = bootstrapTokens + platformOverheadTokens + toolSchemaTokens;
        const totalBootPercent = Math.round((totalBootTokens / 200000) * 1000) / 10;

        const result: Record<string, unknown> = {
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
          standing_rules: standingRules,
          intelligence_brief: intelligenceBrief,
          brief_age_sessions: briefAgeResult,
          behavioral_rules: behavioralRules,
          banner_html: null,                           // ME-1: HTML replaced by banner_text
          banner_text: bannerText,                     // ME-1: compact text boot status
          boot_test_verified: bootTestResult.success,
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          context_estimate: {                          // ME-5: context budget estimation
            bootstrap_tokens: bootstrapTokens,
            platform_overhead_tokens: platformOverheadTokens,
            tool_schema_tokens: toolSchemaTokens,
            total_boot_tokens: totalBootTokens,
            total_boot_percent: totalBootPercent,
          },
          warnings,
        };

        // QW-1: Only include banner_data as fallback when banner_text is absent
        if (!bannerText) {
          result.banner_data = bannerData;
        }

        // QW-5: component_sizes removed from response (logged only)
        const componentSizes = {
          handoff: handoff.size,
          decisions_index: coreResults[1].status === "fulfilled" && coreResults[1].value ? (coreResults[1].value as { content: string }).content.length : 0,
          behavioral_rules: coreResults[2].status === "fulfilled" && coreResults[2].value ? (coreResults[2].value as { size: number }).size : 0,
          intelligence_brief_compact: intelligenceBrief?.length ?? 0,
          standing_rules: JSON.stringify(standingRules).length,
          banner_text: bannerText?.length ?? 0,
          prefetched_docs: prefetchedDocuments.reduce((sum, d) => sum + d.size_bytes, 0),
        };

        logger.info("prism_bootstrap complete", {
          project_slug: resolvedSlug,
          filesFetched,
          bytesDelivered,
          rulesDelivered: !!behavioralRules,
          rulesCached: templateCache.get(MCP_TEMPLATE_PATH) !== null,
          bannerTextRendered: !!bannerText,
          standingRulesCount: standingRules.length,
          intelligenceBriefCompacted: !!intelligenceBrief,
          bootTestVerified: bootTestResult.success,
          componentSizes,
          contextEstimate: { totalBootTokens, totalBootPercent },
          ms: Date.now() - start,
        });

        // QW-2: Compact JSON (no pretty-printing)
        const responseText = JSON.stringify(result);
        const responseBytes = new TextEncoder().encode(responseText).length;
        if (responseBytes > 100_000) {
          logger.error("bootstrap response exceeds 100KB", { project_slug: resolvedSlug, responseBytes });
        } else if (responseBytes > 80_000) {
          logger.warn("bootstrap response exceeds 80KB", { project_slug: resolvedSlug, responseBytes });
        }

        return {
          content: [{ type: "text" as const, text: responseText }],
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
