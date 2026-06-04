// T-2: Prefetch keyword accuracy tests
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { PREFETCH_KEYWORDS } from "../src/config.js";
// The REAL production function — pre-R7-b this file asserted against a local
// re-implementation, so a production regression (e.g. re-adding the QW-4 cap
// of 2) would not have failed here. Metaswarm review (brief-443) flagged it;
// bootstrap.ts now exports the function so these assertions bind production.
import { determinePrefetchFiles } from "../src/tools/bootstrap.js";

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

  it("message with 5+ trigger keywords prefetches every distinct matched document (QW-4 cap removed, R7-b)", () => {
    // This message contains: architecture, bug, task, guardrail, insight —
    // 4 distinct target documents. Pre-R7-b the QW-4 cap sliced this to 2;
    // D-240 Phase B removes the cap, so all distinct matches prefetch.
    const files = determinePrefetchFiles("review the architecture bug task guardrail insight pattern");
    expect(files).toContain(".prism/architecture.md");
    expect(files).toContain(".prism/known-issues.md");
    expect(files).toContain(".prism/task-queue.md");
    expect(files).toContain(".prism/eliminated.md");
    expect(files).toContain(".prism/insights.md");
    expect(files).toHaveLength(5);
  });

  it("prefetch set is naturally bounded by the distinct documents in PREFETCH_KEYWORDS", () => {
    // Worst case: an opening message containing every keyword cannot fetch
    // more than the number of distinct mapped documents.
    const everyKeyword = Object.keys(PREFETCH_KEYWORDS).join(" ");
    const distinctDocs = new Set(Object.values(PREFETCH_KEYWORDS)).size;
    const files = determinePrefetchFiles(everyKeyword);
    expect(files).toHaveLength(distinctDocs);
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
