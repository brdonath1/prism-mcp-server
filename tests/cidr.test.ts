import { describe, it, expect } from "vitest";
import { isIpInCidr, isIpInAnyCidr } from "../src/utils/cidr.js";

describe("CIDR utilities", () => {
  describe("isIpInCidr", () => {
    it("matches IP within /21 range", () => {
      // 160.79.104.0/21 covers 160.79.104.0 - 160.79.111.255
      expect(isIpInCidr("160.79.104.1", "160.79.104.0/21")).toBe(true);
      expect(isIpInCidr("160.79.111.255", "160.79.104.0/21")).toBe(true);
      expect(isIpInCidr("160.79.108.42", "160.79.104.0/21")).toBe(true);
    });

    it("rejects IP outside /21 range", () => {
      expect(isIpInCidr("160.79.112.0", "160.79.104.0/21")).toBe(false);
      expect(isIpInCidr("160.79.103.255", "160.79.104.0/21")).toBe(false);
      expect(isIpInCidr("10.0.0.1", "160.79.104.0/21")).toBe(false);
    });

    it("matches exact /32", () => {
      expect(isIpInCidr("1.2.3.4", "1.2.3.4/32")).toBe(true);
      expect(isIpInCidr("1.2.3.5", "1.2.3.4/32")).toBe(false);
    });

    it("handles /0 (match all)", () => {
      expect(isIpInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
      expect(isIpInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
    });

    it("returns false for malformed input", () => {
      expect(isIpInCidr("not-an-ip", "160.79.104.0/21")).toBe(false);
      expect(isIpInCidr("1.2.3.4", "bad-cidr")).toBe(false);
    });

    // SRV-26 (brief-461 Task C): a prefix outside 0–32 must be REJECTED, not
    // silently wrapped by JS's mod-32 shift (a `/33` typo otherwise widens the
    // allowlist to a /1 — ~1 billion addresses). Out-of-range prefixes return
    // false regardless of the IP.
    it("rejects an out-of-range /33 prefix (does not widen the mask)", () => {
      expect(isIpInCidr("1.2.3.4", "1.2.3.0/33")).toBe(false);
      // Concrete widening proof: under the bug, /33 behaves like ~/1 and admits
      // half of IPv4 — a low address must NOT match a high-address /33.
      expect(isIpInCidr("10.0.0.1", "1.2.3.0/33")).toBe(false);
    });

    it("rejects a negative prefix", () => {
      expect(isIpInCidr("1.2.3.4", "1.2.3.0/-1")).toBe(false);
    });

    it("rejects a prefix above 32 (e.g. /64)", () => {
      expect(isIpInCidr("1.2.3.4", "1.2.3.0/64")).toBe(false);
    });

    it("rejects a non-numeric prefix", () => {
      expect(isIpInCidr("1.2.3.4", "1.2.3.0/abc")).toBe(false);
    });

    it("rejects an IP with an out-of-range octet (>255)", () => {
      // 999 overflows a byte; under the bug it bleeds into the next octet and
      // can spuriously match. A malformed IP must never match — even /0.
      expect(isIpInCidr("999.1.1.1", "0.0.0.0/0")).toBe(false);
      expect(isIpInCidr("1.2.3.256", "1.2.4.0/24")).toBe(false);
    });
  });

  describe("isIpInAnyCidr", () => {
    const cidrs = ["160.79.104.0/21", "10.0.0.0/8"];

    it("matches against any CIDR in list", () => {
      expect(isIpInAnyCidr("160.79.106.1", cidrs)).toBe(true);
      expect(isIpInAnyCidr("10.1.2.3", cidrs)).toBe(true);
    });

    it("rejects when no CIDR matches", () => {
      expect(isIpInAnyCidr("192.168.1.1", cidrs)).toBe(false);
    });

    it("returns false for empty CIDR list", () => {
      expect(isIpInAnyCidr("1.2.3.4", [])).toBe(false);
    });
  });
});
