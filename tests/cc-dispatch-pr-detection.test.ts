// Phase 0a + INS-174: Tests for detectAgentCreatedPr helper in cc-dispatch.ts
//
// The helper scans agent output text for GitHub PR URLs constrained to the
// dispatched repo, enabling the wrapper to detect PRs that CC created
// autonomously (bypassing the wrapper's own commit/push/PR path).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "sk-ant-oat01-test-dummy";

import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies that cc-dispatch.ts imports at module level so we
// can import the helper without pulling in the Agent SDK or git plumbing.
vi.mock("../src/claude-code/client.js", () => ({
  dispatchTask: vi.fn(),
}));
vi.mock("../src/claude-code/repo.js", () => ({
  cloneRepo: vi.fn(),
  commitAndPushBranch: vi.fn(),
}));
vi.mock("../src/dispatch-store.js", () => ({
  writeDispatchRecord: vi.fn().mockResolvedValue(undefined),
  readDispatchRecord: vi.fn().mockResolvedValue(null),
  listDispatchIds: vi.fn().mockResolvedValue([]),
  hydrateStore: vi.fn().mockResolvedValue(undefined),
}));

import { detectAgentCreatedPr } from "../src/tools/cc-dispatch.js";

describe("detectAgentCreatedPr — single PR URL", () => {
  it("returns the URL when a single matching PR URL is in the text", () => {
    const text =
      "I created the PR at https://github.com/brdonath1/prism-mcp-server/pull/42 for your review.";
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/42",
    );
  });

  it("returns null when no PR URLs are present", () => {
    const text = "All tasks completed successfully. No PR was needed.";
    expect(
      detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server"),
    ).toBeNull();
  });

  it("returns null for empty or falsy input", () => {
    expect(detectAgentCreatedPr("", "brdonath1", "repo")).toBeNull();
  });
});

describe("detectAgentCreatedPr — repo scoping", () => {
  it("returns null when PR URLs are from a different repo", () => {
    const text =
      "See https://github.com/brdonath1/platformforge-v2/pull/15 for context.";
    expect(
      detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server"),
    ).toBeNull();
  });

  it("returns null when PR URLs are from a different owner", () => {
    const text =
      "Referenced https://github.com/other-user/prism-mcp-server/pull/99 in the code.";
    expect(
      detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server"),
    ).toBeNull();
  });

  it("matches only the target repo when multiple repos are mentioned", () => {
    const text = [
      "I looked at https://github.com/brdonath1/platformforge-v2/pull/5 for reference.",
      "Then I opened https://github.com/brdonath1/prism-mcp-server/pull/88 with the fix.",
    ].join("\n");
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/88",
    );
  });
});

describe("detectAgentCreatedPr — multiple PRs from same repo", () => {
  it("returns the highest PR number when multiple distinct PRs are present", () => {
    const text = [
      "I referenced https://github.com/brdonath1/prism-mcp-server/pull/10 (old).",
      "The new PR is https://github.com/brdonath1/prism-mcp-server/pull/42.",
    ].join("\n");
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/42",
    );
  });

  it("deduplicates repeated mentions of the same PR URL", () => {
    const text = [
      "Created https://github.com/brdonath1/prism-mcp-server/pull/7.",
      "You can review https://github.com/brdonath1/prism-mcp-server/pull/7 at your convenience.",
    ].join("\n");
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/7",
    );
  });
});

describe("detectAgentCreatedPr — trailing punctuation", () => {
  it("handles a URL followed by a period", () => {
    const text =
      "Done. PR: https://github.com/brdonath1/prism-mcp-server/pull/99.";
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/99",
    );
  });

  it("handles a URL followed by a comma", () => {
    const text =
      "See https://github.com/brdonath1/prism-mcp-server/pull/55, which fixes the bug.";
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/55",
    );
  });

  it("handles a URL inside parentheses", () => {
    const text =
      "Fix applied (https://github.com/brdonath1/prism-mcp-server/pull/12)";
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/12",
    );
  });

  it("handles a URL followed by a newline", () => {
    const text =
      "PR link:\nhttps://github.com/brdonath1/prism-mcp-server/pull/33\nDone.";
    const result = detectAgentCreatedPr(text, "brdonath1", "prism-mcp-server");
    expect(result).toBe(
      "https://github.com/brdonath1/prism-mcp-server/pull/33",
    );
  });
});
