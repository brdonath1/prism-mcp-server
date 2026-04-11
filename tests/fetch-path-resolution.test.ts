// brief-104 A.2: path resolution for prism_fetch
//
// Unit tests for shouldResolveDocPath() — the decision function that decides
// whether a caller-supplied file path should be routed through resolveDocPath
// (because it looks like a PRISM living document) or fetched literally.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { shouldResolveDocPath } from "../src/tools/fetch.js";

describe("shouldResolveDocPath (A.2 — bare living-doc resolution)", () => {
  it.each([
    "handoff.md",
    "session-log.md",
    "task-queue.md",
    "eliminated.md",
    "architecture.md",
    "glossary.md",
    "known-issues.md",
    "insights.md",
    "intelligence-brief.md",
    "decisions/_INDEX.md",
  ])("routes bare living-doc %s through resolver", (name) => {
    expect(shouldResolveDocPath(name)).toBe(true);
  });

  it("routes decision domain files (decisions/foo.md) through resolver", () => {
    expect(shouldResolveDocPath("decisions/architecture.md")).toBe(true);
    expect(shouldResolveDocPath("decisions/operations.md")).toBe(true);
  });

  it("passes .prism/-prefixed paths through literally (no resolution)", () => {
    // Callers who already know the resolved path should not be re-routed.
    expect(shouldResolveDocPath(".prism/handoff.md")).toBe(false);
    expect(shouldResolveDocPath(".prism/decisions/_INDEX.md")).toBe(false);
    expect(shouldResolveDocPath(".prism/decisions/architecture.md")).toBe(
      false,
    );
  });

  it("passes arbitrary repo files through literally", () => {
    // Files that aren't PRISM living documents should go straight to fetchFile.
    expect(shouldResolveDocPath("README.md")).toBe(false);
    expect(shouldResolveDocPath("src/index.ts")).toBe(false);
    expect(shouldResolveDocPath("package.json")).toBe(false);
    expect(shouldResolveDocPath("docs/briefs/brief-103.md")).toBe(false);
  });

  it("does not treat non-.md files in decisions/ as living docs", () => {
    // Decisions directory is PRISM-owned for *.md, but a non-markdown file
    // would be an oddity — pass it through literally rather than corrupting
    // the resolution path.
    expect(shouldResolveDocPath("decisions/notes.txt")).toBe(false);
  });
});
