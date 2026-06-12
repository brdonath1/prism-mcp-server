/**
 * brief-456 / W3-S2 (M-002) — push-failure propagation regression tests.
 *
 * SRV-02: applyPendingDocUpdates must not record proposals as applied (nor
 *         archive false provenance / clear the PDU) when the apply or clear
 *         push returns a result-shaped failure.
 * SRV-15: generateIntelligenceBrief / generatePendingDocUpdates must surface
 *         a failed pushFile as a failed synthesis outcome and a failed
 *         tracker event — never "pushed" on an HTTP-failed push.
 *
 * pushFile returns `{ success: false, error }` for HTTP failures (it throws
 * only for network-level errors), so these tests mock the result shape.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
  resolveDocFiles: vi.fn(),
}));

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/ai/synthesis-tracker.js", () => ({
  recordSynthesisEvent: vi.fn(),
  getRecentSuccessful: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import { applyPendingDocUpdates } from "../src/utils/apply-pdu.js";
import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
} from "../src/ai/synthesize.js";
import { synthesize } from "../src/ai/client.js";
import { pushFile } from "../src/github/client.js";
import {
  resolveDocPath,
  resolveDocPushPath,
  resolveDocFiles,
} from "../src/utils/doc-resolver.js";
import { recordSynthesisEvent } from "../src/ai/synthesis-tracker.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../src/utils/intelligence-brief-spec.js";

const mockSynthesize = vi.mocked(synthesize);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockRecordSynthesisEvent = vi.mocked(recordSynthesisEvent);

const PUSH_FAILURE = {
  success: false as const,
  size: 0,
  sha: "",
  error: "GitHub API forbidden — check PAT scopes. (pushFile test-project/x)",
};

const PUSH_SUCCESS = { success: true as const, size: 100, sha: "pushed-sha" };

/** PDU with two actionable architecture proposals (Apply + fenced block). */
const TWO_PROPOSAL_PDU = `# Pending Doc Updates — test

> Auto-generated proposals.
> Last synthesized: S99 (04-26-26 12:00:00)

## architecture.md

### Proposed: Add mutation primitive section

**Apply via \`prism_patch append\` on \`## Mutation Primitives\`:**
\`\`\`
The safeMutation primitive wraps atomic commits.
\`\`\`

### Proposed: Extend routing notes

**Apply via \`prism_patch append\` on \`## Mutation Primitives\`:**
\`\`\`
Routing is per-call-site.
\`\`\`

## No Updates Needed

<!-- EOF: pending-doc-updates.md -->
`;

const ARCH_CONTENT = `# Architecture — test

## Mutation Primitives

Existing content here.

<!-- EOF: architecture.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SRV-02 — apply-pdu push failures are recorded as failures", () => {
  function setupPduFetches(): void {
    mockResolveDocPath.mockImplementation(async (_slug: string, doc: string) => {
      if (doc === "pending-doc-updates.md") {
        return { content: TWO_PROPOSAL_PDU, sha: "pdu-sha", path: ".prism/pending-doc-updates.md" } as never;
      }
      if (doc === "architecture.md") {
        return { content: ARCH_CONTENT, sha: "arch-sha", path: ".prism/architecture.md" } as never;
      }
      throw new Error(`Not found: ${doc}`);
    });
    mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
  }

  it("apply push {success:false} → proposals land in errors, nothing applied, PDU not archived/cleared", async () => {
    setupPduFetches();
    mockPushFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("architecture.md")) return PUSH_FAILURE as never;
      return PUSH_SUCCESS as never;
    });

    const result = await applyPendingDocUpdates("test-project", 100);

    expect(result.applied).toEqual([]);
    expect(result.errors.length).toBe(2);
    for (const err of result.errors) {
      expect(err.error).toMatch(/push architecture\.md failed/);
      expect(err.error).toMatch(/forbidden/);
    }
    expect(result.archived).toBe(false);
    expect(result.cleared).toBe(false);
    // The PDU file itself must never be overwritten on an errored run.
    const pduWrites = mockPushFile.mock.calls.filter(([, path]) =>
      String(path).includes("pending-doc-updates.md"),
    );
    expect(pduWrites).toEqual([]);
  });

  it("clear push {success:false} → cleared stays false and the failure is visible in errors", async () => {
    setupPduFetches();
    mockPushFile.mockImplementation(async (_repo: string, path: string) => {
      if (path.includes("pending-doc-updates.md") && !path.includes("archive")) {
        return PUSH_FAILURE as never;
      }
      return PUSH_SUCCESS as never;
    });

    const result = await applyPendingDocUpdates("test-project", 100);

    expect(result.applied.length).toBe(2);
    expect(result.archived).toBe(true);
    expect(result.cleared).toBe(false);
    expect(result.errors.some((e) => e.title === "(clear pending-doc-updates.md)")).toBe(true);
  });
});

describe("SRV-15 — background synthesis records failure when the push fails", () => {
  const BRIEF_CONTENT = `# Intelligence Brief — test

> Last synthesized: S26 (06-11-26 09:00:00 AM CST)

${INTELLIGENCE_BRIEF_SPEC_SECTIONS.join("\n\nbody\n\n")}

body

<!-- EOF: intelligence-brief.md -->`;

  const PDU_OUTPUT = `# Pending Doc Updates — test

> Last synthesized: S26 (06-11-26 09:00:00 AM CST)

## architecture.md

No updates needed at this time.

## glossary.md

No updates needed at this time.

## insights.md

No updates needed at this time.

## No Updates Needed

All quiet.

<!-- EOF: pending-doc-updates.md -->`;

  beforeEach(() => {
    mockResolveDocFiles.mockResolvedValue(
      new Map([
        ["handoff.md", { content: "## Meta\n", sha: "h1", size: 10 }],
        ["session-log.md", { content: "### Session 26\n", sha: "s1", size: 16 }],
      ]) as never,
    );
    mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
  });

  it("generateIntelligenceBrief: pushFile {success:false} → outcome.success false + failed tracker event", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: BRIEF_CONTENT,
      input_tokens: 1000,
      output_tokens: 500,
      model: "test-model",
      transport: "messages_api",
    } as never);
    mockPushFile.mockResolvedValue(PUSH_FAILURE as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/push/i);
    expect(mockRecordSynthesisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(mockRecordSynthesisEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("generatePendingDocUpdates: pushFile {success:false} → outcome.success false + failed tracker event", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: PDU_OUTPUT,
      input_tokens: 900,
      output_tokens: 400,
      model: "test-model",
      transport: "messages_api",
    } as never);
    mockPushFile.mockResolvedValue(PUSH_FAILURE as never);

    const outcome = await generatePendingDocUpdates("test-project", 26);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/push/i);
    expect(mockRecordSynthesisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, synthesis_kind: "pending_updates" }),
    );
    expect(mockRecordSynthesisEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
