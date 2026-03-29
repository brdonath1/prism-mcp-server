/**
 * Server-side boot banner SVG renderer (D-34).
 * Produces a ready-to-render SVG matching the locked banner-spec.md v1.0.
 * Claude passes the output directly to visualize:show_widget — zero drift.
 */

import { logger } from "./logger.js";

export interface BannerData {
  templateVersion: string;
  projectDisplayName: string;
  sessionNumber: number;
  timestamp: string;
  handoffVersion: number;
  handoffSizeKb: string;
  decisionCount: number;
  decisionNote: string;
  docCount: number;
  docTotal: number;
  docHealthy: boolean;
  scalingRequired: boolean;
  resumptionLines: string[];
  nextSteps: string[];
  warnings: string[];
}

// --- Helpers ---

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
 * Wrap text into lines that fit the banner's resumption card width.
 * Strips markdown formatting before wrapping.
 */
export function wrapTextLines(
  text: string,
  maxChars: number = 80,
  maxLines: number = 3
): string[] {
  if (!text.trim()) return [];

  const cleaned = stripMarkdown(text);
  const rawLines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const result: string[] = [];

  for (const line of rawLines) {
    if (result.length >= maxLines) break;

    if (line.length <= maxChars) {
      result.push(line);
    } else {
      const words = line.split(/\s+/);
      let current = "";
      for (const word of words) {
        if (result.length >= maxLines) break;
        const test = current ? `${current} ${word}` : word;
        if (test.length > maxChars && current) {
          result.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current && result.length < maxLines) {
        result.push(current);
      }
    }
  }

  return result;
}

/**
 * Extract the best resumption text for the banner from available sources.
 * Priority: explicit resumption_point > "Resumption point" paragraph in current_state > current_state.
 */
export function parseResumptionForBanner(
  resumptionPoint: string,
  currentState: string,
  maxChars: number = 80,
  maxLines: number = 3
): string[] {
  // Priority 1: explicit resumption point from handoff
  if (resumptionPoint.trim()) {
    return wrapTextLines(resumptionPoint, maxChars, maxLines);
  }

  // Priority 2: look for "Resumption point" paragraph in current state
  const resumptionMatch = currentState.match(
    /\*?\*?Resumption point[^:]*:\*?\*?\s*([\s\S]*?)(?:\n\n|$)/i
  );
  if (resumptionMatch) {
    const lines = wrapTextLines(resumptionMatch[1], maxChars, maxLines);
    if (lines.length > 0) return lines;
  }

  // Priority 3: first meaningful content from current state
  if (currentState.trim()) {
    return wrapTextLines(currentState, maxChars, maxLines);
  }

  return ["No specific resumption point set."];
}

// --- SVG Renderer ---

export function renderBannerSvg(data: BannerData): string {
  // Height calculation per banner-spec.md
  const resumptionLineCount = Math.max(data.resumptionLines.length, 1);
  const resumptionHeight = 12 + resumptionLineCount * 22;
  const nextStepItems =
    data.nextSteps.length > 0 ? data.nextSteps : ["No next steps defined."];
  const nextStepsCount = nextStepItems.length;
  const hasWarnings = data.warnings.length > 0;

  // Y positions — computed dynamically
  const resumptionCardY = 264;
  const nextStepsHeaderY = resumptionCardY + resumptionHeight + 28;
  const nextStepsStartY = nextStepsHeaderY + 24;
  const lastNextStepY = nextStepsStartY + (nextStepsCount - 1) * 24;
  const warningY = lastNextStepY + 28;
  const totalHeight = hasWarnings ? warningY + 36 + 16 : lastNextStepY + 30;

  // Build dynamic SVG fragments
  const resumptionSvg = data.resumptionLines
    .map(
      (line, i) =>
        `  <text x="44" y="${286 + i * 22}" fill="var(--vz-text-primary, #eee)" font-size="12">${escapeXml(line)}</text>`
    )
    .join("\n");

  const nextStepsSvg = nextStepItems
    .map((step, i) => {
      const y = nextStepsStartY + i * 24;
      const fill = i === 0 ? "#22c55e" : "var(--vz-text-primary, #eee)";
      return `  <text x="40" y="${y}" fill="${fill}" font-size="12">\u25b8 ${escapeXml(step)}</text>`;
    })
    .join("\n");

  const scalingItem = data.scalingRequired
    ? `<text x="594" y="211" fill="#eab308" font-size="12" font-weight="500" text-anchor="middle">\u26a0 scaling required</text>`
    : `<text x="594" y="211" fill="#22c55e" font-size="12" font-weight="500" text-anchor="middle">\u2713 no scaling needed</text>`;

  const docHealthSpan = data.docHealthy
    ? `<tspan font-size="12" font-weight="600" fill="#22c55e">healthy</tspan>`
    : `<tspan font-size="12" font-weight="600" fill="#ef4444">issues</tspan>`;

  const warningBarSvg = hasWarnings
    ? `\n  <!-- 7. Warning Bar -->\n  <rect x="24" y="${warningY}" width="652" height="36" rx="8" fill="rgba(234,179,8,0.1)" stroke="rgba(234,179,8,0.3)" stroke-width="1"/>\n  <text x="48" y="${warningY + 23}" fill="#eab308" font-size="12" font-weight="500">\u26a0 ${escapeXml(data.warnings[0])}</text>`
    : "";

  logger.info("banner rendered", {
    totalHeight,
    resumptionLines: data.resumptionLines.length,
    nextSteps: nextStepItems.length,
    hasWarnings,
  });

  return `<svg viewBox="0 0 700 ${totalHeight}" xmlns="http://www.w3.org/2000/svg" style="font-family: system-ui, -apple-system, sans-serif;">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#6366f1"/>
      <stop offset="100%" style="stop-color:#8b5cf6"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="700" height="${totalHeight}" rx="12" fill="var(--vz-bg-secondary, #1e1e2e)" stroke="var(--vz-border, #333)" stroke-width="1"/>

  <!-- 1. Header Bar -->
  <rect width="700" height="64" rx="12" fill="url(#headerGrad)"/>
  <rect y="40" width="700" height="24" fill="url(#headerGrad)"/>
  <text x="24" y="28" fill="white" font-size="11" font-weight="600" letter-spacing="1.5" opacity="0.8">PRISM v${escapeXml(data.templateVersion)}</text>
  <text x="24" y="48" fill="white" font-size="18" font-weight="700">${escapeXml(data.projectDisplayName)} \u2014 Session ${data.sessionNumber}</text>
  <rect x="596" y="16" width="80" height="24" rx="12" fill="rgba(255,255,255,0.2)"/>
  <text x="636" y="33" fill="white" font-size="11" font-weight="600" text-anchor="middle">MCP \u2713</text>

  <!-- 2. Timestamp -->
  <text x="24" y="90" fill="var(--vz-text-secondary, #aaa)" font-size="12">${escapeXml(data.timestamp)} CST</text>

  <!-- 3. Metrics Grid -->
  <rect x="24" y="108" width="155" height="64" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <text x="40" y="131" fill="var(--vz-text-secondary, #aaa)" font-size="10" font-weight="500">SESSION</text>
  <text x="40" y="156" fill="var(--vz-text-primary, #eee)" font-size="22" font-weight="700">${data.sessionNumber}</text>

  <rect x="191" y="108" width="155" height="64" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <text x="207" y="131" fill="var(--vz-text-secondary, #aaa)" font-size="10" font-weight="500">HANDOFF</text>
  <text x="207" y="156" fill="var(--vz-text-primary, #eee)" font-size="22" font-weight="700">v${data.handoffVersion} <tspan font-size="12" font-weight="400" fill="var(--vz-text-secondary, #aaa)">${escapeXml(data.handoffSizeKb)} KB</tspan></text>

  <rect x="358" y="108" width="155" height="64" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <text x="374" y="131" fill="var(--vz-text-secondary, #aaa)" font-size="10" font-weight="500">DECISIONS</text>
  <text x="374" y="156" fill="var(--vz-text-primary, #eee)" font-size="22" font-weight="700">${data.decisionCount} <tspan font-size="11" font-weight="400" fill="var(--vz-text-secondary, #aaa)">(${escapeXml(data.decisionNote)})</tspan></text>

  <rect x="525" y="108" width="155" height="64" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <text x="541" y="131" fill="var(--vz-text-secondary, #aaa)" font-size="10" font-weight="500">LIVING DOCS</text>
  <text x="541" y="156" fill="var(--vz-text-primary, #eee)" font-size="22" font-weight="700">${data.docCount}/${data.docTotal} ${docHealthSpan}</text>

  <!-- 4. Tool Verification Bar (4 equal cells with dividers) -->
  <rect x="24" y="188" width="652" height="36" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)"/>
  <line x1="187" y1="194" x2="187" y2="218" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <line x1="350" y1="194" x2="350" y2="218" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <line x1="513" y1="194" x2="513" y2="218" stroke="var(--vz-border, #444)" stroke-width="0.5"/>
  <text x="105" y="211" fill="#22c55e" font-size="12" font-weight="500" text-anchor="middle">\u2713 bootstrap</text>
  <text x="268" y="211" fill="#22c55e" font-size="12" font-weight="500" text-anchor="middle">\u2713 push verified</text>
  <text x="431" y="211" fill="#22c55e" font-size="12" font-weight="500" text-anchor="middle">\u2713 template loaded</text>
  ${scalingItem}

  <!-- 5. Resumption Point -->
  <text x="24" y="252" fill="var(--vz-text-secondary, #aaa)" font-size="11" font-weight="600" letter-spacing="1">RESUMPTION POINT</text>
  <rect x="24" y="${resumptionCardY}" width="652" height="${resumptionHeight}" rx="8" fill="var(--vz-bg-tertiary, #2a2a3e)"/>
${resumptionSvg}

  <!-- 6. Next Steps -->
  <text x="24" y="${nextStepsHeaderY}" fill="var(--vz-text-secondary, #aaa)" font-size="11" font-weight="600" letter-spacing="1">NEXT STEPS</text>
${nextStepsSvg}
${warningBarSvg}
</svg>`;
}
