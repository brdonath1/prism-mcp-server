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
import { fetchFile, pushFile, listRepos } from "../github/client.js";
import { CC_DISPATCH_ENABLED, DOC_ROOT, FRAMEWORK_REPO, GITHUB_PAT, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, RAILWAY_API_TOKEN, RAILWAY_ENABLED, STALE_ACTIVE_THRESHOLD_MS, SYNTHESIS_LOG_LOOKBACK_MS, TRIGGER_AUTO_ENROLL, resolveProjectSlug } from "../config.js";
import { getEnvironmentLogs } from "../railway/client.js";
import { checkStaleActive } from "../utils/stale-active-check.js";
import { checkSynthesisObservationEvents, type ObservationCheckResult } from "../utils/synthesis-fallback-check.js";
import { getExpectedToolSurface, POST_BOOT_TOOL_SEARCHES } from "../tool-registry.js";
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
import { generateCstTimestamp, parseResumptionForBanner, renderBannerText, type BannerTextInput } from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import {
  extractStandingRules,
  selectStandingRulesForBoot,
  topicMatch,
  type StandingRule,
} from "../utils/standing-rules.js";
import { classifySession, parsePersistedRecommendation, type SessionRecommendation } from "../utils/session-classifier.js";
import { applyPendingDocUpdates, isPduEmpty, parseLastSynthesizedSession, type ApplyPduResult } from "../utils/apply-pdu.js";

