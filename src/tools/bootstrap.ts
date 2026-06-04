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
import { CC_DISPATCH_ENABLED, DEFAULT_CONTEXT_WINDOW_TOKENS, DOC_ROOT, FRAMEWORK_REPO, GITHUB_PAT, HANDOFF_CRITICAL_SIZE, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PROJECT_DISPLAY_NAMES, RAILWAY_API_TOKEN, RAILWAY_ENABLED, STALE_ACTIVE_THRESHOLD_MS, SYNTHESIS_LOG_LOOKBACK_MS, TRIGGER_AUTO_ENROLL, resolveProjectSlug } from "../config.js";
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
import {
  BANNER_SPEC_VERSION,
  generateCstTimestamp,
  parseResumptionForBanner,
  parseTemplateBannerSpecVersion,
  renderBannerFallback,
  renderUnifiedBanner,
  type UnifiedBannerInput,
} from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import {
  extractStandingRules,
  selectStandingRulesForBoot,
  topicMatch,
  type StandingRule,
} from "../utils/standing-rules.js";
import { unionStandingRules } from "../utils/standing-rules-union.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../utils/intelligence-brief-spec.js";
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
 * Exported for direct unit testing (tests/prefetch-keywords.test.ts previously
 * asserted against a re-implemented copy — metaswarm review brief-443).
 */
