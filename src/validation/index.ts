/**
 * Validation orchestrator — routes files to the appropriate validators.
 */

import path from "node:path";
import { validateCommon, validateCommitMessage, mergeResults, type ValidationResult } from "./common.js";
import { validateHandoff } from "./handoff.js";
import { validateDecisionIndex } from "./decisions.js";

/**
 * Validate a file's content based on its path.
 * Returns combined errors and warnings from all applicable validators.
 */
export function validateFile(filePath: string, content: string): ValidationResult {
  const results: ValidationResult[] = [];

  // Common validations for all .md files
  if (filePath.endsWith(".md")) {
    results.push(validateCommon(content, filePath));
  }

  // File-specific validations
  const filename = path.basename(filePath);
  const dirname = path.dirname(filePath);

  if (filename === "handoff.md") {
    results.push(validateHandoff(content));
  }

  if (filename === "_INDEX.md" && dirname.endsWith("decisions")) {
    results.push(validateDecisionIndex(content));
  }

  return mergeResults(results);
}

/**
 * Validate a file and its commit message together.
 */
export function validateFileAndCommit(
  filePath: string,
  content: string,
  commitMessage: string
): ValidationResult {
  const results: ValidationResult[] = [
    validateFile(filePath, content),
    validateCommitMessage(commitMessage),
  ];

  return mergeResults(results);
}

// Re-export types and utilities
export type { ValidationResult } from "./common.js";
export { validateCommitMessage } from "./common.js";
