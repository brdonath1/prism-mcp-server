/**
 * Content summarization utilities for context-efficient MCP responses.
 * Used when files exceed size thresholds and summary_mode is enabled.
 */

/**
 * Summarize a markdown file: first N characters + extracted section headers.
 * Keeps the response within context budget while preserving document structure.
 */
export function summarizeMarkdown(content: string, maxPreviewChars = 500): string {
  const preview = content.slice(0, maxPreviewChars);
  const headers = extractHeaders(content);
  const headerList = headers.length > 0
    ? `\n\nSection headers:\n${headers.map(h => `  ${h}`).join("\n")}`
    : "";

  return `${preview}${content.length > maxPreviewChars ? "\n\n[... truncated ...]" : ""}${headerList}`;
}

/**
 * Extract all markdown headers (## level and above) from content.
 */
export function extractHeaders(content: string): string[] {
  const lines = content.split("\n");
  return lines
    .filter(line => /^#{1,4}\s+/.test(line))
    .map(line => line.trim());
}

/**
 * Extract a specific named section from markdown content.
 * Returns the section body (everything between this header and the next same-or-higher-level header).
 */
export function extractSection(content: string, sectionName: string): string | null {
  const lines = content.split("\n");
  let capturing = false;
  let headerLevel = 0;
  const result: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      if (capturing) {
        // Stop if we hit a header at the same or higher level
        if (level <= headerLevel) break;
      }

      if (title.toLowerCase().includes(sectionName.toLowerCase())) {
        capturing = true;
        headerLevel = level;
        continue;
      }
    }

    if (capturing) {
      result.push(line);
    }
  }

  const text = result.join("\n").trim();
  return text.length > 0 ? text : null;
}

/**
 * Parse numbered list items from a section (e.g., Critical Context items).
 */
export function parseNumberedList(text: string): string[] {
  const items: string[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s+(.+)$/);
    if (match) {
      items.push(match[1].trim());
    }
  }

  return items;
}

/**
 * Parse a markdown table into rows of objects.
 * Assumes the first row is the header and second row is the separator.
 */
export function parseMarkdownTable(content: string): Array<Record<string, string>> {
  const lines = content.split("\n").filter(line => line.includes("|"));
  if (lines.length < 3) return []; // Need header + separator + at least 1 row

  const headers = lines[0]
    .split("|")
    .map(h => h.trim())
    .filter(h => h.length > 0);

  // Skip separator line (index 1)
  const rows: Array<Record<string, string>> = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i]
      .split("|")
      .map(c => c.trim())
      .filter(c => c.length > 0);

    if (cells.length === 0) continue;

    const row: Record<string, string> = {};
    headers.forEach((header, idx) => {
      row[header] = cells[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}
