/**
 * Tests for the pending doc-updates synthesis pipeline (D-156 §3.6 / D-155).
 * Mirrors the shape of intelligence-layer.test.ts: prompt-content tests +
 * user-message-builder tests, plus full pipeline tests for generatePendingDocUpdates
 * with the synthesize/pushFile/recordSynthesisEvent boundaries mocked.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-dummy-anthropic";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/ai/client.js", () => ({
  synthesize: vi.fn(),
}));

vi.mock("../src/github/client.js", () => ({
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocFiles: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/ai/synthesis-tracker.js", () => ({
  recordSynthesisEvent: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  PENDING_DOC_UPDATES_PROMPT,
  buildPendingDocUpdatesUserMessage,
} from "../src/ai/prompts.js";
import { generatePendingDocUpdates } from "../src/ai/synthesize.js";
import { synthesize } from "../src/ai/client.js";
import { pushFile } from "../src/github/client.js";
import { resolveDocFiles, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { recordSynthesisEvent } from "../src/ai/synthesis-tracker.js";

const mockSynthesize = vi.mocked(synthesize);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockRecordSynthesisEvent = vi.mocked(recordSynthesisEvent);

const SAMPLE_OUTPUT = `# Pending Doc Updates — test

> Auto-generated proposals.
> Last synthesized: S99 (04-26-26 12:00:00)

## architecture.md

### Proposed: Add safeMutation primitive section
Body of the proposal.

## glossary.md

### Add term: safeMutation
Definition.

## insights.md

### Re-tier: INS-99 (current Tier B → proposed Tier A) — Repeated relevance
Reason.

## No Updates Needed

(architecture / glossary / insights all have proposals above.)`;

beforeEach(() => {
  vi.clearAllMocks();
  // Default — generatePendingDocUpdates push path always resolves to .prism/pending-doc-updates.md
  mockResolveDocPushPath.mockResolvedValue(".prism/pending-doc-updates.md");
  mockPushFile.mockResolvedValue({ commit_sha: "abc123", path: ".prism/pending-doc-updates.md", size: 1024 });
  mockResolveDocFiles.mockResolvedValue(new Map([
    ["handoff.md", { content: "## Meta\n- Handoff Version: 1\n", sha: "h1", size: 30 }],
    ["session-log.md", { content: "### Session 99\n", sha: "s1", size: 16 }],
  ]));
});

// ---- Prompt content (§5.1 #1) ----

describe("PENDING_DOC_UPDATES_PROMPT", () => {
  it("contains all four required H2 section markers", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## architecture.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## glossary.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## insights.md");
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("## No Updates Needed");
  });

  it("specifies EOF sentinel for the new file", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toContain("<!-- EOF: pending-doc-updates.md -->");
  });

  it("forbids deletion of insights / decisions / glossary terms", () => {
    expect(PENDING_DOC_UPDATES_PROMPT).toMatch(/never propose deletion/i);
  });
});

// ---- User-message builder (§5.1 #2) ----

describe("buildPendingDocUpdatesUserMessage", () => {
  it("produces the expected file-bundle format with project/session/timestamp", () => {
    const docs = new Map([
      ["handoff.md", { content: "Handoff body", size: 50 }],
      ["session-log.md", { content: "Session log", size: 80 }],
    ]);
    const message = buildPendingDocUpdatesUserMessage("prism", 99, "04-26-26 12:00:00", docs);
    expect(message).toContain("Project: prism");
    expect(message).toContain("Session just completed: S99");
    expect(message).toContain("Timestamp: 04-26-26 12:00:00");
    expect(message).toContain("### FILE: handoff.md (50 bytes)");
    expect(message).toContain("Handoff body");
    expect(message).toContain("--- END handoff.md ---");
    expect(message).toContain("### FILE: session-log.md (80 bytes)");
  });
});

// ---- Pipeline tests (§5.1 #3-6) ----

describe("generatePendingDocUpdates", () => {
  it("pushes to .prism/pending-doc-updates.md", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: SAMPLE_OUTPUT,
      input_tokens: 5000,
      output_tokens: 1500,
    });

    const outcome = await generatePendingDocUpdates("test-project", 99);
    expect(outcome.success).toBe(true);
    expect(mockResolveDocPushPath).toHaveBeenCalledWith("test-project", "pending-doc-updates.md");
    const [, pushedPath] = mockPushFile.mock.calls[0];
    expect(pushedPath).toBe(".prism/pending-doc-updates.md");
  });

  it("appends EOF sentinel when the model output omits it", async () => {
    const outputWithoutEof = SAMPLE_OUTPUT;
    mockSynthesize.mockResolvedValue({
      success: true,
      content: outputWithoutEof,
      input_tokens: 5000,
      output_tokens: 1500,
    });

    await generatePendingDocUpdates("test-project", 99);
    const [, , pushedContent, commitMessage] = mockPushFile.mock.calls[0];
    expect(pushedContent).toContain("<!-- EOF: pending-doc-updates.md -->");
    expect(commitMessage).toContain("S99 pending doc updates");
  });

  it("excludes intelligence-brief.md and pending-doc-updates.md from the input bundle", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: SAMPLE_OUTPUT,
      input_tokens: 5000,
      output_tokens: 1500,
    });

    await generatePendingDocUpdates("test-project", 99);
    // First call to resolveDocFiles is the living-doc fetch.
    const docNames = mockResolveDocFiles.mock.calls[0][1] as string[];
    expect(docNames).not.toContain("intelligence-brief.md");
    expect(docNames).not.toContain("pending-doc-updates.md");
    expect(docNames).toContain("handoff.md");
    expect(docNames).toContain("session-log.md");
  });

  it("records a synthesis event with synthesis_kind=pending_updates on success", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: SAMPLE_OUTPUT,
      input_tokens: 5000,
      output_tokens: 1500,
    });

    await generatePendingDocUpdates("test-project", 99);
    expect(mockRecordSynthesisEvent).toHaveBeenCalled();
    const event = mockRecordSynthesisEvent.mock.calls.at(-1)![0];
    expect(event.success).toBe(true);
    expect(event.synthesis_kind).toBe("pending_updates");
  });

  it("records a synthesis event with synthesis_kind=pending_updates on Opus failure", async () => {
    mockSynthesize.mockResolvedValue({
      success: false,
      content: "",
      error: "rate limited",
      error_code: "rate_limit",
    });

    const outcome = await generatePendingDocUpdates("test-project", 99);
    expect(outcome.success).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
    const event = mockRecordSynthesisEvent.mock.calls.at(-1)![0];
    expect(event.success).toBe(false);
    expect(event.synthesis_kind).toBe("pending_updates");
    expect(event.error).toBe("rate limited");
  });

  it("records a synthesis event with synthesis_kind=pending_updates on push failure (catch path)", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: SAMPLE_OUTPUT,
      input_tokens: 5000,
      output_tokens: 1500,
    });
    mockPushFile.mockRejectedValueOnce(new Error("github 502"));

    const outcome = await generatePendingDocUpdates("test-project", 99);
    expect(outcome.success).toBe(false);
    const event = mockRecordSynthesisEvent.mock.calls.at(-1)![0];
    expect(event.success).toBe(false);
    expect(event.synthesis_kind).toBe("pending_updates");
    expect(event.error).toContain("github 502");
  });
});
