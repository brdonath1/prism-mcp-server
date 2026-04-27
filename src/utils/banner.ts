/**
 * Server-side boot banner HTML renderer (D-35).
 * Produces a ready-to-render HTML+CSS string matching banner-spec.md v2.0.
 * Claude passes the output directly to show_widget — zero drift.
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
  docStatus: "ok" | "warn" | "critical";
  docLabel: string;
  tools: Array<{
    label: string;
    status: "ok" | "warn" | "critical";
  }>;
  resumption: string;
  nextSteps: Array<{
    text: string;
    status: "priority" | "warn" | "normal";
  }>;
  warnings: string[];
  errors: string[];
}

// --- Helpers ---

export function escapeHtml(str: string): string {
  return str
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
 * Format resumption text for HTML display.
 * Converts markdown structure into readable HTML with line breaks,
 * bold section headers, and styled bullet points.
 */
export function formatResumptionHtml(text: string): string {
  const lines = text.split("\n");
  const htmlLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line = paragraph break
      htmlLines.push('<div style="height:8px"></div>');
      continue;
    }

    // Markdown headers (### Header) -> bold text with spacing
    const headerMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      htmlLines.push(`<div style="font-weight:600;margin-top:6px;color:#eee">${escapeHtml(stripMarkdown(headerMatch[1]))}</div>`);
      continue;
    }

    // Bullet items (- text or * text) -> styled bullet
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      // Convert **bold** to <strong> before escaping
      let content = bulletMatch[1];
      // Extract bold segments, escape, then re-wrap
      content = content.replace(/\*\*(.+?)\*\*/g, '%%BOLD_START%%$1%%BOLD_END%%');
      content = escapeHtml(stripMarkdown(content));
      content = content.replace(/%%BOLD_START%%/g, '<strong style="color:#eee">').replace(/%%BOLD_END%%/g, '</strong>');
      htmlLines.push(`<div style="padding-left:12px;margin-top:3px">\u2022 ${content}</div>`);
      continue;
    }

    // Numbered items (1. text) -> keep numbering
    const numberedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      let content = numberedMatch[2];
      content = content.replace(/\*\*(.+?)\*\*/g, '%%BOLD_START%%$1%%BOLD_END%%');
      content = escapeHtml(stripMarkdown(content));
      content = content.replace(/%%BOLD_START%%/g, '<strong style="color:#eee">').replace(/%%BOLD_END%%/g, '</strong>');
      htmlLines.push(`<div style="padding-left:12px;margin-top:3px">${escapeHtml(numberedMatch[1])}. ${content}</div>`);
      continue;
    }

    // Regular text -> escape and render with bold support
    let content = trimmed;
    content = content.replace(/\*\*(.+?)\*\*/g, '%%BOLD_START%%$1%%BOLD_END%%');
    content = escapeHtml(stripMarkdown(content));
    content = content.replace(/%%BOLD_START%%/g, '<strong style="color:#eee">').replace(/%%BOLD_END%%/g, '</strong>');
    htmlLines.push(`<div>${content}</div>`);
  }

  return htmlLines.join("\n");
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
 * Preserves newlines and markdown structure for formatResumptionHtml to render.
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

// --- Text Banner Renderer (ME-1: compact text replaces HTML) ---

export interface BannerTextInput {
  templateVersion: string;
  sessionNumber: number;
  timestamp: string;
  handoffVersion: number;
  handoffSizeKb: string;
  decisionCount: number;
  guardrailCount: number;
  docCount: number;
  docTotal: number;
  tools: Array<{ label: string; status: "ok" | "warn" | "critical" }>;
  resumption: string;
  nextSteps: string[];
  warnings: string[];
}

/**
 * Render a compact text-based boot status (ME-1, S29).
 * Replaces the ~5KB HTML banner with a ~200-byte text block.
 */
