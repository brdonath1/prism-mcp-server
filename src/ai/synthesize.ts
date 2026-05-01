/**
 * Intelligence synthesis pipeline.
 * Loads all living documents, calls Opus 4.6, pushes intelligence-brief.md.
 */

import { pushFile } from "../github/client.js";
import { LIVING_DOCUMENT_NAMES, SYNTHESIS_ENABLED, SYNTHESIS_TIMEOUT_MS } from "../config.js";
import { resolveDocFiles, resolveDocPushPath } from "../utils/doc-resolver.js";
import { logger } from "../utils/logger.js";
import { synthesize } from "./client.js";
import {
  FINALIZATION_SYNTHESIS_PROMPT,
  PENDING_DOC_UPDATES_PROMPT,
  buildSynthesisUserMessage,
  buildPendingDocUpdatesUserMessage,
} from "./prompts.js";
import { generateCstTimestamp } from "../utils/banner.js";
import {
  getRecentSuccessful,
  recordSynthesisEvent,
} from "./synthesis-tracker.js";

export interface SynthesisOutcome {
  success: boolean;
  bytes_written?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

/**
 * Generate an intelligence brief for a project.
 * Loads all living documents, synthesizes via Opus 4.6, pushes result.
 */
export async function generateIntelligenceBrief(
  projectSlug: string,
  sessionNumber: number
): Promise<SynthesisOutcome> {
  if (!SYNTHESIS_ENABLED) {
    return { success: false, error: "Synthesis disabled — no API key" };
  }

  const start = Date.now();

  try {
    // 1. Fetch ALL living documents (exclude intelligence-brief.md itself to avoid circular reference).
    //    Invariant (S40 FINDING-14): archives MUST NOT be synthesis input. LIVING_DOCUMENT_NAMES
    //    contains only the 10 mandatory docs (no `-archive.md` entries), so the filter below is
    //    archive-safe by construction. If new doc sources are added here, preserve that invariant.
    const docsToFetch = LIVING_DOCUMENT_NAMES.filter(d => d !== "intelligence-brief.md");
    const docMap = await resolveDocFiles(projectSlug, [...docsToFetch]);

    // Also fetch decision domain files if they exist (D-67: backward-compatible)
    const decisionDomainNames = [
      "decisions/architecture.md",
      "decisions/operations.md",
      "decisions/optimization.md",
      "decisions/onboarding.md",
      "decisions/integrity.md",
      "decisions/resilience.md",
      "decisions/production-stack.md",
    ];

    let domainMap: Map<string, { content: string; size: number }> = new Map();
    try {
      domainMap = await resolveDocFiles(projectSlug, decisionDomainNames);
    } catch {
      // Domain files may not all exist — that's fine
      logger.info("Some decision domain files not found", { projectSlug });
    }

    // Merge all documents
    const allDocs = new Map([...docMap, ...domainMap]);

    // 2. Build the user message
    const timestamp = generateCstTimestamp();
    const userMessage = buildSynthesisUserMessage(projectSlug, sessionNumber, timestamp, allDocs);

    logger.info("Synthesis input assembled", {
      projectSlug,
      sessionNumber,
      documentCount: allDocs.size,
      totalBytes: Array.from(allDocs.values()).reduce((sum, d) => sum + d.size, 0),
    });

    // 3. Call Opus 4.7 with adaptive thinking (Phase 3a — CS-2).
    //    Fire-and-forget per D-78 so latency overhead is invisible to operator.
    const result = await synthesize(
      FINALIZATION_SYNTHESIS_PROMPT,
      userMessage,
      undefined,
      SYNTHESIS_TIMEOUT_MS,
      undefined,
      true, // thinking: true — Phase 3a CS-2 adaptive-thinking flag
    );

    if (!result.success) {
      recordSynthesisEvent({
        project: projectSlug,
        sessionNumber,
        timestamp: new Date().toISOString(),
        success: false,
        error: result.error,
        duration_ms: Date.now() - start,
      });
      return { success: false, error: result.error };
    }

    // 4. Validate the response has required sections
    const requiredSections = [
      "## Project State",
      "## Standing Rules & Workflows",
      "## Active Operational Knowledge",
      "## Recent Trajectory",
      "## Risk Flags",
      "## Quality Audit",
    ];

    const missingSections = requiredSections.filter(s => !result.content.includes(s));
    if (missingSections.length > 0) {
      logger.warn("Synthesis output missing sections", { missingSections });
      // Still push — partial brief is better than no brief
    }

    // 5. Ensure EOF sentinel
    let content = result.content.trim();
    if (!content.endsWith("<!-- EOF: intelligence-brief.md -->")) {
      content += "\n\n<!-- EOF: intelligence-brief.md -->\n";
    }

    // 6. Push to project repo (D-67: resolve path)
    const briefPushPath = await resolveDocPushPath(projectSlug, "intelligence-brief.md");
    await pushFile(
      projectSlug,
      briefPushPath,
      content,
      `prism: S${sessionNumber} intelligence brief (auto-synthesized)`
    );

    const outcome: SynthesisOutcome = {
      success: true,
      bytes_written: new TextEncoder().encode(content).length,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
    };

    logger.info("Intelligence brief generated and pushed", {
      projectSlug,
      sessionNumber,
      ...outcome,
      ms: Date.now() - start,
    });

    recordSynthesisEvent({
      project: projectSlug,
      sessionNumber,
      timestamp: new Date().toISOString(),
      success: true,
      input_tokens: outcome.input_tokens,
      output_tokens: outcome.output_tokens,
      duration_ms: Date.now() - start,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - start;
    logger.error("Intelligence brief generation failed", {
      projectSlug,
      sessionNumber,
      error: message,
      ms: duration,
    });

    recordSynthesisEvent({
      project: projectSlug,
      sessionNumber,
      timestamp: new Date().toISOString(),
      success: false,
      error: message,
      duration_ms: duration,
    });

    return { success: false, error: message };
  }
}

/**
 * Generate a pending doc-updates proposal for a project (D-156 §3.6, D-155).
 *
 * Parallel in shape to generateIntelligenceBrief: same input bundle, different
 * system prompt, different output file. Fired alongside generateIntelligenceBrief
 * by finalize.ts commit-action via Promise.allSettled — fire-and-forget per
 * INS-178.
 *
 * Excludes both `intelligence-brief.md` AND `pending-doc-updates.md` from input
 * to avoid circular references.
 */
export async function generatePendingDocUpdates(
  projectSlug: string,
  sessionNumber: number
): Promise<SynthesisOutcome> {
  if (!SYNTHESIS_ENABLED) {
    return { success: false, error: "Synthesis disabled — no API key" };
  }

  const start = Date.now();

  try {
    // 1. Fetch ALL living documents minus intelligence-brief.md AND
    //    pending-doc-updates.md (avoid circular references).
    //    `pending-doc-updates.md` is not in LIVING_DOCUMENT_NAMES today; the
    //    cast + double-filter is defensive in case it gets added later.
    const docsToFetch = (LIVING_DOCUMENT_NAMES as readonly string[]).filter(
      d => d !== "intelligence-brief.md" && d !== "pending-doc-updates.md",
    );
    const docMap = await resolveDocFiles(projectSlug, [...docsToFetch]);

    // Decision domain files — same back-compat fetch as the intelligence brief.
    const decisionDomainNames = [
      "decisions/architecture.md",
      "decisions/operations.md",
      "decisions/optimization.md",
      "decisions/onboarding.md",
      "decisions/integrity.md",
      "decisions/resilience.md",
      "decisions/production-stack.md",
    ];

    let domainMap: Map<string, { content: string; size: number }> = new Map();
    try {
      domainMap = await resolveDocFiles(projectSlug, decisionDomainNames);
    } catch {
      logger.info("Some decision domain files not found", { projectSlug });
    }

    const allDocs = new Map([...docMap, ...domainMap]);

    // 2. Build the user message
    const timestamp = generateCstTimestamp();
    const userMessage = buildPendingDocUpdatesUserMessage(
      projectSlug,
      sessionNumber,
      timestamp,
      allDocs,
    );

    logger.info("Pending doc-updates synthesis input assembled", {
      projectSlug,
      sessionNumber,
      documentCount: allDocs.size,
      totalBytes: Array.from(allDocs.values()).reduce((sum, d) => sum + d.size, 0),
    });

    // 3. Call synthesize with callSite="pdu" so per-call-site routing
    //    (brief-417 Phase 3c-A) can route this through the Claude Code
    //    subprocess + Sonnet 4.6 path when Railway env opts in. Default
    //    behavior (no env vars set) preserves Opus 4.7 + Messages API.
    //    Fire-and-forget per D-78 / D-156 so latency overhead is invisible.
    const result = await synthesize(
      PENDING_DOC_UPDATES_PROMPT,
      userMessage,
      undefined,
      SYNTHESIS_TIMEOUT_MS,
      undefined,
      true, // thinking: true — Phase 3a CS-3 adaptive-thinking flag
      "pdu", // brief-417: per-call-site routing
    );

    if (!result.success) {
      recordSynthesisEvent({
        project: projectSlug,
        sessionNumber,
        timestamp: new Date().toISOString(),
        success: false,
        error: result.error,
        duration_ms: Date.now() - start,
        synthesis_kind: "pending_updates",
      });
      return { success: false, error: result.error };
    }

    // 4. Validate response sections — lenient (warn-and-push, don't fail).
    const requiredSections = [
      "## architecture.md",
      "## glossary.md",
      "## insights.md",
      "## No Updates Needed",
    ];
    const missingSections = requiredSections.filter(s => !result.content.includes(s));
    if (missingSections.length > 0) {
      logger.warn("Pending doc-updates output missing sections", { missingSections });
    }

    // 4b. brief-417: programmatic CS-3 quality checks. All warn-and-push,
    //     never fail the synthesis (visibility hint per INS-238). Operator
    //     triages via Railway logs.
    const currentOutputBytes = new TextEncoder().encode(result.content).length;

    // Byte-count baseline: compare against last 5 successful CS-3 outputs.
    // Only meaningful with at least 3 historical samples (skip otherwise to
    // avoid noisy warnings during cold-start / post-deploy windows).
    const recentSuccessful = getRecentSuccessful(projectSlug, 5, "pending_updates");
    const baselineSamples = recentSuccessful
      .map((e) => e.output_bytes)
      .filter((b): b is number => typeof b === "number" && b > 0);
    if (baselineSamples.length >= 3) {
      const baselineMean =
        baselineSamples.reduce((sum, b) => sum + b, 0) / baselineSamples.length;
      const lower = baselineMean * 0.5;
      const upper = baselineMean * 1.5;
      if (currentOutputBytes < lower || currentOutputBytes > upper) {
        logger.warn("CS3_QUALITY_BYTE_COUNT_WARNING", {
          projectSlug,
          sessionNumber,
          current_bytes: currentOutputBytes,
          baseline_mean_bytes: Math.round(baselineMean),
          baseline_n: baselineSamples.length,
          lower_bound: Math.round(lower),
          upper_bound: Math.round(upper),
        });
      }
    }

    // Preamble check: first non-empty line must start with "## " or "**".
    // Anything else suggests prompt-leak preamble like "Sure, here is..." or
    // "I'll generate the following...".
    const trimmed = result.content.replace(/^\s+/, "");
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    if (!firstLine.startsWith("## ") && !firstLine.startsWith("**") && !firstLine.startsWith("# ")) {
      logger.warn("CS3_QUALITY_PREAMBLE_WARNING", {
        projectSlug,
        sessionNumber,
        first_200_chars: trimmed.slice(0, 200),
      });
    }

    // 5. Ensure EOF sentinel
    let content = result.content.trim();
    if (!content.endsWith("<!-- EOF: pending-doc-updates.md -->")) {
      content += "\n\n<!-- EOF: pending-doc-updates.md -->\n";
    }

    // 6. Push
    const pushPath = await resolveDocPushPath(projectSlug, "pending-doc-updates.md");
    await pushFile(
      projectSlug,
      pushPath,
      content,
      `prism: S${sessionNumber} pending doc updates (auto-synthesized)`,
    );

    const outcome: SynthesisOutcome = {
      success: true,
      bytes_written: new TextEncoder().encode(content).length,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
    };

    logger.info("Pending doc-updates generated and pushed", {
      projectSlug,
      sessionNumber,
      ...outcome,
      ms: Date.now() - start,
    });

    // brief-417: capture transport + model for cost/quality analysis.
    // result.transport is set by synthesize() based on which routing path
    // actually completed (cc_subprocess on success, messages_api_fallback
    // when the subprocess attempt failed and we retried via Messages API,
    // or messages_api when the call-site routes directly there).
    recordSynthesisEvent({
      project: projectSlug,
      sessionNumber,
      timestamp: new Date().toISOString(),
      success: true,
      input_tokens: outcome.input_tokens,
      output_tokens: outcome.output_tokens,
      duration_ms: Date.now() - start,
      synthesis_kind: "pending_updates",
      transport: result.transport,
      model: result.model,
      output_bytes: currentOutputBytes,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - start;
    logger.error("Pending doc-updates generation failed", {
      projectSlug,
      sessionNumber,
      error: message,
      ms: duration,
    });

    recordSynthesisEvent({
      project: projectSlug,
      sessionNumber,
      timestamp: new Date().toISOString(),
      success: false,
      error: message,
      duration_ms: duration,
      synthesis_kind: "pending_updates",
    });

    return { success: false, error: message };
  }
}
