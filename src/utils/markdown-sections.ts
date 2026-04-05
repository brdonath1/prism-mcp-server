/**
 * Markdown section utilities for PRISM living documents.
 * Provides reliable section parsing, patching, and integrity validation.
 *
 * Replaces the fragile single-regex approach in patch.ts (S30).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Section {
  header: string;       // Full header line (e.g., "## Voice Infrastructure")
  level: number;        // Header level (number of #s)
  body: string;         // Content between this header and next section boundary
  startIndex: number;   // Byte offset where header starts in the document
  endIndex: number;     // Byte offset where this section ends (exclusive)
}

export interface IntegrityIssue {
  type: "duplicate_header" | "empty_section" | "orphaned_content";
  header: string;
  details: string;
}

export interface IntegrityResult {
  valid: boolean;
  issues: IntegrityIssue[];
}

// ---------------------------------------------------------------------------
// parseSections
// ---------------------------------------------------------------------------

const HEADER_RE = /^(#{1,6})\s+(.+)$/;
const FENCE_RE = /^```/;

/**
 * Parse a markdown document into sections.
 *
 * Algorithm:
 * 1. Scan line-by-line, tracking fenced code block state.
 * 2. Identify header lines (ignoring headers inside code fences).
 * 3. Compute section boundaries: each section's body extends from
 *    headerEndIndex to whichever comes first:
 *      - startIndex of the next header at the same or higher level
 *      - A line starting with `<!-- EOF:`
 *      - End of string
 */
export function parseSections(content: string): Section[] {
  const lines = content.split("\n");
  const headers: Array<{
    header: string;
    level: number;
    startIndex: number;
    headerEndIndex: number;
  }> = [];

  let offset = 0;
  let inFence = false;

  for (const line of lines) {
    // Track fenced code blocks
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
    }

    if (!inFence) {
      const m = line.match(HEADER_RE);
      if (m) {
        headers.push({
          header: line,
          level: m[1].length,
          startIndex: offset,
          headerEndIndex: offset + line.length + 1, // +1 for the \n
        });
      }
    }

    offset += line.length + 1; // +1 for the \n that split removed
  }

  // Build sections by computing each header's endIndex
  const sections: Section[] = [];

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];

    // Determine where this section ends
    let endIndex = content.length;

    // Check for next header at same or higher level (fewer or equal #s)
    for (let j = i + 1; j < headers.length; j++) {
      if (headers[j].level <= h.level) {
        endIndex = headers[j].startIndex;
        break;
      }
    }

    // Check for <!-- EOF: sentinel within the section body range
    const bodySlice = content.substring(h.headerEndIndex, endIndex);
    const eofIdx = bodySlice.indexOf("<!-- EOF:");
    if (eofIdx !== -1) {
      endIndex = h.headerEndIndex + eofIdx;
    }

    const body = content.substring(h.headerEndIndex, endIndex);

    sections.push({
      header: h.header,
      level: h.level,
      body,
      startIndex: h.startIndex,
      endIndex,
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

/**
 * Normalize a header string for fuzzy comparison:
 * strip bold markers, trim whitespace, lowercase.
 */
function normalizeHeader(header: string): string {
  return header.replace(/\*\*/g, "").trim().toLowerCase();
}

/**
 * Find the target section by header, with fallback matching.
 *
 * 1. Exact match (case-sensitive)
 * 2. Normalized match (strip bold, case-insensitive)
 * 3. Throw if not found or ambiguous
 */
function findSection(sections: Section[], sectionHeader: string): Section {
  // Exact match
  const exact = sections.filter(s => s.header === sectionHeader);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `Ambiguous section: "${sectionHeader}" matches ${exact.length} sections — use a more specific header`
    );
  }

  // Normalized match
  const normalized = normalizeHeader(sectionHeader);
  const fuzzy = sections.filter(s => normalizeHeader(s.header) === normalized);
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error(
      `Ambiguous section: "${sectionHeader}" matches ${fuzzy.length} sections — use a more specific header`
    );
  }

  throw new Error(`Section not found: "${sectionHeader}"`);
}

/**
 * Apply a patch operation to a markdown document's section.
 *
 * Uses parseSections() to reliably find section boundaries,
 * then reconstructs the document with the patched section.
 */
export function applyPatch(
  content: string,
  sectionHeader: string,
  operation: "append" | "prepend" | "replace",
  patchContent: string
): string {
  const sections = parseSections(content);
  const section = findSection(sections, sectionHeader);

  let newSection: string;

  switch (operation) {
    case "append":
      newSection =
        section.header +
        "\n" +
        section.body.trimEnd() +
        "\n" +
        patchContent +
        "\n\n";
      break;
    case "prepend":
      newSection =
        section.header + "\n" + patchContent + "\n" + section.body;
      break;
    case "replace":
      newSection = section.header + "\n" + patchContent + "\n\n";
      break;
  }

  return (
    content.substring(0, section.startIndex) +
    newSection +
    content.substring(section.endIndex)
  );
}

// ---------------------------------------------------------------------------
// validateIntegrity
// ---------------------------------------------------------------------------

/**
 * Post-patch integrity check.
 * Detects duplicate headers (corruption) and empty sections (warnings).
 */
export function validateIntegrity(content: string): IntegrityResult {
  const sections = parseSections(content);
  const issues: IntegrityIssue[] = [];

  // Check for duplicate headers at the same level
  const seen = new Map<string, number>(); // key: "level:header" -> count
  for (const s of sections) {
    const key = `${s.level}:${s.header}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 2) {
      // Report on the second occurrence
      issues.push({
        type: "duplicate_header",
        header: s.header,
        details: `Duplicate header "${s.header}" (level ${s.level}) found — possible corruption from partial replace`,
      });
    }
  }

  // Check for empty sections
  for (const s of sections) {
    if (s.body.trim() === "") {
      issues.push({
        type: "empty_section",
        header: s.header,
        details: `Section "${s.header}" has an empty body`,
      });
    }
  }

  // Only duplicate_header issues make the result invalid
  const valid = !issues.some(i => i.type === "duplicate_header");

  return { valid, issues };
}
