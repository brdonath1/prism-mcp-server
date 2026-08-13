/**
 * Decision index validation rules for decisions/_INDEX.md.
 */

import { parseMarkdownTable, extractSection } from "../utils/summarizer.js";
import type { ValidationResult } from "./common.js";

/**
 * Canonical decision-status enum — the single source of truth for decision
 * status values, shared by the `_INDEX.md` full-file push validator
 * (validateDecisionIndex below) and `prism_log_decision`'s write-time
 * validation (src/tools/log-decision.ts). Legacy `DECIDED` is deliberately
 * absent: the write path historically accepted arbitrary strings while this
 * validator rejected them, which is exactly the drift brief-s204c closes.
 * Do not fork this list — import it.
 */
export const VALID_DECISION_STATUSES: readonly string[] = [
  "SETTLED",
  "PENDING",
  "SUPERSEDED",
  "REVISITED",
  "ACCEPTED",
  "OPEN",
];

/**
 * Normalize a decision status to its canonical uppercase form.
 *
 * Returns the canonical value when the input matches a canonical status
 * case-insensitively (surrounding whitespace ignored), or `null` when it does
 * not. Callers must fail fast on `null` — never substitute a guessed status,
 * since silent mutation would mask caller intent.
 */
export function normalizeDecisionStatus(status: string): string | null {
  const canonical = status.trim().toUpperCase();
  return VALID_DECISION_STATUSES.includes(canonical) ? canonical : null;
}

/**
 * Validate decisions/_INDEX.md structure and content.
 *
 * Real `_INDEX.md` files start with a Domain Files reference table
 * (File/Decisions/Scope) and only then get to the Decision Summary
 * table (ID/Title/Domain/Status/Session). `parseMarkdownTable()` reads
 * every pipe line in the file as a single table, so validating the raw
 * content would pull the Domain Files header row and fail with a
 * spurious "missing required column: ID" error (brief 105). We extract
 * the Decision Summary section first so only the right table is fed
 * into the parser; when the section header is absent (older fixtures
 * or tests that pass a bare table) we fall back to the whole content.
 */
export function validateDecisionIndex(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Must contain a markdown table
  if (!content.includes("|")) {
    errors.push("Decision index must contain a markdown table.");
    return { errors, warnings };
  }

  const decisionSection = extractSection(content, "Decision Summary");
  const tableContent = decisionSection ?? content;
  const rows = parseMarkdownTable(tableContent);

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
      if (status && normalizeDecisionStatus(status) === null) {
        errors.push(
          `Decision status "${status}" is invalid. Must be one of: ${VALID_DECISION_STATUSES.join(", ")}.`
        );
      }
    }
  }

  return { errors, warnings };
}