// Re-export the standing-rule helpers so existing imports from
// "../src/tools/bootstrap.js" continue to resolve (PR 4 / D-156 §3.5
// extracted these to src/utils/standing-rules.ts; back-compat per INS-28).
export {
  extractStandingRules,
  selectStandingRulesForBoot,
  topicMatch,
};
export type { StandingRule };

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
    const bootTestPath = await resolveDocPushPath(slug, "boot-test.md");
    await pushFile(slug, bootTestPath, content, `prism: S${sessionNumber} boot test`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Trigger enrollment marker template (brief-105). Schema is fixed by Trigger's
 * discoverMarkerProjects validator at brdonath1/trigger:src/config/discovery.ts.
 * Required fields are enabled, brief_dir, brief_pattern, branch_strategy.
 * Optional fields are filled in with safe defaults so the validator's
 * fallbacks aren't silently relied on. Operators can edit the file
 * post-creation to customize per-project behavior or set enabled: false to
 * opt out.
 */
const TRIGGER_MARKER_CONTENT = `# Trigger enrollment marker \u2014 auto-generated by prism_bootstrap.
# Presence of this file (with enabled: true) enrolls this repo in Trigger.
#
# Layout:
#   brief_dir/  \u2014 pending briefs Trigger should poll and dispatch
#   archive/    \u2014 completed briefs (auto-moved by post_merge: [archive] after PR merge)
#
# Edit values below to customize per-project behavior; set enabled: false to opt out.
enabled: true
brief_dir: .prism/briefs/queue/
brief_pattern: "brief-*.md"
branch_strategy: main-only
intra_project_parallel: false
max_parallel_briefs: 1
post_merge:
  - notify
  - archive
`;

/**
 * Drop the Trigger enrollment marker into the target project repo on first
 * session, idempotent thereafter (brief-105). Returns the structured outcome
 * surfaced as the `trigger_enrollment` field of the bootstrap response.
 *
 * Branches:
 *   - "skipped"         \u2014 TRIGGER_AUTO_ENROLL is disabled
 *   - "marker_present"  \u2014 `.prism/trigger.yaml` already exists
 *   - "marker_created"  \u2014 pushed canonical marker on the absent path
 *   - "error"           \u2014 fetch or push failed; non-fatal so the outer
 *                              bootstrap call still returns success and the
 *                              operator can always start a session even if
 *                              Trigger enrollment is broken
 *
 * The `trigger_enrollment.reason` field carries the error message back to
 * the client for visibility in future banner integration (out of scope here).
 */
async function ensureTriggerMarker(slug: string): Promise<{
  status: "marker_present" | "marker_created" | "skipped" | "error";
  reason?: string;
}> {
  if (!TRIGGER_AUTO_ENROLL) {
    return { status: "skipped", reason: "TRIGGER_AUTO_ENROLL=false" };
  }

  // Step 1: Check if the marker is already there. fetchFile throws
  // "Not found: ..." on 404 \u2014 that's the expected "marker absent" case,
  // not an error. Any other error (auth, rate-limit, network) is surfaced
  // via status: "error" so we don't silently swallow infrastructure faults.
  let markerPresent = false;
  try {
    await fetchFile(slug, ".prism/trigger.yaml");
    markerPresent = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.startsWith("Not found")) {
      logger.warn("trigger marker check failed", { slug, error: msg });
      return { status: "error", reason: msg };
    }
  }

  if (markerPresent) {
    logger.debug("trigger marker already present", { slug });
    return { status: "marker_present" };
  }

  // Step 2: Marker absent \u2014 drop it. Failures here are surfaced via
  // `trigger_enrollment.status = "error"` rather than thrown, so the
  // outer bootstrap call never fails because of marker-write trouble.
  try {
    const commitMessage =
      `prism: enroll ${slug} in Trigger via marker file\n\n` +
      "Auto-generated by prism_bootstrap on first session. Edit\n" +
      "`.prism/trigger.yaml` to customize behavior or opt out.";
    const result = await pushFile(
      slug,
      ".prism/trigger.yaml",
      TRIGGER_MARKER_CONTENT,
      commitMessage,
    );
    if (!result.success) {
      const reason = result.error ?? "unknown push error";
      logger.warn("trigger marker write failed", { slug, error: reason });
      return { status: "error", reason };
    }
    logger.info("trigger marker created", { slug });
    return { status: "marker_created" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("trigger marker write failed", { slug, error: msg });
    return { status: "error", reason: msg };
  }
}

/**
 * Boot-time stale-active surfacing (brief-416 / D-196 Piece 3).
 *
 * Reads the project's Trigger state file (`brdonath1/trigger:state/<slug>.json`)
 * and, when the active slot has been occupied past the configured threshold
 * without a PR opened, returns a structured payload the bootstrap handler
 * surfaces as a warning + `STALE_ACTIVE_DETECTED` diagnostic.
 *
 * Returns `null` for every non-stale outcome — including:
 *   - state file missing (404 or any other fetch error → not enrolled or
 *     daemon hasn't written state yet; non-fatal, no warning),
 *   - state.active null (slot empty),
 *   - PR already opened (post-PR wedges clear via post-merge actions),
 *   - elapsed below threshold (healthy in-flight dispatch),
 *   - malformed state JSON.
 *
 * Bytes accounting: the state-file content is NOT delivered to Claude — only
 * the resulting ≤200-char warning string reaches the response. Callers must
 * NOT increment bytesDelivered / filesFetched for this read.
 */
async function checkTriggerStaleActive(slug: string): Promise<{
  brief_id: string | null;
  elapsed_minutes: number;
  execution_started_at: string;
} | null> {
  let stateJson: string;
  try {
    const file = await fetchFile("trigger", `state/${slug}.json`, "state");
    stateJson = file.content;
  } catch (err) {
    // 404 = project not enrolled / no state yet; auth/rate-limit/network =
    // infrastructure noise that should not block boot or page the operator.
    // checkStaleActive's contract is "false negatives acceptable" — we
    // honor it here.
    logger.debug("trigger state fetch skipped", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const result = checkStaleActive(stateJson, new Date(), STALE_ACTIVE_THRESHOLD_MS);
  if (!result.is_stale || result.execution_started_at === null || result.elapsed_minutes === null) {
    return null;
  }

  return {
    brief_id: result.brief_id,
    elapsed_minutes: result.elapsed_minutes,
    execution_started_at: result.execution_started_at,
  };
}

/**
 * Boot-time synthesis observation surfacing (brief-419 / Phase 3c-A).
 *
 * Queries the prism-mcp-server's own Railway production environment for
 * recent warn-level logs and returns the subset matching one of the three
 * Phase 3c-A observation codes for the booting project, within the
 * configured lookback window.
 *
 * Returns null (and surfaces no warning) when:
 *   - RAILWAY_API_TOKEN is unset (Railway tools disabled),
 *   - RAILWAY_ENVIRONMENT_ID is not injected (running outside Railway, or
 *     a deploy variant that doesn't surface the standard ID env vars),
 *   - the Railway log fetch throws (auth, rate-limit, network, schema drift),
 *   - no matching events appear in the window.
 *
 * Bytes accounting: log content is server-side-only — only the resulting
 * ≤200-char warning strings (max 3 lines) reach the response. Callers must
 * NOT increment bytesDelivered / filesFetched for this read.
 *
 * Self-environment resolution uses the static env-var path: Railway
 * injects RAILWAY_ENVIRONMENT_ID at deploy time. Falls back to null
 * (silent) when the env var is absent — local dev or alternate deploy
 * surfaces simply skip this check rather than walking projects → envs at
 * boot.
 */
async function checkSynthesisObservation(
  slug: string,
): Promise<ObservationCheckResult | null> {
  if (!RAILWAY_API_TOKEN) return null;

  const envId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!envId || envId.trim().length === 0) {
    logger.debug("synthesis observation skipped — RAILWAY_ENVIRONMENT_ID not injected", {
      slug,
    });
    return null;
  }

  // Filter `@level:warn` catches all three observation codes in one call:
  // SYNTHESIS_TRANSPORT_FALLBACK and both CS3_QUALITY_* warnings are all
  // logger.warn emissions. Other warn-level entries are returned too but
  // the pure check function filters by kind — those entries are cheap to
  // discard. Substring filter on "SYNTHESIS_" alone would miss the
  // CS3_QUALITY_* codes; Railway's filter syntax does not OR multiple
  // prefixes. limit:200 amply covers a 4h window even on a busy fleet.
  let logs;
  try {
    logs = await getEnvironmentLogs(envId, 200, "@level:warn");
  } catch (err) {
    logger.debug("synthesis observation fetch skipped", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return checkSynthesisObservationEvents(
    logs,
    slug,
    new Date(),
    SYNTHESIS_LOG_LOOKBACK_MS,
  );
}

/**
 * D-68: Dynamic slug resolution — match project_slug against all repos
 * when static PROJECT_DISPLAY_NAMES map doesn't contain a match.
 * Uses normalized string comparison (strip hyphens, underscores, spaces, brackets).
 * Returns the matched repo name or null.
 */
async function resolveSlugDynamic(input: string): Promise<string | null> {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s[\]()]/g, "");
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
      const diagnostics = new DiagnosticsCollector();

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
        // Only surface if we used dynamic resolution (static map hits are expected)
        if (!Object.keys(PROJECT_DISPLAY_NAMES).includes(resolvedSlug)) {
          diagnostics.warn("SLUG_RESOLVED_DYNAMICALLY", `Project slug resolved dynamically: "${project_slug}" → "${resolvedSlug}"`, { input: project_slug, resolved: resolvedSlug });
        }
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
          diagnostics.warn("HANDOFF_SCALING_RECOMMENDED", `Handoff is ${(handoff.size / 1024).toFixed(1)}KB \u2014 exceeds 15KB critical threshold`, { sizeBytes: handoff.size, thresholdBytes: HANDOFF_CRITICAL_SIZE });
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

        // Launch boot-test push, trigger marker drop, stale-active check, and
        // prefetch in parallel. ensureTriggerMarker and checkTriggerStaleActive
        // are both fully self-contained — neither throws, and a failed marker
        // write or stale-active fetch never causes the bootstrap call to fail.
        // Running them in parallel with the boot-test push keeps wall-clock
        // cost sub-second when the marker is already present and the state
        // file is small (typically <2KB).
        const bootTestPromise = pushBootTest(resolvedSlug, sessionNumber, sessionTimestamp, handoffVersion);
        const triggerEnrollmentPromise = ensureTriggerMarker(resolvedSlug);
        const staleActivePromise = checkTriggerStaleActive(resolvedSlug);
        const observationPromise = checkSynthesisObservation(resolvedSlug);

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
              } catch (prefetchErr) {
                // Prefetch failure is non-critical
                diagnostics.warn("PREFETCH_FAILED", `Failed to prefetch ${docName}`, { file: docName, error: prefetchErr instanceof Error ? prefetchErr.message : String(prefetchErr) });
              }
            })
          ).then(() => {});
        }

        // Wait for boot-test, prefetch, trigger marker drop, stale-active
        // check, and synthesis-observation check to complete.
        const [bootTestResult, , triggerEnrollment, staleActive, observation] = await Promise.all([
          bootTestPromise,
          prefetchPromise,
          triggerEnrollmentPromise,
          staleActivePromise,
          observationPromise,
        ]);

        // brief-416 / D-196 Piece 3: surface a stale Trigger active slot so
        // the operator can recover before queuing more work. The warning
        // line fits the banner code fence (single line, ≤200 chars); the
        // structured diagnostic carries the full payload (brief_id,
        // elapsed_minutes, execution_started_at, threshold_minutes, and a
        // pointer to INS-236) for downstream observers. Both render via the
        // existing channels — no special UX coordination with the
        // recommended-session-settings line.
        if (staleActive) {
          const briefLabel = staleActive.brief_id ?? "unknown brief";
          warnings.push(
            `Trigger active slot stuck on ${briefLabel} (${staleActive.elapsed_minutes}m elapsed, no PR). Daemon restart required (see INS-236).`,
          );
          diagnostics.info(
            "STALE_ACTIVE_DETECTED",
            `Trigger active slot stuck on ${briefLabel}`,
            {
              brief_id: staleActive.brief_id,
              elapsed_minutes: staleActive.elapsed_minutes,
              execution_started_at: staleActive.execution_started_at,
              threshold_minutes: Math.round(STALE_ACTIVE_THRESHOLD_MS / 60_000),
              recovery_procedure: "INS-236",
            },
          );
        }

        // brief-419 / Phase 3c-A: surface CS-3 synthesis observation events
        // detected in the configured lookback window. Each kind contributes
        // its own warning line (max 3 added) so the operator sees fallback,
        // byte-count, and preamble events independently. Pointers reference
        // INS-242 (the log-code definitions). The structured diagnostic
        // carries per-kind counts plus a capped slice of the raw events for
        // downstream observers — full payload stays server-side.
        if (observation?.has_events) {
          if (observation.fallback_count > 0) {
            const suffix =
              observation.fallback_count > 1 ? ` (× ${observation.fallback_count})` : "";
            warnings.push(
              `Synthesis transport fallback detected last finalize${suffix} — CS-3 routed via messages_api fallback (see INS-242).`,
            );
          }
          if (observation.byte_warning_count > 0) {
            const suffix =
              observation.byte_warning_count > 1
                ? ` (× ${observation.byte_warning_count})`
                : "";
            warnings.push(
              `CS-3 output byte-count outside baseline last finalize${suffix} — verify pending-doc-updates.md content (see INS-242).`,
            );
          }
          if (observation.preamble_warning_count > 0) {
            const suffix =
              observation.preamble_warning_count > 1
                ? ` (× ${observation.preamble_warning_count})`
                : "";
            warnings.push(
              `CS-3 preamble-leak warning last finalize${suffix} — first non-empty line not "## "/"**"/"# " (see INS-242).`,
            );
          }
          diagnostics.info(
            "SYNTHESIS_OBSERVATION_DETECTED",
            `Phase 3c-A observation events detected for ${resolvedSlug}`,
            {
              fallback_count: observation.fallback_count,
              byte_warning_count: observation.byte_warning_count,
              preamble_warning_count: observation.preamble_warning_count,
              events: observation.events.slice(0, 10),
              lookback_minutes: Math.round(SYNTHESIS_LOG_LOOKBACK_MS / 60_000),
            },
          );
        }

        // 5. Intelligence brief + insights + pending doc-updates loaded in parallel
        //    (D.1 fix — was sequential; pending-doc-updates added per D-156 §3.5).
        let intelligenceBrief: string | null = null;
        let intelligenceBriefFull: string | null = null;
        let insightsContent: string | null = null;

        const [briefOutcome, insightsOutcome, pendingUpdatesOutcome] =
          await Promise.allSettled([
            resolveDocPath(resolvedSlug, "intelligence-brief.md"),
            resolveDocPath(resolvedSlug, "insights.md"),
            resolveDocPath(resolvedSlug, "pending-doc-updates.md"),
          ]);

        // Always-prefetch pending-doc-updates.md when it exists. Surfaced as an
        // entry in `prefetched_documents` per D-156 §3.5 / brief author note.
        let pduAppliedAtBoot: ApplyPduResult | null = null;
        if (pendingUpdatesOutcome.status === "fulfilled") {
          const pendingFile = pendingUpdatesOutcome.value;
          prefetchedDocuments.push({
            file: `${DOC_ROOT}/pending-doc-updates.md`,
            size_bytes: pendingFile.content.length,
            summary: summarizeMarkdown(pendingFile.content),
          });
          bytesDelivered += pendingFile.content.length;
          filesFetched++;
          logger.info("pending doc-updates prefetched", {
            size: pendingFile.content.length,
          });

          // brief-422 Piece 2: stale-PDU safety net. Catches the case where
          // finalize-side auto-apply (Piece 1) was skipped — `skip_synthesis:
          // true`, synthesis disabled, or a synthesis run that crashed before
          // it could write the cleared marker. Stale = PDU synthesized at
          // session N, current bootstrap is session M with M > N+1.
          // Empty PDU files are skipped (cleared state is not stale).
          try {
            if (!isPduEmpty(pendingFile.content)) {
              const synthSession = parseLastSynthesizedSession(pendingFile.content);
              if (synthSession !== null && sessionNumber > synthSession + 1) {
                const ageSessions = sessionNumber - synthSession;
                logger.info("stale PDU detected at bootstrap — auto-applying", {
                  projectSlug: resolvedSlug,
                  synthSession,
                  currentSession: sessionNumber,
                  ageSessions,
                });
                pduAppliedAtBoot = await applyPendingDocUpdates(resolvedSlug, sessionNumber);
                if (pduAppliedAtBoot.applied.length > 0) {
                  warnings.push(
                    `PDU stale (${ageSessions} sessions old) — ${pduAppliedAtBoot.applied.length} proposal${pduAppliedAtBoot.applied.length === 1 ? "" : "s"} auto-applied at boot.`,
                  );
                  diagnostics.info(
                    "PDU_AUTO_APPLIED_AT_BOOT",
                    `Stale PDU auto-applied at boot — ${pduAppliedAtBoot.applied.length} proposal(s)`,
                    {
                      synth_session: synthSession,
                      age_sessions: ageSessions,
                      applied: pduAppliedAtBoot.applied,
                      skipped: pduAppliedAtBoot.skipped,
                      errors: pduAppliedAtBoot.errors,
                    },
                  );
                } else if (pduAppliedAtBoot.errors.length > 0 || pduAppliedAtBoot.skipped.length > 0) {
                  // No proposals landed but the run surfaced something —
                  // include a warning so the operator can investigate.
                  warnings.push(
                    `PDU stale (${ageSessions} sessions old) — auto-apply produced no successful applies.`,
                  );
                  diagnostics.warn(
                    "PDU_AUTO_APPLY_NOOP",
                    "Stale PDU auto-apply produced no successful applies",
                    {
                      synth_session: synthSession,
                      age_sessions: ageSessions,
                      skipped: pduAppliedAtBoot.skipped,
                      errors: pduAppliedAtBoot.errors,
                    },
                  );
                }
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn("stale-PDU bootstrap apply failed — continuing", {
              projectSlug: resolvedSlug,
              error: msg,
            });
          }
        }

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
              diagnostics.warn("BRIEF_STALE", `Intelligence brief is ${briefAge} sessions old (last synthesized S${briefSession})`, { briefAge, briefSession });
            }
          }
        }

        if (insightsOutcome.status === "fulfilled") {
          insightsContent = insightsOutcome.value.content;
        }

        const allStandingRules = extractStandingRules(insightsContent);
        const standingRules = selectStandingRulesForBoot(allStandingRules, opening_message);

        // D-156: Tier accounting for diagnostics + log
        const tierA = allStandingRules.filter(r => r.tier === "A");
        const tierB = allStandingRules.filter(r => r.tier === "B");
        const tierC = allStandingRules.filter(r => r.tier === "C");
        const tierBSelected = standingRules.filter(r => r.tier === "B");
        const tierBExcluded = tierB.length - tierBSelected.length;
        const topicsMatched = Array.from(new Set(tierBSelected.flatMap(r => r.topics)));

        if (allStandingRules.length > 0) {
          logger.info("standing rules extracted", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_loaded: tierBSelected.length,
            tier_b_excluded: tierBExcluded,
            tier_c_excluded: tierC.length,
            topics_matched: topicsMatched,
            ids: standingRules.map(r => r.id),
          });

          // D-156: Diagnostics field surfacing tier accounting (only when rules exist —
          // preserves back-compat with empty-diagnostics assertion on clean bootstrap).
          diagnostics.info("STANDING_RULES_TIERED", "Standing rules selected by tier", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_loaded: tierBSelected.length,
            tier_b_excluded: tierBExcluded,
            tier_c_excluded: tierC.length,
            topics_matched: topicsMatched,
          });
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
          diagnostics.warn("BOOT_TEST_FAILED", `Boot-test push failed: ${bootTestResult.error}`, { error: bootTestResult.error });
        }

        const toolsList: Array<{ label: string; status: "ok" | "warn" | "critical" }> = [
          { label: "bootstrap", status: "ok" },
          { label: pushToolLabel, status: pushToolStatus },
          { label: "template loaded", status: "ok" },
          { label: scalingRequired ? "scaling required" : "no scaling needed", status: scalingRequired ? "warn" : "ok" },
        ];

        // brief-411 / D-193 Piece 1: read the persisted recommendation from
        // handoff.md instead of reclassifying. The single source of truth is
        // finalize — pre-411 the bootstrap-side classifier ran with
        // `critical_context` + `opening_message` as additional inputs and
        // produced different verdicts than finalize for the same handoff
        // (S107→S108 banner discrepancy). Failure here is non-fatal; the
        // back-compat fallback covers handoffs written by pre-411 finalize
        // runs by classifying on `next_steps` only — matching what finalize
        // WOULD have produced.
        let recommendedSessionSettings: SessionRecommendation | null = null;
        try {
          recommendedSessionSettings = parsePersistedRecommendation(handoff.content);
          if (!recommendedSessionSettings) {
            recommendedSessionSettings = classifySession({ next_steps: nextSteps });
          }
        } catch (err) {
          logger.warn("recommendation parse/classify failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

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
            suggested: recommendedSessionSettings
              ? {
                  display: recommendedSessionSettings.display,
                  rationale: recommendedSessionSettings.rationale,
                }
              : null,
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
          trigger_enrollment: triggerEnrollment,        // brief-105: marker drop outcome
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          context_estimate: {                          // ME-5: context budget estimation
            bootstrap_tokens: bootstrapTokens,
            platform_overhead_tokens: platformOverheadTokens,
            tool_schema_tokens: toolSchemaTokens,
            total_boot_tokens: totalBootTokens,
            total_boot_percent: totalBootPercent,
          },
          expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED, !!GITHUB_PAT),  // D-83 (S44); github category added in brief-403
          post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES,                                     // D-83 (S44)
          recommended_session_settings: recommendedSessionSettings,                             // brief-405 / D-191 — advisory model + thinking suggestion
          pdu_applied_at_boot: pduAppliedAtBoot,                                                 // brief-422 Piece 2 — stale-PDU safety net summary (null when nothing was applied)
          warnings,
          diagnostics: diagnostics.list(),
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
          diagnostics.error("BOOTSTRAP_OVERSIZE", `Response is ${(responseBytes / 1024).toFixed(1)}KB \u2014 exceeds 100KB`, { responseBytes });
        } else if (responseBytes > 80_000) {
          logger.warn("bootstrap response exceeds 80KB", { project_slug: resolvedSlug, responseBytes });
          diagnostics.warn("BOOTSTRAP_OVERSIZE", `Response is ${(responseBytes / 1024).toFixed(1)}KB \u2014 exceeds 80KB warning threshold`, { responseBytes });
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
