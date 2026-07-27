// brief-720 (S9) — boot_masthead_html: an ADDITIVE HTML masthead carrying the
// same information as boot_masthead_svg plus an embedded copyable session name.
//
// The load-bearing guarantee is backward compatibility: `boot_masthead_svg`
// must stay byte-identical so a consumer that does not know the new field
// exists sees no change at all. SVG_AT_BRIEF_720 below is the literal render
// captured from the pre-brief-720 tree (`git show HEAD:src/utils/banner.ts`
// transpiled standalone, 2,353 bytes) — it locks that guarantee for good.
import { describe, it, expect } from "vitest";
import {
  renderBootMastheadHtml,
  renderBootMastheadSvg,
  type UnifiedBannerInput,
} from "../src/utils/banner.js";

/** Representative production boot input (mirrors bootstrap.ts assembly). */
const INPUT: UnifiedBannerInput = {
  surface: "boot",
  templateVersion: "2.19.1",
  sessionNumber: 9,
  timestamp: "07-27-26 14:32:07",
  sessionNameLine: "PRISM MCP Server — Session 9: 07-27-26 14:32:07 CST",
  handoffVersion: 41,
  handoffNote: "8.4KB",
  decisionCount: 278,
  decisionNote: "12 guardrails",
  docCount: 10,
  docTotal: 10,
  statusRow: [
    { label: "MCP tools", status: "ok" },
    { label: "Boot test", status: "ok" },
    { label: "Docs healthy", status: "ok" },
    { label: "Handoff size", status: "ok" },
  ],
  suggested: {
    display: "Opus 4.6 · extended thinking",
    rationale: "architecture + multi-file refactor",
  },
  resumption: "Brief 720 — embed a copyable session name in the boot masthead.",
  listItems: ["Ship brief-720", "Write the companion kernel change"],
  warnings: [],
};

/** renderBootMastheadSvg(INPUT) as it rendered BEFORE brief-720. */
const SVG_AT_BRIEF_720 = `<svg width="100%" viewBox="0 0 680 256" role="img" xmlns="http://www.w3.org/2000/svg">
<title>PRISM boot banner masthead</title>
<desc>Boot status masthead showing session 9, timestamp, handoff and decision counts, 4 status checks, chat session title, and the suggested session setting.</desc>
<rect x="40" y="40" width="600" height="200" rx="12" class="box"/>
<g class="c-purple"><rect x="65" y="64" width="14" height="14" rx="2" transform="rotate(45 72 71)"/></g>
<g class="c-purple"><text x="92" y="80" class="th" font-size="24">PRISM</text></g>
<text x="182" y="80" class="ts" font-size="13">v2.19.1</text>
<g class="c-green"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>
<line x1="64" y1="98" x2="616" y2="98" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="64" y="124" class="th" font-size="13">Chat: PRISM MCP Server — Session 9: 07-27-26 14:32:07 CST</text>
<rect x="64" y="144" width="150" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="139" y="160" class="ts" text-anchor="middle">Handoff v41 · 8.4KB</text>
<rect x="226" y="144" width="190" height="24" rx="6" fill="var(--color-background-primary)" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="321" y="160" class="ts" text-anchor="middle">278 decisions · 12 guardrails</text>
<g class="c-green"><rect x="428" y="144" width="140" height="24" rx="6"/><text x="498" y="160" class="ts" text-anchor="middle">10/10 docs healthy</text></g>
<g class="c-green"><text x="64" y="192" class="th" font-size="13">✓</text></g>
<text x="78" y="192" class="ts">MCP tools</text>
<g class="c-green"><text x="152" y="192" class="th" font-size="13">✓</text></g>
<text x="166" y="192" class="ts">Boot test</text>
<g class="c-green"><text x="240" y="192" class="th" font-size="13">✓</text></g>
<text x="254" y="192" class="ts">Docs healthy</text>
<g class="c-green"><text x="345" y="192" class="th" font-size="13">✓</text></g>
<text x="359" y="192" class="ts">Handoff size</text>
<line x1="64" y1="208" x2="616" y2="208" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>
<text x="64" y="228" class="ts">Suggested: Opus 4.6 · extended thinking — architecture + multi-file refactor</text>
</svg>`;

const HTML = renderBootMastheadHtml(INPUT);

/** HTML void elements — they never push onto the element stack. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Minimal structural check: strip raw-text element bodies (`<script>`,
 * `<style>`), then walk every remaining tag and assert the element stack opens
 * and closes in order. Catches unbalanced/misnested markup without pulling in
 * an HTML parser dependency.
 */
