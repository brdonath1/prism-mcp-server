/**
 * brief-456 / W3-S2 (M-003, SRV-10) — PDU prompt↔parser contract test.
 *
 * The PDU auto-apply pipeline rejected 100% of spec-conformant synthesis
 * output since inception: PENDING_DOC_UPDATES_PROMPT instructed prose
 * bodies while parseProposals demanded `**Apply via prism_patch ...**` /
 * `**Body:**` + fenced blocks, and the three insights housekeeping forms
 * were invisible to the parser entirely (live repro: the S170 boot's
 * PDU_AUTO_APPLY_NOOP skipped all 7 proposals of the S168 batch — "no
 * Apply instruction in proposal body" ×4, "no Body instruction for
 * glossary term" ×3).
 *
 * This test IS the written contract's enforcement: (1) the prompt must
 * elicit exactly the shapes the parser consumes; (2) a document following
 * the prompt's documented format to the letter — mirroring the S168 batch
 * shape (4 section proposals + 3 glossary terms) plus the 3 housekeeping
 * forms — must parse to actionable proposals and round-trip through
 * applyPendingDocUpdates onto the target docs.
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
  isPduEmpty,
  parseProposals,
  PDU_ARCHIVE_DOC,
} from "../src/utils/apply-pdu.js";
import { PENDING_DOC_UPDATES_PROMPT } from "../src/ai/prompts.js";
import { pushFile } from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";

const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);

const FENCE = "```";

/**
 * Golden fixture following PENDING_DOC_UPDATES_PROMPT's documented output
 * format TO THE LETTER. Shape mirrors the S168 batch that the S170 boot
 * skipped in full: 4 architecture proposals + 3 glossary terms — plus the
 * 3 insights housekeeping forms (which the parser previously could not
 * even see).
 */
const CONFORMANT_PDU = [
  "# Pending Doc Updates — test-project",
  "",
  "> Auto-generated proposals. Operator review required before applying via `prism_patch`.",
  "> Last synthesized: S168 (06-09-26 11:00:00 PM CST)",
  "",
  "## architecture.md",
  "",
  "### Proposed: Document the dispatch-state repo split",
  "",
  "Rationale: surfaced when the auto-deploy loop was traced in S167.",
  "",
  "**Apply via `prism_patch append` on `## Claude Code Orchestration`:**",
  `${FENCE}markdown`,
  "Dispatch state persists to brdonath1/prism-dispatch-state so Railway",
  "auto-deploys cannot kill in-flight dispatches.",
  FENCE,
  "",
  "### Proposed: Update the synthesis routing table",
  "",
  "Rationale: Phase 3c-B changed per-call-site routing defaults.",
  "",
  "**Apply via `prism_patch replace` on `## Synthesis Routing`:**",
  `${FENCE}markdown`,
  "CS-1 draft and CS-2 brief route via messages_api; CS-3 pdu may route",
  "via cc_subprocess when SYNTHESIS_PDU_TRANSPORT opts in.",
  FENCE,
  "",
  "### Proposed: Add write-integrity invariants section",
  "",
  "Rationale: brief-456 landed result-checking across the write surface.",
  "",
  "**Apply via `prism_patch append` on `## Reliability`:**",
  `${FENCE}markdown`,
  "Every GitHub write path checks the PushResult before recording success.",
  FENCE,
  "",
  "### Proposed: Preface the observation-gate contract",
  "",
  "Rationale: SYNTHESIS_FAILED joined the boot observation codes.",
  "",
  "**Apply via `prism_patch prepend` on `## Observability`:**",
  `${FENCE}markdown`,
  "Boot-time observation codes: SYNTHESIS_FAILED, SYNTHESIS_TRANSPORT_FALLBACK,",
  "CS3_QUALITY_BYTE_COUNT_WARNING, CS3_QUALITY_PREAMBLE_WARNING.",
  FENCE,
  "",
  "## glossary.md",
  "",
  "### Add term: write-integrity gate",
  "",
  "First surfaced in brief-456 (S168).",
  "",
  "**Body:**",
  `${FENCE}markdown`,
  "| write-integrity gate | Push-result checks across the GitHub write surface | 168 |",
  FENCE,
  "",
  "### Add term: observation gate",
  "",
  "First surfaced in brief-419.",
  "",
  "**Body:**",
  `${FENCE}markdown`,
  "| observation gate | Boot-time Railway log check surfacing synthesis events | 168 |",
  FENCE,
  "",
  "### Add term: draft bridge",
  "",
  "First surfaced in brief-456 (SRV-19).",
  "",
  "**Body:**",
  `${FENCE}markdown`,
  "| draft bridge | Translation of draft contract keys into doc mutations | 168 |",
  FENCE,
  "",
  "## insights.md",
  "",
  "### Re-tier: INS-311 (current Tier B → proposed Tier A) — recurring transient-401 relevance",
  "",
  "### Consolidate: INS-242 + INS-238 — overlapping synthesis-observability guidance",
  "",
  "### Mark dormant: INS-104 — superseded by the D-253 tier system",
  "",
  "## No Updates Needed",
  "",
  "All sections above carry proposals.",
  "",
  "<!-- EOF: pending-doc-updates.md -->",
  "",
].join("\n");