export function renderBannerText(data: BannerTextInput): string {
  const toolStatus = data.tools
    .map(t => `${t.status === "ok" ? "\u2713" : t.status === "warn" ? "\u26a0" : "\u2717"} ${t.label}`)
    .join(" | ");

  // Truncate resumption to 200 chars if needed
  const resumption = data.resumption.length > 200
    ? data.resumption.slice(0, 197) + "..."
    : data.resumption;

  const lines: string[] = [
    `PRISM v${data.templateVersion} | Session ${data.sessionNumber} | ${data.timestamp} CST`,
    `Handoff v${data.handoffVersion} (${data.handoffSizeKb}KB) | ${data.decisionCount} decisions (${data.guardrailCount} guardrails) | ${data.docCount}/${data.docTotal} docs healthy`,
    toolStatus,
    "",
    `Resumption: ${stripMarkdown(resumption)}`,
  ];

  if (data.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next:");
    data.nextSteps.forEach((step, i) => {
      lines.push(`${i === 0 ? "\u25b8" : "\u25b8"} ${stripMarkdown(step)}${i === 0 ? " [priority]" : ""}`);
    });
  }

  if (data.warnings.length > 0) {
    lines.push("");
    data.warnings.forEach((w) => {
      lines.push(`\u26a0 ${w}`);
    });
  }

  return lines.join("\n");
}

// --- HTML Renderer ---

/**
 * Map tool status to the appropriate icon character.
 */
export function toolIcon(status: "ok" | "warn" | "critical"): string {
  if (status === "ok") return "\u2713";
  if (status === "warn") return "\u26a0";
  return "\u2717";
}

/**
 * Render the boot banner as a self-contained HTML+CSS string.
 * Follows banner-spec.md v2.0 exactly.
 */
