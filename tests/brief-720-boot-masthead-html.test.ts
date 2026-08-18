// brief-720 (S9) — boot_masthead_html: an ADDITIVE HTML masthead carrying the
// same information as boot_masthead_svg plus an embedded copyable session name.
//
// The load-bearing guarantee is backward compatibility: `boot_masthead_svg`
// must stay byte-identical so a consumer that does not know the new field
// exists sees no change from an unrelated banner change. SVG_AT_4_14_9 below
// is the literal render re-captured at server 4.14.9 (banner color
// self-containment, D10). The old "locks that guarantee for good" wording is
// retired -- a byte-exact pin cannot be both permanent and re-specifiable --
// so this constant instead locks the render against COLLATERAL drift: it
// moves only on a deliberate, reviewed edit to renderBootMastheadSvg, and the
// reviewer diffs old vs new to confirm exactly the var() expressions changed.
import { describe, it, expect } from "vitest";
import {
  renderBootMastheadHtml,
  renderBootMastheadSvg,
  renderFinalizationBannerHtml,
  type UnifiedBannerInput,
  type FinalizationBannerHtmlInput,
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

/** renderBootMastheadSvg(INPUT), re-captured at server 4.14.9 (D10): the
 *  byte-exact anti-collateral-drift pin. Only the four lines carrying a
 *  `--color-border-tertiary` / `--color-background-primary` var() chain
 *  differ from the pre-4.14.9 capture (a stroke/fill widened to the
 *  documented-token-first chained fallback); every other byte is identical. */
const SVG_AT_4_14_9 = `<svg width="100%" viewBox="0 0 680 256" role="img" xmlns="http://www.w3.org/2000/svg">
<title>PRISM boot banner masthead</title>
<desc>Boot status masthead showing session 9, timestamp, handoff and decision counts, 4 status checks, chat session title, and the suggested session setting.</desc>
<rect x="40" y="40" width="600" height="200" rx="12" class="box"/>
<g class="c-purple"><rect x="65" y="64" width="14" height="14" rx="2" transform="rotate(45 72 71)"/></g>
<g class="c-purple"><text x="92" y="80" class="th" font-size="24">PRISM</text></g>
<text x="182" y="80" class="ts" font-size="13">v2.19.1</text>
<g class="c-green"><rect x="556" y="60" width="60" height="22" rx="11"/><text x="586" y="75" class="ts" text-anchor="middle">boot</text></g>
<line x1="64" y1="98" x2="616" y2="98" stroke="var(--border,var(--color-border-tertiary,rgba(11,11,11,0.10)))" stroke-width="0.5"/>
<text x="64" y="124" class="th" font-size="13">Chat: PRISM MCP Server — Session 9: 07-27-26 14:32:07 CST</text>
<rect x="64" y="144" width="150" height="24" rx="6" fill="var(--surface-1,var(--color-background-primary,#fcfcfb))" stroke="var(--border,var(--color-border-tertiary,rgba(11,11,11,0.10)))" stroke-width="0.5"/>
<text x="139" y="160" class="ts" text-anchor="middle">Handoff v41 · 8.4KB</text>
<rect x="226" y="144" width="190" height="24" rx="6" fill="var(--surface-1,var(--color-background-primary,#fcfcfb))" stroke="var(--border,var(--color-border-tertiary,rgba(11,11,11,0.10)))" stroke-width="0.5"/>
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
<line x1="64" y1="208" x2="616" y2="208" stroke="var(--border,var(--color-border-tertiary,rgba(11,11,11,0.10)))" stroke-width="0.5"/>
<text x="64" y="228" class="ts">Suggested: Opus 4.6 · extended thinking — architecture + multi-file refactor</text>
</svg>`;

const HTML = renderBootMastheadHtml(INPUT);

/** N10 / section 11 fixture: minimum legal finalize input. */
const FIN_MIN: FinalizationBannerHtmlInput = {
  templateVersion: "2.19.1",
  sessionNumber: 1,
  timestamp: "01-01-26 00:00:00",
  handoffFromVersion: 1,
  handoffToVersion: 2,
  handoffStatus: "pushed",
  decisionCount: 1,
  decisionDelta: null,
  docCount: 1,
  docTotal: 2,
  statusRow: [{ label: "verified", status: "ok" }],
  deliverables: ["One deliverable"],
  llmUsage: null,
  next: null,
  nextSessionNameLine: null,
};

/** N10 / section 11 fixture: maximum legal finalize input -- 4 status rows,
 *  12 deliverables of 160 chars each (the enforced caps, see
 *  tests/finalize-banner-caps.test.ts), 8 LLM usage rows, next +
 *  nextSessionNameLine set, all docs updated. */
const FIN_MAX: FinalizationBannerHtmlInput = {
  templateVersion: "2.19.1",
  sessionNumber: 999,
  timestamp: "12-31-26 23:59:59",
  handoffFromVersion: 199,
  handoffToVersion: 200,
  handoffStatus: "pushed",
  decisionCount: 999,
  decisionDelta: 40,
  docCount: 10,
  docTotal: 10,
  statusRow: [
    { label: "docs updated", status: "ok" },
    { label: "index synced", status: "warn" },
    { label: "pushed", status: "critical" },
    { label: "verified", status: "ok" },
  ],
  deliverables: Array.from({ length: 12 }, (_, i) => `D${i}`.padEnd(160, "x")),
  llmUsage: Array.from({ length: 8 }, (_, i) => ({
    aspect: `Aspect ${i + 1}`,
    model: `Model ${i + 1}`,
    settings: `Settings ${i + 1}`,
  })),
  next: "Next-session pointer for the growth-bound fixture",
  nextSessionNameLine: "PRISM Framework - Session 1000: 12-31-26 23:59:59 CST",
};

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
  it("renders byte-identically to the pinned 4.14.9 capture", () => {
    expect(renderBootMastheadSvg(INPUT)).toBe(SVG_AT_4_14_9);
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
  // Boot HTML has ZERO exceptions (unlike the finalize `.brand`/`.mark`
  // block, which is finalize-only). Server 4.14.9 legitimately introduces
  // color literals as var() fallback TERMINALS, so the invariant is no
  // longer "no literal anywhere" -- it is "no literal outside a var()
  // fallback position": for every hex/rgba/hsla match, the text between the
  // nearest preceding `;`, `{` or `"` and the match must contain `var(--`.
  it("contains no color literal outside a var() fallback position", () => {
    const literalRe = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|\b(?:rgba?|hsla?)\s*\([^)]*\)/g;
    const matches = [...HTML.matchAll(literalRe)];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      const upto = HTML.slice(0, m.index);
      const boundary = Math.max(upto.lastIndexOf(";"), upto.lastIndexOf("{"), upto.lastIndexOf('"'));
      const segment = HTML.slice(boundary + 1, m.index + m[0].length);
      expect(segment).toContain("var(--");
    }
  });

  it("routes every color through the --pbm-* private aliases, each chaining a documented token first", () => {
    // Substring safety: `--pbm-surface-1:var(--surface-1,var(--color-` does
    // NOT contain `--surface-1:var(--color-`, and `var(--pbm-surface-1)`
    // does NOT contain `var(--surface-1)` -- the double leading hyphen
    // prevents any stale-name false pass.
    for (const name of [
      "--pbm-surface-1", "--pbm-surface-2", "--pbm-text-primary",
      "--pbm-text-secondary", "--pbm-border", "--pbm-tint-ok",
      "--pbm-tint-ok-surface", "--pbm-tint-danger",
    ]) {
      expect(HTML).toContain(`${name}:var(--`);
      expect(HTML).toContain(`var(${name})`);
    }
    // --pbm-tint-warn has ZERO style-block consumers (its only consumer is
    // HTML_STATUS_TINT_EXPR, interpolated inline -- see the N1 test below).
    expect(HTML).toContain("--pbm-tint-warn:var(--");
    expect(HTML).not.toContain("var(--pbm-tint-warn)");
    expect(HTML).toContain("--pbm-font-mono:var(--font-mono,");
    expect(HTML).toContain("font-family:var(--pbm-font-mono)");
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

describe("brief-720 -- 4.14.9 banner color self-containment (N1-N4, N7, N9, N10)", () => {
  it("N1 -- covers --pbm-tint-warn (zero style-block consumers) via the warn/critical status glyphs", () => {
    const html = renderBootMastheadHtml({
      ...INPUT,
      statusRow: [
        { label: "W", status: "warn" },
        { label: "C", status: "critical" },
      ],
    });
    expect(html).toContain("var(--pbm-tint-warn)");
    expect(html).toContain("var(--pbm-tint-danger)");
  });

  function documentedTokenFirst(payload: string) {
    const totalColor = (payload.match(/var\(--color-/g) ?? []).length;
    const chainedColor = (payload.match(/,var\(--color-/g) ?? []).length;
    expect(chainedColor).toBe(totalColor);
    // T12/T13 (D7) deliberately drop the --border-radius-* legacy link
    // entirely (D-Q0) -- neither a bare nor a chained form should remain.
    expect(payload).not.toMatch(/--border-radius-/);
  }
  it("N2 -- every migrated var() chain leads with the documented token; --color-*/--border-radius-* never appear as a first argument", () => {
    documentedTokenFirst(HTML);
    documentedTokenFirst(renderBootMastheadSvg(INPUT));
    documentedTokenFirst(renderFinalizationBannerHtml(FIN_MAX));
    // Neutral branches (docs not all healthy/updated): the SVG neutral docs
    // chip and the finalize neutral docsChipStyle are distinct migrated rows
    // in the plan's per-site table and must be scanned too.
    documentedTokenFirst(renderBootMastheadSvg({ ...INPUT, docCount: 9 }));
    documentedTokenFirst(renderFinalizationBannerHtml(FIN_MIN));
  });

  // Presentation-attribute exemptions (fold F1/D0): the brand diamond icon's
  // fill="currentColor" and the copy-button icon's stroke="currentColor" are
  // SVG presentation attributes, not var() terminals, and are stripped before
  // scanning the boot HTML payload for a bare currentColor/transparent.
  it("N3 -- every host-namespace var() chain terminates in a literal; no currentColor/transparent terminal survives outside the two named presentation-attribute exemptions", () => {
    const strippedHtml = HTML
      .replace(/fill="currentColor"/g, "")
      .replace(/stroke="currentColor"/g, "");
    expect(strippedHtml).not.toContain("currentColor");
    expect(strippedHtml).not.toContain("transparent");

    const svg = renderBootMastheadSvg(INPUT);
    expect(svg).not.toContain("currentColor");
    expect(svg).not.toContain("transparent");

    const fin = renderFinalizationBannerHtml(FIN_MAX);
    expect(fin).not.toContain("currentColor");
    expect(fin).not.toContain("transparent");
  });

  it("N4 -- no dangling --pbm-* alias and no cycle of any length in the boot masthead style block", () => {
    const style = HTML.match(/<style>([\s\S]*?)<\/style>/)![1];
    const definitions = style.match(/--pbm-[a-z0-9-]+:[^;]+;/g) ?? [];
    expect(definitions.length).toBeGreaterThan(0);
    const defined = new Set(definitions.map((d) => d.slice(0, d.indexOf(":"))));
    for (const name of defined) expect(name.startsWith("--pbm-")).toBe(true);
    // No definition's right-hand side references another --pbm-* name --
    // forbids direct AND indirect cycles by namespace disjointness.
    for (const def of definitions) expect(def).not.toMatch(/var\(--pbm-/);

    const consumed = [...HTML.matchAll(/var\((--pbm-[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(consumed.length).toBeGreaterThan(0);
    for (const name of consumed) expect(defined.has(name)).toBe(true);
  });

  it("N7 -- D-256 designation pills/chips carry both a surface AND text fallback from the same ramp stop pair", () => {
    expect(HTML).toMatch(/\.pbm-badge\{[^}]*color:var\(--pbm-tint-ok\)[^}]*background:var\(--pbm-tint-ok-surface\)/);
    expect(HTML).toMatch(/\.pbm-chip-ok\{[^}]*color:var\(--pbm-tint-ok\)[^}]*background:var\(--pbm-tint-ok-surface\)/);
    expect(HTML).toContain("--pbm-tint-ok:var(--text-success,var(--color-text-success,#27500A))");
    expect(HTML).toContain("--pbm-tint-ok-surface:var(--bg-success,var(--color-background-success,#EAF3DE))");

    const fin = renderFinalizationBannerHtml(FIN_MAX);
    expect(fin).toContain(
      "color:var(--text-danger,var(--color-text-danger,#791F1F));background:var(--bg-danger,var(--color-background-danger,#FCEBEB))",
    );
    expect(fin).toContain(
      "color:var(--text-success,var(--color-text-success,#27500A));background:var(--bg-success,var(--color-background-success,#EAF3DE))",
    );

    // Fold D-Q6: the caption data-state designations are D-256 elements 9-10
    // (text-role only, no surface component) and ride the same ramp-stop
    // aliases the pills use.
    expect(HTML).toContain('.pbm-caption[data-state="ok"]{color:var(--pbm-tint-ok);}');
    expect(HTML).toContain('.pbm-caption[data-state="fail"]{color:var(--pbm-tint-danger);}');
    expect(HTML).toContain("--pbm-tint-danger:var(--text-danger,var(--color-text-danger,#791F1F))");
  });

  it("N9 -- each legacy token maps to exactly one literal everywhere it appears (guards per-site literal drift)", () => {
    const literalFor: Record<string, string> = {
      "--color-background-primary": "#fcfcfb",
      "--color-background-secondary": "#ffffff",
      "--color-text-primary": "#0b0b0b",
      "--color-text-secondary": "#52514e",
      "--color-text-tertiary": "#898781",
      "--color-border-tertiary": "rgba(11,11,11,0.10)",
      "--color-text-success": "#27500A",
      "--color-background-success": "#EAF3DE",
      "--color-text-danger": "#791F1F",
      "--color-background-danger": "#FCEBEB",
      "--color-text-warning": "#633806",
    };
    const payloads = [
      HTML,
      renderBootMastheadSvg(INPUT),
      renderFinalizationBannerHtml(FIN_MAX),
      // Neutral branches (fold-adjacent coverage; see N2): the SVG neutral
      // docs chip and finalize neutral docsChipStyle rows.
      renderBootMastheadSvg({ ...INPUT, docCount: 9 }),
      renderFinalizationBannerHtml(FIN_MIN),
    ];
    for (const payload of payloads) {
      for (const [token, literal] of Object.entries(literalFor)) {
        const marker = `var(${token},`;
        let idx = payload.indexOf(marker);
        while (idx !== -1) {
          const after = payload.slice(idx + marker.length);
          expect(after.startsWith(literal)).toBe(true);
          idx = payload.indexOf(marker, idx + 1);
        }
      }
    }
  });

  // Section 11: growth <= +25% per surface vs the 0224a03c HEAD baseline, on
  // the four named fixtures above (BOOT = HTML, BOOT_SVG, FIN_MIN, FIN_MAX).
  it("N10 -- payload growth stays at or under +25% per surface vs the 0224a03c HEAD baseline", () => {
    const HEAD_BYTES = { boot: 7464, bootSvg: 2353, finMin: 3100, finMax: 12820 };
    const measured = {
      boot: Buffer.byteLength(HTML, "utf8"),
      bootSvg: Buffer.byteLength(renderBootMastheadSvg(INPUT), "utf8"),
      finMin: Buffer.byteLength(renderFinalizationBannerHtml(FIN_MIN), "utf8"),
      finMax: Buffer.byteLength(renderFinalizationBannerHtml(FIN_MAX), "utf8"),
    };
    for (const key of Object.keys(HEAD_BYTES) as Array<keyof typeof HEAD_BYTES>) {
      const growth = (measured[key] - HEAD_BYTES[key]) / HEAD_BYTES[key];
      expect(growth).toBeLessThanOrEqual(0.25);
    }
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
