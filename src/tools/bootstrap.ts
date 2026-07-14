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
import { BOOTSTRAP_OVERSIZE_ERROR_BYTES, BOOTSTRAP_OVERSIZE_WARN_BYTES, CC_DISPATCH_ENABLED, DEFAULT_CONTEXT_WINDOW_TOKENS, DOC_ROOT, FRAMEWORK_REPO, GITHUB_PAT, HANDOFF_CRITICAL_SIZE, HANDOFF_ITEM_BUDGET_BYTES, LIVING_DOCUMENTS, MCP_TEMPLATE_PATH, PREFETCH_KEYWORDS, PREFETCH_SUMMARY_CAP_BYTES, PROJECT_DISPLAY_NAMES, RAILWAY_API_TOKEN, RAILWAY_ENABLED, STALE_ACTIVE_THRESHOLD_MS, SYNTHESIS_LOG_LOOKBACK_MS, TRIGGER_AUTO_ENROLL, resolveBootIndexMode, resolveBootMastheadSvg, resolveBriefCompactMode, resolvePrefetchMode, resolveProjectSlug } from "../config.js";
import { computePayloadAttribution } from "../utils/payload-attribution.js";
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
  renderBootMastheadSvg,
  renderUnifiedBanner,
  type UnifiedBannerInput,
} from "../utils/banner.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import {
  extractStandingRules,
  selectStandingRulesForBoot,
  type StandingRule,
} from "../utils/standing-rules.js";
import { unionStandingRules } from "../utils/standing-rules-union.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../utils/intelligence-brief-spec.js";
import { classifySession, parsePersistedRecommendation, type SessionRecommendation } from "../utils/session-classifier.js";
import { applyPendingDocUpdates, isPduEmpty, parseLastSynthesizedSession, type ApplyPduResult } from "../utils/apply-pdu.js";
import { buildAutonomousWorkLoopPayload } from "../utils/autonomous-work-loop.js";

