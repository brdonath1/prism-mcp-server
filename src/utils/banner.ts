/**
 * Unified server-side banner generator (brief-439 / D-240 Phase B, R8).
 *
 * ONE text generator produces the `banner_text` field for BOTH surfaces:
 * boot (`prism_bootstrap`) and finalization (`prism_finalize`). Boot and
 * finalize banners are byte-consistent by construction — same line grammar,
 * same separators, same icon set, same truncation rules — because they share
 * this single code path. The authoritative contract lives in
 * `docs/banner-spec.md`; cite that file for any future banner change.
 *
 * History: the HTML boot banner (D-35) was replaced by `banner_text` in ME-1
 * (template v2.10.0); the HTML finalization widget (D-46, consumed by Rule 11
 * Step 6 / D-84) is deprecated as of banner spec 3.0 — `finalization_banner_html`
 * is now always null and the finalize response carries `banner_text` instead.
 */

export interface BannerStatusEntry {
  label: string;
  status: "ok" | "warn" | "critical";
}

/**
 * Banner spec version emitted by the server (`banner_spec_version` response
 * field) and compared against the version the framework template declares
 * (`Banner-Spec-Version: X.Y`). On mismatch the server logs a BANNER_DRIFT
 * warn diagnostic — visibility only, never blocking. Spec 2.0 was the HTML
 * banner contract (banner-spec.md v2.0, D-35/D-46); 3.0 is the unified text
 * contract defined in docs/banner-spec.md.
 */
export const BANNER_SPEC_VERSION = "3.0";

/** Status glyphs shared by every banner surface. */
const STATUS_ICONS: Record<BannerStatusEntry["status"], string> = {
  ok: "✓",
  warn: "⚠",
  critical: "✗",
};

/** Max rendered length of the Resumption line's text. */
const RESUMPTION_MAX_CHARS = 200;

export type BannerSurface = "boot" | "finalize";

/**
 * Input to the unified banner generator. Surface-specific values are plain
 * data; the structural grammar (line order, separators, icons, truncation)
 * is fixed by the generator and documented in docs/banner-spec.md.
 */
export interface UnifiedBannerInput {
  /** Which surface this banner is for. Controls the session tag ("finalized"),
   *  the docs label ("docs healthy" vs "docs updated"), the list-block label
   *  ("Next:" vs "Deliverables:"), and the boot-only [priority] tag. */
  surface: BannerSurface;
  /** Framework template version (e.g. "2.19.1"); "unknown" when unparseable. */
  templateVersion: string;
  sessionNumber: number;
  /** CST timestamp, "MM-DD-YY HH:MM:SS" (see generateCstTimestamp). */
  timestamp: string;
  handoffVersion: number;
  /** Parenthetical after the handoff version — boot: "{size}KB";
   *  finalize: "pushed" | "push failed" | "unverified". */
  handoffNote: string;
  decisionCount: number;
  /** Optional parenthetical after the decision count — boot: "{N} guardrails";
   *  finalize: operator-supplied note (banner_data.decisions_note) or null. */
  decisionNote?: string | null;
  docCount: number;
  docTotal: number;
  /** Line 3 status row — boot: tool checks; finalize: phase steps. */
  statusRow: BannerStatusEntry[];
  /** Optional model+thinking recommendation (brief-405 / D-191). Renders as
   *  the `Suggested:` line immediately after the status row; omitted entirely
   *  (no blank placeholder) when null/undefined. */
  suggested?: {
    display: string;
    rationale: string;
  } | null;
  resumption: string;
  /** List block items — boot: next steps; finalize: deliverables. */
  listItems: string[];
  warnings: string[];
}

// --- Shared text helpers ---

export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * Generate a CST timestamp in "MM-DD-YY HH:MM:SS" format.
 */
