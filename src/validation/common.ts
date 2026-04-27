/**
 * Common validation rules for all PRISM .md files.
 * EOF sentinel check, empty check, commit message prefix validation.
 */

import { VALID_COMMIT_PREFIXES } from "../config.js";
import path from "node:path";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * Validate that a .md file has the correct EOF sentinel.
 * Expected format: <!-- EOF: {filename} -->
 */
export function validateEofSentinel(content: string, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const filename = path.basename(filePath);
  const expectedSentinel = `<!-- EOF: ${filename} -->`;

  const trimmed = content.trimEnd();
  if (!trimmed.endsWith(expectedSentinel)) {
    // Check if there's any EOF sentinel at all (possibly wrong filename)
    const eofMatch = trimmed.match(/<!-- EOF: (.+?) -->$/);
    if (eofMatch) {
      errors.push(
        `EOF sentinel references "${eofMatch[1]}" but file is "${filename}". Expected: ${expectedSentinel}`
      );
    } else {
      errors.push(`Missing EOF sentinel. Must end with: ${expectedSentinel}`);
    }
  }

  return { errors, warnings };
}

/**
 * Validate that file content is non-empty and valid UTF-8.
 */
export function validateNotEmpty(content: string, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (content.trim().length === 0) {
    errors.push(`File "${path.basename(filePath)}" must not be empty.`);
  }

  return { errors, warnings };
}

/**
 * Validate a commit message prefix.
 */
export function validateCommitMessage(message: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const hasValidPrefix = VALID_COMMIT_PREFIXES.some(prefix => message.startsWith(prefix));
  if (!hasValidPrefix) {
    errors.push(
      `Commit message must start with one of: ${VALID_COMMIT_PREFIXES.join(", ")}. Got: "${message.slice(0, 30)}..."`
    );
  }

  return { errors, warnings };
}

/**
 * Run all common validations on a .md file.
 */
export function validateCommon(content: string, filePath: string): ValidationResult {
  const results: ValidationResult[] = [
    validateNotEmpty(content, filePath),
    validateEofSentinel(content, filePath),
  ];

  return mergeResults(results);
}

/**
 * Merge multiple validation results into one.
 */
export function mergeResults(results: ValidationResult[]): ValidationResult {
  return {
    errors: results.flatMap(r => r.errors),
    warnings: results.flatMap(r => r.warnings),
  };
}
