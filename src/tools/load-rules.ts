/**
 * prism_load_rules tool — Mid-session lazy-load of Tier B / Tier C standing rules
 * by explicit topic (D-156 §3.5, Phase 2 PR 4).
 *
 * Why this exists: bootstrap delivers Tier A bodies plus a Tier B+C index
 * (D-253 — partial reversal of R7-b; Tier B bodies are no longer shipped at
 * boot, which overflowed the Claude.ai inline tool-result cap). Tier B and
 * Tier C bodies are reference-only at boot, so when a session needs one (e.g.
 * a rule listed in the boot index), this tool fetches it on demand by topic
 * without re-running a full bootstrap.
 *
 * R2-B (D-240 Phase B): rules resolve from a UNION of the standing-rule
 * registry (`.prism/standing-rules.md`) and the legacy location
 * (`insights.md`), dedup'd by INS-N with the registry winning on conflict.
 * Projects with no standing-rules.md behave exactly as before.
 *
 * Standard MCP tool response contract (L-5):
 * - Success: { content: [{ type: "text", text: JSON.stringify(result) }] }
 * - Error:   { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true }
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveProjectSlug } from "../config.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import {
  matchesExplicitTopic,
  normalizeTopic,
  selectStandingRulesByTopic,
  type StandingRule,
} from "../utils/standing-rules.js";
import { unionStandingRules } from "../utils/standing-rules-union.js";

/**
 * Input schema for prism_load_rules.
 *
 * `topic` is normalized (trimmed + lowercased) before matching, so callers may
 * pass `"Synthesis"`, `" synthesis "`, `"SYNTHESIS"`, etc.
 */
const inputSchema = {
  project_slug: z.string().min(1).describe("Project repo name (e.g. 'prism', 'prism-mcp-server')"),
  topic: z.string().min(1).describe("Single topic keyword to match against rule topics arrays (e.g. 'synthesis', 'cc_dispatch'). Case-insensitive exact match."),
  include_tier_c: z.boolean().optional().describe("When true, also include Tier C rules whose topics match. Defaults to false (Tier B only)."),
};

/**
 * Register the prism_load_rules tool on an MCP server instance.
 */
