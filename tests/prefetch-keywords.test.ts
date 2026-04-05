// T-2: Prefetch keyword accuracy tests
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { PREFETCH_KEYWORDS } from "../src/config.js";

/** Simulate the determinePrefetchFiles logic from bootstrap.ts */
function determinePrefetchFiles(openingMessage: string): string[] {
  const lower = openingMessage.toLowerCase();
  const filesToFetch = new Set<string>();
  for (const [keyword, file] of Object.entries(PREFETCH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      filesToFetch.add(file);
    }
  }
  // QW-4: Budget cap of 2
  return Array.from(filesToFetch).slice(0, 2);
}

describe("T-2: prefetch keyword accuracy", () => {
  it('"Begin next session" triggers 0 prefetches', () => {
    const files = determinePrefetchFiles("Begin next session");
    expect(files).toHaveLength(0);
  });

  it('"fix the architecture bug" triggers architecture.md and known-issues.md', () => {
    const files = determinePrefetchFiles("fix the architecture bug");
    expect(files).toContain(".prism/architecture.md");
    expect(files).toContain(".prism/known-issues.md");
  });

  it('"review the task queue" triggers task-queue.md', () => {
    const files = determinePrefetchFiles("review the task queue");
    expect(files).toContain(".prism/task-queue.md");
  });

  it("message with 5+ trigger keywords results in max 2 prefetched documents", () => {
    // This message contains: architecture, bug, task, guardrail, insight — 5+ keywords
    const files = determinePrefetchFiles("review the architecture bug task guardrail insight pattern");
    expect(files.length).toBeLessThanOrEqual(2);
  });

  it("generic words (next, plan, session, previous, issue, error) are NOT in keyword map", () => {
    const removedKeywords = ["next", "plan", "session", "previous", "issue", "error"];
    for (const kw of removedKeywords) {
      expect(PREFETCH_KEYWORDS[kw]).toBeUndefined();
    }
  });

  it("specific words (architecture, bug, task, guardrail, glossary) ARE in keyword map", () => {
    const keepKeywords = ["architecture", "bug", "task", "guardrail", "glossary"];
    for (const kw of keepKeywords) {
      expect(PREFETCH_KEYWORDS[kw]).toBeDefined();
    }
  });
});