const ARCH_DOC = `# Architecture — test-project

## Claude Code Orchestration

Existing orchestration notes.

## Synthesis Routing

Old routing table.

## Reliability

Existing reliability notes.

## Observability

Existing observability notes.

<!-- EOF: architecture.md -->
`;

const GLOSSARY_DOC = `# Glossary — test-project

| Term | Definition | Session |
|------|------------|---------|
| existing | Existing definition | 50 |

<!-- EOF: glossary.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SRV-10 contract — prompt side elicits exactly what the parser consumes", () => {
  it("instructs the Apply line shape for architecture proposals", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("**Apply via `prism_patch");
    expect(PENDING_DOC_UPDATES_PROMPT).toMatch(/Apply via `prism_patch <?(append|replace|prepend)/);
  });

  it("instructs the **Body:** + single-table-row shape for glossary terms", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("**Body:**");
    expect(PENDING_DOC_UPDATES_PROMPT).toMatch(/table row/i);
  });

  it("instructs fenced blocks for the apply payloads", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("```markdown");
  });

  it("marks insights housekeeping forms as operator-review (surfaced as skipped, never auto-applied)", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("### Re-tier:");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("### Consolidate:");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("### Mark dormant:");
    expect(PENDING_DOC_UPDATES_PROMPT).toMatch(/operator[- ]review/i);
  });

  it("keeps the pre-existing structural contract (four H2 sections, EOF sentinel, no deletions)", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## architecture.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## glossary.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## insights.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## No Updates Needed");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("<!-- EOF: pending-doc-updates.md -->");
    expect(PENDING_DOC_UPDATES_PROMPT).toMatch(/never propose deletion/i);
  });
});

