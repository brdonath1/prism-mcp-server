/**
 * prism_finalize — banner assembly.
 *
 * Extracted from `src/tools/finalize.ts` (S203 audit R27 / F-C1-11, F-A2-13):
 * the pure/near-pure banner-assembly region, split out so the error-banner
 * shape has ONE home instead of three inline copies — the structural reason
 * four finalize responses shipped with no banner field at all (F-A2-4).
 * `commitPhase` deliberately stays in finalize.ts.
 *
 * Contracts: `docs/banner-spec.md`, `_templates/finalization-banner-spec.md`.
 */

import { DOC_ROOT, LIVING_DOCUMENTS, PROJECT_DISPLAY_NAMES } from "../../config.js";
import { resolveDocPath } from "../../utils/doc-resolver.js";
import { logger } from "../../utils/logger.js";
import { extractSection, parseNumberedList, parseMarkdownTable } from "../../utils/summarizer.js";
import { parseTemplateVersion } from "../../validation/handoff.js";
import {
  BANNER_SPEC_VERSION,
  generateCstTimestamp,
  renderBannerFallback,
  renderUnifiedBanner,
  stripMarkdown,
  type BannerStatusEntry,
  type FinalizationBannerHtmlInput,
  type FinalizationBannerLlmUsageEntry,
} from "../../utils/banner.js";
import type { DiagnosticsCollector } from "../../utils/diagnostics.js";
import { classifySession, type SessionRecommendation } from "../../utils/session-classifier.js";

/**
 * Derive the human-readable project name used in chat session titles.
 * Mirrors bootstrap's display-name fallback so finalization can name the next
 * chat without depending on bootstrap-local helpers.
 */
function getProjectDisplayName(slug: string): string {
  if (PROJECT_DISPLAY_NAMES[slug]) return PROJECT_DISPLAY_NAMES[slug];
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Count living documents successfully committed, normalized across both
 * repo layouts (.prism/ and legacy root-level — the pre-R8 counters missed
 * the legacy form and reported 0 for unmigrated repos).
 *
 * Counts ONLY the 10 mandatory living documents: domain decision files
 * (decisions/{domain}.md) are not living documents — decisions/_INDEX.md is
 * the registry entry in the 10-doc list. Distinct paths only, so the result
 * is bounded by LIVING_DOCUMENTS.length by construction. Used by BOTH the
 * commit confirmation (`living_documents_updated`) and the finalization
 * banner so the two never disagree (brief-439 review finding).
 */
export function countLivingDocumentsUpdated(
  results: Array<{ path: string; success: boolean }>,
): number {
  const matched = new Set<string>();
  for (const r of results) {
    if (!r.success) continue;
    const bare = r.path.startsWith(`${DOC_ROOT}/`)
      ? r.path.slice(DOC_ROOT.length + 1)
      : r.path;
    if ((LIVING_DOCUMENTS as readonly string[]).includes(`${DOC_ROOT}/${bare}`)) {
      matched.add(bare);
    }
  }
  return matched.size;
}

export interface FinalizeBannerData {
  deliverables?: Array<{ text: string; status: "ok" | "warn" }>;
  decisions_note?: string;
  step_statuses?: {
    audit?: "ok" | "warn" | "critical";
    draft?: "ok" | "warn" | "critical";
    commit?: "ok" | "warn" | "critical";
    verified?: "ok" | "warn" | "critical";
  };
  llm_usage?: unknown[];
}

export function normalizeBannerText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const normalized = stripMarkdown(value).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? normalized.slice(0, maxLength).trim()
    : normalized;
}

/** Row cap for operator-supplied `banner_data.deliverables` (S203 audit R19 /
 *  F-A2-12): the one unbounded operator-controlled input on the banner path —
 *  `llm_usage` has been capped at 8 since brief-447, deliverables at nothing. */
export const BANNER_DELIVERABLES_MAX_ROWS = 12;

/** Per-row text cap (chars) for operator-supplied deliverables (S203 audit R19). */
export const BANNER_DELIVERABLE_TEXT_MAX_CHARS = 160;

/** Result of capping `banner_data.deliverables`. The two counters drive the
 *  BANNER_DELIVERABLES_TRUNCATED diagnostic — a truncation the operator cannot
 *  see is the F-A2-15 defect, so this one is always reported. */
export interface NormalizedBannerDeliverables {
  items: string[];
  dropped_rows: number;
  clamped_texts: number;
}

/**
 * Cap operator-supplied deliverables to BANNER_DELIVERABLES_MAX_ROWS rows of
 * at most BANNER_DELIVERABLE_TEXT_MAX_CHARS chars each (S203 audit R19).
 * Rows keep request order; markdown is stripped and whitespace collapsed by
 * `normalizeBannerText`, which is not itself truncation and is not counted.
 * Pure — exported for direct unit testing.
 */
