// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { validateDecisionIndex } from "../src/validation/decisions.js";
import { validateEofSentinel, validateCommitMessage } from "../src/validation/common.js";
import { validateProjectSlug, validateFilePath } from "../src/validation/slug.js";

describe("validateDecisionIndex with all statuses", () => {
  const makeTable = (status: string) =>
    `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | Test decision | architecture | ${status} | S1 |
<!-- EOF: _INDEX.md -->`;

  it("accepts SETTLED status", () => {
    const result = validateDecisionIndex(makeTable("SETTLED"));
    expect(result.errors).toHaveLength(0);
  });

  it("accepts PENDING status", () => {
    const result = validateDecisionIndex(makeTable("PENDING"));
    expect(result.errors).toHaveLength(0);
  });

  it("accepts SUPERSEDED status", () => {
    const result = validateDecisionIndex(makeTable("SUPERSEDED"));
    expect(result.errors).toHaveLength(0);
  });

  it("accepts REVISITED status", () => {
    const result = validateDecisionIndex(makeTable("REVISITED"));
    expect(result.errors).toHaveLength(0);
  });

  it("accepts ACCEPTED status (B.6)", () => {
    const result = validateDecisionIndex(makeTable("ACCEPTED"));
    expect(result.errors).toHaveLength(0);
  });

  it("accepts OPEN status (B.6)", () => {
    const result = validateDecisionIndex(makeTable("OPEN"));
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid status", () => {
    const result = validateDecisionIndex(makeTable("INVALID"));
    expect(result.errors.some(e => e.includes("invalid"))).toBe(true);
  });

  it("detects duplicate IDs", () => {
    const table = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | First | architecture | SETTLED | S1 |
| D-1 | Duplicate | operations | PENDING | S2 |
<!-- EOF: _INDEX.md -->`;
    const result = validateDecisionIndex(table);
    expect(result.errors.some(e => e.includes("Duplicate"))).toBe(true);
  });

  it("validates D-N format", () => {
    const table = `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| X-1 | Bad format | architecture | SETTLED | S1 |
<!-- EOF: _INDEX.md -->`;
    const result = validateDecisionIndex(table);
    expect(result.errors.some(e => e.includes("D-N format"))).toBe(true);
  });
});

describe("validateEofSentinel", () => {
  it("passes for correct sentinel", () => {
    const result = validateEofSentinel("content\n<!-- EOF: test.md -->", "test.md");
    expect(result.errors).toHaveLength(0);
  });

  it("fails for mismatching filename in sentinel", () => {
    const result = validateEofSentinel("content\n<!-- EOF: other.md -->", "test.md");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("other.md");
    expect(result.errors[0]).toContain("test.md");
  });

  it("fails for missing sentinel", () => {
    const result = validateEofSentinel("content without any sentinel", "test.md");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Missing");
  });
});

describe("validateCommitMessage", () => {
  it("accepts all valid prefixes", () => {
    const valid = ["prism: finalize", "fix: bug", "docs: update", "chore: cleanup"];
    for (const msg of valid) {
      const result = validateCommitMessage(msg);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("rejects feat: prefix", () => {
    const result = validateCommitMessage("feat: new feature");
    expect(result.errors).toHaveLength(1);
  });

  it("rejects empty string", () => {
    const result = validateCommitMessage("");
    expect(result.errors).toHaveLength(1);
  });

  it("rejects messages starting with uppercase prefix", () => {
    const result = validateCommitMessage("Prism: finalize");
    expect(result.errors).toHaveLength(1);
  });
});

describe("validateProjectSlug", () => {
  it("accepts valid slugs", () => {
    const valid = ["prism", "prism-mcp-server", "platformforge-v2", "OpenClaw", "test_project"];
    for (const slug of valid) {
      const result = validateProjectSlug(slug);
      expect(result.valid).toBe(true);
    }
  });

  it("rejects empty slug", () => {
    const result = validateProjectSlug("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rejects slug exceeding max length", () => {
    const result = validateProjectSlug("a".repeat(101));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds");
  });

  it("rejects slugs with special characters", () => {
    const invalid = ["project@name", "project name", "project/name", "../evil"];
    for (const slug of invalid) {
      const result = validateProjectSlug(slug);
      expect(result.valid).toBe(false);
    }
  });

  it("rejects slugs starting with hyphen", () => {
    const result = validateProjectSlug("-invalid");
    expect(result.valid).toBe(false);
  });
});

describe("validateFilePath", () => {
  it("accepts valid relative paths", () => {
    const valid = ["handoff.md", "decisions/_INDEX.md", "src/index.ts"];
    for (const path of valid) {
      const result = validateFilePath(path);
      expect(result.valid).toBe(true);
    }
  });

  it("rejects empty path", () => {
    const result = validateFilePath("");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("rejects path traversal attempts", () => {
    const result = validateFilePath("../../../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("..");
  });

  it("rejects absolute paths", () => {
    const result = validateFilePath("/etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("relative");
  });
});
