/**
 * Handoff-specific validation rules for handoff.md.
 */

import { HANDOFF_CRITICAL_SIZE, HANDOFF_WARNING_SIZE } from "../config.js";
import { extractSection, parseNumberedList } from "../utils/summarizer.js";
import type { ValidationResult } from "./common.js";

/**
 * Strip markdown bold/italic markers from text for reliable regex parsing.
 * Handles **bold**, *italic*, and ***bold-italic***.
 */
function stripBold(text: string): string {
  return text.replace(/\*{1,3}/g, "");
}

/**
 * Validate handoff.md structure and content.
 */
export function validateHandoff(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size checks
  const sizeBytes = new TextEncoder().encode(content).length;
  if (sizeBytes > HANDOFF_CRITICAL_SIZE) {
    warnings.push(
      `Handoff is ${(sizeBytes / 1024).toFixed(1)}KB — exceeds critical threshold of 15KB. Scaling recommended.`
    );
  } else if (sizeBytes > HANDOFF_WARNING_SIZE) {
    warnings.push(
      `Handoff is ${(sizeBytes / 1024).toFixed(1)}KB — approaching critical threshold of 15KB.`
    );
  }

  // Must contain ## Meta section
  const meta = extractSection(content, "Meta");
  if (!meta) {
    errors.push('Handoff must contain a "## Meta" section.');
  } else {
    // Meta must contain required fields (strip bold for matching)
    const cleanMeta = stripBold(meta);
    const requiredFields = ["Handoff Version", "Session Count", "Template Version", "Status"];
    for (const field of requiredFields) {
      if (!cleanMeta.includes(field)) {
        errors.push(`Meta section missing required field: "${field}".`);
      }
    }
  }

  // Must contain ## Critical Context section with at least 1 numbered item
  const criticalContext = extractSection(content, "Critical Context");
  if (!criticalContext) {
    errors.push('Handoff must contain a "## Critical Context" section.');
  } else {
    const items = parseNumberedList(criticalContext);
    if (items.length === 0) {
      errors.push("Critical Context section must contain at least 1 numbered item.");
    }
  }

  // Must contain ## Where We Are section (non-empty)
  const whereWeAre = extractSection(content, "Where We Are");
  if (!whereWeAre) {
    errors.push('Handoff must contain a non-empty "## Where We Are" section.');
  }

  // Must NOT reference session chat or previous conversation as artifact locations
  const antiPatterns = ["session chat", "previous conversation"];
  for (const pattern of antiPatterns) {
    if (content.toLowerCase().includes(pattern)) {
      errors.push(
        `Handoff must not reference "${pattern}" as an artifact location. Artifacts live in GitHub, not in session memory.`
      );
    }
  }

  return { errors, warnings };
}

/**
 * Parse handoff version from Meta section.
 * Handles list format ("Handoff Version: 19"), bold ("**Handoff Version:** 78"),
 * table format ("| Handoff Version | v2 |"), and v-prefix ("Handoff Version: v42").
 * Falls back to searching entire content for blockquote/inline formats.
 */
export function parseHandoffVersion(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    // Handle list format: "Handoff Version: 40" and table format: "| Handoff Version | v2 |"
    const listMatch = clean.match(/Handoff Version[:\s|]*v?(\d+)/i);
    if (listMatch) return parseInt(listMatch[1], 10);
  }

  // Fallback: search entire content for blockquote or inline format
  const fallback = stripBold(content).match(/Handoff Version[:\s|]*v?(\d+)/i);
  return fallback ? parseInt(fallback[1], 10) : null;
}

/**
 * Parse session count from Meta section.
 * Handles list, bold, table, and v-prefix formats.
 * Falls back to searching entire content, then to "Last updated: S{N}" pattern.
 */
export function parseSessionCount(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    const listMatch = clean.match(/Session Count[:\s|]*v?(\d+)/i);
    if (listMatch) return parseInt(listMatch[1], 10);
  }

  // Fallback 1: search entire content
  const fallback1 = stripBold(content).match(/Session Count[:\s|]*v?(\d+)/i);
  if (fallback1) return parseInt(fallback1[1], 10);

  // Fallback 2: "Last updated: S134" pattern
  const fallback2 = content.match(/Last updated[:\s]*S(\d+)/i);
  return fallback2 ? parseInt(fallback2[1], 10) : null;
}

/**
 * Parse template version from Meta section.
 * Handles list, bold, table formats, and "PRISM v2.1.1" prefix.
 * Falls back to searching entire content.
 */
export function parseTemplateVersion(content: string): string | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    const match = clean.match(/Template Version[:\s|]*(?:PRISM\s+)?v?([\d.]+)/i);
    if (match) return match[1];
  }

  const fallback = stripBold(content).match(/Template Version[:\s|]*(?:PRISM\s+)?v?([\d.]+)/i);
  return fallback ? fallback[1] : null;
}
