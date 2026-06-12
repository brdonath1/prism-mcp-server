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
import {
  sanitizeContent,
  sanitizeContentField,
  detectZwsHeaders,
  stripZwsHeaders,
} from "../sanitize-content.js";

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

  it("brief-460 / SRV-29: leaves headers inside BALANCED fenced code blocks untouched (parseSections never treated them as headers)", () => {
    // Pre-460 pin was the inverse — the fence-blind sanitizer corrupted
    // fenced code samples for zero protective value.
    const input = "```\n## still fenced, never a header to the parser\n```";
    expect(sanitizeContentField(input)).toBe(input);
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

// ───────────────────────────────────────────────────────────────────────────
// brief-460 / W3-S4 (M-007) — level/fence/anchor-aware redesign + the
// contamination primitives. SRV-03 (level-aware), SRV-29 (fence-aware),
// SRV-77 (newline-only anchor), SRV-78 (detect/strip primitives).
// ───────────────────────────────────────────────────────────────────────────
describe("sanitizeContent — brief-460 level/fence/anchor contract", () => {
  it("SRV-03 level-aware: headers DEEPER than targetLevel survive byte-identical; levels <= targetLevel are neutralized", () => {
    const input = "## escape\n### subsection\n#### detail";
    const outcome = sanitizeContent(input, { targetLevel: 2 });
    expect(outcome.text).toBe(`##${ZWS} escape\n### subsection\n#### detail`);
    expect(outcome.neutralized).toEqual([{ line: 1, header: "## escape" }]);
  });

  it("KI-26 regression pin: the original exploit shape — `## Injected` against a `##` target (level 2 <= 2) — is still neutralized", () => {
    const outcome = sanitizeContent("body\n## Injected", { targetLevel: 2 });
    expect(outcome.text).toBe(`body\n##${ZWS} Injected`);
    expect(outcome.neutralized).toHaveLength(1);
  });

  it("KI-26 regression pin: `# Top` against a `##` target (level 1 <= 2) is still neutralized", () => {
    const outcome = sanitizeContent("# Top\nbody", { targetLevel: 2 });
    expect(outcome.text).toBe(`#${ZWS} Top\nbody`);
  });

  it("defaults to targetLevel 6 (every level neutralized) when no options are given", () => {
    const outcome = sanitizeContent("###### deepest");
    expect(outcome.text).toBe(`######${ZWS} deepest`);
  });

  it("SRV-29 fence-aware: balanced fences protect their content; headers outside the fence are still neutralized", () => {
    const input = "## outside\n```bash\n# install\n## inside\n```\n## after";
    const outcome = sanitizeContent(input, { targetLevel: 6 });
    expect(outcome.text).toBe(
      `##${ZWS} outside\n\`\`\`bash\n# install\n## inside\n\`\`\`\n##${ZWS} after`,
    );
    expect(outcome.fencesBalanced).toBe(true);
    expect(outcome.neutralized.map((n) => n.line)).toEqual([1, 6]);
  });

  it("SRV-29 unbalanced-fence fallback: an odd fence count reverts to fence-blind neutralization", () => {
    const input = "```\n## header-shaped inside unterminated fence";
    const outcome = sanitizeContent(input);
    expect(outcome.fencesBalanced).toBe(false);
    expect(outcome.text).toBe(`\`\`\`\n##${ZWS} header-shaped inside unterminated fence`);
  });

  it("SRV-77 newline-only anchor: the first line is never touched (mid-line-embedded fields cannot start a header)", () => {
    const input = "## starts the field but lands mid-line\nbody";
    const outcome = sanitizeContent(input, { anchor: "newline-only", targetLevel: 3 });
    expect(outcome.text).toBe(input);
    expect(outcome.neutralized).toHaveLength(0);
  });

  it("SRV-77 newline-only + targetLevel 3: embedded `\\n####` detail survives, `\\n###`/`\\n##` are neutralized", () => {
    const input = "first line\n#### detail allowed\n### entry collision\n## section escape";
    const outcome = sanitizeContent(input, { anchor: "newline-only", targetLevel: 3 });
    expect(outcome.text).toBe(
      `first line\n#### detail allowed\n###${ZWS} entry collision\n##${ZWS} section escape`,
    );
    expect(outcome.neutralized.map((n) => n.header)).toEqual([
      "### entry collision",
      "## section escape",
    ]);
  });

  it("reports no mutation (empty neutralized) when nothing changes", () => {
    const outcome = sanitizeContent("plain prose\n- list item");
    expect(outcome.text).toBe("plain prose\n- list item");
    expect(outcome.neutralized).toHaveLength(0);
  });
});

describe("ZWS contamination primitives (brief-460 / SRV-78)", () => {
  it("detectZwsHeaders finds exactly the lines carrying the neutralization signature", () => {
    const contaminated = `clean line\n###${ZWS} Mangled One\nprose\n##${ZWS} Mangled Two\n### Real Header`;
    const found = detectZwsHeaders(contaminated);
    expect(found).toEqual([
      { line: 2, header: `###${ZWS} Mangled One` },
      { line: 4, header: `##${ZWS} Mangled Two` },
    ]);
  });

  it("detectZwsHeaders returns [] on clean content (including real headers)", () => {
    expect(detectZwsHeaders("## Real\n### Also Real\nbody")).toEqual([]);
  });

  it("stripZwsHeaders restores the neutralized signature to real headers (M-041 primitive; not wired into any write path)", () => {
    const contaminated = `###${ZWS} Mangled\nbody\n##${ZWS} Also Mangled`;
    expect(stripZwsHeaders(contaminated)).toBe("### Mangled\nbody\n## Also Mangled");
  });

  it("strip → detect round-trips to zero findings", () => {
    const contaminated = `#${ZWS} a\n##${ZWS} b`;
    expect(detectZwsHeaders(stripZwsHeaders(contaminated))).toEqual([]);
  });
});
