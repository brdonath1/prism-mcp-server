// brief-439 (D-240 Phase B, R8): unified drift-proof banner generator tests.
// Boot + finalization banners MUST come from the ONE generator and be
// structurally consistent by construction. Also covers the Rule 2 single-line
// null fallback and the banner_spec_version template-declaration parser.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  BANNER_SPEC_VERSION,
  renderUnifiedBanner,
  renderBannerFallback,
  parseTemplateBannerSpecVersion,
  type UnifiedBannerInput,
} from "../src/utils/banner.js";

function makeBootInput(overrides: Partial<UnifiedBannerInput> = {}): UnifiedBannerInput {
  return {
    surface: "boot",
    templateVersion: "2.10.0",
    sessionNumber: 29,
    timestamp: "04-04-26 07:47:30",
    handoffVersion: 33,
    handoffNote: "4.4KB",
    decisionCount: 65,
    decisionNote: "10 guardrails",
    docCount: 10,
    docTotal: 10,
    statusRow: [
      { label: "bootstrap", status: "ok" },
      { label: "push verified", status: "ok" },
      { label: "template loaded", status: "ok" },
      { label: "no scaling needed", status: "ok" },
    ],
    suggested: null,
    resumption: "All S28 work complete. Verify IP allowlist deploy.",
    listItems: ["Verify IP allowlist deploy (S28)", "Implement D-48 server-side (S26)"],
    warnings: [],
    ...overrides,
  };
}

function makeFinalizeInput(overrides: Partial<UnifiedBannerInput> = {}): UnifiedBannerInput {
  return {
    surface: "finalize",
    templateVersion: "2.10.0",
    sessionNumber: 29,
    timestamp: "04-04-26 18:30:00",
    handoffVersion: 34,
    handoffNote: "pushed",
    decisionCount: 65,
    decisionNote: null,
    docCount: 6,
    docTotal: 10,
    statusRow: [
      { label: "audit", status: "ok" },
      { label: "draft", status: "ok" },
      { label: "commit", status: "ok" },
      { label: "verified", status: "ok" },
    ],
    suggested: null,
    resumption: "All S29 work complete.",
    listItems: ["6 files pushed"],
    warnings: [],
    ...overrides,
  };
}

// ── Boot surface grammar (byte-compat with the pre-R8 renderBannerText) ──────

describe("unified banner — boot surface grammar", () => {
  it("line 1 is the version/session/timestamp line", () => {
    const lines = renderUnifiedBanner(makeBootInput()).split("\n");
    expect(lines[0]).toBe("PRISM v2.10.0 | Session 29 | 04-04-26 07:47:30 CST");
  });

  it("line 2 is the handoff/decisions/docs line", () => {
    const lines = renderUnifiedBanner(makeBootInput()).split("\n");
    expect(lines[1]).toBe(
      "Handoff v33 (4.4KB) | 65 decisions (10 guardrails) | 10/10 docs healthy",
    );
  });

  it("line 3 is the tool status row", () => {
    const lines = renderUnifiedBanner(makeBootInput()).split("\n");
    expect(lines[2]).toBe(
      "✓ bootstrap | ✓ push verified | ✓ template loaded | ✓ no scaling needed",
    );
  });

  it("renders warn and critical status icons", () => {
    const text = renderUnifiedBanner(
      makeBootInput({
        statusRow: [
          { label: "bootstrap", status: "ok" },
          { label: "push failed", status: "warn" },
          { label: "template missing", status: "critical" },
        ],
      }),
    );
    expect(text.split("\n")[2]).toBe(
      "✓ bootstrap | ⚠ push failed | ✗ template missing",
    );
  });

  it("Suggested line occupies position 4 when present", () => {
    const lines = renderUnifiedBanner(
      makeBootInput({
        suggested: { display: "Opus 4.7 · Adaptive off", rationale: "Executional queue" },
      }),
    ).split("\n");
    expect(lines[3]).toBe("Suggested: Opus 4.7 · Adaptive off — Executional queue");
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("Resumption: All S28 work complete. Verify IP allowlist deploy.");
  });

  it("Suggested line is omitted entirely when null (no blank placeholder)", () => {
    const lines = renderUnifiedBanner(makeBootInput({ suggested: null })).split("\n");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("Resumption: All S28 work complete. Verify IP allowlist deploy.");
  });

  it("first next step carries the [priority] tag, later steps do not", () => {
    const text = renderUnifiedBanner(makeBootInput());
    expect(text).toContain("Next:");
    expect(text).toContain("▸ Verify IP allowlist deploy (S28) [priority]");
    expect(text).toContain("▸ Implement D-48 server-side (S26)");
    expect(text).not.toContain("Implement D-48 server-side (S26) [priority]");
  });

  it("resumption is truncated to 200 chars with ellipsis", () => {
    const text = renderUnifiedBanner(makeBootInput({ resumption: "A".repeat(250) }));
    expect(text).toContain("Resumption: " + "A".repeat(197) + "...");
    expect(text).not.toContain("A".repeat(250));
  });

  it("strips markdown from resumption and steps", () => {
    const text = renderUnifiedBanner(
      makeBootInput({
        resumption: "**Bold** resumption with `code`",
        listItems: ["Do *italic* thing"],
      }),
    );
    expect(text).toContain("Resumption: Bold resumption with code");
    expect(text).toContain("▸ Do italic thing [priority]");
  });

  it("renders warning lines prefixed with the warning glyph", () => {
    const text = renderUnifiedBanner(
      makeBootInput({ warnings: ["Handoff is 16.2KB — exceeds 15KB critical threshold."] }),
    );
    expect(text).toContain("⚠ Handoff is 16.2KB — exceeds 15KB critical threshold.");
  });

  it("omits the Next block when there are no list items", () => {
    const text = renderUnifiedBanner(makeBootInput({ listItems: [] }));
    expect(text).not.toContain("Next:");
    expect(text).not.toContain("▸");
  });

  it("stays under 500 bytes for typical input", () => {
    const byteLength = new TextEncoder().encode(renderUnifiedBanner(makeBootInput())).length;
    expect(byteLength).toBeLessThan(500);
  });
});

