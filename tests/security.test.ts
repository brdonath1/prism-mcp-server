// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { validateFilePath, validateProjectSlug } from "../src/validation/slug.js";
import { isIpInCidr } from "../src/utils/cidr.js";

describe("Path traversal prevention (C-1)", () => {
  it("rejects URL-encoded traversal: %2e%2e/etc/passwd", () => {
    const result = validateFilePath("%2e%2e/etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("..");
  });

  it("rejects mixed traversal: ..%2f", () => {
    const result = validateFilePath("..%2f");
    expect(result.valid).toBe(false);
  });

  it("rejects null byte: %00", () => {
    const result = validateFilePath("%00");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("null byte");
  });

  it("rejects raw null byte", () => {
    const result = validateFilePath("foo\x00bar");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("null byte");
  });

  it("rejects nested encoding: %252e%252e", () => {
    // %252e decodes to %2e — the path still contains encoded traversal after one decode
    const result = validateFilePath("%252e%252e/%252f");
    expect(result.valid).toBe(false);
  });

  it("rejects URL-encoded leading slash: %2fetc/passwd", () => {
    const result = validateFilePath("%2fetc/passwd");
    expect(result.valid).toBe(false);
  });

  it("accepts valid relative paths", () => {
    expect(validateFilePath("handoff.md").valid).toBe(true);
    expect(validateFilePath(".prism/handoff.md").valid).toBe(true);
    expect(validateFilePath("decisions/_INDEX.md").valid).toBe(true);
  });

  it("rejects empty path", () => {
    expect(validateFilePath("").valid).toBe(false);
  });

  it("rejects raw traversal", () => {
    expect(validateFilePath("../etc/passwd").valid).toBe(false);
  });

  it("rejects absolute path", () => {
    expect(validateFilePath("/etc/passwd").valid).toBe(false);
  });
});

describe("Slug validation — null bytes (M-2)", () => {
  it("rejects slug with null byte", () => {
    const result = validateProjectSlug("my-project\x00evil");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("null byte");
  });

  it("rejects empty slug", () => {
    expect(validateProjectSlug("").valid).toBe(false);
  });

  it("rejects oversized slug", () => {
    const result = validateProjectSlug("a".repeat(101));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("100");
  });

  it("rejects slug with special characters", () => {
    expect(validateProjectSlug("my project").valid).toBe(false);
    expect(validateProjectSlug("my/project").valid).toBe(false);
    expect(validateProjectSlug("../evil").valid).toBe(false);
  });

  it("accepts valid slugs", () => {
    expect(validateProjectSlug("prism").valid).toBe(true);
    expect(validateProjectSlug("my-project").valid).toBe(true);
    expect(validateProjectSlug("project_123").valid).toBe(true);
  });
});

describe("Decision ID format validation (M-3)", () => {
  it("valid IDs: D-1 through D-9999", () => {
    const validIds = ["D-1", "D-42", "D-999", "D-9999"];
    const regex = /^D-\d{1,4}$/;
    for (const id of validIds) {
      expect(regex.test(id)).toBe(true);
    }
  });

  it("rejects D-99999 (too many digits)", () => {
    expect(/^D-\d{1,4}$/.test("D-99999")).toBe(false);
  });

  it("rejects D-abc (non-numeric)", () => {
    expect(/^D-\d{1,4}$/.test("D-abc")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(/^D-\d{1,4}$/.test("")).toBe(false);
  });

  it("rejects missing prefix", () => {
    expect(/^D-\d{1,4}$/.test("42")).toBe(false);
  });
});

describe("Insight ID format validation (M-3)", () => {
  it("valid IDs: INS-1 through INS-9999", () => {
    const validIds = ["INS-1", "INS-42", "INS-999", "INS-9999"];
    const regex = /^INS-\d{1,4}$/;
    for (const id of validIds) {
      expect(regex.test(id)).toBe(true);
    }
  });

  it("rejects INS-99999 (too many digits)", () => {
    expect(/^INS-\d{1,4}$/.test("INS-99999")).toBe(false);
  });

  it("rejects INS-abc (non-numeric)", () => {
    expect(/^INS-\d{1,4}$/.test("INS-abc")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(/^INS-\d{1,4}$/.test("")).toBe(false);
  });

  it("rejects wrong prefix", () => {
    expect(/^INS-\d{1,4}$/.test("D-42")).toBe(false);
  });
});

// SRV-83 (brief-461 Task C): behavioral CIDR test, replacing the prior
// source-string grep (the grep "passes" even if the runtime is broken — it
// missed the SRV-26 prefix-widening bug). Exercises isIpInCidr directly.
// NOTE: the auth-middleware source greps below (timing-safe / IP extraction)
// are intentionally NOT converted here — behavioralizing the auth path means
// exercising the OR/AND token-vs-IP composition, which is SRV-36, explicitly
// OUT OF SCOPE for brief-461 (deferred to an operator-gated deploy).
describe("CIDR IPv6 awareness (M-1) — behavioral (SRV-83)", () => {
  it("returns false (not a crash) for a pure IPv6 client address against an IPv4 CIDR", () => {
    expect(isIpInCidr("2001:db8::1", "160.79.104.0/21")).toBe(false);
    expect(isIpInCidr("::1", "160.79.104.0/21")).toBe(false);
  });

  it("returns false for an IPv6 CIDR (unsupported) rather than throwing", () => {
    expect(isIpInCidr("160.79.104.1", "::/0")).toBe(false);
  });

  it("still matches IPv6-mapped IPv4 against an IPv4 CIDR", () => {
    expect(isIpInCidr("::ffff:160.79.104.1", "160.79.104.0/21")).toBe(true);
  });
});

describe("Timing-safe auth (C-2)", () => {
  it("auth middleware uses timingSafeEqual", () => {
    const { readFileSync } = require("fs");
    const source = readFileSync("src/middleware/auth.ts", "utf-8");
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("safeTokenCompare");
    // Should NOT use === for token comparison
    expect(source).not.toContain("token === MCP_AUTH_TOKEN");
  });
});

describe("Client IP extraction (H-5)", () => {
  it("auth middleware uses req.ip as fallback", () => {
    const { readFileSync } = require("fs");
    const source = readFileSync("src/middleware/auth.ts", "utf-8");
    expect(source).toContain("req.ip");
  });

  it("auth middleware parses X-Forwarded-For", () => {
    const { readFileSync } = require("fs");
    const source = readFileSync("src/middleware/auth.ts", "utf-8");
    expect(source).toContain("x-forwarded-for");
  });
});

describe("Log sanitization (M-6)", () => {
  it("AI client sanitizes API keys in error logs", () => {
    const { readFileSync } = require("fs");
    const source = readFileSync("src/ai/client.ts", "utf-8");
    expect(source).toContain("sk-***REDACTED***");
    expect(source).toContain("sanitized");
  });
});
