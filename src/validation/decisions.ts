/**
 * Decision index validation rules for decisions/_INDEX.md.
 */

import { parseMarkdownTable } from "../utils/summarizer.js";
import type { ValidationResult } from "./common.js";

/** Valid decision statuses */
const VALID_STATUSES = ["SETTLED", "PENDING", "SUPERSEDED", "REVISITED", "ACCEPTED", "OPEN"];

/**
 * Validate decisions/_INDEX.md structure and content.
 */
export function validateDecisionIndex(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must contain a markdown table
  if (!content.includes("|")) {
    errors.push("Decision index must contain a markdown table.");
    return { errors, warnings };
  }

  const rows = parseMarkdownTable(content);

  if (rows.length === 0) {
    warnings.push("Decision index table has no data rows.");
    return { errors, warnings };
  }

  // Validate required columns exist (check first row)
  const requiredColumns = ["ID", "Title", "Domain", "Status", "Session"];
  const firstRow = rows[0];
  const presentColumns = Object.keys(firstRow);

  for (const col of requiredColumns) {
    if (!presentColumns.some(c => c.toLowerCase() === col.toLowerCase())) {
      errors.push(`Decision index table missing required column: "${col}".`);
    }
  }

  // Validate each row
  const seenIds = new Set<string>();

  for (const row of rows) {
    // Find ID column (case-insensitive)
    const idKey = presentColumns.find(c => c.toLowerCase() === "id");
    const statusKey = presentColumns.find(c => c.toLowerCase() === "status");

    if (idKey) {
      const id = row[idKey];

      // ID must be D-N format
      if (id && !/^D-\d+$/.test(id)) {
        errors.push(`Decision ID "${id}" must follow D-N format (e.g., D-1, D-42).`);
      }

      // No duplicate IDs
      if (id && seenIds.has(id)) {
        errors.push(`Duplicate decision ID: "${id}".`);
      }
      if (id) seenIds.add(id);
    }

    if (statusKey) {
      const status = row[statusKey];
      if (status && !VALID_STATUSES.includes(status.toUpperCase())) {
        errors.push(
          `Decision status "${status}" is invalid. Must be one of: ${VALID_STATUSES.join(", ")}.`
        );
      }
    }
  }

  return { errors, warnings };
}
