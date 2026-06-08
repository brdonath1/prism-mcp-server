/**
 * Server-side banner generators (brief-439 / R8 text core; brief-447 / D-249
 * graphical restoration).
 *
 * THREE renderers over ONE shared data contract:
 *   - renderUnifiedBanner — the single text generator producing `banner_text`
 *     for BOTH surfaces (boot `prism_bootstrap`, finalize `prism_finalize`).
 *     Boot and finalize text banners are byte-consistent by construction —
 *     same line grammar, separators, icon set, truncation rules — because
 *     they share this one code path. It is always the genuine fallback.
 *   - renderBootMastheadSvg — a compact boot SVG masthead built ONLY from
 *     server-owned fields (D-249, Option M). Emitted alongside `banner_text`
 *     as `boot_masthead_svg`; Claude passes it to `visualize:show_widget`
 *     verbatim (zero interpretation → strictly more drift-proof than text
 *     assembly).
 *   - renderFinalizationBannerHtml — the rich finalization HTML widget
 *     (`finalization_banner_html`), rendered via `visualize:show_widget` at
 *     session end (the variable-length Deliverables list wraps natively).
 *
 * Contracts: `_templates/banner-spec.md` (boot) and
 * `_templates/finalization-banner-spec.md` (finalize); cite them for any
 * future banner change. The graphical renderers emit inert markup STRINGS —
 * the `visualize` design-system classes (box, c-purple, c-green, …) and CSS
 * variables (--color-*, --border-radius-*) resolve at render time inside the
 * widget host, so never substitute hardcoded colors for them.
 *
 * History: the original HTML boot banner (D-35) gave way to `banner_text` in
 * ME-1 (template v2.10.0), and the HTML finalization widget (D-46) was
 * deprecated at spec 3.0 (R8). D-249 (spec 4.0) restores both as graphical
 * companions to the unified text generator, retaining R8's
 * `banner_spec_version` drift handshake.
 */

export interface BannerStatusEntry {
  label: string;
  status: "ok" | "warn" | "critical";
}

/**
 * Banner spec version emitted by the server (`banner_spec_version` response
 * field) and compared against the version the framework template declares
 * (`Banner-Spec-Version: X.Y`). On mismatch the server logs a BANNER_DRIFT
 * warn diagnostic — visibility only, never blocking. Spec 2.0 was the original
 * HTML banner contract (D-35/D-46); 3.0 was the unified text contract (R8);
 * 4.0 (D-249) restores the graphical banners — boot SVG masthead +
 * finalization HTML widget — atop the unified text generator. Contracts:
 * `_templates/banner-spec.md` and `_templates/finalization-banner-spec.md`.
 */
export const BANNER_SPEC_VERSION = "4.0";

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
 * is fixed by the generator and documented in _templates/banner-spec.md.
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

/**
 * Escape a string for safe interpolation into the graphical banner markup
 * (SVG text nodes and HTML element content). Escapes the five XML/HTML
 * metacharacters; `&` must be replaced first. The render functions only
 * interpolate into element content (never attribute values), but quotes are
 * escaped too for defense in depth. The widget host resolves design-system
 * classes/CSS variables at render time — escaping never touches those.
 */
export function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
 * Grammar (_templates/banner-spec.md, spec 4.0):
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

// --- Boot SVG masthead (brief-447 / D-249, Option M) ---

/** SVG/HTML status-glyph color classes, parallel to STATUS_ICONS. */
const STATUS_COLOR_CLASS: Record<BannerStatusEntry["status"], string> = {
  ok: "c-green",
  warn: "c-amber",
  critical: "c-red",
};

