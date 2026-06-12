/**
 * brief-456 / W3-S2 (M-004) — synthesis output guards + failure visibility
 * at the generateIntelligenceBrief / generatePendingDocUpdates level.
 *
 * SRV-07: a refused synthesis must never overwrite intelligence-brief.md; a
 *         max_tokens-truncated brief that is missing required sections must
 *         not be pushed over a good brief.
 * SRV-52: the `> Last synthesized: S{N} ({timestamp})` header is server-
 *         stamped before push — model omission/reformat cannot kill the
 *         staleness/status consumers.
 * SRV-80: the brief success tracker event carries transport/model/
 *         output_bytes (parity with the PDU event).
 * SRV-51: every failure exit emits a warn-level SYNTHESIS_FAILED observation
 *         log, and checkSynthesisObservationEvents recognizes the code.
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

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SYNTHESIS_ENABLED: true,
  };
});

import {
  generateIntelligenceBrief,
  generatePendingDocUpdates,
  enforceLastSynthesizedHeader,
} from "../src/ai/synthesize.js";
import { synthesize } from "../src/ai/client.js";
import { pushFile } from "../src/github/client.js";
import { resolveDocFiles, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { recordSynthesisEvent } from "../src/ai/synthesis-tracker.js";
import { logger } from "../src/utils/logger.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../src/utils/intelligence-brief-spec.js";
import { parseLastSynthesizedSession } from "../src/utils/apply-pdu.js";
import { checkSynthesisObservationEvents } from "../src/utils/synthesis-fallback-check.js";

const mockSynthesize = vi.mocked(synthesize);
const mockPushFile = vi.mocked(pushFile);
const mockResolveDocFiles = vi.mocked(resolveDocFiles);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockRecordSynthesisEvent = vi.mocked(recordSynthesisEvent);
const mockLoggerWarn = vi.mocked(logger.warn);

const PUSH_SUCCESS = { success: true as const, size: 100, sha: "pushed-sha" };

const FULL_BRIEF_BODY = `# Intelligence Brief — test

${INTELLIGENCE_BRIEF_SPEC_SECTIONS.join("\n\nbody\n\n")}

body

<!-- EOF: intelligence-brief.md -->`;

const FULL_PDU_BODY = `# Pending Doc Updates — test

## architecture.md

No updates needed at this time.

## glossary.md

No updates needed at this time.

## insights.md

No updates needed at this time.

## No Updates Needed

All quiet.

<!-- EOF: pending-doc-updates.md -->`;

function expectSynthesisFailedWarn(): void {
  const calls = mockLoggerWarn.mock.calls.filter(([msg]) =>
    String(msg).includes("SYNTHESIS_FAILED"),
  );
  expect(calls.length).toBeGreaterThan(0);
  // Observation gate filters by attrs.projectSlug — the emission must tag it.
  expect(calls[0][1]).toMatchObject({ projectSlug: "test-project" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDocFiles.mockResolvedValue(
    new Map([["handoff.md", { content: "## Meta\n", sha: "h1", size: 10 }]]) as never,
  );
  mockResolveDocPushPath.mockImplementation(async (_slug: string, doc: string) => `.prism/${doc}`);
  mockPushFile.mockResolvedValue(PUSH_SUCCESS as never);
});

describe("SRV-07 — refused/truncated synthesis never overwrites intelligence-brief.md", () => {
  it("synthesis refusal (success:false) → nothing pushed, failure surfaced", async () => {
    mockSynthesize.mockResolvedValue({
      success: false,
      error: "synthesis returned stop_reason=refusal",
      error_code: "API_ERROR",
    } as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(false);
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockRecordSynthesisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("max_tokens truncation with missing required sections → NOT pushed, failed event recorded", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: "# Intelligence Brief — test\n\n## Project State\n\ntruncated mid-",
      input_tokens: 1000,
      output_tokens: 4096,
      model: "test-model",
      transport: "messages_api",
      stop_reason: "max_tokens",
    } as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toMatch(/max_tokens/);
    expect(mockPushFile).not.toHaveBeenCalled();
    expect(mockRecordSynthesisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("max_tokens with ALL required sections present → still pushes (partial-tolerance preserved)", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: FULL_BRIEF_BODY,
      input_tokens: 1000,
      output_tokens: 4096,
      model: "test-model",
      transport: "messages_api",
      stop_reason: "max_tokens",
    } as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(true);
    expect(mockPushFile).toHaveBeenCalledTimes(1);
  });
});

describe("SRV-52 — 'Last synthesized' header is server-stamped", () => {
  it("brief: model omits the header → pushed content carries the canonical server-stamped line", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: FULL_BRIEF_BODY,
      input_tokens: 1000,
      output_tokens: 500,
      model: "test-model",
      transport: "messages_api",
    } as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(true);
    const pushedContent = String(mockPushFile.mock.calls[0][2]);
    expect(pushedContent).toMatch(/^> Last synthesized: S26 \(/m);
  });

  it("brief: model emits a stale/wrong header → replaced with the server-known session", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: `# Intelligence Brief — test\n\n> Last synthesized: S12 (stale)\n\n${FULL_BRIEF_BODY.replace("# Intelligence Brief — test\n\n", "")}`,
      input_tokens: 1000,
      output_tokens: 500,
      model: "test-model",
      transport: "messages_api",
    } as never);

    await generateIntelligenceBrief("test-project", 26);

    const pushedContent = String(mockPushFile.mock.calls[0][2]);
    expect(pushedContent).toMatch(/^> Last synthesized: S26 \(/m);
    expect(pushedContent).not.toContain("S12 (stale)");
  });

  it("PDU: model omits the header → pushed content parses to the server-known session", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: FULL_PDU_BODY,
      input_tokens: 900,
      output_tokens: 400,
      model: "test-model",
      transport: "messages_api",
    } as never);

    const outcome = await generatePendingDocUpdates("test-project", 26);

    expect(outcome.success).toBe(true);
    const pushedContent = String(mockPushFile.mock.calls[0][2]);
    expect(parseLastSynthesizedSession(pushedContent)).toBe(26);
  });
});

describe("SRV-80 — brief success tracker event carries transport/model/output_bytes", () => {
  it("records transport, model and output_bytes on the success event", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: FULL_BRIEF_BODY,
      input_tokens: 1000,
      output_tokens: 500,
      model: "test-model",
      transport: "messages_api",
    } as never);

    await generateIntelligenceBrief("test-project", 26);

    expect(mockRecordSynthesisEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        transport: "messages_api",
        model: "test-model",
        output_bytes: expect.any(Number),
      }),
    );
  });
});

describe("SRV-51 — failure exits emit a warn-level SYNTHESIS_FAILED observation log", () => {
  it("brief: synthesize failure → SYNTHESIS_FAILED warn tagged with projectSlug", async () => {
    mockSynthesize.mockResolvedValue({
      success: false,
      error: "timeout",
      error_code: "TIMEOUT",
    } as never);

    await generateIntelligenceBrief("test-project", 26);

    expectSynthesisFailedWarn();
  });

  it("brief: push failure → SYNTHESIS_FAILED warn", async () => {
    mockSynthesize.mockResolvedValue({
      success: true,
      content: FULL_BRIEF_BODY,
      input_tokens: 1000,
      output_tokens: 500,
      model: "test-model",
      transport: "messages_api",
    } as never);
    mockPushFile.mockResolvedValue({ success: false, size: 0, sha: "", error: "403" } as never);

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(false);
    expectSynthesisFailedWarn();
  });

  it("brief: thrown error (input assembly) → SYNTHESIS_FAILED warn", async () => {
    mockResolveDocFiles.mockRejectedValue(new Error("GitHub API 500"));

    const outcome = await generateIntelligenceBrief("test-project", 26);

    expect(outcome.success).toBe(false);
    expectSynthesisFailedWarn();
  });

  it("PDU: synthesize failure → SYNTHESIS_FAILED warn", async () => {
    mockSynthesize.mockResolvedValue({
      success: false,
      error: "rate limited",
      error_code: "API_ERROR",
    } as never);

    await generatePendingDocUpdates("test-project", 26);

    expectSynthesisFailedWarn();
  });

  it("checkSynthesisObservationEvents recognizes SYNTHESIS_FAILED and counts it", () => {
    const now = new Date();
    const result = checkSynthesisObservationEvents(
      [
        {
          message: "SYNTHESIS_FAILED — background synthesis did not produce a pushed intelligence_brief",
          timestamp: new Date(now.getTime() - 60_000).toISOString(),
          severity: "warn",
          attributes: [{ key: "projectSlug", value: "prism" }],
        } as never,
      ],
      "prism",
      now,
      4 * 60 * 60 * 1000,
    );

    expect(result.has_events).toBe(true);
    expect(result.synthesis_failed_count).toBe(1);
    expect(result.events[0].kind).toBe("SYNTHESIS_FAILED");
    expect(result.fallback_count).toBe(0);
  });

  it("checkSynthesisObservationEvents: no SYNTHESIS_FAILED events → count is 0", () => {
    const now = new Date();
    const result = checkSynthesisObservationEvents(
      [
        {
          message: "SYNTHESIS_TRANSPORT_FALLBACK — cc_subprocess failed",
          timestamp: new Date(now.getTime() - 60_000).toISOString(),
          severity: "warn",
          attributes: [{ key: "projectSlug", value: "prism" }],
        } as never,
      ],
      "prism",
      now,
      4 * 60 * 60 * 1000,
    );

    expect(result.synthesis_failed_count).toBe(0);
    expect(result.fallback_count).toBe(1);
  });
});

describe("enforceLastSynthesizedHeader (SRV-52 helper)", () => {
  it("replaces an existing header line with the canonical form", () => {
    const out = enforceLastSynthesizedHeader(
      "# Title\n\n> Last synthesized: S9 (whenever)\n\nBody.",
      26,
      "06-11-26 09:00:00 AM CST",
    );
    expect(out).toContain("> Last synthesized: S26 (06-11-26 09:00:00 AM CST)");
    expect(out).not.toContain("S9 (whenever)");
  });

  it("injects after the H1 title when the header is missing", () => {
    const out = enforceLastSynthesizedHeader("# Title\n\nBody.", 26, "ts");
    const lines = out.split("\n");
    expect(lines[0]).toBe("# Title");
    expect(out).toContain("> Last synthesized: S26 (ts)");
    expect(out.indexOf("> Last synthesized")).toBeLessThan(out.indexOf("Body."));
  });

  it("prepends when there is no H1 title", () => {
    const out = enforceLastSynthesizedHeader("Body only.", 26, "ts");
    expect(out.startsWith("> Last synthesized: S26 (ts)")).toBe(true);
  });
});
