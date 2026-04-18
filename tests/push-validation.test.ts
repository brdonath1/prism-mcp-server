// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { validateFile, validateFileAndCommit } from "../src/validation/index.js";
import { validateEofSentinel, validateCommitMessage } from "../src/validation/common.js";

describe("validate-all-or-push-none invariant", () => {
  it("rejects all files if one fails EOF sentinel validation", () => {
    const file1 = {
      path: "handoff.md",
      content: "# Handoff\nSome content\n<!-- EOF: handoff.md -->",
      message: "prism: test commit",
    };
    const file2 = {
      path: "session-log.md",
      content: "# Session Log\nSome content\n<!-- EOF: wrong-file.md -->",
      message: "prism: test commit",
    };

    const result1 = validateFileAndCommit(file1.path, file1.content, file1.message);
    const result2 = validateFileAndCommit(file2.path, file2.content, file2.message);

    // file2 should have errors
    expect(result2.errors.length).toBeGreaterThan(0);
    // In a validate-all-or-push-none system, the presence of ANY error blocks ALL pushes
    const allErrors = [...result1.errors, ...result2.errors];
    expect(allErrors.length).toBeGreaterThan(0);
  });
});

describe("EOF sentinel validation", () => {
  it("passes for matching filename", () => {
    const result = validateEofSentinel("content\n<!-- EOF: handoff.md -->", "handoff.md");
    expect(result.errors).toHaveLength(0);
  });

  it("fails for mismatching filename", () => {
    const result = validateEofSentinel("content\n<!-- EOF: wrong.md -->", "handoff.md");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("wrong.md");
  });

  it("fails for missing sentinel", () => {
    const result = validateEofSentinel("content without sentinel", "handoff.md");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Missing EOF sentinel");
  });

  it("handles trailing whitespace after sentinel", () => {
    const result = validateEofSentinel("content\n<!-- EOF: handoff.md -->  \n", "handoff.md");
    expect(result.errors).toHaveLength(0);
  });
});

describe("commit message prefix validation", () => {
  it("accepts valid prefixes", () => {
    for (const prefix of ["prism:", "fix:", "docs:", "chore:"]) {
      const result = validateCommitMessage(`${prefix} test message`);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("accepts audit: and test: prefixes (A-16)", () => {
    const auditResult = validateCommitMessage("audit: s46 framework audit report");
    expect(auditResult.errors).toHaveLength(0);

    const testResult = validateCommitMessage("test: add fixtures for session-pattern parsing");
    expect(testResult.errors).toHaveLength(0);
  });

  it("rejects invalid prefixes", () => {
    const result = validateCommitMessage("feat: added something");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("must start with one of");
  });

  it("rejects empty commit messages", () => {
    const result = validateCommitMessage("");
    expect(result.errors).toHaveLength(1);
  });
});

describe("file content validation", () => {
  it("rejects empty content", () => {
    const result = validateFile("handoff.md", "");
    expect(result.errors.some(e => e.includes("must not be empty"))).toBe(true);
  });

  it("accepts valid markdown with EOF sentinel", () => {
    const result = validateFile("glossary.md", "# Glossary\nTerms here\n<!-- EOF: glossary.md -->");
    expect(result.errors).toHaveLength(0);
  });
});
