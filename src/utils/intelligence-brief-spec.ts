/**
 * intelligence-brief-spec — the canonical list of H2 sections an
 * intelligence-brief.md is REQUIRED to contain, per the synthesis spec in
 * `src/ai/prompts.ts` (FINALIZATION_SYNTHESIS_PROMPT: "Produce a markdown
 * document with EXACTLY these 3 sections").
 *
 * brief-465 / SRV-72: re-spec'd from 6 sections to the 3 the boot loader
 * actually delivers. The pre-brief-465 spec mandated 6 sections, but
 * compactIntelligenceBrief delivered only Project State + Risk Flags + Quality
 * Audit — so "Standing Rules & Workflows", "Active Operational Knowledge", and
 * "Recent Trajectory" were synthesized at full Fable-5 cost every finalize and
 * then silently dropped at boot. Trajectory + active-knowledge essentials are
 * now folded INTO Project State; Standing Rules is dropped entirely (it
 * duplicated the boot-time standing-rules pipeline AND demanded extraction from
 * a registry the synthesis input no longer contains — SRV-27). Every section
 * synthesized now reaches the session.
 *
 * Single source of truth (INS-30): both the synthesis-side validation
 * (`src/ai/synthesize.ts` — warns when output misses a section) and the
 * bootstrap-side SLO instrumentation (`src/tools/bootstrap.ts` — R-intel-SLO
 * boot-completeness computation, D-240 Phase B) consume THIS list.
 *
 * Entries include the `## ` prefix because consumers match them as literal
 * substrings of the document content — the same check synthesize.ts has
 * always used.
 */
export const INTELLIGENCE_BRIEF_SPEC_SECTIONS: readonly string[] = [
  "## Project State",
  "## Risk Flags",
  "## Quality Audit",
] as const;
