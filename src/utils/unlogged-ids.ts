/**
 * Unlogged-ID reference detection (brief-444, optional sub-change / D-240
 * Phase B). At finalize, the session text being committed (handoff.md,
 * session-log.md, etc.) frequently references decision and insight IDs.
 * When a referenced `D-N` / `INS-N` was never logged via prism_log_decision
 * / prism_log_insight — i.e. it is absent from every registry source — the
 * operator loses the entry silently: the prose mentions it but the registry
 * has no record. commitPhase surfaces these as a NON-BLOCKING
 * `UNLOGGED_ID_REFERENCED` warn diagnostic.
 *
 * Pure functions only — the caller assembles registry ID sets (committed
 * file versions take precedence over repo state) and passes them in. A
 * `null` registry set means "state unknown" (operational fetch failure):
 * that ID family is skipped entirely rather than risking false positives.
 */

/** Matches canonical decision references: D-1 … D-9999. */
const DECISION_REF_RE = /\bD-(\d{1,4})\b/g;

/** Matches canonical insight references: INS-1 … INS-99999. */
const INSIGHT_REF_RE = /\bINS-(\d{1,5})\b/g;

/**
 * Extract every D-N / INS-N reference from a text body. Returned sets hold
 * the canonical hyphenated form (e.g. "D-241", "INS-69").
 */
export function extractReferencedIds(text: string): {
  decisions: Set<string>;
  insights: Set<string>;
} {
  const decisions = new Set<string>();
  const insights = new Set<string>();
  for (const m of text.matchAll(DECISION_REF_RE)) {
    decisions.add(`D-${m[1]}`);
  }
  for (const m of text.matchAll(INSIGHT_REF_RE)) {
    insights.add(`INS-${m[1]}`);
  }
  return { decisions, insights };
}

/** Numeric-ascending sort for D-N / INS-N IDs ("D-9" before "D-41"). */
function sortByNumber(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const na = parseInt(a.slice(a.indexOf("-") + 1), 10);
    const nb = parseInt(b.slice(b.indexOf("-") + 1), 10);
    return na - nb;
  });
}

export interface UnloggedIdReport {
  /** Referenced D-N IDs absent from the decision registry (sorted ascending). */
  decisions: string[];
  /** Referenced INS-N IDs absent from every insight registry source (sorted ascending). */
  insights: string[];
}

/**
 * Compare the IDs referenced across the committed session files against the
 * registry ID sets. `null` for either registry set means that family's
 * state is unknown — it is skipped (fail-open, no false positives).
 */
export function findUnloggedIds(
  committedFiles: Array<{ path: string; content: string }>,
  registry: {
    decisionIds: Set<string> | null;
    insightIds: Set<string> | null;
  },
): UnloggedIdReport {
  const referencedDecisions = new Set<string>();
  const referencedInsights = new Set<string>();
  for (const file of committedFiles) {
    const refs = extractReferencedIds(file.content);
    for (const id of refs.decisions) referencedDecisions.add(id);
    for (const id of refs.insights) referencedInsights.add(id);
  }

  const decisions =
    registry.decisionIds === null
      ? []
      : sortByNumber(
          [...referencedDecisions].filter((id) => !registry.decisionIds!.has(id)),
        );
  const insights =
    registry.insightIds === null
      ? []
      : sortByNumber(
          [...referencedInsights].filter((id) => !registry.insightIds!.has(id)),
        );

  return { decisions, insights };
}
