// T-4: Banner text format tests
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { renderBannerText, type BannerTextInput } from "../src/utils/banner.js";

function makeBannerInput(overrides: Partial<BannerTextInput> = {}): BannerTextInput {
  return {
    templateVersion: "2.10.0",
    sessionNumber: 29,
    timestamp: "04-04-26 07:47:30",
    handoffVersion: 33,
    handoffSizeKb: "4.4",
    decisionCount: 65,
    guardrailCount: 10,
    docCount: 10,
    docTotal: 10,
    tools: [
      { label: "bootstrap", status: "ok" },
      { label: "push verified", status: "ok" },
      { label: "template loaded", status: "ok" },
      { label: "no scaling needed", status: "ok" },
    ],
    resumption: "All S28 work complete. Verify IP allowlist deploy.",
    nextSteps: ["Verify IP allowlist deploy (S28)", "Implement D-48 server-side (S26)"],
    warnings: [],
    ...overrides,
  };
}

describe("T-4: banner text format", () => {
  it("returns a string under 500 bytes", () => {
    const text = renderBannerText(makeBannerInput());
    const byteLength = new TextEncoder().encode(text).length;
    expect(byteLength).toBeLessThan(500);
  });

  it("contains session number", () => {
    const text = renderBannerText(makeBannerInput({ sessionNumber: 42 }));
    expect(text).toContain("Session 42");
  });

  it("contains handoff version", () => {
    const text = renderBannerText(makeBannerInput({ handoffVersion: 33 }));
    expect(text).toContain("Handoff v33");
  });

  it("contains doc count with health status", () => {
    const text = renderBannerText(makeBannerInput({ docCount: 10, docTotal: 10 }));
    expect(text).toContain("10/10 docs healthy");
  });

  it("contains resumption point (truncated if >200 chars)", () => {
    const longResumption = "A".repeat(250);
    const text = renderBannerText(makeBannerInput({ resumption: longResumption }));
    expect(text).toContain("Resumption:");
    expect(text).toContain("...");
    // Should be truncated
    expect(text).not.toContain("A".repeat(250));
  });

  it("contains at least 1 next step", () => {
    const text = renderBannerText(makeBannerInput({ nextSteps: ["Step one", "Step two"] }));
    expect(text).toContain("Next:");
    expect(text).toContain("Step one");
  });

  it("contains tool verification status", () => {
    const text = renderBannerText(makeBannerInput());
    expect(text).toContain("bootstrap");
    expect(text).toContain("push verified");
    expect(text).toContain("\u2713"); // checkmark
  });
});