// ── Finalize surface grammar ─────────────────────────────────────────────────

describe("unified banner — finalize surface grammar", () => {
  it("line 1 carries the finalized tag in the session segment", () => {
    const lines = renderUnifiedBanner(makeFinalizeInput()).split("\n");
    expect(lines[0]).toBe("PRISM v2.10.0 | Session 29 finalized | 04-04-26 18:30:00 CST");
  });

  it("line 2 is the handoff/decisions/docs-updated line", () => {
    const lines = renderUnifiedBanner(makeFinalizeInput()).split("\n");
    expect(lines[1]).toBe("Handoff v34 (pushed) | 65 decisions | 6/10 docs updated");
  });

  it("line 2 includes the decision note parenthetical when provided", () => {
    const lines = renderUnifiedBanner(makeFinalizeInput({ decisionNote: "2 new" })).split("\n");
    expect(lines[1]).toBe("Handoff v34 (pushed) | 65 decisions (2 new) | 6/10 docs updated");
  });

  it("line 3 is the finalization step row", () => {
    const lines = renderUnifiedBanner(makeFinalizeInput()).split("\n");
    expect(lines[2]).toBe("✓ audit | ✓ draft | ✓ commit | ✓ verified");
  });

  it("list block is labeled Deliverables and items carry no [priority] tag", () => {
    const text = renderUnifiedBanner(makeFinalizeInput());
    expect(text).toContain("Deliverables:");
    expect(text).toContain("▸ 6 files pushed");
    expect(text).not.toContain("[priority]");
    expect(text).not.toContain("Next:");
  });

  it("supports the Suggested line at position 4 like boot", () => {
    const lines = renderUnifiedBanner(
      makeFinalizeInput({
        suggested: { display: "Sonnet 4.6 · Adaptive off", rationale: "Mechanical queue" },
      }),
    ).split("\n");
    expect(lines[3]).toBe("Suggested: Sonnet 4.6 · Adaptive off — Mechanical queue");
  });

  it("contains no HTML", () => {
    const text = renderUnifiedBanner(makeFinalizeInput());
    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
  });
});

// ── Structural consistency: boot and finalize share one skeleton ─────────────