export function registerLoadRules(server: McpServer): void {
  server.tool(
    "prism_load_rules",
    "Mid-session lazy-load of Tier B / Tier C standing rules from a project's rule sources (.prism/standing-rules.md unioned with insights.md), filtered by an explicit topic keyword (D-156 §3.5). Tier A is always excluded — those rules are auto-loaded at bootstrap.",
    inputSchema,
    async ({ project_slug, topic, include_tier_c }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      const includeTierC = include_tier_c === true;
      const normalizedTopic = normalizeTopic(topic);
      const resolvedSlug = resolveProjectSlug(project_slug);

      logger.info("prism_load_rules", {
        project_slug: resolvedSlug,
        topic: normalizedTopic,
        include_tier_c: includeTierC,
      });

      try {
        // R2-B (D-240 Phase B): fetch BOTH rule sources in parallel via the
        // same path-resolution mechanism bootstrap uses — the standing-rule
        // registry (.prism/standing-rules.md) and the legacy location
        // (insights.md). Rules are unioned by INS-N with the registry winning
        // on conflict, so projects that have not migrated keep resolving from
        // insights.md alone.
        const [standingRulesOutcome, insightsOutcome] = await Promise.allSettled([
          resolveDocPath(resolvedSlug, "standing-rules.md"),
          resolveDocPath(resolvedSlug, "insights.md"),
        ]);
        const standingRulesContent =
          standingRulesOutcome.status === "fulfilled" ? standingRulesOutcome.value.content : null;
        const insightsContent =
          insightsOutcome.status === "fulfilled" ? insightsOutcome.value.content : null;

        // insights.md is a mandatory living document — its absence is signal
        // even when the registry covers the rules. A missing standing-rules.md
        // is NOT flagged: that's the normal pre-migration state.
        if (insightsOutcome.status === "rejected") {
          const reason = insightsOutcome.reason;
          const message = reason instanceof Error ? reason.message : String(reason);
          diagnostics.warn(
            "INSIGHTS_FILE_NOT_FOUND",
            `insights.md could not be loaded for project "${resolvedSlug}": ${message}`,
            { project: resolvedSlug, error: message },
          );
        }

        if (standingRulesContent === null && insightsContent === null) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                project: resolvedSlug,
                topic: normalizedTopic,
                include_tier_c: includeTierC,
                matched_rules: [] as StandingRule[],
                counts: {
                  total_standing_rules: 0,
                  tier_b_total: 0,
                  tier_b_matched: 0,
                  tier_c_total: 0,
                  tier_c_matched: 0,
                },
                sources: {
                  standing_rules_file: false,
                  insights_file: false,
                  from_standing_rules_file: 0,
                  from_insights: 0,
                  conflicts: [] as string[],
                },
                diagnostics: diagnostics.list(),
              }),
            }],
          };
        }

        const union = unionStandingRules(standingRulesContent, insightsContent);
        if (union.conflicts.length > 0) {
          diagnostics.warn(
            "STANDING_RULE_SOURCE_CONFLICT",
            `${union.conflicts.length} INS id(s) present in BOTH standing-rules.md and insights.md — registry version used: ${union.conflicts.join(", ")}. Finish the migration (R3-imm) to clear this.`,
            { conflicts: union.conflicts },
          );
        }

        const allRules = union.rules;
        const tierB = allRules.filter(r => r.tier === "B");
        const tierC = allRules.filter(r => r.tier === "C");
        const tierBMatched = tierB.filter(r => matchesExplicitTopic(normalizedTopic, r.topics));
        const tierCMatched = includeTierC
          ? tierC.filter(r => matchesExplicitTopic(normalizedTopic, r.topics))
          : [];

        const matchedRules = selectStandingRulesByTopic(allRules, normalizedTopic, includeTierC);

        // §3.3: when there are Tier B rules to consider but none match, surface
        // the unpopulated-topics gap so operators see signal vs. silence.
        if (tierB.length > 0 && tierBMatched.length === 0) {
          const tierBWithEmptyTopics = tierB.filter(r => r.topics.length === 0).length;
          diagnostics.info(
            "STANDING_RULES_TOPICS_UNPOPULATED",
            `Tier B has ${tierB.length} rules but none matched topic "${normalizedTopic}". ${tierBWithEmptyTopics} of those have empty topics arrays — populating <!-- topics: ... --> on rules will improve match coverage.`,
            {
              tier_b_total: tierB.length,
              tier_b_with_empty_topics: tierBWithEmptyTopics,
              topic: normalizedTopic,
            },
          );
        }

        logger.info("prism_load_rules complete", {
          project_slug: resolvedSlug,
          topic: normalizedTopic,
          include_tier_c: includeTierC,
          total: allRules.length,
          tier_b_total: tierB.length,
          tier_b_matched: tierBMatched.length,
          tier_c_total: tierC.length,
          tier_c_matched: tierCMatched.length,
          from_standing_rules_file: union.fromStandingRulesFile,
          from_insights: union.fromInsights,
          conflicts: union.conflicts.length,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              project: resolvedSlug,
              topic: normalizedTopic,
              include_tier_c: includeTierC,
              matched_rules: matchedRules,
              counts: {
                total_standing_rules: allRules.length,
                tier_b_total: tierB.length,
                tier_b_matched: tierBMatched.length,
                tier_c_total: tierC.length,
                tier_c_matched: tierCMatched.length,
              },
              sources: {
                standing_rules_file: standingRulesContent !== null,
                insights_file: insightsContent !== null,
                from_standing_rules_file: union.fromStandingRulesFile,
                from_insights: union.fromInsights,
                conflicts: union.conflicts,
              },
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_load_rules failed", {
          project_slug: resolvedSlug,
          topic: normalizedTopic,
          error: message,
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: message,
              project: resolvedSlug,
              topic: normalizedTopic,
              diagnostics: diagnostics.list(),
            }),
          }],
          isError: true,
        };
      }
    },
  );
}
