/**
 * D-275 / brief-s196c — openrouter per-site quality gates (design §4.5).
 *
 * Also pins the gate constants to their upstream contracts: the draft
 * contract keys must appear in FINALIZATION_DRAFT_PROMPT, the PDU sections in
 * PENDING_DOC_UPDATES_PROMPT, and the brief sections come from the shared
 * INTELLIGENCE_BRIEF_SPEC_SECTIONS module — so a prompt edit that would
 * silently break the gates fails here first.
 */

import { describe, expect, it } from "vitest";
import {
  FINALIZATION_DRAFT_PROMPT,
  PENDING_DOC_UPDATES_PROMPT,
} from "../../ai/prompts.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../../utils/intelligence-brief-spec.js";
import {
  OPENROUTER_BRIEF_MIN_BYTES,
  OPENROUTER_DRAFT_CONTRACT_KEYS,
  OPENROUTER_PDU_MIN_BYTES,
  OPENROUTER_PDU_REQUIRED_SECTIONS,
  validateOpenrouterSynthesisOutput,
} from "../openrouter.js";

function briefContent(padTo = OPENROUTER_BRIEF_MIN_BYTES + 500): string {
  const body = [
    "# Intelligence Brief — test",
    "",
    "## Project State",
    "state text",
    "## Risk Flags",
    "risk text",
    "## Quality Audit",
    "audit text",
  ].join("\n");
  return body + "\n" + "x".repeat(Math.max(0, padTo - body.length));
}

function pduContent(): string {
  const body = [
    "# Pending Doc Updates — test",
    "",
    "## architecture.md",
    "No updates needed at this time.",
    "## glossary.md",
    "No updates needed at this time.",
    "## insights.md",
    "No updates needed at this time.",
    "## No Updates Needed",
    "All sections reviewed.",
  ].join("\n");
  // Pad above the 500-byte floor — the gate tests section presence and size
  // independently.
  return body + "\n" + "x".repeat(Math.max(0, OPENROUTER_PDU_MIN_BYTES + 100 - body.length));
}

const FULL_DRAFT = JSON.stringify({
  session_log_entry: "### Session 1",
  handoff_where_we_are: "here",
  handoff_next_steps: ["a"],
  handoff_session_history: "S1: done",
  task_queue_completed: [],
  task_queue_new: [],
});

describe("openrouter quality gates — synthesis_brief", () => {
  it("passes a complete brief above the byte floor", () => {
    expect(validateOpenrouterSynthesisOutput("synthesis_brief", briefContent())).toEqual({ ok: true });
  });

  it("fails a thinking-starved stub below the byte floor", () => {
    const result = validateOpenrouterSynthesisOutput("synthesis_brief", "## Project State\nok");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("brief-below-min-bytes");
  });

  it("fails when a required section is missing even above the floor", () => {
    const noRisk = briefContent().replace("## Risk Flags", "## Something Else");
    const result = validateOpenrouterSynthesisOutput("synthesis_brief", noRisk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("## Risk Flags");
  });
});

describe("openrouter quality gates — synthesis_pdu", () => {
  it("passes a grammar-complete PDU", () => {
    expect(validateOpenrouterSynthesisOutput("synthesis_pdu", pduContent())).toEqual({ ok: true });
  });

  it("fails below the byte floor", () => {
    const result = validateOpenrouterSynthesisOutput("synthesis_pdu", "## architecture.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("pdu-below-min-bytes");
  });

  it("fails when an H2 grammar section is missing", () => {
    const missing = pduContent().replace("## No Updates Needed", "## Wrap Up");
    const result = validateOpenrouterSynthesisOutput("synthesis_pdu", missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("## No Updates Needed");
  });
});

describe("openrouter quality gates — synthesis_draft", () => {
  it("passes a full 6-key contract JSON (with or without fences)", () => {
    expect(validateOpenrouterSynthesisOutput("synthesis_draft", FULL_DRAFT)).toEqual({ ok: true });
    expect(
      validateOpenrouterSynthesisOutput("synthesis_draft", "```json\n" + FULL_DRAFT + "\n```"),
    ).toEqual({ ok: true });
  });

  it("passes at exactly 4 of 6 contract keys (the floor)", () => {
    const fourKeys = JSON.stringify({
      session_log_entry: "x",
      handoff_where_we_are: "x",
      handoff_next_steps: [],
      handoff_session_history: "x",
    });
    expect(validateOpenrouterSynthesisOutput("synthesis_draft", fourKeys)).toEqual({ ok: true });
  });

  it("fails below 4 contract keys — closing the raw_content success gap on the GLM route", () => {
    const twoKeys = JSON.stringify({ session_log_entry: "x", task_queue_new: [] });
    const result = validateOpenrouterSynthesisOutput("synthesis_draft", twoKeys);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("draft-contract-keys(2<4)");
  });

  it("fails unparseable and non-object output", () => {
    const notJson = validateOpenrouterSynthesisOutput("synthesis_draft", "Sure! Here are the drafts…");
    expect(notJson).toEqual({ ok: false, reason: "draft-json-parse-failed" });

    const array = validateOpenrouterSynthesisOutput("synthesis_draft", "[1,2,3]");
    expect(array).toEqual({ ok: false, reason: "draft-json-not-an-object" });
  });
});

describe("gate constants stay pinned to their upstream contracts", () => {
  it("draft contract keys all appear in FINALIZATION_DRAFT_PROMPT", () => {
    for (const key of OPENROUTER_DRAFT_CONTRACT_KEYS) {
      expect(FINALIZATION_DRAFT_PROMPT).toContain(`"${key}"`);
    }
    expect(OPENROUTER_DRAFT_CONTRACT_KEYS).toHaveLength(6);
  });

  it("PDU gate sections all appear in PENDING_DOC_UPDATES_PROMPT", () => {
    for (const section of OPENROUTER_PDU_REQUIRED_SECTIONS) {
      expect(PENDING_DOC_UPDATES_PROMPT).toContain(section);
    }
    expect(OPENROUTER_PDU_REQUIRED_SECTIONS).toHaveLength(4);
  });

  it("brief gate consumes the shared spec-section module (INS-30 single source)", () => {
    // The gate imports INTELLIGENCE_BRIEF_SPEC_SECTIONS directly; assert the
    // spec still carries the 3 boot-delivered sections the gate enforces.
    expect(INTELLIGENCE_BRIEF_SPEC_SECTIONS).toEqual([
      "## Project State",
      "## Risk Flags",
      "## Quality Audit",
    ]);
  });

  it("keeps the deliberately-low byte floors (fallback trigger, not prose judgment)", () => {
    expect(OPENROUTER_BRIEF_MIN_BYTES).toBe(2000);
    expect(OPENROUTER_PDU_MIN_BYTES).toBe(500);
  });
});