describe("SRV-10 contract — parser side consumes the prompt's documented format", () => {
  it("parses all 7 actionable proposals from the conformant fixture (S168 batch shape)", () => {
    const proposals = parseProposals(CONFORMANT_PDU);
    const actionable = proposals.filter((p) => p.operation !== null);
    expect(actionable).toHaveLength(7);

    const archOps = actionable.filter((p) => p.targetFile === "architecture.md");
    expect(archOps).toHaveLength(4);
    expect(archOps.map((p) => p.operation)).toEqual(["append", "replace", "append", "prepend"]);
    expect(archOps[0].section).toBe("## Claude Code Orchestration");
    expect(archOps[0].content).toContain("prism-dispatch-state");

    const glossaryOps = actionable.filter((p) => p.targetFile === "glossary.md");
    expect(glossaryOps).toHaveLength(3);
    for (const g of glossaryOps) {
      expect(g.operation).toBe("glossary_row");
      expect(g.content).toMatch(/^\|.*\|$/);
    }
  });

  it("surfaces the 3 insights housekeeping forms as visible operator-review skips (not invisible)", () => {
    const proposals = parseProposals(CONFORMANT_PDU);
    const housekeeping = proposals.filter((p) => p.operation === null);
    expect(housekeeping).toHaveLength(3);
    const titles = housekeeping.map((p) => p.title);
    expect(titles.some((t) => t.startsWith("Re-tier:"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Consolidate:"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Mark dormant:"))).toBe(true);
    for (const h of housekeeping) {
      expect(h.unparsedReason).toMatch(/operator review/i);
    }
  });

  it("isPduEmpty treats a housekeeping-only batch as non-empty (accretion fix)", () => {
    const housekeepingOnly = [
      "# Pending Doc Updates — test-project",
      "",
      "> Last synthesized: S168 (06-09-26 11:00:00 PM CST)",
      "",
      "## insights.md",
      "",
      "### Re-tier: INS-311 (current Tier B → proposed Tier A) — rationale",
      "",
      "<!-- EOF: pending-doc-updates.md -->",
    ].join("\n");
    expect(isPduEmpty(housekeepingOnly)).toBe(false);
  });

  it("isPduEmpty still treats the cleared template as empty", () => {
    expect(isPduEmpty("# Pending Doc Updates\n\n## No Updates Needed\n\nNothing.\n")).toBe(true);
  });
});

describe("SRV-10 contract — round trip: the parser APPLIES a conformant batch", () => {
  function setupFetches(): void {
    mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
      if (doc === "pending-doc-updates.md") {
        return { content: CONFORMANT_PDU, sha: "pdu", path: ".prism/pending-doc-updates.md" } as never;
      }
      if (doc === "architecture.md") {
        return { content: ARCH_DOC, sha: "arch", path: ".prism/architecture.md" } as never;
      }
      if (doc === "glossary.md") {
        return { content: GLOSSARY_DOC, sha: "gloss", path: ".prism/glossary.md" } as never;
      }
      throw new Error(`Not found: ${doc}`);
    });
    mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "ok" } as never);
  }

  it("applies all 7 proposals, archives provenance (incl. housekeeping skips), clears the PDU", async () => {
    setupFetches();

    const result = await applyPendingDocUpdates("test-project", 170);

    expect(result.applied).toHaveLength(7);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    for (const s of result.skipped) {
      expect(s.reason).toMatch(/operator review/i);
    }
    expect(result.archived).toBe(true);
    expect(result.cleared).toBe(true);

    const archPush = mockPushFile.mock.calls.find((c) => c[1] === ".prism/architecture.md");
    expect(archPush).toBeDefined();
    const archContent = String(archPush![2]);
    expect(archContent).toContain("prism-dispatch-state");
    expect(archContent).toContain("CS-1 draft and CS-2 brief route via messages_api");
    expect(archContent).toContain("Every GitHub write path checks the PushResult");
    expect(archContent).toContain("Boot-time observation codes: SYNTHESIS_FAILED,");

    const glossaryPush = mockPushFile.mock.calls.find((c) => c[1] === ".prism/glossary.md");
    expect(glossaryPush).toBeDefined();
    const glossaryContent = String(glossaryPush![2]);
    expect(glossaryContent).toContain("| write-integrity gate |");
    expect(glossaryContent).toContain("| observation gate |");
    expect(glossaryContent).toContain("| draft bridge |");

    const archivePush = mockPushFile.mock.calls.find((c) => c[1] === `.prism/${PDU_ARCHIVE_DOC}`);
    expect(archivePush).toBeDefined();
    const archiveContent = String(archivePush![2]);
    expect(archiveContent).toContain("### Applied");
    expect(archiveContent).toContain("- Document the dispatch-state repo split → architecture.md");
    expect(archiveContent).toContain("### Rejected / Skipped");
    expect(archiveContent).toContain("Re-tier: INS-311");

    const pduClearPush = mockPushFile.mock.calls.find(
      (c) => c[1] === ".prism/pending-doc-updates.md",
    );
    expect(pduClearPush).toBeDefined();
    expect(String(pduClearPush![2])).toContain("7 applied, 3 rejected/skipped");
  });
});