export function determinePrefetchFiles(openingMessage: string): string[] {
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
 * R-intel-SLO (D-240 Phase B): target maximum intelligence-brief age, in
 * sessions. Mirrors the S30 BRIEF_STALE warning threshold (warn when
 * age > 2) — the SLO reports against the same line the staleness warning
 * fires on.
 */
export const INTEL_SLO_BRIEF_AGE_TARGET_SESSIONS = 2;

/** R-intel-SLO: inputs to the boot-payload SLO computation. */
export interface IntelSloInputs {
  /** The intelligence-brief content as DELIVERED in the response (null when absent). */
  intelligenceBrief: string | null;
  /** Brief age in sessions (sessionCount − last-synthesized session), null when unparseable/absent. */
  briefAgeSessions: number | null;
  /** handoff.md fetched and delivered (bootstrap throws without it, so true on any success path). */
  handoffPresent: boolean;
  /** decisions/_INDEX.md fetched and delivered. */
  decisionsPresent: boolean;
  /** insights.md fetched (rule source / institutional knowledge). */
  insightsPresent: boolean;
  /** Behavioral-rules template (core-template-mcp.md) delivered. */
  behavioralRulesPresent: boolean;
}

/** R-intel-SLO: the structured SLO block emitted in bootstrap diagnostics. */
export interface IntelSlo {
  /** Percent (0–100) of spec items delivered: 6 brief sections + 4 core fields. */
  boot_completeness_percent: number;
  brief_sections_delivered: number;
  brief_sections_spec: number;
  /** Spec section headers absent from the delivered brief (all 6 when the brief is missing). */
  brief_sections_missing: string[];
  brief_age_sessions: number | null;
  brief_age_target_sessions: number;
  /** null when age is unknown (brief absent or header unparseable). */
  brief_age_within_target: boolean | null;
  continuity_coverage: {
    handoff: boolean;
    decisions: boolean;
    insights: boolean;
    covered: number;
    total: number;
  };
}

/**
 * Compute the intelligence SLO for a bootstrap response (R-intel-SLO,
 * D-240 Phase B / audit brief-431).
 *
 * Boot completeness measures "sections/fields delivered vs spec" over 10
 * items: the 6 intelligence-brief spec sections
 * (INTELLIGENCE_BRIEF_SPEC_SECTIONS, matched as literal substrings of the
 * DELIVERED brief content — the same check synthesize.ts validates output
 * with) plus 4 core boot fields (handoff, decisions index, insights,
 * behavioral rules). Section matching against the delivered payload makes
 * the metric sensitive to exactly the failure INS-249 documented: a
 * renamed or dropped section shows up as lost completeness.
 *
 * Pure function, exported for direct unit testing. Log-only — callers MUST
 * NOT gate behavior on the result.
 */
export function computeIntelSlo(inputs: IntelSloInputs): IntelSlo {
  const sectionsDelivered = inputs.intelligenceBrief
    ? INTELLIGENCE_BRIEF_SPEC_SECTIONS.filter(s => inputs.intelligenceBrief!.includes(s))
    : [];
  const sectionsMissing = INTELLIGENCE_BRIEF_SPEC_SECTIONS.filter(
    s => !sectionsDelivered.includes(s),
  );

  const fieldFlags = [
    inputs.handoffPresent,
    inputs.decisionsPresent,
    inputs.insightsPresent,
    inputs.behavioralRulesPresent,
  ];
  const specTotal = INTELLIGENCE_BRIEF_SPEC_SECTIONS.length + fieldFlags.length;
  const deliveredTotal =
    sectionsDelivered.length + fieldFlags.filter(Boolean).length;

  const continuityFlags = {
    handoff: inputs.handoffPresent,
    decisions: inputs.decisionsPresent,
    insights: inputs.insightsPresent,
  };

  return {
    boot_completeness_percent: Math.round((deliveredTotal / specTotal) * 100),
    brief_sections_delivered: sectionsDelivered.length,
    brief_sections_spec: INTELLIGENCE_BRIEF_SPEC_SECTIONS.length,
    brief_sections_missing: sectionsMissing,
    brief_age_sessions: inputs.briefAgeSessions,
    brief_age_target_sessions: INTEL_SLO_BRIEF_AGE_TARGET_SESSIONS,
    brief_age_within_target:
      inputs.briefAgeSessions === null
        ? null
        : inputs.briefAgeSessions <= INTEL_SLO_BRIEF_AGE_TARGET_SESSIONS,
    continuity_coverage: {
      ...continuityFlags,
      covered: Object.values(continuityFlags).filter(Boolean).length,
      total: 3,
    },
  };
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
 *
 * D-241 (brief-444): `intra_project_parallel` and `max_parallel_briefs` are
 * DEAD CONFIG \u2014 the daemon never reads them, and same-repo brief execution
 * is always serial (one active brief per repo). They stay in the emitted
 * marker only for schema compatibility, pinned to false/1, and the generated
 * comment must never imply they gate parallelism (the S146 hand-edit that
 * raised them to true/5 changed nothing and misled the operator).
 */
const TRIGGER_MARKER_CONTENT = `# Trigger enrollment marker \u2014 auto-generated by prism_bootstrap.
# Presence of this file (with enabled: true) enrolls this repo in Trigger.
#
# Layout:
#   brief_dir/  \u2014 pending briefs Trigger should poll and dispatch
#   archive/    \u2014 completed briefs (auto-moved by post_merge: [archive] after PR merge)
#
# Edit values below to customize per-project behavior; set enabled: false to opt out.
#
# D-241: intra_project_parallel and max_parallel_briefs are DEAD CONFIG \u2014 the
# daemon never reads them, and same-repo brief execution is ALWAYS serial (one
# active brief per repo at a time). They are emitted only for marker-schema
# compatibility; editing them does NOT enable parallel dispatch.
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

        // Decision index is optional. Presence (file fetched, even if the
        // table is empty) feeds the R-intel-SLO continuity-coverage metric.
        let decisions: Array<{ id: string; title: string; status: string }> = [];
        const decisionsPresent =
          coreResults[1].status === "fulfilled" && coreResults[1].value !== null;
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
          // brief-439 / R8: prefer the explicit "Template Version" declaration \u2014
          // the generic first-"version" match would be polluted by the
          // Banner-Spec-Version handshake line once templates declare it.
          const versionMatch = templateData.content.match(/template version[:\s*]*v?([\d.]+)/i)
            ?? templateData.content.match(/version[:\s*]*([\d.]+)/i);
          if (versionMatch) templateVersion = versionMatch[1];
          logger.info("behavioral rules delivered", { size: templateData.size, version: templateVersion });
        } else {
          warnings.push("Behavioral rules template not found \u2014 Claude should fetch core-template-mcp.md manually.");
        }

        // brief-439 / R8: banner_spec_version handshake. Compare the spec
        // version this server emits against the one the behavioral-rules
        // template declares (`Banner-Spec-Version: X.Y`). Mismatch logs a
        // BANNER_DRIFT warn diagnostic \u2014 visibility only, never blocking.
        // Templates that declare nothing predate the handshake and are not
        // drift. Contract: docs/banner-spec.md.
        let templateBannerSpecVersion: string | null = null;
        if (behavioralRules) {
          templateBannerSpecVersion = parseTemplateBannerSpecVersion(behavioralRules);
          if (
            templateBannerSpecVersion !== null &&
            templateBannerSpecVersion !== BANNER_SPEC_VERSION
          ) {
            diagnostics.warn(
              "BANNER_DRIFT",
              `Template declares banner spec ${templateBannerSpecVersion}; server emits ${BANNER_SPEC_VERSION}. Align core-template-mcp.md with docs/banner-spec.md.`,
              {
                template_declared: templateBannerSpecVersion,
                server_emitted: BANNER_SPEC_VERSION,
              },
            );
            logger.warn("banner spec drift detected", {
              template_declared: templateBannerSpecVersion,
              server_emitted: BANNER_SPEC_VERSION,
            });
          }
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

        // Parse guardrails from decisions.
        // R7-b (D-240 Phase B): cap raised 10 → 20 under the 500K-context
        // rationale — deliberate reversal of the token-economy slimming.
        const guardrails = decisions
          .filter(d => d.status.toUpperCase() === "SETTLED")
          .slice(0, 20)
          .map(d => ({ id: d.id, summary: d.title }));

        // Recent decisions (last 15 — R7-b raised the cap from 5, D-240 Phase B)
        const recentDecisions = decisions.slice(-15);

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

        // R7-b (D-240 Phase B): the QW-4 hard cap of 2 prefetched documents is
        // REMOVED under the 500K-context rationale — a deliberate reversal of
        // the token-economy slimming; do not re-introduce the cap. The set is
        // naturally bounded by the distinct documents PREFETCH_KEYWORDS maps
        // to (7 today), and each entry delivers a bounded summarizeMarkdown
        // summary (500-char preview + headers), not the full document.
        const prefetchPaths = Array.from(prefetchSet);

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

        // 5. Intelligence brief + insights + pending doc-updates + standing-rules
        //    registry loaded in parallel (D.1 fix — was sequential;
        //    pending-doc-updates added per D-156 §3.5; standing-rules.md added
        //    per R2-B / D-240 Phase B).
        let intelligenceBrief: string | null = null;
        let insightsContent: string | null = null;

        const [briefOutcome, insightsOutcome, pendingUpdatesOutcome, standingRulesFileOutcome] =
          await Promise.allSettled([
            resolveDocPath(resolvedSlug, "intelligence-brief.md"),
            resolveDocPath(resolvedSlug, "insights.md"),
            resolveDocPath(resolvedSlug, "pending-doc-updates.md"),
            resolveDocPath(resolvedSlug, "standing-rules.md"),
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
                      archived: pduAppliedAtBoot.archived, // brief-444: provenance archived
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
          filesFetched++;

          // R7-b (D-240 Phase B): deliver the FULL intelligence brief — a
          // deliberate reversal of the D-47 three-section compaction under
          // the 500K-context rationale. The old compactor matched section
          // headers literally (INS-249), so only 3 of the 6 spec sections
          // ever reached Claude and a renamed header silently dropped a
          // section. Full passthrough has no header-name coupling. Do NOT
          // re-introduce compaction here as a token optimization — see D-240.
          intelligenceBrief = briefFile.content;
          bytesDelivered += intelligenceBrief.length;
          logger.info("intelligence brief loaded (full delivery, R7-b)", {
            size: briefFile.content.length,
          });
        }

        // S30: Brief staleness detection — parse session number from intelligence brief header
        let briefAgeResult: number | null = null;
        if (intelligenceBrief) {
          const briefSessionMatch = intelligenceBrief.match(/Last synthesized:\s*S(\d+)/);
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

        // R2-B (D-240 Phase B): standing rules resolve from a UNION of the
        // registry (.prism/standing-rules.md) and insights.md, dedup'd by
        // INS-N with the registry winning on conflict. Projects that haven't
        // migrated (no standing-rules.md) behave exactly as before.
        const standingRulesFileContent =
          standingRulesFileOutcome.status === "fulfilled"
            ? standingRulesFileOutcome.value.content
            : null;
        const rulesUnion = unionStandingRules(standingRulesFileContent, insightsContent);
        if (rulesUnion.conflicts.length > 0) {
          diagnostics.warn(
            "STANDING_RULE_SOURCE_CONFLICT",
            `${rulesUnion.conflicts.length} INS id(s) present in BOTH standing-rules.md and insights.md — registry version used: ${rulesUnion.conflicts.join(", ")}. Finish the migration (R3-imm) to clear this.`,
            { conflicts: rulesUnion.conflicts },
          );
        }

        const allStandingRules = rulesUnion.rules;

        // R7-b (D-240 Phase B): deliver ALL Tier A + Tier B rule bodies at
        // boot — a deliberate reversal of the D-156 topic-gated Tier B
        // selection under the 500K-context rationale (pre-R7-b, Tier B only
        // loaded when the opening message matched the rule's topics, so a
        // boot without an opening message delivered Tier A alone). Tier C
        // bodies stay excluded; a Tier-C INDEX (IDs + titles, no bodies)
        // ships in `standing_rules_tier_c_index` so the session knows what
        // prism_load_rules can pull on demand.
        const standingRules = selectStandingRulesForBoot(allStandingRules);

        // D-156: Tier accounting for diagnostics + log (R7-b: topic-match
        // accounting removed with the gate; Tier C is now indexed, not silent)
        const tierA = allStandingRules.filter(r => r.tier === "A");
        const tierB = allStandingRules.filter(r => r.tier === "B");
        const tierC = allStandingRules.filter(r => r.tier === "C");
        const standingRulesTierCIndex = tierC.map(r => ({ id: r.id, title: r.title }));

        if (allStandingRules.length > 0) {
          logger.info("standing rules extracted", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_loaded: tierB.length,
            tier_c_indexed: tierC.length,
            from_standing_rules_file: rulesUnion.fromStandingRulesFile,
            from_insights: rulesUnion.fromInsights,
            conflicts: rulesUnion.conflicts.length,
            ids: standingRules.map(r => r.id),
          });

          // D-156: Diagnostics field surfacing tier accounting (only when rules exist).
          diagnostics.info("STANDING_RULES_TIERED", "Standing rules delivered by tier (Tier A+B bodies, Tier C indexed — R7-b)", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_loaded: tierB.length,
            tier_c_indexed: tierC.length,
            from_standing_rules_file: rulesUnion.fromStandingRulesFile,
            from_insights: rulesUnion.fromInsights,
          });
        }

        // R-intel-SLO (D-240 Phase B): intelligence SLO instrumentation.
        // Emitted on EVERY bootstrap as an info-level diagnostic plus a
        // structured log line. Log-only by contract — nothing downstream may
        // gate on it (the BRIEF_STALE warning above remains the operator
        //-facing staleness signal; this block is the measurable SLO record).
        const intelSlo = computeIntelSlo({
          intelligenceBrief,
          briefAgeSessions: briefAgeResult,
          handoffPresent: true, // bootstrap throws before this point when handoff.md is missing
          decisionsPresent,
          insightsPresent: insightsContent !== null,
          behavioralRulesPresent: behavioralRules !== null,
        });
        diagnostics.info(
          "INTEL_SLO",
          `Boot completeness ${intelSlo.boot_completeness_percent}% (${intelSlo.brief_sections_delivered}/${intelSlo.brief_sections_spec} brief sections) — brief age ${intelSlo.brief_age_sessions ?? "unknown"} session(s) (target ≤ ${intelSlo.brief_age_target_sessions}), continuity ${intelSlo.continuity_coverage.covered}/${intelSlo.continuity_coverage.total}`,
          { ...intelSlo },
        );
        logger.info("intelligence SLO", {
          project_slug: resolvedSlug,
          ...intelSlo,
        });

        // 6. Banner rendering — unified generator, boot surface (brief-439 / R8).
        const projectDisplayName = getProjectDisplayName(resolvedSlug);
        const resumption = parseResumptionForBanner(resumptionPoint, currentState);
        const guardrailCount = guardrails.length;
        const docCount = LIVING_DOCUMENTS.length;
        const docTotal = LIVING_DOCUMENTS.length;

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

        // brief-439 / R8: render via the unified generator — the single code
        // path shared with prism_finalize. On render failure, banner_text
        // carries the Rule 2 single-line fallback instead of going null with
        // a structured banner_data object (the pre-R8 contradiction with the
        // template's documented fallback). banner_data is gone — banner_text
        // is the only banner format (docs/banner-spec.md).
        let bannerText: string;
        try {
          const bannerInput: UnifiedBannerInput = {
            surface: "boot",
            templateVersion: handoffTemplateVersion,
            sessionNumber,
            timestamp: sessionTimestamp,
            handoffVersion,
            handoffNote: `${(handoff.size / 1024).toFixed(1)}KB`,
            decisionCount: decisions.length,
            decisionNote: `${guardrailCount} guardrails`,
            docCount,
            docTotal,
            statusRow: toolsList,
            resumption,
            listItems: nextSteps,
            warnings,
            suggested: recommendedSessionSettings
              ? {
                  display: recommendedSessionSettings.display,
                  rationale: recommendedSessionSettings.rationale,
                }
              : null,
          };
          bannerText = renderUnifiedBanner(bannerInput);
          logger.info("boot banner text rendered", { textLength: bannerText.length });
        } catch (bannerError) {
          const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("boot banner render failed — using single-line fallback", { error: msg });
          diagnostics.warn("BANNER_RENDER_FALLBACK", "Boot banner render failed — banner_text carries the single-line fallback", { error: msg });
          bannerText = renderBannerFallback({ sessionNumber, handoffVersion, docCount, docTotal });
        }

        const result: Record<string, unknown> = {
          project: resolvedSlug,
          project_display_name: projectDisplayName,    // brief-439: display name survives banner_data removal (Rule 2 Block 1 source)
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
          standing_rules_tier_c_index: standingRulesTierCIndex, // R7-b (D-240 Phase B): Tier-C IDs + titles, bodies via prism_load_rules
          intelligence_brief: intelligenceBrief,
          brief_age_sessions: briefAgeResult,
          behavioral_rules: behavioralRules,
          banner_html: null,                           // ME-1: HTML replaced by banner_text; field kept null for back-compat (brief-439)
          banner_text: bannerText,                     // brief-439 / R8: unified generator output (single-line fallback on render failure)
          banner_spec_version: BANNER_SPEC_VERSION,    // brief-439 / R8: banner contract version this server emits
          template_banner_spec_version: templateBannerSpecVersion, // brief-439 / R8: version the template declares (null = pre-handshake template)
          boot_test_verified: bootTestResult.success,
          trigger_enrollment: triggerEnrollment,        // brief-105: marker drop outcome
          bytes_delivered: bytesDelivered,
          files_fetched: filesFetched,
          expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED, !!GITHUB_PAT),  // D-83 (S44); github category added in brief-403
          post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES,                                     // D-83 (S44)
          recommended_session_settings: recommendedSessionSettings,                             // brief-405 / D-191 — advisory model + thinking suggestion
          pdu_applied_at_boot: pduAppliedAtBoot,                                                 // brief-422 Piece 2 — stale-PDU safety net summary (null when nothing was applied)
          warnings,
          diagnostics: diagnostics.list(),
        };

        // ME-5: Context budget estimation (brief-433 / D-240 Phase B R7-a).
        // The numerator is measured from the COMPLETE assembled response —
        // the exact payload returned to the caller — not a hand-picked field
        // subset (the brief-431 audit found the old subset omitted ~13
        // response fields, undercounting the real boot payload). The chars/3.5
        // token proxy is unchanged; only the completeness of its input is.
        // context_estimate itself is attached after measurement — its ~0.2KB
        // self-contribution is negligible against the proxy's own error bars.
        const responseJson = JSON.stringify(result);
        const bootstrapTokens = Math.round(responseJson.length / 3.5);
        const platformOverheadTokens = 5000;
        const toolSchemaTokens = 2500;
        const totalBootTokens = bootstrapTokens + platformOverheadTokens + toolSchemaTokens;
        const totalBootPercent = Math.round((totalBootTokens / DEFAULT_CONTEXT_WINDOW_TOKENS) * 1000) / 10;
        result.context_estimate = {
          bootstrap_tokens: bootstrapTokens,
          platform_overhead_tokens: platformOverheadTokens,
          tool_schema_tokens: toolSchemaTokens,
          total_boot_tokens: totalBootTokens,
          total_boot_percent: totalBootPercent,
          context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        };

        // QW-5: component_sizes removed from response (logged only)
        const componentSizes = {
          handoff: handoff.size,
          decisions_index: coreResults[1].status === "fulfilled" && coreResults[1].value ? (coreResults[1].value as { content: string }).content.length : 0,
          behavioral_rules: coreResults[2].status === "fulfilled" && coreResults[2].value ? (coreResults[2].value as { size: number }).size : 0,
          intelligence_brief: intelligenceBrief?.length ?? 0, // R7-b: full brief (compaction reversed)
          standing_rules: JSON.stringify(standingRules).length,
          standing_rules_tier_c_index: JSON.stringify(standingRulesTierCIndex).length,
          banner_text: bannerText.length,
          prefetched_docs: prefetchedDocuments.reduce((sum, d) => sum + d.size_bytes, 0),
        };

        logger.info("prism_bootstrap complete", {
          project_slug: resolvedSlug,
          filesFetched,
          bytesDelivered,
          rulesDelivered: !!behavioralRules,
          rulesCached: templateCache.get(MCP_TEMPLATE_PATH) !== null,
          bannerTextBytes: bannerText.length,
          bannerSpecVersion: BANNER_SPEC_VERSION,
          standingRulesCount: standingRules.length,
          standingRulesTierCIndexCount: standingRulesTierCIndex.length,
          intelligenceBriefDelivered: !!intelligenceBrief, // R7-b: full delivery, compaction reversed
          intelSlo: {
            completeness: intelSlo.boot_completeness_percent,
            briefAge: intelSlo.brief_age_sessions,
            continuity: intelSlo.continuity_coverage.covered,
          },
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
