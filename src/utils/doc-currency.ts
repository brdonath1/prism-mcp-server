/**
 * Doc-currency parsing helpers (D-156 §3.7, D-155).
 *
 * Surfaces "narrative doc has not been touched in N sessions while M
 * architecture decisions have landed since then" signals to the audit
 * phase of prism_finalize. The decision is advisory: the audit response
 * carries `acknowledgment_required` flags; this PR does not block commit.
 */

import { parseMarkdownTable } from "./summarizer.js";

/**
 * Per-doc currency warning surfaced in the audit response.
 *
 * `last_modified_session` is null when the doc lacks a `> Updated: S<N>`
 * marker — that case is treated conservatively (no warning fires).
 */
export interface CurrencyWarning {
  path: string;
  last_modified_session: number | null;
  current_session: number;
  sessions_since_last_modified: number | null;
  pending_arch_decisions_count: number;
  pending_arch_decision_ids: string[];
  acknowledgment_required: boolean;
}

/**
 * Extract the highest `> Updated: S<N>` session marker from a markdown body.
 *
 * Returns null when no well-formed marker is present. Multiple markers
 * (e.g., when archive sections preserve historical markers) yield the
 * highest session number — i.e., the most recent.
 */
export function parseLastModifiedSession(docBody: string): number | null {
  if (!docBody) return null;

  const matches = [...docBody.matchAll(/^>\s*Updated:\s*S(\d+)\b/gm)];
  if (matches.length === 0) return null;

  let highest: number | null = null;
  for (const m of matches) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && (highest === null || n > highest)) {
      highest = n;
    }
  }
  return highest;
}

/**
 * Count architecture-domain decisions in `decisions/_INDEX.md` whose
 * Session column is strictly greater than `sinceSession`.
 *
 * The INDEX format is the standard PRISM table: ID | Title | Domain |
 * Status | Session. Domain match is case-insensitive substring on
 * "architecture" so legacy entries like "Architecture / Operations"
 * still register.
 */
export function parseArchDecisionsSinceSession(
  indexBody: string,
  sinceSession: number,
): { count: number; ids: string[] } {
  if (!indexBody) return { count: 0, ids: [] };

  const rows = parseMarkdownTable(indexBody);
  if (rows.length === 0) return { count: 0, ids: [] };

  const sample = rows[0];
  const idKey = Object.keys(sample).find(k => k.toLowerCase() === "id") ?? "ID";
  const domainKey =
    Object.keys(sample).find(k => k.toLowerCase() === "domain") ?? "Domain";
  const sessionKey =
    Object.keys(sample).find(k => k.toLowerCase() === "session") ?? "Session";

  const ids: string[] = [];
  for (const row of rows) {
    const domain = (row[domainKey] ?? "").toLowerCase();
    if (!domain.includes("architecture")) continue;

    // Tolerate both bare ("64") and S-prefixed ("S64") session formats —
    // production uses bare, some legacy/test fixtures use S-prefix.
    const rawSession = (row[sessionKey] ?? "").trim().replace(/^S/i, "");
    const sessionVal = parseInt(rawSession, 10);
    if (!Number.isFinite(sessionVal)) continue;
    if (sessionVal <= sinceSession) continue;

    const id = (row[idKey] ?? "").trim();
    if (id) ids.push(id);
  }

  return { count: ids.length, ids };
}

/**
 * Compute a `CurrencyWarning` for a single narrative doc.
 *
 * Per D-156 §3.7, `acknowledgment_required` fires when the doc has not
 * been updated in more than 10 sessions AND at least one architecture
 * decision has been logged since the doc's last-modified session.
 */
export function computeCurrencyWarning(args: {
  path: string;
  docBody: string;
  indexBody: string;
  currentSession: number;
}): CurrencyWarning {
  const { path, docBody, indexBody, currentSession } = args;
  const lastModifiedSession = parseLastModifiedSession(docBody);

  if (lastModifiedSession === null) {
    return {
      path,
      last_modified_session: null,
      current_session: currentSession,
      sessions_since_last_modified: null,
      pending_arch_decisions_count: 0,
      pending_arch_decision_ids: [],
      acknowledgment_required: false,
    };
  }

  const sessionsSince = currentSession - lastModifiedSession;
  const arch = parseArchDecisionsSinceSession(indexBody, lastModifiedSession);

  return {
    path,
    last_modified_session: lastModifiedSession,
    current_session: currentSession,
    sessions_since_last_modified: sessionsSince,
    pending_arch_decisions_count: arch.count,
    pending_arch_decision_ids: arch.ids,
    acknowledgment_required: sessionsSince > 10 && arch.count > 0,
  };
}