export function generateCstTimestamp(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("month")}-${get("day")}-${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Extract the best resumption text for the banner from available sources.
 * Priority: explicit resumption_point > "Resumption point" paragraph in current_state > current_state.
 */
export function parseResumptionForBanner(
  resumptionPoint: string,
  currentState: string,
): string {
  // Priority 1: explicit resumption point from handoff
  if (resumptionPoint.trim()) {
    return resumptionPoint.trim();
  }

  // Priority 2: look for "Resumption point" paragraph in current state
  const resumptionMatch = currentState.match(
    /\*?\*?Resumption point[^:]*:\*?\*?\s*([\s\S]*?)(?:\n\n|$)/i
  );
  if (resumptionMatch) {
    const cleaned = resumptionMatch[1].trim();
    if (cleaned.length > 0) return cleaned;
  }

  // Priority 3: full current state with structure preserved
  if (currentState.trim()) {
    return currentState.trim();
  }

  return "No specific resumption point set.";
}

// --- Unified banner generator (the ONE banner code path) ---

/**
 * Render the unified text banner for either surface.
 *
 * Grammar (docs/banner-spec.md, spec 3.0):
 *
 *   L1  PRISM v{tv} | Session {N}[ finalized] | {timestamp} CST
 *   L2  Handoff v{V} ({note}) | {D} decisions[ ({note})] | {C}/{T} docs {healthy|updated}
 *   L3  {icon} {label}[ | {icon} {label}...]
 *   L4? Suggested: {display} — {rationale}
 *       (blank)
 *       Resumption: {text ≤200 chars, markdown stripped}
 *      [(blank)
 *       {Next:|Deliverables:}
 *       ▸ {item}[ [priority]]   ← [priority] on the first boot item only
 *       ...]
 *      [(blank)
 *       ⚠ {warning}
 *       ...]
 */
export function renderUnifiedBanner(data: UnifiedBannerInput): string {
  const isBoot = data.surface === "boot";

  const sessionSegment = `Session ${data.sessionNumber}${isBoot ? "" : " finalized"}`;
  const decisionSegment = `${data.decisionCount} decisions${
    data.decisionNote ? ` (${data.decisionNote})` : ""
  }`;
  const docsSegment = `${data.docCount}/${data.docTotal} docs ${isBoot ? "healthy" : "updated"}`;

  const statusRow = data.statusRow
    .map((t) => `${STATUS_ICONS[t.status]} ${t.label}`)
    .join(" | ");

  // Truncate resumption to 200 chars if needed
  const resumption =
    data.resumption.length > RESUMPTION_MAX_CHARS
      ? data.resumption.slice(0, RESUMPTION_MAX_CHARS - 3) + "..."
      : data.resumption;

  const lines: string[] = [
    `PRISM v${data.templateVersion} | ${sessionSegment} | ${data.timestamp} CST`,
    `Handoff v${data.handoffVersion} (${data.handoffNote}) | ${decisionSegment} | ${docsSegment}`,
    statusRow,
  ];

  // brief-405 / D-191: emit a model-recommendation line below the status row
  // when the classifier produced a recommendation. Omit entirely on null/
  // undefined so older clients render no blank line.
  if (data.suggested) {
    lines.push(`Suggested: ${data.suggested.display} — ${data.suggested.rationale}`);
  }

  lines.push("");
  lines.push(`Resumption: ${stripMarkdown(resumption)}`);

  if (data.listItems.length > 0) {
    lines.push("");
    lines.push(isBoot ? "Next:" : "Deliverables:");
    data.listItems.forEach((item, i) => {
      lines.push(`▸ ${stripMarkdown(item)}${isBoot && i === 0 ? " [priority]" : ""}`);
    });
  }

  if (data.warnings.length > 0) {
    lines.push("");
    data.warnings.forEach((w) => {
      lines.push(`⚠ ${w}`);
    });
  }

  return lines.join("\n");
}

/**
 * Single-line banner fallback — the Rule 2 fallback format, rendered
 * server-side so `banner_text` carries it directly when the full render
 * fails. Resolves the pre-R8 contradiction where the server fell back to a
 * structured `banner_data` object while the template documented a
 * single-line text fallback.
 */
export function renderBannerFallback(data: {
  sessionNumber: number;
  handoffVersion: number;
  docCount: number;
  docTotal: number;
}): string {
  return `PRISM | Session ${data.sessionNumber} | Handoff v${data.handoffVersion} | ${data.docCount}/${data.docTotal} docs`;
}

/**
 * Parse the banner spec version a framework template declares
 * (`Banner-Spec-Version: X.Y`, tolerant of bold/blockquote markup, spacing
 * or underscore separators, and an optional `v` prefix). Returns null when
 * the template declares nothing — pre-handshake templates are not drift.
 */
export function parseTemplateBannerSpecVersion(content: string): string | null {
  const match = content.match(/banner[-_\s]?spec[-_\s]?version[:\s*]*v?(\d+(?:\.\d+)+|\d+)/i);
  return match ? match[1] : null;
}