/**
 * Render the boot SVG masthead from server-owned fields only (D-249).
 *
 * Reuses the boot fields of `UnifiedBannerInput` (the same object bootstrap
 * feeds `renderUnifiedBanner`), so the masthead and `banner_text` agree by
 * construction. The variable/narrative tail (Resumption, Next, warnings, the
 * client-side Tool Surface line) is NOT in the masthead — it stays in
 * `banner_text` and renders inline below. Because the masthead carries no
 * client-side data, Claude passes the returned string to `visualize:show_widget`
 * verbatim. Static layout/classes/colors are byte-identical to the approved
 * `_templates/banner-spec.md` target; only the annotated fields interpolate.
 *
 * The status row is laid out left-to-right at y=192 using a proportional
 * x-advance per label; glyph color follows status (c-green/c-amber/c-red). The
 * `Suggested:` line and its divider are omitted (and the viewBox/panel height
 * tightened) when `suggested` is null — mirroring renderUnifiedBanner.
 */
export function renderBootMastheadSvg(data: UnifiedBannerInput): string {
  const esc = escapeMarkup;
  const hasSuggested = data.suggested != null;
  const viewBoxHeight = hasSuggested ? 256 : 232;
  const panelHeight = hasSuggested ? 200 : 176;

  const decisionChipText = `${data.decisionCount} decisions${
    data.decisionNote ? ` · ${data.decisionNote}` : ""
  }`;
  const docsLabel = `${data.docCount}/${data.docTotal} docs healthy`;
  const docsHealthy = data.docCount === data.docTotal;

  const desc =
    `Boot status masthead showing session ${data.sessionNumber}, timestamp, ` +
    `handoff and decision counts, ${data.statusRow.length} status checks` +
    `${hasSuggested ? ", and the suggested session setting" : ""}.`;

  const parts: string[] = [
    `<svg width="100%" viewBox="0 0 680 ${viewBoxHeight}" role="img" xmlns="http://www.w3.org/2000/svg">`,
    `<title>PRISM boot banner masthead</title>`,
    `<desc>${esc(desc)}</desc>`,
    `<rect x="40" y="40" width="600" height="${panelHeight}" rx="12" class="box"/>`,
    `<g class="c-purple"><rect x="65" y="64" width="14" height="14" rx="2" transform="rotate(45 72 71)"/></g>`,
    `<g class="c-purple"><text x="92" y="80" class="th" font-size="24">PRISM</text></g>`,
    `<text x="182" y="80" class="ts" font-size="13">v${esc(data.templateVersion)}</text>`,
    `<g class="c-teal"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>`,
    `<line x1="64" y1="98" x2="616" y2="98" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>`,
    `<text x="64" y="124" class="th" font-size="16">Session ${data.sessionNumber}</text>`,
    `<text x="176" y="124" class="ts" font-size="13">${esc(data.timestamp)} CST</text>`,
    `<rect x="64" y="144" width="150" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>`,
    `<text x="139" y="160" class="ts" text-anchor="middle">Handoff v${data.handoffVersion} · ${esc(data.handoffNote)}</text>`,
    `<rect x="226" y="144" width="190" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>`,
    `<text x="321" y="160" class="ts" text-anchor="middle">${esc(decisionChipText)}</text>`,
  ];

  // Chip 3 (docs): success-green when every doc is healthy, otherwise a
  // neutral chip (white fill + tertiary border) matching chips 1–2.
  if (docsHealthy) {
    parts.push(
      `<g class="c-green"><rect x="428" y="144" width="140" height="24" rx="6"/><text x="498" y="160" class="ts" text-anchor="middle">${esc(docsLabel)}</text></g>`,
    );
  } else {
    parts.push(
      `<rect x="428" y="144" width="140" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>`,
      `<text x="498" y="160" class="ts" text-anchor="middle">${esc(docsLabel)}</text>`,
    );
  }

  // Status glyphs row at y=192. glyph→label offset is a constant 14px; the
  // next glyph advances by a proportional estimate of the label width plus a
  // gap (matches the approved target for the canonical boot status set).
  let glyphX = 64;
  for (const entry of data.statusRow) {
    const labelX = glyphX + 14;
    parts.push(
      `<g class="${STATUS_COLOR_CLASS[entry.status]}"><text x="${glyphX}" y="192" class="th" font-size="13">${STATUS_ICONS[entry.status]}</text></g>`,
      `<text x="${labelX}" y="192" class="ts">${esc(entry.label)}</text>`,
    );
    glyphX = labelX + Math.round(entry.label.length * 5.5 + 24.5);
  }

  if (hasSuggested) {
    parts.push(
      `<line x1="64" y1="208" x2="616" y2="208" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>`,
      `<text x="64" y="228" class="ts">Suggested: ${esc(data.suggested!.display)} — ${esc(data.suggested!.rationale)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

// --- Finalization HTML widget (brief-447 / D-249) ---

/**
 * Input to {@link renderFinalizationBannerHtml}. Distinct from the SVG/text
 * boot fields: the handoff chip shows a from→to version transition, decisions
 * carry a net delta, and phase steps + deliverables come straight from the
 * finalize commit. Optional fields (`decisionDelta`, `next`) drop their
 * segment/line when null/undefined.
 */
export interface FinalizationBannerHtmlInput {
  /** Framework template version (e.g. "2.19.1"); "unknown" when unparseable. */
  templateVersion: string;
  sessionNumber: number;
  /** CST timestamp, "MM-DD-YY HH:MM:SS" (see generateCstTimestamp). */
  timestamp: string;
  /** Outgoing handoff version (the chip's "v{from} →"). */
  handoffFromVersion: number;
  /** New handoff version (the chip's "→ v{to}"). */
  handoffToVersion: number;
  /** Push outcome parenthetical: "pushed" | "push failed" | "unverified". */
  handoffStatus: string;
  decisionCount: number;
  /** Net new decisions this session; omit the "(+N)" segment when null. */
  decisionDelta?: number | null;
  docCount: number;
  docTotal: number;
  /** Phase step row — the actual prism_finalize phases + statuses. */
  statusRow: BannerStatusEntry[];
  /** Deliverable lines — the list wraps natively in HTML. */
  deliverables: string[];
  /** Next-session pointer; the line is omitted when null/empty. */
  next?: string | null;
}

/** Phase-step glyph CSS color variables for the finalization HTML widget. */
const PHASE_COLOR_VAR: Record<BannerStatusEntry["status"], string> = {
  ok: "--color-text-success",
  warn: "--color-text-warning",
  critical: "--color-text-danger",
};

/**
 * Render the rich finalization HTML widget (D-249), rendered via
 * `visualize:show_widget` at session end. Static layout/classes/styles are
 * byte-identical to the approved `_templates/finalization-banner-spec.md`
 * target; only the annotated data interpolates. The variable-length
 * Deliverables list wraps natively — one `▸` row per deliverable (the last row
 * drops its bottom margin to match the target). The self-contained `.brand`/
 * `.mark` `<style>` block is intentionally hardcoded purple + dark `@media`
 * (no host CSS var exists for the brand color); all other colors stay on the
 * `visualize` design-system CSS variables for theming/dark-mode.
 */
export function renderFinalizationBannerHtml(data: FinalizationBannerHtmlInput): string {
  const esc = escapeMarkup;
  const docsAllUpdated = data.docCount === data.docTotal;
  const decisionsText = `${data.decisionCount} decisions${
    data.decisionDelta != null ? ` (+${data.decisionDelta})` : ""
  }`;

  // Docs chip: success-colored when every doc updated, else a neutral chip
  // (matching the two stat chips before it).
  const docsChipStyle = docsAllUpdated
    ? "font-size:12px;color:var(--color-text-success);background:var(--color-background-success);padding:5px 10px;border-radius:var(--border-radius-md);"
    : "font-size:12px;color:var(--color-text-secondary);background:var(--color-background-primary);border:0.5px solid var(--color-border-tertiary);padding:5px 10px;border-radius:var(--border-radius-md);";

  const srOnly =
    `Finalization banner: session ${data.sessionNumber} finalized, handoff ` +
    `${data.handoffStatus}, all ${data.statusRow.length} phases complete, ` +
    `${data.deliverables.length} deliverables shipped.`;

  const lines: string[] = [
    `<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">${esc(srOnly)}</h2>`,
    `<style>.brand{color:#534AB7}.mark{background:#534AB7}@media(prefers-color-scheme:dark){.brand{color:#b3aef0}.mark{background:#b3aef0}}</style>`,
    `<div style="background:var(--color-background-secondary);border:0.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);padding:1.1rem 1.25rem;">`,
    `  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">`,
    `    <div style="display:flex;align-items:center;gap:10px;">`,
    `      <span class="mark" style="display:inline-block;width:13px;height:13px;border-radius:2px;transform:rotate(45deg);"></span>`,
    `      <span class="brand" style="font-size:22px;font-weight:500;letter-spacing:0.5px;">PRISM</span>`,
    `      <span style="font-size:13px;color:var(--color-text-secondary);">v${esc(data.templateVersion)}</span>`,
    `    </div>`,
    `    <span style="font-size:12px;font-weight:500;color:var(--color-text-success);background:var(--color-background-success);padding:4px 12px;border-radius:var(--border-radius-md);">finalized</span>`,
    `  </div>`,
    `  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:12px;">`,
    `    <span style="font-size:16px;font-weight:500;color:var(--color-text-primary);">Session ${data.sessionNumber} finalized</span>`,
    `    <span style="font-size:13px;color:var(--color-text-secondary);">${esc(data.timestamp)} CST</span>`,
    `  </div>`,
    `  <div style="border-top:0.5px solid var(--color-border-tertiary);padding-top:12px;margin-bottom:12px;display:flex;flex-wrap:wrap;gap:8px;">`,
    `    <span style="font-size:12px;color:var(--color-text-secondary);background:var(--color-background-primary);border:0.5px solid var(--color-border-tertiary);padding:5px 10px;border-radius:var(--border-radius-md);">Handoff v${data.handoffFromVersion} → v${data.handoffToVersion} · ${esc(data.handoffStatus)}</span>`,
    `    <span style="font-size:12px;color:var(--color-text-secondary);background:var(--color-background-primary);border:0.5px solid var(--color-border-tertiary);padding:5px 10px;border-radius:var(--border-radius-md);">${esc(decisionsText)}</span>`,
    `    <span style="${docsChipStyle}">${data.docCount}/${data.docTotal} docs updated</span>`,
    `  </div>`,
    `  <div style="display:flex;flex-wrap:wrap;gap:18px;margin-bottom:12px;">`,
  ];

  for (const entry of data.statusRow) {
    lines.push(
      `    <span style="font-size:12px;color:var(--color-text-secondary);"><span style="color:var(${PHASE_COLOR_VAR[entry.status]});font-weight:500;">${STATUS_ICONS[entry.status]}</span> ${esc(entry.label)}</span>`,
    );
  }

  lines.push(
    `  </div>`,
    `  <div style="border-top:0.5px solid var(--color-border-tertiary);padding-top:12px;">`,
    `    <div style="font-size:12px;font-weight:500;color:var(--color-text-secondary);margin-bottom:8px;">Deliverables</div>`,
  );

  data.deliverables.forEach((deliverable, i) => {
    const isLast = i === data.deliverables.length - 1;
    const rowStyle = isLast
      ? "font-size:13px;color:var(--color-text-primary);line-height:1.5;"
      : "font-size:13px;color:var(--color-text-primary);line-height:1.5;margin-bottom:7px;";
    lines.push(
      `    <div style="${rowStyle}"><span class="brand" style="margin-right:8px;">▸</span>${esc(deliverable)}</div>`,
    );
  });

  lines.push(`  </div>`);

  if (data.next != null && data.next.trim() !== "") {
    lines.push(
      `  <div style="margin-top:12px;font-size:12px;color:var(--color-text-tertiary);">Next: ${esc(data.next)}</div>`,
    );
  }

  lines.push(`</div>`);
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
