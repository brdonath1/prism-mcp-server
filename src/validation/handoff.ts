/**
 * Handoff-specific validation rules for handoff.md.
 */

import { HANDOFF_CRITICAL_SIZE, HANDOFF_WARNING_SIZE } from "../config.js";
import { extractSection, parseNumberedList } from "../utils/summarizer.js";
import type { ValidationResult } from "./common.js";

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
    // Meta must contain required fields
    const requiredFields = ["Handoff Version", "Session Count", "Template Version", "Status"];
    for (const field of requiredFields) {
      if (!meta.includes(field)) {
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
 */
export function parseHandoffVersion(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (!meta) return null;

  const match = meta.match(/Handoff Version[:\s]*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse session count from Meta section.
 */
export function parseSessionCount(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (!meta) return null;

  const match = meta.match(/Session Count[:\s]*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse template version from Meta section.
 */
export function parseTemplateVersion(content: string): string | null {
  const meta = extractSection(content, "Meta");
  if (!meta) return null;

  const match = meta.match(/Template Version[:\s]*([\d.]+)/i);
  return match ? match[1] : null;
}