describe("unified banner — boot/finalize structural consistency", () => {
  /** Classify each banner line into its structural role. */
  function skeleton(text: string): string[] {
    return text.split("\n").map((line) => {
      if (line === "") return "blank";
      if (/^PRISM v.+ \| Session \d+( finalized)? \| .+ CST$/.test(line)) return "header";
      if (/^Handoff v\d+ \(.+\) \| \d+ decisions( \(.+\))? \| \d+\/\d+ docs (healthy|updated)$/.test(line)) return "counts";
      if (/^Suggested: .+ — .+$/.test(line)) return "suggested";
      if (/^Resumption: /.test(line)) return "resumption";
      if (/^(Next|Deliverables):$/.test(line)) return "list-label";
      if (/^▸ /.test(line)) return "list-item";
      if (/^⚠ /.test(line)) return "warning";
      return `status-row`;
    });
  }

  it("identical feature sets produce identical line skeletons", () => {
    const boot = renderUnifiedBanner(
      makeBootInput({
        suggested: { display: "Opus 4.7", rationale: "r" },
        warnings: ["w1"],
      }),
    );
    const finalize = renderUnifiedBanner(
      makeFinalizeInput({
        suggested: { display: "Opus 4.7", rationale: "r" },
        warnings: ["w1"],
        listItems: ["a", "b"],
      }),
    );
    expect(skeleton(finalize)).toEqual(skeleton(boot));
  });

  it("both surfaces use the same status icon set and separator", () => {
    const boot = renderUnifiedBanner(makeBootInput()).split("\n")[2];
    const finalize = renderUnifiedBanner(makeFinalizeInput()).split("\n")[2];
    for (const row of [boot, finalize]) {
      expect(row).toMatch(/^[✓⚠✗] .+( \| [✓⚠✗] .+)*$/);
    }
  });

  it("lines 1-3 are always present on both surfaces (Rule 2 / Rule 11 contract)", () => {
    for (const input of [makeBootInput(), makeFinalizeInput()]) {
      const lines = renderUnifiedBanner(input).split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      expect(lines[0]).toMatch(/^PRISM v/);
      expect(lines[1]).toMatch(/^Handoff v/);
      expect(lines[2]).toMatch(/^[✓⚠✗] /);
    }
  });
});

// ── Null fallback (Rule 2 single-line format) ────────────────────────────────

describe("unified banner — single-line fallback", () => {
  it("matches the Rule 2 fallback format exactly", () => {
    const line = renderBannerFallback({
      sessionNumber: 29,
      handoffVersion: 33,
      docCount: 10,
      docTotal: 10,
    });
    expect(line).toBe("PRISM | Session 29 | Handoff v33 | 10/10 docs");
  });

  it("is a single line with no trailing whitespace", () => {
    const line = renderBannerFallback({
      sessionNumber: 1,
      handoffVersion: 1,
      docCount: 0,
      docTotal: 10,
    });
    expect(line).not.toContain("\n");
    expect(line).toBe(line.trim());
  });
});

// ── banner_spec_version handshake parsing ────────────────────────────────────

describe("banner_spec_version handshake", () => {
  it("BANNER_SPEC_VERSION is a semver-ish string", () => {
    expect(BANNER_SPEC_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it("parses a plain template declaration", () => {
    const content = "# Template\n\nBanner-Spec-Version: 3.0\n\nRules.";
    expect(parseTemplateBannerSpecVersion(content)).toBe("3.0");
  });

  it("parses a bold blockquote declaration (template header style)", () => {
    const content = "# PRISM Core Template v2.20.0\n\n> **Template Version:** 2.20.0\n> **Banner-Spec-Version:** 3.0\n";
    expect(parseTemplateBannerSpecVersion(content)).toBe("3.0");
  });

  it("tolerates spacing/underscore variants and a v prefix", () => {
    expect(parseTemplateBannerSpecVersion("banner spec version: v3.1")).toBe("3.1");
    expect(parseTemplateBannerSpecVersion("Banner_Spec_Version: 2.0")).toBe("2.0");
  });

  it("returns null when the template declares nothing", () => {
    const content = "# PRISM Core Template v2.19.1\n\n> **Template Version:** 2.19.1\n";
    expect(parseTemplateBannerSpecVersion(content)).toBeNull();
  });

  it("returns null on malformed declarations", () => {
    expect(parseTemplateBannerSpecVersion("Banner-Spec-Version: soon")).toBeNull();
    expect(parseTemplateBannerSpecVersion("")).toBeNull();
  });
});