export function normalizeBannerDeliverables(
  entries: ReadonlyArray<{ text: string; status?: "ok" | "warn" }> | undefined,
): NormalizedBannerDeliverables {
  if (!Array.isArray(entries)) return { items: [], dropped_rows: 0, clamped_texts: 0 };

  const kept = entries.slice(0, BANNER_DELIVERABLES_MAX_ROWS);
  const items: string[] = [];
  let clampedTexts = 0;
  for (const entry of kept) {
    const collapsed = normalizeBannerText(entry?.text, Number.POSITIVE_INFINITY);
    if (collapsed.length > BANNER_DELIVERABLE_TEXT_MAX_CHARS) {
      clampedTexts++;
      items.push(collapsed.slice(0, BANNER_DELIVERABLE_TEXT_MAX_CHARS).trim());
    } else {
      items.push(collapsed);
    }
  }
  return {
    items,
    dropped_rows: entries.length - kept.length,
    clamped_texts: clampedTexts,
  };
}

export function normalizeFinalizationLlmUsage(
  entries: unknown,
): FinalizationBannerLlmUsageEntry[] {
  if (!Array.isArray(entries)) return [];

  const rows: FinalizationBannerLlmUsageEntry[] = [];
  for (const entry of entries) {
    const record =
      entry != null && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const aspect = normalizeBannerText(record.aspect, 80);
    const model = normalizeBannerText(record.model, 80);
    const settings = normalizeBannerText(record.settings, 120);
    if (!aspect || !model) continue;

    rows.push({
      aspect,
      model,
      settings: settings || null,
    });
    if (rows.length >= 8) break;
  }
  return rows;
}

/**
 * Banner fields for every finalize shape that has no commit result to render
 * from — deadline expiries, hard errors, and the use_draft_files pre-flight
 * rejections (S203 audit R12 / F-A2-4).
 *
 * `docCount: null` is load-bearing (S203 audit R18 / F-A2-11): these shapes
 * did NOT verify the repo, and the atomic commit may well have landed, so the
 * pre-R18 hardcoded `0` asserted "0/10 docs" as fact. Null renders
 * `?/10 docs (unverified)` instead — an unknown reported as unknown.
 */
export function assembleFinalizeErrorBannerFields(
  sessionNumber: number,
  handoffVersion: number,
): {
  banner_text: string;
  banner_spec_version: typeof BANNER_SPEC_VERSION;
  finalization_banner_html: null;
} {
  return {
    banner_text: renderBannerFallback({
      sessionNumber,
      handoffVersion,
      docCount: null,
      docTotal: LIVING_DOCUMENTS.length,
    }),
    banner_spec_version: BANNER_SPEC_VERSION,
    finalization_banner_html: null,
  };
}

/**
 * The finalize render obligation, delivered on every action that returns a
 * banner (S203 audit R11 / F-A2-3, F-D3).
 *
 * The detailed structure used to ride only on `action=audit`'s
 * `session_end_rules` fetch, while the kernel forbids memorizing Rules 10–15
 * from boot — so every commit-only / full / use_draft_files path reached a
 * banner-bearing response holding nothing but the one-line kernel obligation.
 * This constant is the ~1KB standalone restatement: no extra GitHub round-trip
 * on the commit path, and negligible against the ~100KB response ceiling.
 */
export const FINALIZE_RENDER_CONTRACT = [
  "FINALIZE RENDER CONTRACT (server-delivered; do not summarize or paraphrase)",
  "",
  "RENDER — in the SAME turn that receives this response:",
  "1. If `finalization_banner_html` is non-null, render it via visualize:show_widget.",
  "2. Make ONE render attempt per turn. Never retry a failed widget call.",
  "3. Never omit the banner because the widget channel is down.",
  "",
  "FALLBACK — if the widget call fails, errors, times out, or the field is null:",
  "4. Render `banner_text` inline as a fenced block in the SAME turn.",
  "5. Note the render failure in one clause. Do not re-enumerate the banner in prose.",
  "",
  "CONFIRM — after the banner, in this order:",
  "6. State what landed: `living_documents_updated`/10 docs, handoff version, commit outcome.",
  "7. Surface every `diagnostics` entry at warn or error level, by code.",
  "8. If `all_succeeded` is false, name the failed paths from `results` and stop —",
  "   do not report a partial finalization as a completed one.",
].join("\n");

