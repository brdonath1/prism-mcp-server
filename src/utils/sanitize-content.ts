/**
 * Neutralize embedded markdown section headers in user-supplied content.
 *
 * Inserts a Unicode zero-width space (U+200B) after the leading '#' characters
 * on any line that begins with one or more '#' followed by a space. This makes
 * the line unrecognizable as a section header to the markdown parser while
 * remaining readable to humans in rendered output.
 *
 * Applies to all user-supplied content fields before they are written into
 * living documents: reasoning / assumptions / impact / title (log-decision.ts)
 * and content (patch.ts). Fixes KI-26 — without this, a user-supplied string
 * starting with `## ` becomes a real section header on the next parse, breaking
 * the section tree and enabling silent corruption that validateIntegrity() does
 * not catch (it only flags duplicate headers, not novel ones).
 *
 * The regex matches `#`, `##`, ..., `######` followed by a space, anchored at
 * a line start (string start or immediately after `\n`). The leading anchor is
 * preserved via capture group 1 so any `\n` before the header is not consumed.
 */
export function sanitizeContentField(text: string): string {
  return text.replace(/(^|\n)(#{1,6}) /g, "$1$2\u200B ");
}
