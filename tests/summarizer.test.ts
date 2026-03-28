import { describe, it, expect } from "vitest";
import {
  parseMarkdownTable,
  extractHeaders,
  extractSection,
  parseNumberedList,
  summarizeMarkdown,
} from "../src/utils/summarizer.js";

describe("parseMarkdownTable", () => {
  it("parses a standard markdown table", () => {
    const table = `| ID | Title | Status |
|-----|-------|--------|
| D-1 | First decision | SETTLED |
| D-2 | Second decision | PENDING |`;

    const rows = parseMarkdownTable(table);
    expect(rows).toHaveLength(2);
    expect(rows[0]["ID"]).toBe("D-1");
    expect(rows[0]["Title"]).toBe("First decision");
    expect(rows[0]["Status"]).toBe("SETTLED");
    expect(rows[1]["ID"]).toBe("D-2");
  });

  it("returns empty array for content without a table", () => {
    const content = "# Just a heading\n\nSome text.";
    expect(parseMarkdownTable(content)).toEqual([]);
  });

  it("handles table with extra whitespace", () => {
    const table = `|  ID  |  Title  |
|------|---------|
|  D-1  |  Spaced  |`;

    const rows = parseMarkdownTable(table);
    expect(rows).toHaveLength(1);
    expect(rows[0]["ID"]).toBe("D-1");
    expect(rows[0]["Title"]).toBe("Spaced");
  });
});

describe("extractHeaders", () => {
  it("extracts all markdown headers", () => {
    const content = `# Top Level
## Second Level
Some text
### Third Level
#### Fourth Level
Regular line`;

    const headers = extractHeaders(content);
    expect(headers).toEqual([
      "# Top Level",
      "## Second Level",
      "### Third Level",
      "#### Fourth Level",
    ]);
  });

  it("returns empty array for content with no headers", () => {
    expect(extractHeaders("Just text\nMore text")).toEqual([]);
  });
});

describe("extractSection", () => {
  it("extracts a named section", () => {
    const content = `## Meta
- Version: 1
- Status: active

## Critical Context
1. First item
2. Second item

## Where We Are
Some text here`;

    const meta = extractSection(content, "Meta");
    expect(meta).toContain("Version: 1");
    expect(meta).toContain("Status: active");
    expect(meta).not.toContain("Critical Context");
  });

  it("returns null for missing section", () => {
    const content = "## Meta\nSome content";
    expect(extractSection(content, "Nonexistent")).toBeNull();
  });

  it("is case-insensitive", () => {
    const content = "## Critical Context\nImportant stuff";
    expect(extractSection(content, "critical context")).toContain("Important stuff");
  });
});

describe("parseNumberedList", () => {
  it("extracts numbered items", () => {
    const text = `1. First item
2. Second item
3. Third item`;

    const items = parseNumberedList(text);
    expect(items).toEqual(["First item", "Second item", "Third item"]);
  });

  it("ignores non-numbered lines", () => {
    const text = `Some text
1. Item one
More text
2. Item two`;

    const items = parseNumberedList(text);
    expect(items).toEqual(["Item one", "Item two"]);
  });
});

describe("summarizeMarkdown", () => {
  it("returns full content for short files", () => {
    const content = "# Short file\n\nJust a few lines.";
    const summary = summarizeMarkdown(content, 500);
    expect(summary).toContain("Short file");
    expect(summary).not.toContain("truncated");
  });

  it("truncates long content and shows headers", () => {
    const content = "# Title\n\n" + "x".repeat(600) + "\n\n## Section Two\n\nMore content";
    const summary = summarizeMarkdown(content, 100);
    expect(summary).toContain("[... truncated ...]");
    expect(summary).toContain("# Title");
    expect(summary).toContain("## Section Two");
  });
});
