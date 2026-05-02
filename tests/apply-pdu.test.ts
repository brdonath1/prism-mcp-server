/**
 * Tests for src/utils/apply-pdu.ts (brief-422 Piece 1).
 *
 * Pure-function tests for the parser run without mocks; the apply-pipeline
 * tests mock the GitHub client and doc-resolver boundaries to keep the
 * tests hermetic.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

import {
  applyPendingDocUpdates,
  insertGlossaryRow,
  isPduEmpty,
  parseLastSynthesizedSession,
  parseProposals,
  buildClearedPdu,
} from "../src/utils/apply-pdu.js";
import { fetchFile, pushFile } from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);

const STRUCTURED_PDU = `# Pending Doc Updates — test

> Auto-generated proposals.
> Last synthesized: S99 (04-26-26 12:00:00)

## architecture.md

### Proposed: Add safeMutation primitive section
The S62 audit produced a primitive — document the boundaries.

**Apply via \`prism_patch append\` on \`## Mutation Primitives\`:**
\`\`\`
The safeMutation primitive wraps atomic Git Trees commits with HEAD-snapshot
comparison and per-conflict retry.
\`\`\`

### Proposed: Update Synthesis Routing diagram
Phase 3c adjusted the per-call-site routing.

**Apply via \`prism_patch replace\` on \`### Synthesis Per-Call-Site Routing\`:**
\`\`\`
CS-3 routes via Sonnet 4.6 + cc_subprocess when SYNTHESIS_PDU_TRANSPORT=cc_subprocess.
\`\`\`

## glossary.md

### Add term: safeMutation
First surfaced in D-181.

**Body:**
\`\`\`
| safeMutation | Atomic-only multi-file mutation primitive (D-181) | 99 |
\`\`\`

## insights.md

### Re-tier: INS-99 (current Tier B → proposed Tier A) — Repeated relevance

## No Updates Needed

(architecture / glossary / insights all have proposals above.)

<!-- EOF: pending-doc-updates.md -->
`;

const ARCH_BEFORE = `# Architecture — test

> Updated: S98 (2026-04-25)

## Mutation Primitives

Existing content here.

<!-- EOF: architecture.md -->
`;

// Two independent target sections (sibling H2s) so the append on Mutation
// Primitives does not clobber the body of the replace target.
const ARCH_WITH_REPLACE_TARGET = `# Architecture — test

> Updated: S98 (2026-04-25)

## Mutation Primitives

Existing content here.

## Synthesis

### Synthesis Per-Call-Site Routing

Old routing description.

<!-- EOF: architecture.md -->
`;

const GLOSSARY_BEFORE = `# Glossary

| Term | Definition | Session |
|------|------------|---------|
| existing | Existing definition | 50 |

<!-- EOF: glossary.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDocPushPath.mockImplementation(async (_slug, doc) => `.prism/${doc}`);
  mockPushFile.mockResolvedValue({ success: true, sha: "new-sha", size: 100 });
});

// ---- Pure-function parser tests ----

describe("parseLastSynthesizedSession", () => {
  it("extracts session number from `> Last synthesized: S<N>` line", () => {
    expect(parseLastSynthesizedSession(STRUCTURED_PDU)).toBe(99);
  });

  it("returns null when the line is absent", () => {
    expect(parseLastSynthesizedSession("# No metadata\n\n## architecture.md\n")).toBeNull();
  });
});

describe("isPduEmpty", () => {
  it("returns true for cleared / no-proposals PDU", () => {
    const cleared = buildClearedPdu("test", "S99 (date)", 100, "2026-05-02");
    expect(isPduEmpty(cleared)).toBe(true);
  });

  it("returns false when at least one `### Proposed:` exists", () => {
    expect(isPduEmpty(STRUCTURED_PDU)).toBe(false);
  });

  it("returns false when at least one `### Add term:` exists (glossary-only PDU)", () => {
    const glossaryOnly = `# PDU\n\n## glossary.md\n\n### Add term: foo\n\n**Body:**\n\`\`\`\n| foo | bar | 1 |\n\`\`\`\n`;
    expect(isPduEmpty(glossaryOnly)).toBe(false);
  });
});

describe("parseProposals", () => {
  it("parses architecture proposals with append/replace operations", () => {
    const proposals = parseProposals(STRUCTURED_PDU);
    const archProposals = proposals.filter(p => p.targetFile === "architecture.md");
    expect(archProposals).toHaveLength(2);
    expect(archProposals[0].operation).toBe("append");
    expect(archProposals[0].section).toBe("## Mutation Primitives");
    expect(archProposals[0].content).toContain("safeMutation primitive");
    expect(archProposals[1].operation).toBe("replace");
    expect(archProposals[1].section).toBe("### Synthesis Per-Call-Site Routing");
  });

  it("parses glossary proposals as glossary_row operations with table-row content", () => {
    const proposals = parseProposals(STRUCTURED_PDU);
    const glossaryProposals = proposals.filter(p => p.targetFile === "glossary.md");
    expect(glossaryProposals).toHaveLength(1);
    expect(glossaryProposals[0].operation).toBe("glossary_row");
    expect(glossaryProposals[0].content).toMatch(/^\|\s*safeMutation\s*\|/);
  });

  it("ignores insights re-tier subsections (only `### Proposed:` / `### Add term:` are picked up)", () => {
    const proposals = parseProposals(STRUCTURED_PDU);
    const insightsProposals = proposals.filter(p => p.targetFile === "insights.md");
    // The brief's parser only recognizes `### Proposed:` and `### Add term:`.
    // Insights housekeeping forms (`### Re-tier:`, `### Consolidate:`,
    // `### Mark dormant:`) are operator decisions that do not have a
    // mechanical apply path — they are left for human review.
    expect(insightsProposals).toHaveLength(0);
  });

  it("ignores `## No Updates Needed` and other non-target ## headings", () => {
    const proposals = parseProposals(STRUCTURED_PDU);
    expect(proposals.every(p => ["architecture.md", "glossary.md", "insights.md"].includes(p.targetFile))).toBe(true);
  });
});

describe("insertGlossaryRow", () => {
  it("inserts a row immediately above the EOF sentinel", () => {
    const result = insertGlossaryRow(GLOSSARY_BEFORE, "| new | new def | 99 |");
    expect(result).toContain("| existing | Existing definition | 50 |");
    expect(result).toContain("| new | new def | 99 |");
    const eofIdx = result.indexOf("<!-- EOF: glossary.md -->");
    const rowIdx = result.indexOf("| new | new def | 99 |");
    expect(rowIdx).toBeLessThan(eofIdx);
    expect(rowIdx).toBeGreaterThan(result.indexOf("| existing"));
  });

  it("throws when the EOF sentinel is missing", () => {
    expect(() => insertGlossaryRow("# glossary\n", "| foo | bar | 1 |")).toThrow(/EOF sentinel/);
  });
});

// ---- Apply-pipeline tests ----

describe("applyPendingDocUpdates — pipeline", () => {
  function setupFetchByPath(map: Record<string, string>): void {
    mockResolveDocPath.mockImplementation(async (_slug, doc) => {
      const content = map[doc];
      if (content === undefined) {
        throw new Error(`Not found: fetchFile test/${doc}`);
      }
      return { path: `.prism/${doc}`, content, sha: "sha-" + doc, legacy: false };
    });
  }

  it("applies append/replace to architecture.md, table-row to glossary.md, then clears the PDU", async () => {
    setupFetchByPath({
      "pending-doc-updates.md": STRUCTURED_PDU,
      "architecture.md": ARCH_WITH_REPLACE_TARGET,
      "glossary.md": GLOSSARY_BEFORE,
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.applied).toContain("Add safeMutation primitive section");
    expect(result.applied).toContain("Update Synthesis Routing diagram");
    expect(result.applied).toContain("safeMutation");
    expect(result.errors).toEqual([]);
    expect(result.cleared).toBe(true);

    // architecture.md should have one push, glossary.md one push, PDU one push.
    const pushedPaths = mockPushFile.mock.calls.map(c => c[1]);
    expect(pushedPaths).toContain(".prism/architecture.md");
    expect(pushedPaths).toContain(".prism/glossary.md");
    expect(pushedPaths).toContain(".prism/pending-doc-updates.md");

    // The architecture.md push should contain the appended content.
    const archPush = mockPushFile.mock.calls.find(c => c[1] === ".prism/architecture.md");
    expect(archPush?.[2]).toContain("safeMutation primitive wraps atomic Git Trees");

    // The glossary.md push should contain the new row above EOF.
    const glossaryPush = mockPushFile.mock.calls.find(c => c[1] === ".prism/glossary.md");
    expect(glossaryPush?.[2]).toContain("| safeMutation | Atomic-only multi-file mutation primitive");

    // The cleared PDU should reference the apply session.
    const pduPush = mockPushFile.mock.calls.find(c => c[1] === ".prism/pending-doc-updates.md");
    expect(pduPush?.[2]).toContain("Last applied: S100");
  });

  it("returns empty result when the PDU file is missing (not found)", async () => {
    mockResolveDocPath.mockRejectedValue(new Error("Not found: fetchFile test/.prism/pending-doc-updates.md"));
    const result = await applyPendingDocUpdates("test", 100);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.cleared).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("returns empty result when the PDU file is the cleared template (no proposals)", async () => {
    setupFetchByPath({
      "pending-doc-updates.md": buildClearedPdu("test", "S99", 99, "2026-04-26"),
    });
    const result = await applyPendingDocUpdates("test", 100);
    expect(result.applied).toEqual([]);
    expect(result.cleared).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("skips proposals whose target section does not exist in the file", async () => {
    setupFetchByPath({
      "pending-doc-updates.md": STRUCTURED_PDU,
      "architecture.md": ARCH_BEFORE,                  // No `### Synthesis Per-Call-Site Routing` section
      "glossary.md": GLOSSARY_BEFORE,
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.applied).toContain("Add safeMutation primitive section");
    expect(result.applied).toContain("safeMutation");
    expect(result.skipped.some(s => s.title === "Update Synthesis Routing diagram")).toBe(true);
    // PDU should still be cleared since no errors occurred (skipped is not error).
    expect(result.cleared).toBe(true);
  });

  it("does NOT clear the PDU file when any apply errors occurred (so operator can re-run)", async () => {
    setupFetchByPath({
      "pending-doc-updates.md": STRUCTURED_PDU,
      "architecture.md": ARCH_WITH_REPLACE_TARGET,
      "glossary.md": GLOSSARY_BEFORE,
    });
    // First architecture.md push succeeds; second push (glossary) errors.
    mockPushFile.mockImplementation(async (_repo, path) => {
      if (path === ".prism/glossary.md") throw new Error("github 502");
      return { success: true, sha: "ok", size: 100 };
    });

    const result = await applyPendingDocUpdates("test", 100);

    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.cleared).toBe(false);
    // No PDU clear push happened.
    const clearAttempt = mockPushFile.mock.calls.find(c => c[1] === ".prism/pending-doc-updates.md");
    expect(clearAttempt).toBeUndefined();
  });
});