/**
 * Assemble the finalization banner via the unified generator (brief-439 / R8;
 * brief-447 / D-249).
 *
 * Returns BOTH the unified `banner_text` (shares the single banner code path
 * with prism_bootstrap — boot and finalize text banners are byte-consistent by
 * construction) AND a structured `htmlInput` for the restored finalization HTML
 * widget (D-249). The caller renders the widget via renderFinalizationBannerHtml
 * and sets `finalization_banner_html`; `banner_text` remains the genuine
 * fallback. Contracts: _templates/banner-spec.md, _templates/finalization-banner-spec.md.
 *
 * Never throws — render failure falls back to the Rule 2 single-line text and a
 * null `htmlInput` (so the caller emits a null widget, not a broken one).
 */
export async function assembleFinalizeBanner(
  projectSlug: string,
  sessionNumber: number,
  handoffVersion: number,
  files: Array<{ path: string; content: string }>,
  results: Array<{ path: string; success: boolean; verified: boolean }>,
  allSucceeded: boolean,
  bannerData?: FinalizeBannerData,
  diagnostics?: DiagnosticsCollector,
): Promise<{ text: string; htmlInput: FinalizationBannerHtmlInput | null }> {
  const docsTotal = LIVING_DOCUMENTS.length;

  try {
    // Same normalized count the commit confirmation uses — banner L2 and
    // the confirmation sentence agree by construction, and {C} ≤ {T}.
    const docsUpdated = countLivingDocumentsUpdated(results);

    // Extract resumption + next steps from the handoff content in the commit
    const handoffFile = files.find(
      (f) => f.path === "handoff.md" || f.path === `${DOC_ROOT}/handoff.md`,
    );
    let resumption = "See handoff.md for resumption point.";
    let nextStepsForRecommendation: string[] = [];
    if (handoffFile) {
      const whereWeAre = extractSection(handoffFile.content, "Where We Are")
        ?? extractSection(handoffFile.content, "Current State")
        ?? "";
      if (whereWeAre.trim()) {
        const firstParagraph = whereWeAre.split("\n\n")[0]?.trim();
        if (firstParagraph) resumption = firstParagraph;
      }
      // brief-405 / D-191: parse next_steps for the classifier. The
      // finalization banner is the primary pre-boot signal —
      // handoff_next_steps is the canonical source.
      nextStepsForRecommendation = parseNumberedList(
        extractSection(handoffFile.content, "Next Steps")
          ?? extractSection(handoffFile.content, "Immediate Next")
          ?? ""
      );
    }

    // Banner line 1 version segment: the framework template version the
    // handoff declares — the same semantic the boot banner renders. Falls
    // back to "unknown" exactly like boot when unparseable.
    const templateVersion = handoffFile
      ? (parseTemplateVersion(handoffFile.content) ?? "unknown")
      : "unknown";

    // brief-405 / D-191: classify the next session. Pure function, no I/O.
    // Failure is non-fatal — the banner renders without the Suggested line.
    let recommendation: SessionRecommendation | null = null;
    try {
      recommendation = classifySession({
        next_steps: nextStepsForRecommendation,
      });
    } catch (classifyErr) {
      logger.warn("session classifier failed (finalize)", {
        error: classifyErr instanceof Error ? classifyErr.message : String(classifyErr),
      });
    }

    // Handoff push status → line 2 parenthetical
    const handoffResult = results.find(
      (r) => r.path === "handoff.md" || r.path === `${DOC_ROOT}/handoff.md`,
    );
    let handoffNote = "pushed";
    if (!handoffResult?.success) {
      handoffNote = "push failed";
    } else if (handoffResult && !handoffResult.verified) {
      handoffNote = "unverified";
    }

    // Count decisions from the repo index, falling back to the commit files
    // array (handles legacy paths and unmigrated repos).
    let decisionsCount = 0;
    try {
      const indexDoc = await resolveDocPath(projectSlug, "decisions/_INDEX.md");
      decisionsCount = parseMarkdownTable(indexDoc.content).length;
    } catch {
      const indexFile = files.find(
        (f) =>
          f.path === "decisions/_INDEX.md" ||
          f.path === `${DOC_ROOT}/decisions/_INDEX.md`,
      );
      if (indexFile) {
        decisionsCount = parseMarkdownTable(indexFile.content).length;
      }
    }

    // Deliverables list — operator-supplied via banner_data, or a default
    // push-count line. Per-item status is no longer rendered (push failures
    // already surface as warning lines); the field is still accepted for
    // backward compatibility. S203 audit R19: operator rows are capped at
    // BANNER_DELIVERABLES_MAX_ROWS × BANNER_DELIVERABLE_TEXT_MAX_CHARS, and
    // any cut is reported — never silent.
    const succeededCount = results.filter((r) => r.success).length;
    let listItems: string[];
    if (bannerData?.deliverables) {
      const normalized = normalizeBannerDeliverables(bannerData.deliverables);
      listItems = normalized.items;
      if (normalized.dropped_rows > 0 || normalized.clamped_texts > 0) {
        const parts: string[] = [];
        if (normalized.dropped_rows > 0) {
          parts.push(
            `${normalized.dropped_rows} row(s) dropped past the ${BANNER_DELIVERABLES_MAX_ROWS}-row cap`,
          );
        }
        if (normalized.clamped_texts > 0) {
          parts.push(
            `${normalized.clamped_texts} row text(s) cut to ${BANNER_DELIVERABLE_TEXT_MAX_CHARS} chars`,
          );
        }
        diagnostics?.warn(
          "BANNER_DELIVERABLES_TRUNCATED",
          `banner_data.deliverables exceeded the banner caps — ${parts.join("; ")}. The banner shows the first ${listItems.length} row(s); nothing else was lost from the commit.`,
          {
            supplied_rows: bannerData.deliverables.length,
            rendered_rows: listItems.length,
            dropped_rows: normalized.dropped_rows,
            clamped_texts: normalized.clamped_texts,
            max_rows: BANNER_DELIVERABLES_MAX_ROWS,
            max_text_chars: BANNER_DELIVERABLE_TEXT_MAX_CHARS,
          },
        );
      }
    } else {
      listItems = [`${succeededCount} file${succeededCount === 1 ? "" : "s"} pushed`];
    }

    // Step row — operator overrides win; otherwise derived from the commit
    const stepStatuses = bannerData?.step_statuses ?? {};
    const allVerified = results.every((r) => r.success && r.verified);
    const statusRow: BannerStatusEntry[] = [
      { label: "audit", status: stepStatuses.audit ?? "ok" },
      { label: "draft", status: stepStatuses.draft ?? "ok" },
      { label: "commit", status: stepStatuses.commit ?? (allSucceeded ? "ok" : "critical") },
      { label: "verified", status: stepStatuses.verified ?? (allVerified ? "ok" : "warn") },
    ];

    // One timestamp shared by the text banner, HTML widget, and next-chat
    // title so the visible finalization contract cannot drift internally.
    const timestamp = generateCstTimestamp();
    const nextSessionNameLine =
      `${getProjectDisplayName(projectSlug)} — Session ${sessionNumber + 1}: ${timestamp} CST`;

    const bannerText = renderUnifiedBanner({
      surface: "finalize",
      templateVersion,
      sessionNumber,
      timestamp,
      handoffVersion,
      handoffNote,
      decisionCount: decisionsCount,
      decisionNote: bannerData?.decisions_note ?? null,
      docCount: docsUpdated,
      docTotal: docsTotal,
      statusRow,
      suggested: recommendation
        ? { display: recommendation.display, rationale: recommendation.rationale }
        : null,
      resumption,
      listItems,
      warnings: results
        .filter((r) => !r.success)
        .map((r) => `Push failed: ${r.path}`),
    });

    // brief-447 / D-249: structured input for the finalization HTML widget,
    // built from the SAME finalize data so the widget and banner_text agree.
    // The handoff chip shows the outgoing→incoming version transition; the
    // `Next:` pointer reuses the first handoff next-step (omitted when none).
    // decisionDelta has no source on the commit path, so the "(+N)" segment is
    // dropped (null).
    const htmlInput: FinalizationBannerHtmlInput = {
      templateVersion,
      sessionNumber,
      timestamp,
      handoffFromVersion: handoffVersion - 1,
      handoffToVersion: handoffVersion,
      handoffStatus: handoffNote,
      decisionCount: decisionsCount,
      decisionDelta: null,
      docCount: docsUpdated,
      docTotal: docsTotal,
      statusRow,
      deliverables: listItems,
      llmUsage: normalizeFinalizationLlmUsage(bannerData?.llm_usage),
      next:
        nextStepsForRecommendation.length > 0
          ? stripMarkdown(nextStepsForRecommendation[0])
          : null,
      nextSessionNameLine,
    };

    logger.info("finalization banner rendered", { textLength: bannerText.length });
    return { text: bannerText, htmlInput };
  } catch (bannerError) {
    const msg = bannerError instanceof Error ? bannerError.message : String(bannerError);
    logger.warn("finalization banner render failed — using single-line fallback", { error: msg });
    const docsUpdatedFallback = results.filter((r) => r.success).length;
    return {
      text: renderBannerFallback({
        sessionNumber,
        handoffVersion,
        docCount: Math.min(docsUpdatedFallback, docsTotal),
        docTotal: docsTotal,
      }),
      htmlInput: null,
    };
  }
}