// Re-export the standing-rule helpers so existing imports from
// "../src/tools/bootstrap.js" continue to resolve (PR 4 / D-156 §3.5
// extracted these to src/utils/standing-rules.ts; back-compat per INS-28).
export {
  extractStandingRules,
  selectStandingRulesForBoot,
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
  /**
   * The FULL synthesized intelligence-brief content (null when absent).
   * D-253: this is the pre-compaction SOURCE, not the compacted boot delivery.
   * The SLO measures synthesis completeness — whether all 6 spec sections were
   * produced — which the delivery-layer compaction (Change 3) must not reduce.
   * The dropped-section guard at delivery time is the BRIEF_COMPACT_FALLBACK
   * diagnostic, not this metric.
   */
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
 * D-253 / INS-249: the three intelligence-brief spec sections the boot-time
 * compactor consumes, referenced by POSITION in INTELLIGENCE_BRIEF_SPEC_SECTIONS
 * (the single source of truth) rather than by string literal. Exported so the
 * coupling test can assert they remain a subset of the spec — the guard that
 * keeps compaction from silently drifting if the spec is renamed/reordered.
 */
export const BRIEF_COMPACT_SECTIONS = {
  /** Section summarized to its first 3 sentences. */
  projectState: INTELLIGENCE_BRIEF_SPEC_SECTIONS[0], // "## Project State"
  /** First section passed through in full. */
  riskFlags: INTELLIGENCE_BRIEF_SPEC_SECTIONS[1],    // "## Risk Flags" (brief-465 / SRV-72: spec re-spec'd to 3 sections)
  /** Second section passed through in full. */
  qualityAudit: INTELLIGENCE_BRIEF_SPEC_SECTIONS[2], // "## Quality Audit"
} as const;

/**
 * Extract a single H2 section from a markdown brief: from the line whose
 * trimmed text equals `header` up to (but excluding) the next H2 header, the
 * document's `<!-- EOF` marker, or end-of-input — whichever comes first. The
 * returned text includes the header line and is trimmed. Returns null when the
 * header is absent — the signal {@link compactIntelligenceBrief} uses to fall
 * back to full passthrough.
 */
function extractBriefSection(full: string, header: string): string | null {
  const lines = full.split("\n");
  const start = lines.findIndex(line => line.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("## ") || trimmed.startsWith("<!-- EOF")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Compact an intelligence brief for boot delivery (D-253 — restores the D-47
 * three-section digest with the INS-249 header-coupling defect FIXED).
 *
 * Output contract (INS-249): a one-line `**Project State (compact):**` digest
 * carrying the first 3 sentences of the Project State section, then the FULL
 * Risk Flags section, then the FULL Quality Audit section.
 *
 * The fix for the silent-drop defect the R7-b reversal documented: section
 * names come from {@link BRIEF_COMPACT_SECTIONS} (positions in the spec export,
 * no string literals), and if ANY consumed section is absent from the input the
 * function delivers the FULL brief unchanged and records a
 * BRIEF_COMPACT_FALLBACK diagnostic naming the missing section — so a
 * renamed/dropped header surfaces loudly instead of silently shrinking the
 * brief. Returns the brief string to deliver (compacted, or full on fallback).
 *
 * brief-s202b T3 (P-3): in `dedup` mode (the BRIEF_COMPACT_MODE default) the
 * `**Project State (compact):**` digest line is dropped — the S202 audit
 * (§B.4) measured it as a full duplicate of the handoff-derived
 * `current_state` field delivered in the same payload. FULL Risk Flags and
 * FULL Quality Audit are kept whole. The spec-coupling + fallback guard above
 * is IDENTICAL in both modes (all three sections must still be present, or
 * the full brief ships with the diagnostic) — D-253 lesson (b) retained.
 * `legacy` mode ships the digest line again (env rollback, no deploy).
 */
export function compactIntelligenceBrief(
  full: string,
  diagnostics: DiagnosticsCollector,
  mode: "dedup" | "legacy" = resolveBriefCompactMode(),
): string {
  const projectState = extractBriefSection(full, BRIEF_COMPACT_SECTIONS.projectState);
  const riskFlags = extractBriefSection(full, BRIEF_COMPACT_SECTIONS.riskFlags);
  const qualityAudit = extractBriefSection(full, BRIEF_COMPACT_SECTIONS.qualityAudit);

  if (projectState === null || riskFlags === null || qualityAudit === null) {
    const missingSection =
      projectState === null
        ? BRIEF_COMPACT_SECTIONS.projectState
        : riskFlags === null
          ? BRIEF_COMPACT_SECTIONS.riskFlags
          : BRIEF_COMPACT_SECTIONS.qualityAudit;
    diagnostics.warn(
      "BRIEF_COMPACT_FALLBACK",
      `Intelligence brief is missing the "${missingSection}" section — delivering the full brief instead of compacting (INS-249 silent-drop guard, D-253)`,
      { missing_section: missingSection },
    );
    return full;
  }

  if (mode === "dedup") {
    return [riskFlags, qualityAudit].join("\n\n");
  }

  // Legacy mode — first 3 sentences of the Project State body (header line
  // stripped) as the digest line, then the two full sections.
  const projectStateBody = projectState.split("\n").slice(1).join("\n").trim();
  const projectStateDigest = projectStateBody
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 3)
    .join(" ");

  return [
    `**Project State (compact):** ${projectStateDigest}`,
    riskFlags,
    qualityAudit,
  ].join("\n\n");
}

/**
 * brief-s202b T1 (P-1): title cap for the compact rule index. Titles are 62%
 * of the legacy standing_rules_index bytes (12,253 of 19,873 B measured);
 * the consumer contract (core-template-mcp.md:104 — "consults the index to
 * lazy-load") needs id + short title + topics only. Capped, never dropped:
 * a truncated title still makes the rule discoverable, and `topics` (the
 * prism_load_rules match key) is kept whole.
 */
export function truncateTitle60(title: string): string {
  if (title.length <= 60) return title;
  return `${title.slice(0, 60).trimEnd()}…`;
}

/** brief-s202b T1: one fetched-doc row of the session-state manifest. */
export interface ManifestDocRow {
  path: string;
  sha: string;
  bytes: number;
}

/** brief-s202b T1 (P-1): the machine-readable session-state manifest. */
export interface SessionStateManifest {
  docs: ManifestDocRow[];
  rules: {
    total: number;
    tier_counts: { A: number; B: number; C: number };
    index: Array<{ id: string; t: string; topics: string[]; title60: string }>;
  };
  brief: {
    synthesized_session: number | null;
    sections: string[];
  };
}

/**
 * Build the `session_state_manifest` bootstrap field (brief-s202b T1 / P-1).
 *
 * Replaces the two boot fields whose cost scales with REPOSITORY POPULATION
 * rather than session need (audit §B.3/§B.7): the B/C rules index (compact
 * rows here: id + tier + topics + title60) and the prefetch surface (doc
 * rows: path + sha + bytes, lazy-loadable via prism_fetch). Behavioral rules
 * and Tier-A bodies are NOT manifest-izable — they sit on the wrong side of
 * the fidelity wall (proposals §0.1) and are untouched.
 *
 * Pure and exported for direct unit testing.
 */
export function buildSessionStateManifest(inputs: {
  docs: ManifestDocRow[];
  allRules: StandingRule[];
  indexedRules: StandingRule[];
  briefSynthesizedSession: number | null;
  deliveredBrief: string | null;
}): SessionStateManifest {
  const tierCount = (tier: string): number =>
    inputs.allRules.filter(r => r.tier === tier).length;
  return {
    docs: inputs.docs,
    rules: {
      total: inputs.allRules.length,
      tier_counts: { A: tierCount("A"), B: tierCount("B"), C: tierCount("C") },
      index: inputs.indexedRules.map(r => ({
        id: r.id,
        t: r.tier,
        topics: r.topics,
        title60: truncateTitle60(r.title),
      })),
    },
    brief: {
      synthesized_session: inputs.briefSynthesizedSession,
      // Spec-coupled (no string literals): which spec sections actually
      // appear in the DELIVERED brief — the manifest advertises what the
      // session holds vs what prism_fetch can pull on demand.
      sections: inputs.deliveredBrief
        ? INTELLIGENCE_BRIEF_SPEC_SECTIONS.filter(s => inputs.deliveredBrief!.includes(s))
        : [],
    },
  };
}

/**
 * brief-s202b T7 (P-2 server guard): parse the optional `Kernel-Manifest:`
 * header line from the behavioral-rules template — a comma list of the H2
 * section titles the kernel template MUST deliver. Returns the trimmed list,
 * or null when the template declares no manifest (pre-kernel template — not
 * drift, no diagnostic). Entries may be written with or without their
 * leading `## ` marker.
 */
export function parseKernelManifestHeader(content: string): string[] | null {
  const match = content.match(/^.*Kernel-Manifest:\s*(.+)$/m);
  if (!match) return null;
  const entries = match[1]
    .split(",")
    .map(e => e.trim())
    .filter(e => e.length > 0);
  return entries.length > 0 ? entries : null;
}

/**
 * brief-s202b T7: which Kernel-Manifest-required sections are missing from
 * the delivered template. Comparison is against the template's H2 lines,
 * case-insensitive, tolerant of the entry carrying or omitting `##`.
 */
export function findMissingKernelSections(templateContent: string, required: string[]): string[] {
  const h2Titles = new Set(
    templateContent
      .split("\n")
      .map(line => line.trim())
      .filter(line => /^##\s+/.test(line))
      .map(line => line.replace(/^##\s+/, "").trim().toLowerCase()),
  );
  return required.filter(entry => {
    const normalized = entry.replace(/^#{1,6}\s*/, "").trim().toLowerCase();
    return !h2Titles.has(normalized);
  });
}

/**
 * brief-s202b T4: cap a prefetch summary at `capBytes` UTF-8 bytes on a
 * character boundary, ending with an ellipsis when truncated. SRV-74 capped
 * the header COUNT; this bounds the whole summary string.
 */
export function capSummaryBytes(summary: string, capBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(summary).length <= capBytes) return summary;
  const ellipsis = "…"; // 3 bytes in UTF-8
  let keep = summary;
  // Cut to a fast char-length estimate first, then walk back to fit.
  if (keep.length > capBytes) keep = keep.slice(0, capBytes);
  while (keep.length > 0 && encoder.encode(keep).length > capBytes - 3) {
    keep = keep.slice(0, -1);
  }
  return `${keep}${ellipsis}`;
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
    const result = await pushFile(slug, bootTestPath, content, `prism: S${sessionNumber} boot test`);
    // pushFile reports HTTP failures (403 scope loss, 422, 409-after-retry)
    // as a result shape, not a throw — the write-path verification must
    // propagate that result instead of reporting verified (SRV-16).
    return { success: result.success, error: result.error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Trigger enrollment marker template (brief-105). Schema is fixed by Trigger's
 * discoverMarkerProjects validator at brdonath1/trigger:src/config/discovery.ts.
 * Required fields are enabled, brief_dir, and brief_pattern.
 * Optional fields are filled in with safe defaults so the validator's
 * fallbacks aren't silently relied on. Operators can edit the file
 * post-creation to customize per-project behavior or set enabled: false to
 * opt out.
 *
 * Per-repo brief parallelism is controlled by brief frontmatter (`parallel:
 * true` + disjoint `affects`) via the daemon's Scheduler/OverlapDetector and
 * bounded by the global worker cap. There are no per-marker concurrency knobs:
 * the daemon's validateMarker reads only enabled, brief_dir, brief_pattern,
 * post_merge, wrong_repo_guard, and brief_branch. The retired
 * `branch_strategy`, `intra_project_parallel`, and `max_parallel_briefs`
 * fields are therefore no longer emitted.
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
# Per-repo brief parallelism is controlled by brief frontmatter (parallel: true
# + disjoint affects) and the daemon's global worker cap \u2014 there are no
# per-marker concurrency knobs.
enabled: true
brief_dir: .prism/briefs/queue/
brief_pattern: "brief-*.md"
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

        // brief-s202b T7 (P-2 server guard): Kernel-Manifest handshake. A
        // kernel-split template (s202c) declares `Kernel-Manifest:` — a comma
        // list of the H2 sections the delivered kernel MUST contain. When the
        // header is present and any listed section is missing, warn loudly
        // (BANNER_DRIFT pattern): a thinned kernel must never ship silently
        // (the INS-249 silent-drop class, D-253 lesson b). Templates without
        // the header predate the kernel split — no diagnostic.
        if (behavioralRules) {
          const kernelManifest = parseKernelManifestHeader(behavioralRules);
          if (kernelManifest !== null) {
            const missingKernelSections = findMissingKernelSections(behavioralRules, kernelManifest);
            if (missingKernelSections.length > 0) {
              diagnostics.warn(
                "KERNEL_SPLIT_DRIFT",
                `Behavioral-rules template declares Kernel-Manifest section(s) missing from its own delivered content: ${missingKernelSections.join(", ")}. The kernel template at ${MCP_TEMPLATE_PATH} may be split-damaged — verify against the manifest before trusting this boot's rules.`,
                {
                  missing_sections: missingKernelSections,
                  declared_sections: kernelManifest,
                },
              );
              logger.warn("kernel split drift detected", {
                missing_sections: missingKernelSections,
                declared_count: kernelManifest.length,
              });
            }
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

        // brief-s202b T5 (P-3/P-7): advisory Critical Context item budget.
        // Items measured 708 B average on the S202 baseline — paragraphs, not
        // the 3-5 FACTS the template intends. WARN-ONLY by design: boot never
        // rejects a handoff, and the finalize-side twin (validateHandoff) is
        // a validation WARNING, never an error.
        {
          const encoder = new TextEncoder();
          const oversizeItems = criticalContext
            .map((item, idx) => ({ index: idx + 1, bytes: encoder.encode(item).length }))
            .filter(entry => entry.bytes > HANDOFF_ITEM_BUDGET_BYTES);
          if (oversizeItems.length > 0) {
            diagnostics.warn(
              "HANDOFF_ITEM_OVERSIZE",
              `${oversizeItems.length} Critical Context item(s) exceed the ${HANDOFF_ITEM_BUDGET_BYTES}B item budget (${oversizeItems.map(e => `#${e.index}: ${e.bytes}B`).join(", ")}). Advisory only — trim items to single facts at the next finalize (P-3).`,
              { items: oversizeItems, budget_bytes: HANDOFF_ITEM_BUDGET_BYTES },
            );
          }
        }

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
        // SRV-85: selection was position-blind — `.slice(0, 20)` over index
        // order always shipped D-1..D-20 and NEVER surfaced any later settled
        // decision (measured on the live 209-row prism index: guardrails were
        // exactly D-1..D-20 while D-21..D-242 never reached boot). Blend the
        // FOUNDATIONAL settled decisions (earliest — the architectural
        // precedents) with the MOST-RECENT settled ones (current settled
        // direction), deduped, count cap preserved. Uses only data already in
        // the index (status + order); a curated "pinned" column is the cleaner
        // fix but depends on the not-yet-landed M-021 payload contract (out of
        // scope), so this is the server-side mechanical blend.
        const GUARDRAIL_CAP = 20;
        const GUARDRAIL_FOUNDATIONAL = 10;
        const settledDecisions = decisions.filter(d => d.status.toUpperCase() === "SETTLED");
        const guardrailMap = new Map<string, { id: string; summary: string }>();
        for (const d of settledDecisions.slice(0, GUARDRAIL_FOUNDATIONAL)) {
          guardrailMap.set(d.id, { id: d.id, summary: d.title });
        }
        // Fill the remaining slots from the tail (most-recent settled first),
        // skipping any already pinned as foundational.
        for (let i = settledDecisions.length - 1; i >= 0 && guardrailMap.size < GUARDRAIL_CAP; i--) {
          const d = settledDecisions[i];
          if (!guardrailMap.has(d.id)) guardrailMap.set(d.id, { id: d.id, summary: d.title });
        }
        const guardrails = Array.from(guardrailMap.values());

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

        // brief-s202b T1 (P-1): fetched-doc rows for session_state_manifest —
        // path + sha + TRUE byte size for every doc the server resolved this
        // boot, so the session can lazy-load bodies via prism_fetch without a
        // separate discovery call. Collected opportunistically below.
        const manifestDocRows: ManifestDocRow[] = [];
        const utf8Encoder = new TextEncoder();
        const addManifestDocRow = (path: string, sha: string, content: string): void => {
          if (manifestDocRows.some(r => r.path === path)) return;
          manifestDocRows.push({ path, sha, bytes: utf8Encoder.encode(content).length });
        };
        addManifestDocRow(handoffResolved.path, handoffResolved.sha, handoffResolved.content);
        if (coreResults[1].status === "fulfilled" && coreResults[1].value) {
          const decisionsResolved = coreResults[1].value as { path: string; content: string; sha: string };
          addManifestDocRow(decisionsResolved.path, decisionsResolved.sha, decisionsResolved.content);
        }

        // brief-s202b T4 (P-4): prefetch trigger policy. `opening_only` (the
        // default) drops the next_steps-keyword auto-trigger — it fired on
        // registry-style words ("queue", "task", "priority") present in nearly
        // every handoff's next steps, so most boots carried 1-3 summaries
        // regardless of need (audit §B.3). Opening-message keywords (the
        // operator's actual ask signal) and the always-prefetched
        // pending-doc-updates entry are kept. `legacy` restores the old
        // trigger exactly (env rollback, no deploy).
        const prefetchMode = resolvePrefetchMode();
        const prefetchSet = new Set<string>();

        if (opening_message) {
          for (const f of determinePrefetchFiles(opening_message)) {
            prefetchSet.add(f);
          }
        }

        // Pre-fetch based on next-steps content — legacy mode only (T4).
        if (prefetchMode === "legacy" && nextSteps.length > 0) {
          for (const f of determinePrefetchFiles(nextSteps.join(" "))) {
            prefetchSet.add(f);
          }
        }

        // R7-b (D-240 Phase B): the QW-4 hard cap of 2 prefetched documents is
        // REMOVED under the 500K-context rationale — a deliberate reversal of
        // the token-economy slimming; do not re-introduce the cap. The set is
        // naturally bounded by the distinct documents PREFETCH_KEYWORDS maps
        // to (7 today), and each entry delivers a bounded summarizeMarkdown
        // summary (500-char preview + up to 25 section headers with a "(+N
        // more)" note — SRV-74), not the full document. Pre-brief-465 the
        // header list was unbounded, so a header-dense doc (real task-queue.md)
        // produced a ~2.6KB summary — a silent boot-payload growth vector.
        const prefetchPaths = Array.from(prefetchSet);

        if (prefetchPaths.length > 0) {
          prefetchPromise = Promise.all(
            prefetchPaths.map(async (filePath) => {
              const docName = filePath.replace(`${DOC_ROOT}/`, "");
              try {
                const resolved = await resolveDocPath(resolvedSlug, docName);
                // brief-s202b T4: per-summary hard cap in opening_only mode.
                // SRV-74 bounded the header COUNT; a header-dense doc still
                // measured 2,009 B (task-queue). Legacy mode keeps the
                // uncapped SRV-74 behavior byte-for-byte.
                const rawSummary = summarizeMarkdown(resolved.content);
                prefetchedDocuments.push({
                  file: filePath,
                  size_bytes: resolved.content.length,
                  summary:
                    prefetchMode === "opening_only"
                      ? capSummaryBytes(rawSummary, PREFETCH_SUMMARY_CAP_BYTES)
                      : rawSummary,
                });
                addManifestDocRow(resolved.path, resolved.sha, resolved.content);
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

        // brief-419 / Phase 3c-A: surface synthesis observation events
        // detected in the configured lookback window. Each kind contributes
        // its own warning line (max 4 added) so the operator sees failure,
        // fallback, byte-count, and preamble events independently. Pointers
        // reference INS-242 (the log-code definitions). The structured
        // diagnostic carries per-kind counts plus a capped slice of the raw
        // events for downstream observers — full payload stays server-side.
        if (observation?.has_events) {
          // brief-456 (SRV-51): a failed background synthesis was previously
          // invisible at the next boot — the gate matched only the three
          // warn-level quality codes. SYNTHESIS_FAILED is emitted warn-level
          // by src/ai/synthesize.ts at every failure exit.
          if (observation.synthesis_failed_count > 0) {
            const suffix =
              observation.synthesis_failed_count > 1
                ? ` (× ${observation.synthesis_failed_count})`
                : "";
            warnings.push(
              `Background synthesis FAILED last finalize${suffix} — intelligence-brief / pending-doc-updates may be one session stale; check Railway logs for SYNTHESIS_FAILED (see INS-242).`,
            );
          }
          if (observation.fallback_count > 0) {
            const suffix =
              observation.fallback_count > 1 ? ` (× ${observation.fallback_count})` : "";
            // brief-456 (SRV-32): SYNTHESIS_TRANSPORT_FALLBACK fires for all
            // three call sites (draft/brief/pdu) — render the actual call-site
            // label(s) from the event attributes instead of a hardcoded CS-3.
            const CALL_SITE_LABELS: Record<string, string> = {
              draft: "CS-1 (draft)",
              brief: "CS-2 (brief)",
              pdu: "CS-3 (pdu)",
            };
            const callSiteCounts = new Map<string, number>();
            for (const ev of observation.events) {
              if (ev.kind !== "SYNTHESIS_TRANSPORT_FALLBACK") continue;
              const label =
                CALL_SITE_LABELS[ev.attributes.callSite ?? ""] ?? "call-site unlabeled";
              callSiteCounts.set(label, (callSiteCounts.get(label) ?? 0) + 1);
            }
            const callSiteParts = [...callSiteCounts.entries()]
              .map(([label, n]) => (n > 1 && callSiteCounts.size > 1 ? `${label} × ${n}` : label))
              .join(", ");
            warnings.push(
              `Synthesis transport fallback detected last finalize${suffix} — ${callSiteParts} routed via messages_api fallback (see INS-242).`,
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
              synthesis_failed_count: observation.synthesis_failed_count,
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
        // D-253: the FULL synthesized brief, kept alongside the compacted
        // delivery. Staleness parsing and the INTEL_SLO completeness metric
        // both read this — the "Last synthesized:" header and the sections
        // compaction drops live only here. null when the brief is absent.
        let briefFullContent: string | null = null;
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
          const rawPduSummary = summarizeMarkdown(pendingFile.content);
          prefetchedDocuments.push({
            file: `${DOC_ROOT}/pending-doc-updates.md`,
            size_bytes: pendingFile.content.length,
            // brief-s202b T4: same per-summary cap as the keyword prefetch.
            summary:
              resolvePrefetchMode() === "opening_only"
                ? capSummaryBytes(rawPduSummary, PREFETCH_SUMMARY_CAP_BYTES)
                : rawPduSummary,
          });
          addManifestDocRow(pendingFile.path, pendingFile.sha, pendingFile.content);
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
                      archived: pduAppliedAtBoot.archived, // brief-444: all-rejected batches are archived too
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

        // brief-s202b T4: PREFETCH_DELIVERED hit-rate telemetry — the audit
        // (§B.3) found prefetch consumption unmeasurable because nothing
        // recorded what was delivered. Info-level, emitted whenever at least
        // one summary shipped (either mode), naming the files so transcript
        // audits can compute hit rate.
        if (prefetchedDocuments.length > 0) {
          diagnostics.info(
            "PREFETCH_DELIVERED",
            `Prefetched ${prefetchedDocuments.length} document summar${prefetchedDocuments.length === 1 ? "y" : "ies"}: ${prefetchedDocuments.map(d => d.file).join(", ")}`,
            { files: prefetchedDocuments.map(d => d.file), mode: prefetchMode },
          );
        }

        if (briefOutcome.status === "fulfilled") {
          const briefFile = briefOutcome.value;
          filesFetched++;

          // D-253: compact the intelligence brief for delivery — a partial,
          // evidence-driven reversal of the R7-b full passthrough. R7-b's
          // "500K-context" rationale broke in production: prism boots hit
          // 234–246KB, exceeding the Claude.ai inline tool-result cap, so the
          // ENTIRE response was offloaded to a sandbox file and zero bytes
          // reached the session. Compaction returns to the D-47 three-section
          // digest (Project State summary + full Risk Flags + full Quality
          // Audit). The INS-249 silent-drop defect that motivated R7-b is
          // FIXED, not reintroduced: section names are spec-coupled (no string
          // literals) and a missing section falls back to FULL passthrough
          // with a BRIEF_COMPACT_FALLBACK diagnostic — superseding the
          // brief-443 "Do NOT re-introduce compaction" note. The full brief is
          // retained in briefFullContent for staleness + INTEL_SLO.
          briefFullContent = briefFile.content;
          intelligenceBrief = compactIntelligenceBrief(briefFile.content, diagnostics);
          addManifestDocRow(briefFile.path, briefFile.sha, briefFile.content);
          bytesDelivered += intelligenceBrief.length;
          logger.info("intelligence brief compacted for delivery (D-253)", {
            fullSize: briefFile.content.length,
            deliveredSize: intelligenceBrief.length,
            compactMode: resolveBriefCompactMode(), // brief-s202b T3
          });
        }

        // S30: Brief staleness detection — parse the session number from the
        // FULL brief header. D-253: the "Last synthesized:" line lives in the
        // preamble compaction drops, so staleness reads briefFullContent, not
        // the compacted delivery.
        let briefAgeResult: number | null = null;
        let briefSynthesizedSession: number | null = null; // brief-s202b T1: manifest brief row
        if (briefFullContent) {
          const briefSessionMatch = briefFullContent.match(/Last synthesized:\s*S(\d+)/);
          if (briefSessionMatch) {
            const briefSession = parseInt(briefSessionMatch[1], 10);
            briefSynthesizedSession = briefSession;
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
          addManifestDocRow(insightsOutcome.value.path, insightsOutcome.value.sha, insightsOutcome.value.content);
        }
        if (standingRulesFileOutcome.status === "fulfilled") {
          addManifestDocRow(
            standingRulesFileOutcome.value.path,
            standingRulesFileOutcome.value.sha,
            standingRulesFileOutcome.value.content,
          );
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

        // D-253 (partial reversal of R7-b / D-240 Phase B): deliver ONLY
        // Tier A rule bodies at boot. The R7-b "500K-context" rationale for
        // shipping all of Tier B broke in production — prism boots reached
        // 234–246KB, exceeding the Claude.ai inline tool-result cap, so the
        // ENTIRE response was offloaded to a sandbox file and zero bytes
        // reached the session. Tier B bodies are now lazy-loaded by topic via
        // prism_load_rules (D-156 §3.5 restored). Tier B + Tier C ship as an
        // INDEX (IDs + titles + tier + topics, no bodies) in
        // `standing_rules_index` so the session knows what prism_load_rules
        // can pull on demand.
        const standingRules = selectStandingRulesForBoot(allStandingRules);

        // D-156 / D-253: Tier accounting for diagnostics + log. Tier B and
        // Tier C are both indexed (bodies excluded); only Tier A bodies ship.
        const tierA = allStandingRules.filter(r => r.tier === "A");
        const tierB = allStandingRules.filter(r => r.tier === "B");
        const tierC = allStandingRules.filter(r => r.tier === "C");
        // D-253: boot index = Tier B ∪ Tier C entries (Tier B first, then
        // Tier C; both in source/union order). Each entry carries id + title +
        // tier + topics so the session can see what prism_load_rules can fetch
        // and by which topic.
        const standingRulesIndex = [
          ...tierB.map(r => ({ id: r.id, title: r.title, tier: r.tier, topics: r.topics })),
          ...tierC.map(r => ({ id: r.id, title: r.title, tier: r.tier, topics: r.topics })),
        ];
        // SRV-109: the deprecated `standing_rules_tier_c_index` alias (D-253
        // "one-release" C-only {id,title}) is removed here — its removal window
        // closed (D-253 shipped #69; many merges have deployed since) and the
        // S167 audit verified zero consumers: the live framework template reads
        // neither index field, and in-repo references were tests only. It
        // duplicated ~2,836 B (~795 tokens) of standing_rules_index data on
        // every prism boot — the #1 low-risk diet candidate (§D2).

        if (allStandingRules.length > 0) {
          logger.info("standing rules extracted", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_indexed: tierB.length,
            tier_c_indexed: tierC.length,
            from_standing_rules_file: rulesUnion.fromStandingRulesFile,
            from_insights: rulesUnion.fromInsights,
            conflicts: rulesUnion.conflicts.length,
            ids: standingRules.map(r => r.id),
          });

          // D-156 / D-253: Diagnostics field surfacing tier accounting (only when rules exist).
          diagnostics.info("STANDING_RULES_TIERED", "Standing rules delivered by tier (Tier A bodies; Tier B+C indexed — D-253)", {
            total: allStandingRules.length,
            delivered: standingRules.length,
            tier_a: tierA.length,
            tier_b_indexed: tierB.length,
            tier_c_indexed: tierC.length,
            from_standing_rules_file: rulesUnion.fromStandingRulesFile,
            from_insights: rulesUnion.fromInsights,
          });

          // brief-459 / SRV-12: indexed B/C rules with empty topics can never
          // match a prism_load_rules topic query — name them AT BOOT so the
          // session knows the by-ID recovery path exists, instead of learning
          // only after a failed topic lookup.
          const emptyTopicIndexed = standingRulesIndex.filter(e => e.topics.length === 0);
          if (emptyTopicIndexed.length > 0) {
            diagnostics.info(
              "STANDING_RULES_EMPTY_TOPICS_INDEXED",
              `${emptyTopicIndexed.length} indexed Tier B/C rule(s) have no topics and cannot match a topic query — retrieve by ID via prism_load_rules rule_id: ${emptyTopicIndexed.map(e => e.id).join(", ")}`,
              { ids: emptyTopicIndexed.map(e => e.id) },
            );
          }
        }

        // R-intel-SLO (D-240 Phase B): intelligence SLO instrumentation.
        // Emitted on EVERY bootstrap as an info-level diagnostic plus a
        // structured log line. Log-only by contract — nothing downstream may
        // gate on it (the BRIEF_STALE warning above remains the operator
        //-facing staleness signal; this block is the measurable SLO record).
        const intelSlo = computeIntelSlo({
          intelligenceBrief: briefFullContent, // D-253: measure synthesis completeness on the FULL brief, not the compacted delivery
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
        // Shared boot-banner input — pure data assembly, feeds BOTH the text
        // generator and the SVG masthead so they agree by construction.
        const sessionNameLine = `${projectDisplayName} \u2014 Session ${sessionNumber}: ${sessionTimestamp} CST`;
        const bannerInput: UnifiedBannerInput = {
          surface: "boot",
          templateVersion: handoffTemplateVersion,
          sessionNumber,
          timestamp: sessionTimestamp,
          sessionNameLine,
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

        let bannerText: string;
        try {
          bannerText = renderUnifiedBanner(bannerInput);
          logger.info("boot banner text rendered", { textLength: bannerText.length });
        } catch (bannerError) {
          const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
          logger.warn("boot banner render failed — using single-line fallback", { error: msg });
          diagnostics.warn("BANNER_RENDER_FALLBACK", "Boot banner render failed — banner_text carries the single-line fallback", { error: msg });
          bannerText = renderBannerFallback({ sessionNumber, handoffVersion, docCount, docTotal });
        }

        // brief-447 / D-249: boot SVG masthead built from the same server-owned
        // data (Option M). Independent of banner_text — banner_text remains the
        // genuine fallback, so a masthead render failure just omits the field
        // (null) rather than affecting the text banner.
        // brief-s202b T6 (P-6a): BOOT_MASTHEAD_SVG=off skips the render and
        // ships null — the template's fallback path (banner_text only) is
        // pre-built and production-tested by render-failure handling. Default
        // ON: graphical banners are an explicit operator choice (D-249); the
        // knob exists for context-pressure pushes, not as a silent removal.
        let bootMastheadSvg: string | null = null;
        if (resolveBootMastheadSvg()) {
          try {
            bootMastheadSvg = renderBootMastheadSvg(bannerInput);
            logger.info("boot masthead SVG rendered", { svgLength: bootMastheadSvg.length });
          } catch (svgError) {
            const msg = svgError instanceof Error ? svgError.message : String(svgError);
            logger.warn("boot masthead SVG render failed — omitting (banner_text remains)", { error: msg });
          }
        } else {
          logger.info("boot masthead SVG disabled via BOOT_MASTHEAD_SVG=off (brief-s202b T6)");
        }

        // brief-s202b T1 (P-1): session_state_manifest + BOOT_INDEX_MODE.
        // `full` (default) ships the legacy standing_rules_index unchanged PLUS
        // the manifest — an additive release so the template can learn to
        // consume the manifest before the legacy index is dropped (SRV-109
        // two-phase field-removal pattern). `compact` ships the manifest ONLY
        // (measured legacy index: 19,873 B; compact manifest index ≈ 4.5KB —
        // titles capped at 60 chars, topics kept whole as the
        // prism_load_rules match key).
        const bootIndexMode = resolveBootIndexMode();
        const sessionStateManifest = buildSessionStateManifest({
          docs: manifestDocRows,
          allRules: allStandingRules,
          indexedRules: [...tierB, ...tierC],
          briefSynthesizedSession,
          deliveredBrief: intelligenceBrief,
        });

        const result: Record<string, unknown> = {
          project: resolvedSlug,
          project_display_name: projectDisplayName,    // brief-439: display name survives banner_data removal (Rule 2 Block 1 source)
          handoff_version: handoffVersion,
          template_version: handoffTemplateVersion,
          session_count: sessionCount,
          session_number: sessionNumber,
          session_timestamp: sessionTimestamp,
          session_name_line: sessionNameLine,
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
          // D-253: Tier B ∪ Tier C entries ({id,title,tier,topics}) — bodies
          // via prism_load_rules. brief-s202b T1: OMITTED (not nulled) in
          // BOOT_INDEX_MODE=compact — session_state_manifest.rules.index is
          // the compact replacement.
          ...(bootIndexMode === "full" ? { standing_rules_index: standingRulesIndex } : {}),
          session_state_manifest: sessionStateManifest, // brief-s202b T1 (P-1): {docs, rules, brief} — lazy-load map (prism_fetch / prism_load_rules)
          intelligence_brief: intelligenceBrief,
          brief_age_sessions: briefAgeResult,
          behavioral_rules: behavioralRules,
          banner_text: bannerText,                     // brief-439 / R8: unified generator output (single-line fallback on render failure)
          boot_masthead_svg: bootMastheadSvg,          // brief-447 / D-249: SVG masthead for visualize:show_widget (null on render failure — banner_text is the fallback)
          banner_spec_version: BANNER_SPEC_VERSION,    // brief-439 / R8: banner contract version this server emits
          template_banner_spec_version: templateBannerSpecVersion, // brief-439 / R8: version the template declares (null = pre-handshake template)
          boot_test_verified: bootTestResult.success,
          trigger_enrollment: triggerEnrollment,        // brief-105: marker drop outcome
          // bytes_delivered: SRV-28 — set post-measurement to the true delivered
          // payload size (responseBytes). The pre-brief-465 field summed SOURCE
          // content.length of fetched docs (handoff/decisions/template/prefetch
          // sources), so it conflated source-fetched with delivered bytes
          // (measured 99,797 vs the real 115,842). See the post-measurement block.
          files_fetched: filesFetched,
          expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED, !!GITHUB_PAT),  // D-83 (S44); github category added in brief-403
          post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES,                                     // D-83 (S44)
          recommended_session_settings: recommendedSessionSettings,                             // brief-405 / D-191 — advisory model + thinking suggestion
          autonomous_work_loop: buildAutonomousWorkLoopPayload(),                                // PRISM Autonomous Work Loop v1 — additive post-boot queue autonomy contract
          pdu_applied_at_boot: pduAppliedAtBoot,                                                 // brief-422 Piece 2 — stale-PDU safety net summary (null when nothing was applied)
          warnings,
        };

        // ME-5 / D-253: Context budget estimation + in-response oversize
        // tripwire. Measurement MUST precede diagnostics materialization. The
        // brief-433 numerator is measured from the assembled response (not a
        // hand-picked field subset — the brief-431 audit found the old subset
        // omitted ~13 fields). The D-253 fix: pre-D-253 `diagnostics:
        // diagnostics.list()` was baked into `result` BEFORE the oversize
        // check ran, so the BOOTSTRAP_OVERSIZE diagnostic could only ever
        // reach Railway logs, never any payload. Now `result` is assembled
        // WITHOUT diagnostics and WITHOUT context_estimate, measured once,
        // checked for oversize, and only THEN do those fields attach —
        // diagnostics LAST so it captures any oversize entry.
        //
        // `measured` undercounts the final payload by exactly the fields
        // attached after it (context_estimate, response_bytes, bytes_delivered,
        // diagnostics — all small). The chars/3.5 proxy's own error bars and the
        // recalibrated thresholds both dwarf that gap, so the undercount is
        // acceptable for both the estimate and the tripwire.
        const measured = JSON.stringify(result);
        const bootstrapTokens = Math.round(measured.length / 3.5);
        const responseBytes = new TextEncoder().encode(measured).length;

        // SRV-39 / SRV-68: per-section DELIVERED byte attribution of the measured
        // response. Replaces the old source-size componentSizes (which summed to
        // ~157KB vs the real ~116KB and misdirected the diet). Computed from the
        // measured `result` so it reconciles to responseBytes within the JSON
        // envelope; the top sections attach to BOOTSTRAP_OVERSIZE so an operator
        // who sees the tripwire fire knows WHICH section drove the size.
        const attribution = computePayloadAttribution(result);

        // SRV-39: oversize tripwire — recalibrated thresholds (config, env-
        // tunable) against the real ~234–246KB platform-offload cap instead of
        // the old 80/100KB literals that ERROR-fired on every ~115KB prism boot
        // (ambient noise). Now carries per-section attribution. Evaluated BEFORE
        // diagnostics.list() materializes below so the entry ships in-response.
        if (responseBytes > BOOTSTRAP_OVERSIZE_ERROR_BYTES) {
          logger.error("bootstrap response oversize (error)", { project_slug: resolvedSlug, responseBytes, top_sections: attribution.top });
          diagnostics.error("BOOTSTRAP_OVERSIZE", `Response is ${(responseBytes / 1024).toFixed(1)}KB — exceeds ${(BOOTSTRAP_OVERSIZE_ERROR_BYTES / 1024).toFixed(0)}KB error threshold (approaching platform-offload cap)`, { responseBytes, top_sections: attribution.top });
        } else if (responseBytes > BOOTSTRAP_OVERSIZE_WARN_BYTES) {
          logger.warn("bootstrap response oversize (warn)", { project_slug: resolvedSlug, responseBytes, top_sections: attribution.top });
          diagnostics.warn("BOOTSTRAP_OVERSIZE", `Response is ${(responseBytes / 1024).toFixed(1)}KB — exceeds ${(BOOTSTRAP_OVERSIZE_WARN_BYTES / 1024).toFixed(0)}KB warning threshold`, { responseBytes, top_sections: attribution.top });
        }

        const platformOverheadTokens = 5000;
        const toolSchemaTokens = 2500;
        const totalBootTokens = bootstrapTokens + platformOverheadTokens + toolSchemaTokens;
        const totalBootPercent = Math.round((totalBootTokens / DEFAULT_CONTEXT_WINDOW_TOKENS) * 1000) / 10;

        // Post-measurement attachments — context_estimate, then response_bytes
        // (new, D-253), then diagnostics LAST (now includes any oversize entry).
        result.context_estimate = {
          bootstrap_tokens: bootstrapTokens,
          platform_overhead_tokens: platformOverheadTokens,
          tool_schema_tokens: toolSchemaTokens,
          total_boot_tokens: totalBootTokens,
          total_boot_percent: totalBootPercent,
          context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        };
        result.response_bytes = responseBytes; // D-253: measured response size (undercounts the fields attached after measurement)
        // SRV-28: bytes_delivered is now the TRUE delivered size (the measured
        // response), not the source-content sum the pre-brief-465 field reported.
        // Retained (not renamed) for back-compat — it is now an accurate twin of
        // response_bytes rather than a misleading source-bytes counter.
        result.bytes_delivered = responseBytes;
        result.diagnostics = diagnostics.list();

        // QW-5: component_sizes removed from response (logged only).
        // SRV-68: attribute DELIVERED bytes (per-field serialized sizes of the
        // measured response) instead of SOURCE sizes — the old map summed to
        // ~157KB against a real ~116KB response and misdirected the diet.
        const componentSizes = attribution.sizes;

        logger.info("prism_bootstrap complete", {
          project_slug: resolvedSlug,
          filesFetched,
          sourceBytesFetched: bytesDelivered, // SRV-28: this counter sums SOURCE content.length of fetched docs — the honest name. bytes_delivered (response field) is responseBytes.
          responseBytes, // D-253: central payload-diet metric
          rulesDelivered: !!behavioralRules,
          rulesCached: templateCache.get(MCP_TEMPLATE_PATH) !== null,
          bannerTextBytes: bannerText.length,
          bannerSpecVersion: BANNER_SPEC_VERSION,
          standingRulesCount: standingRules.length,
          standingRulesIndexCount: standingRulesIndex.length,
          bootIndexMode,                                   // brief-s202b T1
          prefetchMode,                                    // brief-s202b T4
          manifestDocRows: manifestDocRows.length,         // brief-s202b T1
          intelligenceBriefDelivered: !!intelligenceBrief, // D-253: compacted at boot (spec-coupled, fallback-guarded)
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

        // QW-2: Compact JSON (no pretty-printing). Single serialization of the
        // full payload (the earlier `measured` excluded the post-measurement
        // attachments by design; see above).
        const responseText = JSON.stringify(result);

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
