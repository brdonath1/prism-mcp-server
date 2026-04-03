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
