// T-4: Banner text format tests.
//
// brief-439 (D-240 Phase B, R8): the boot banner now comes from the unified
// generator (renderUnifiedBanner, surface "boot"). The expected strings below
// are unchanged from the pre-R8 renderBannerText suite — they double as the
// byte-compatibility proof that unification did not alter the boot banner
// grammar Rule 2 consumes.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { renderUnifiedBanner, type UnifiedBannerInput } from "../src/utils/banner.js";

function makeBannerInput(overrides: Partial<UnifiedBannerInput> = {}): UnifiedBannerInput {
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
    resumption: "All S28 work complete. Verify IP allowlist deploy.",
    listItems: ["Verify IP allowlist deploy (S28)", "Implement D-48 server-side (S26)"],
    warnings: [],
    ...overrides,
  };
}

describe("T-4: banner text format", () => {
  it("returns a string under 500 bytes", () => {
    const text = renderUnifiedBanner(makeBannerInput());
    const byteLength = new TextEncoder().encode(text).length;
    expect(byteLength).toBeLessThan(500);
  });

  it("contains session number", () => {
    const text = renderUnifiedBanner(makeBannerInput({ sessionNumber: 42 }));
    expect(text).toContain("Session 42");
  });

  it("contains handoff version", () => {
    const text = renderUnifiedBanner(makeBannerInput({ handoffVersion: 33 }));
    expect(text).toContain("Handoff v33");
  });

  it("contains doc count with health status", () => {
    const text = renderUnifiedBanner(makeBannerInput({ docCount: 10, docTotal: 10 }));
    expect(text).toContain("10/10 docs healthy");
  });

  it("contains resumption point (truncated if >200 chars)", () => {
    const longResumption = "A".repeat(250);
    const text = renderUnifiedBanner(makeBannerInput({ resumption: longResumption }));
    expect(text).toContain("Resumption:");
    expect(text).toContain("...");
    // Should be truncated
    expect(text).not.toContain("A".repeat(250));
  });

  it("contains at least 1 next step", () => {
    const text = renderUnifiedBanner(makeBannerInput({ listItems: ["Step one", "Step two"] }));
    expect(text).toContain("Next:");
    expect(text).toContain("Step one");
  });

  it("contains tool verification status", () => {
    const text = renderUnifiedBanner(makeBannerInput());
    expect(text).toContain("bootstrap");
    expect(text).toContain("push verified");
    expect(text).toContain("✓"); // checkmark
  });

  it("byte-compat: full boot banner matches the pre-R8 renderBannerText output", () => {
    // Frozen expected output captured from the pre-unification generator.
    const text = renderUnifiedBanner(
      makeBannerInput({
        suggested: { display: "Sonnet 5 · Adaptive on", rationale: "Executional queue" },
        warnings: ["Handoff is 16.2KB"],
      }),
    );
    expect(text).toBe(
      [
        "PRISM v2.10.0 | Session 29 | 04-04-26 07:47:30 CST",
        "Handoff v33 (4.4KB) | 65 decisions (10 guardrails) | 10/10 docs healthy",
        "✓ bootstrap | ✓ push verified | ✓ template loaded | ✓ no scaling needed",
        "Suggested: Sonnet 5 · Adaptive on — Executional queue",
        "",
        "Resumption: All S28 work complete. Verify IP allowlist deploy.",
        "",
        "Next:",
        "▸ Verify IP allowlist deploy (S28) [priority]",
        "▸ Implement D-48 server-side (S26)",
        "",
        "⚠ Handoff is 16.2KB",
      ].join("\n"),
    );
  });
});