export function renderBannerHtml(data: BannerData): string {
  const e = (s: string) => escapeHtml(stripMarkdown(s));

  // Resumption HTML — uses structured formatter instead of flat text
  const resumptionHtml = formatResumptionHtml(data.resumption);

  // Tools HTML
  const toolsHtml = data.tools
    .map((t, _i) => {
      const cls = t.status !== "ok" ? ` ${t.status}` : "";
      return `<div class="bn-tool${cls}">${toolIcon(t.status)} ${e(t.label)}</div>`;
    })
    .join("\n      ");

  // Next steps HTML — first step is always priority regardless of status field
  const stepsData = data.nextSteps.length > 0
    ? data.nextSteps
    : [{ text: "No next steps defined.", status: "normal" as const }];
  const stepsHtml = stepsData
    .map((step, i) => {
      const cls = i === 0 ? "priority" : step.status !== "normal" ? step.status : "";
      return `<div class="bn-step${cls ? ` ${cls}` : ""}">\u25b8 ${e(step.text)}</div>`;
    })
    .join("\n        ");

  // Warning bars (conditional)
  const warningsHtml = data.warnings
    .map((w) => `<div class="bn-alert warn">\u26a0 ${e(w)}</div>`)
    .join("\n    ");

  // Error bars (conditional)
  const errorsHtml = data.errors
    .map((err) => `<div class="bn-alert critical">\u2717 ${e(err)}</div>`)
    .join("\n    ");

  logger.info("banner HTML rendered", {
    tools: data.tools.length,
    nextSteps: stepsData.length,
    warnings: data.warnings.length,
    errors: data.errors.length,
  });

  return `<style>
:root {
  --bn-bg: #1e1e2e;
  --bn-surface: #2a2a3e;
  --bn-border: #3a3a4e;
  --bn-text: #eee;
  --bn-text-muted: #aaa;
  --bn-accent-start: #6366f1;
  --bn-accent-end: #8b5cf6;
  --bn-ok: #22c55e;
  --bn-warn: #eab308;
  --bn-critical: #ef4444;
  --bn-info: #60a5fa;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
.bn { font-family: system-ui, -apple-system, sans-serif; background: var(--bn-bg); border-radius: 12px; border: 1px solid var(--bn-border); overflow: hidden; color: var(--bn-text); }
.bn-header { background: linear-gradient(90deg, var(--bn-accent-start), var(--bn-accent-end)); padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
.bn-header-text { display: flex; flex-direction: column; gap: 4px; }
.bn-version { font-size: 11px; font-weight: 600; letter-spacing: 1.5px; opacity: 0.8; color: white; }
.bn-title { font-size: 18px; font-weight: 700; color: white; }
.bn-badge { background: rgba(255,255,255,0.2); border-radius: 12px; padding: 4px 14px; font-size: 11px; font-weight: 600; color: white; white-space: nowrap; }
.bn-body { padding: 16px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.bn-timestamp { font-size: 12px; color: var(--bn-text-muted); }
.bn-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.bn-card { background: var(--bn-surface); border: 0.5px solid var(--bn-border); border-radius: 8px; padding: 12px 14px; }
.bn-card-label { font-size: 10px; font-weight: 500; color: var(--bn-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.bn-card-value { font-size: 22px; font-weight: 700; line-height: 1.2; }
.bn-card-sub { font-size: 12px; font-weight: 400; color: var(--bn-text-muted); margin-left: 4px; }
.bn-card-sub.ok { color: var(--bn-ok); font-weight: 600; }
.bn-card-sub.warn { color: var(--bn-warn); font-weight: 600; }
.bn-card-sub.critical { color: var(--bn-critical); font-weight: 600; }
.bn-toolbar { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--bn-surface); border-radius: 8px; overflow: hidden; }
.bn-tool { text-align: center; font-size: 12px; font-weight: 500; padding: 9px 8px; color: var(--bn-ok); border-right: 0.5px solid var(--bn-border); }
.bn-tool:last-child { border-right: none; }
.bn-tool.warn { color: var(--bn-warn); }
.bn-tool.critical { color: var(--bn-critical); }
.bn-section-label { font-size: 11px; font-weight: 600; letter-spacing: 1px; color: var(--bn-text-muted); text-transform: uppercase; margin-bottom: 6px; }
.bn-resumption { background: var(--bn-surface); border-radius: 8px; padding: 14px 18px; font-size: 12px; line-height: 1.7; color: var(--bn-text-muted); }
.bn-steps { display: flex; flex-direction: column; gap: 6px; }
.bn-step { font-size: 12px; line-height: 1.6; color: var(--bn-text); padding-left: 4px; }
.bn-step.priority { color: var(--bn-ok); }
.bn-step.warn { color: var(--bn-warn); }
.bn-alert { display: flex; align-items: flex-start; gap: 10px; border-radius: 8px; padding: 9px 16px; font-size: 12px; font-weight: 500; line-height: 1.5; }
.bn-alert.warn { background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.3); color: var(--bn-warn); }
.bn-alert.critical { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: var(--bn-critical); }
</style>

<div class="bn">
  <div class="bn-header">
    <div class="bn-header-text">
      <div class="bn-version">PRISM v${e(data.templateVersion)}</div>
      <div class="bn-title">${e(data.projectDisplayName)} \u2014 Session ${data.sessionNumber}</div>
    </div>
    <div class="bn-badge">MCP \u2713</div>
  </div>
  <div class="bn-body">
    <div class="bn-timestamp">${e(data.timestamp)} CST</div>
    <div class="bn-metrics">
      <div class="bn-card">
        <div class="bn-card-label">Session</div>
        <div class="bn-card-value">${data.sessionNumber}</div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Handoff</div>
        <div class="bn-card-value">v${data.handoffVersion} <span class="bn-card-sub">${e(data.handoffSizeKb)} KB</span></div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Decisions</div>
        <div class="bn-card-value">${data.decisionCount} <span class="bn-card-sub">(${e(data.decisionNote)})</span></div>
      </div>
      <div class="bn-card">
        <div class="bn-card-label">Living docs</div>
        <div class="bn-card-value">${data.docCount}/${data.docTotal} <span class="bn-card-sub ${data.docStatus}">${e(data.docLabel)}</span></div>
      </div>
    </div>
    <div class="bn-toolbar">
      ${toolsHtml}
    </div>
    <div>
      <div class="bn-section-label">Resumption point</div>
      <div class="bn-resumption">${resumptionHtml}</div>
    </div>
    <div>
      <div class="bn-section-label">Next steps</div>
      <div class="bn-steps">
        ${stepsHtml}
      </div>
    </div>
    ${warningsHtml}
    ${errorsHtml}
  </div>
</div>`;
}