function unbalancedTags(html: string): string[] {
  const stripped = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "<$1></$1>",
  );
  const stack: string[] = [];
  const problems: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = tagRe.exec(stripped)) !== null) {
    consumed += match[0].length;
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open ?? "nothing"}>`);
    } else if (!selfClosing && !VOID_ELEMENTS.has(name)) {
      stack.push(name);
    }
  }
  if (stack.length > 0) problems.push(`unclosed: ${stack.join(", ")}`);
  // Every `<` in the stripped markup must have been part of a parsed tag.
  const angleCount = (stripped.match(/</g) ?? []).length;
  const tagCount = (stripped.match(tagRe) ?? []).length;
  if (angleCount !== tagCount) {
    problems.push(`${angleCount} '<' chars but only ${tagCount} parsed tags`);
  }
  if (consumed === 0) problems.push("no tags parsed");
  return problems;
}

describe("brief-720 — boot_masthead_svg backward compatibility", () => {
  it("renders byte-identically to the pre-brief-720 output", () => {
    expect(renderBootMastheadSvg(INPUT)).toBe(SVG_AT_BRIEF_720);
  });

  it("is unaffected by rendering the HTML masthead from the same input", () => {
    const before = renderBootMastheadSvg(INPUT);
    renderBootMastheadHtml(INPUT);
    expect(renderBootMastheadSvg(INPUT)).toBe(before);
  });
});

describe("brief-720 — renderBootMastheadHtml content parity", () => {
  it("carries the wordmark, template version and boot badge", () => {
    expect(HTML).toContain(">PRISM</span>");
    expect(HTML).toContain("v2.19.1");
    expect(HTML).toContain(">boot</span>");
  });

  it("carries the session name, the three chips and every status check", () => {
    expect(HTML).toContain(INPUT.sessionNameLine!);
    expect(HTML).toContain("Handoff v41 · 8.4KB");
    expect(HTML).toContain("278 decisions · 12 guardrails");
    expect(HTML).toContain("10/10 docs healthy");
    for (const entry of INPUT.statusRow) expect(HTML).toContain(entry.label);
    expect(HTML.match(/class="pbm-glyph"/g)).toHaveLength(INPUT.statusRow.length);
  });

  it("carries the Suggested line, and omits it (with its divider) when null", () => {
    expect(HTML).toContain(
      "Suggested: Opus 4.6 · extended thinking — architecture + multi-file refactor",
    );
    expect((HTML.match(/class="pbm-rule"/g) ?? []).length).toBe(2);
    const bare = renderBootMastheadHtml({ ...INPUT, suggested: null });
    expect(bare).not.toContain("Suggested:");
    expect((bare.match(/class="pbm-rule"/g) ?? []).length).toBe(1);
  });

  it("degrades to a plain session line — no copy control — without a session name", () => {
    const bare = renderBootMastheadHtml({ ...INPUT, sessionNameLine: null });
    expect(bare).toContain("Session 9");
    expect(bare).not.toContain("data-prism-copy");
    expect(bare).not.toContain("<script>");
    expect(bare).toContain("07-27-26 14:32:07 CST");
  });

  it("escapes markup in interpolated fields", () => {
    const hostile = renderBootMastheadHtml({
      ...INPUT,
      sessionNameLine: `Proj <img> & "quoted" — Session 9`,
    });
    expect(hostile).toContain("Proj &lt;img&gt; &amp; &quot;quoted&quot; — Session 9");
    expect(hostile).not.toContain("<img>");
  });
});

describe("brief-720 — HTML constraints", () => {
  it("contains no hardcoded color literal", () => {
    expect(HTML.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g)).toBeNull();
    expect(HTML).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/);
  });

  it("routes every color through a CSS variable, with light/dark-safe fallbacks", () => {
    for (const name of [
      "--surface-1", "--surface-2", "--text-primary",
      "--text-secondary", "--border", "--tint-ok", "--tint-danger",
    ]) {
      expect(HTML).toContain(`${name}:var(--color-`);
      expect(HTML).toContain(`var(${name})`);
    }
    expect(HTML).toContain("--font-mono:");
    expect(HTML).toContain("font-family:var(--font-mono)");
  });

  it("loads no external resource", () => {
    expect(HTML).not.toMatch(/<script[^>]+src/i);
    expect(HTML).not.toMatch(/<link/i);
    expect(HTML).not.toMatch(/@import/i);
    expect(HTML).not.toMatch(/http/i);
    expect(HTML).not.toMatch(/position:\s*fixed/i);
  });

  it("is structurally balanced markup", () => {
    expect(unbalancedTags(HTML)).toEqual([]);
    expect(unbalancedTags(renderBootMastheadHtml({ ...INPUT, sessionNameLine: null }))).toEqual([]);
  });

  it("scopes every CSS rule under the masthead root id", () => {
    const style = HTML.match(/<style>([\s\S]*?)<\/style>/)![1];
    const selectors = style.split("}").map(s => s.split("{")[0].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) expect(selector.startsWith("#prism-boot-masthead")).toBe(true);
  });

  it("uses a 12px radius on the outer card", () => {
    expect(HTML).toContain("border-radius:12px");
  });
});

describe("brief-720 — accessibility + the copy control", () => {
  it("has a visually-hidden summary heading", () => {
    const heading = HTML.match(/<h2 style="([^"]+)">([^<]+)<\/h2>/);
    expect(heading).not.toBeNull();
    expect(heading![1]).toContain("clip:rect(0 0 0 0)");
    expect(heading![2]).toContain("PRISM boot banner");
    expect(heading![2]).toContain("session 9");
    expect(heading![2]).toContain(INPUT.sessionNameLine!);
  });

  it("gives the icon-only copy button an accessible label and a live status region", () => {
    expect(HTML).toContain('aria-label="Copy the session name to the clipboard"');
    expect(HTML).toMatch(/<button [^>]*>\s*<svg/);
    expect(HTML).toContain('aria-live="polite"');
    expect(HTML).toContain("Rename this chat to match");
    expect(HTML).not.toContain("Rename this chat to match.");
  });

  it("tries the clipboard API first, then the execCommand fallback", () => {
    expect(HTML).toContain("navigator.clipboard.writeText(text)");
    expect(HTML).toContain("document.execCommand('copy')");
    expect(HTML).toContain("document.createElement('textarea')");
  });

  it("has three distinct visible outcomes and never fails silently", () => {
    expect(HTML).toContain("say('Copied','ok',true)");
    expect(HTML).toContain("say('Copied via fallback','ok',true)");
    expect(HTML).toContain(
      "say('Copy failed \\u2014 select the name above and copy it manually','fail',false)",
    );
    // The failure state is the only one that does NOT auto-revert: a copy that
    // did not happen must stay on screen until the operator acts on it.
    expect(HTML).not.toMatch(/say\('Copy failed[^)]*'fail',true\)/);
  });
});
