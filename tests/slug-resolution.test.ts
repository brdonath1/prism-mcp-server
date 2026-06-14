/**
 * Tests for resolveProjectSlug() — KI-15 server-side slug resolution.
 */

import { describe, it, expect } from "vitest";
import { resolveProjectSlug } from "../src/config.js";

describe("resolveProjectSlug", () => {
  // Completion criteria from the brief:

  it("resolves exact slug", () => {
    expect(resolveProjectSlug("platformforge-v2")).toBe("platformforge-v2");
  });

  it("resolves display name (case-insensitive)", () => {
    expect(resolveProjectSlug("PlatformForge v2")).toBe("platformforge-v2");
  });

  it("resolves Claude project name with hyphen", () => {
    expect(resolveProjectSlug("PlatformForge-v2")).toBe("platformforge-v2");
  });

  it("resolves PRISM Framework display name", () => {
    expect(resolveProjectSlug("PRISM Framework")).toBe("prism");
  });

  it("passes through nonexistent input", () => {
    expect(resolveProjectSlug("nonexistent")).toBe("nonexistent");
  });

  // Additional edge cases:

  it("resolves exact slug 'prism'", () => {
    expect(resolveProjectSlug("prism")).toBe("prism");
  });

  it("resolves case-insensitive slug", () => {
    expect(resolveProjectSlug("PRISM")).toBe("prism");
  });

  it("resolves display name with extra whitespace", () => {
    expect(resolveProjectSlug("  PlatformForge v2  ")).toBe("platformforge-v2");
  });

  it("resolves SnapQuote display name", () => {
    expect(resolveProjectSlug("SnapQuote")).toBe("snapquote-ai");
  });

  it("resolves Cash Plus Pawn FTP display name", () => {
    expect(resolveProjectSlug("Cash Plus Pawn FTP")).toBe("prism-cash-plus-pawn-ftp");
  });

  it("resolves ResVault display name", () => {
    expect(resolveProjectSlug("ResVault")).toBe("resvault");
  });

  it("resolves OpenClaw (case-sensitive slug)", () => {
    expect(resolveProjectSlug("OpenClaw")).toBe("OpenClaw");
  });

  it("resolves openclaw lowercase to OpenClaw", () => {
    // normalized match should handle this
    expect(resolveProjectSlug("openclaw")).toBe("OpenClaw");
  });
});

describe("display-name → slug resolution (via resolveProjectSlug)", () => {
  it("resolves all display names to slugs", () => {
    // SRV-113: the DISPLAY_NAME_TO_SLUG map is internal; assert behavior
    // through the public resolveProjectSlug surface instead.
    expect(resolveProjectSlug("prism framework")).toBe("prism");
    expect(resolveProjectSlug("platformforge v2")).toBe("platformforge-v2");
    expect(resolveProjectSlug("snapquote")).toBe("snapquote-ai");
  });
});
