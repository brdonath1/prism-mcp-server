// brief-s202b T3 (P-3) — intelligence-brief digest-dedup matrix.
// `dedup` (default) drops the Project State digest line (measured full
// duplicate of `current_state` in the same payload — S202 audit §B.4);
// `legacy` ships it again. The BRIEF_COMPACT_FALLBACK spec-coupling guard is
// identical in both modes (D-253 lesson b — retained exactly as today).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compactIntelligenceBrief, BRIEF_COMPACT_SECTIONS } from "../src/tools/bootstrap.js";
import { INTELLIGENCE_BRIEF_SPEC_SECTIONS } from "../src/utils/intelligence-brief-spec.js";
import { DiagnosticsCollector } from "../src/utils/diagnostics.js";

const FULL_BRIEF = `# Intelligence Brief — Test

> Last synthesized: S27 (2026-07-01)

## Project State
First sentence of state. Second sentence with detail. Third one. Fourth sentence never digested.

## Risk Flags
- INS-249: the old compactor matched headers literally.

## Quality Audit
Docs current; task-queue slightly behind session-log.

<!-- EOF: intelligence-brief.md -->`;

const savedMode = { value: undefined as string | undefined };

beforeEach(() => {
  savedMode.value = process.env.BRIEF_COMPACT_MODE;
});
afterEach(() => {
  if (savedMode.value === undefined) delete process.env.BRIEF_COMPACT_MODE;
  else process.env.BRIEF_COMPACT_MODE = savedMode.value;
});

describe("brief-s202b T3 — compactIntelligenceBrief digest-dedup", () => {
  it("dedup (default): drops the Project State digest, keeps FULL Risk Flags + FULL Quality Audit", () => {
    delete process.env.BRIEF_COMPACT_MODE;
    const diagnostics = new DiagnosticsCollector();
    const out = compactIntelligenceBrief(FULL_BRIEF, diagnostics);

    expect(out).not.toContain("**Project State (compact):**");
    expect(out).not.toContain("First sentence of state.");
    expect(out).toContain("## Risk Flags");
    expect(out).toContain("- INS-249: the old compactor matched headers literally.");
    expect(out).toContain("## Quality Audit");
    expect(out).toContain("Docs current; task-queue slightly behind session-log.");
    expect(diagnostics.isEmpty()).toBe(true);
  });

  it("legacy: ships the 3-sentence digest line again (env rollback)", () => {
    const diagnostics = new DiagnosticsCollector();
    const out = compactIntelligenceBrief(FULL_BRIEF, diagnostics, "legacy");

    expect(out).toContain("**Project State (compact):**");
    expect(out).toContain("First sentence of state. Second sentence with detail. Third one.");
    expect(out).not.toContain("Fourth sentence never digested.");
    expect(out).toContain("## Risk Flags");
    expect(out).toContain("## Quality Audit");
    expect(diagnostics.isEmpty()).toBe(true);
  });

  it("reads BRIEF_COMPACT_MODE from env when the mode arg is omitted", () => {
    process.env.BRIEF_COMPACT_MODE = "legacy";
    const out = compactIntelligenceBrief(FULL_BRIEF, new DiagnosticsCollector());
    expect(out).toContain("**Project State (compact):**");
  });

  it("fallback guard is identical in BOTH modes: a missing consumed section delivers the FULL brief + BRIEF_COMPACT_FALLBACK", () => {
    for (const mode of ["dedup", "legacy"] as const) {
      // Drop each consumed section in turn — including Project State, which
      // dedup mode does not EMIT but must still REQUIRE (spec coupling: a
      // renamed source section must surface loudly, never silently).
      for (const section of Object.values(BRIEF_COMPACT_SECTIONS)) {
        const damaged = FULL_BRIEF.replace(section, `${section} (renamed)`);
        const diagnostics = new DiagnosticsCollector();
        const out = compactIntelligenceBrief(damaged, diagnostics, mode);
        expect(out).toBe(damaged);
        const fallback = diagnostics.list().find(d => d.code === "BRIEF_COMPACT_FALLBACK");
        expect(fallback).toBeDefined();
        expect(fallback!.level).toBe("warn");
        expect(fallback!.context?.missing_section).toBe(section);
      }
    }
  });

  it("spec coupling: consumed section names remain a subset of the spec export", () => {
    for (const section of Object.values(BRIEF_COMPACT_SECTIONS)) {
      expect(INTELLIGENCE_BRIEF_SPEC_SECTIONS).toContain(section);
    }
  });
});
