/**
 * Unit tests for sanitizeContentField — KI-26 fix.
 *
 * The function neutralizes embedded markdown section headers in user-supplied
 * content by inserting a Unicode zero-width space (U+200B) between the leading
 * `#` cluster and the following space. The tests below cover the six cases
 * called out in brief-421 plus a few regressions worth pinning.
 *
 * Co-located under src/utils/__tests__/ per the brief — vitest.config.ts
 * picks these up alongside the legacy tests/ folder.
 */

import { describe, it, expect } from "vitest";
import { sanitizeContentField } from "../sanitize-content.js";

const ZWS = "​";

describe("sanitizeContentField", () => {
  it("returns content with no headers unchanged", () => {
    const input = "Just some plain prose. No headers here.\nLine two.\nLine three.";
    expect(sanitizeContentField(input)).toBe(input);
  });

  it("neutralizes a `## Section` at line start", () => {
    const input = "## Section\nbody";
    expect(sanitizeContentField(input)).toBe(`##${ZWS} Section\nbody`);
  });

  it("neutralizes a `### Subsection` mid-string after a newline", () => {
    const input = "intro\n### Subsection\nbody";
    expect(sanitizeContentField(input)).toBe(`intro\n###${ZWS} Subsection\nbody`);
  });

  it("does NOT neutralize `#` not followed by a space (e.g. `#hashtag`)", () => {
    const input = "this is a #hashtag, not a header";
    expect(sanitizeContentField(input)).toBe(input);
  });

  it("neutralizes headers inside fenced code blocks too (acceptable; ZWS in a code fence is harmless)", () => {
    const input = "```\n## still a header to the parser\n```";
    expect(sanitizeContentField(input)).toBe(`\`\`\`\n##${ZWS} still a header to the parser\n\`\`\``);
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizeContentField("")).toBe("");
  });

  // ---------------------------------------------------------------------
  // Regression / spec reinforcements beyond the six required cases.
  // ---------------------------------------------------------------------

  it("matches the brief's verification spot-check exactly", () => {
    // Brief: sanitizeContentField("intro\n## Header\nbody")
    //        must return "intro\n##​ Header\nbody".
    expect(sanitizeContentField("intro\n## Header\nbody")).toBe(
      `intro\n##${ZWS} Header\nbody`,
    );
  });

  it("neutralizes all six header levels (h1 through h6)", () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = "#".repeat(level);
      const input = `${hashes} Title`;
      expect(sanitizeContentField(input)).toBe(`${hashes}${ZWS} Title`);
    }
  });

  it("does NOT match seven or more `#` characters (not a valid header)", () => {
    const input = "####### NotAHeader";
    expect(sanitizeContentField(input)).toBe(input);
  });

  it("neutralizes multiple injected headers in one pass", () => {
    const input = "preamble\n## First\nmiddle\n### Second\ntail";
    expect(sanitizeContentField(input)).toBe(
      `preamble\n##${ZWS} First\nmiddle\n###${ZWS} Second\ntail`,
    );
  });

  it("preserves the leading newline before an injected header", () => {
    // Critical regression: the naive interpretation of the brief's regex
    // (replacement uses only `$2`) would consume the leading `\n` and merge
    // lines. Capture group 1 must hold the anchor.
    const input = "line one\n## Two";
    expect(sanitizeContentField(input)).toBe(`line one\n##${ZWS} Two`);
  });

  it("does NOT neutralize a `#` that lacks a trailing space (e.g. `##body`)", () => {
    const input = "##body without space";
    expect(sanitizeContentField(input)).toBe(input);
  });

  it("does NOT match a header that is indented (mid-line position)", () => {
    // The regex is anchored to line start. An indented `## Header` after
    // spaces is not a CommonMark header anyway (4+ spaces makes it a code
    // block; 1-3 spaces is still a header but marginal). We choose the
    // line-start-only behavior to keep the rule simple and surgical.
    const input = "    ## indented";
    expect(sanitizeContentField(input)).toBe(input);
  });

  it("neutralizes a header at string start with no preceding newline", () => {
    expect(sanitizeContentField("# Top")).toBe(`#${ZWS} Top`);
  });
});
