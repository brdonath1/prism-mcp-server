// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { extractDecisionEdges } from "../src/tools/analytics.js";

describe("extractDecisionEdges — directional cross-references", () => {
  const knownIds = new Set(["D-1", "D-2", "D-3", "D-4", "D-5"]);

  it("returns one directed edge for a single cross-reference", () => {
    const content = [
      "### D-2: Plain fetch over Octokit",
      "- Reasoning: Octokit is heavy; see D-1 for the stateless principle.",
      "",
      "### D-1: Stateless server design",
      "- Reasoning: no cross-reference here.",
    ].join("\n");

    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([{ from: "D-2", to: "D-1" }]);
  });

  it("records multiple edges from one section, in source order", () => {
    const content = [
      "### D-3: Validation-first push",
      "- Reasoning: Extends D-1 and D-2 with server-side checks.",
    ].join("\n");

    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([
      { from: "D-3", to: "D-1" },
      { from: "D-3", to: "D-2" },
    ]);
  });

  it("does not count self-references as edges", () => {
    const content = [
      "### D-4: Supersedes D-4's predecessor",
      "- Reasoning: D-4 is self-referential here which must NOT count.",
    ].join("\n");

    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([]);
  });

  it("ignores references to unknown D-N ids", () => {
    const content = [
      "### D-1: Stateless server",
      "- Reasoning: follows from D-99 which no longer exists.",
    ].join("\n");

    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([]);
  });

  it("collapses duplicate references within one section to a single edge", () => {
    const content = [
      "### D-5: Big decision",
      "- Reasoning: depends on D-1 per the rationale.",
      "- Also see: D-1 again, D-1 once more.",
    ].join("\n");

    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([{ from: "D-5", to: "D-1" }]);
  });

  it("handles a fixture with 2 domain files and asserts edge count matches expectation", () => {
    // Simulate 2 domain files combined; the function runs once per file.
    const archFile = [
      "### D-2: Plain fetch over Octokit",
      "- Derives from D-1.",
      "",
      "### D-3: Validation-first push",
      "- Builds on D-1 and D-2.",
    ].join("\n");

    const opsFile = [
      "### D-4: Promise.allSettled parallel",
      "- Complements D-3.",
      "",
      "### D-5: Structured summaries",
      "- Driven by D-2 and D-4.",
    ].join("\n");

    const archEdges = extractDecisionEdges(archFile, knownIds);
    const opsEdges = extractDecisionEdges(opsFile, knownIds);

    expect(archEdges).toEqual([
      { from: "D-2", to: "D-1" },
      { from: "D-3", to: "D-1" },
      { from: "D-3", to: "D-2" },
    ]);
    expect(opsEdges).toEqual([
      { from: "D-4", to: "D-3" },
      { from: "D-5", to: "D-2" },
      { from: "D-5", to: "D-4" },
    ]);

    // 6 directional edges total — no /2 halving.
    expect(archEdges.length + opsEdges.length).toBe(6);
  });

  it("does not count the `### D-N:` header line as a reference to itself", () => {
    // Regression: the header itself contains the ownerId, but we should NOT
    // treat that as a self-reference or an edge.
    const content = "### D-1: Stateless server design\n- Reasoning: no refs.";
    const edges = extractDecisionEdges(content, knownIds);
    expect(edges).toEqual([]);
  });
});
