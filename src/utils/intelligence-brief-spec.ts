/**
 * intelligence-brief-spec — the canonical list of H2 sections an
 * intelligence-brief.md is REQUIRED to contain, per the synthesis spec in
 * `src/ai/prompts.ts` (FINALIZATION_SYNTHESIS_PROMPT: "Produce a markdown
 * document with EXACTLY these 6 sections").
 *
 * Single source of truth (INS-30): both the synthesis-side validation
 * (`src/ai/synthesize.ts` — warns when Opus output misses a section) and the
 * bootstrap-side SLO instrumentation (`src/tools/bootstrap.ts` — R-intel-SLO
 * boot-completeness computation, D-240 Phase B) consume THIS list. Before
 * R-intel-SLO the list lived inline in synthesize.ts; duplicating it for the
 * SLO would have created exactly the mirror-pattern drift INS-30 warns about.
 *
 * Entries include the `## ` prefix because consumers match them as literal
 * substrings of the document content — the same check synthesize.ts has
 * always used.
 */
export const INTELLIGENCE_BRIEF_SPEC_SECTIONS: readonly string[] = [
  "## Project State",
  "## Standing Rules & Workflows",
  "## Active Operational Knowledge",
  "## Recent Trajectory",
  "## Risk Flags",
  "## Quality Audit",
] as const;
