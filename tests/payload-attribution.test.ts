import { describe, it, expect } from "vitest";
import { computePayloadAttribution } from "../src/utils/payload-attribution.js";

// SRV-68 / SRV-39: the pre-brief-465 componentSizes attributed SOURCE sizes and
// omitted 30+ fields, so its keys summed to 157,495 vs the real 115,842. The
// replacement attributes DELIVERED (assembled JSON) sizes that reconcile to the
// measured response, and surfaces the top-N for the BOOTSTRAP_OVERSIZE diagnostic.
describe("computePayloadAttribution (SRV-39 / SRV-68)", () => {
  it("attributes each field its delivered JSON byte size", () => {
    const obj = { a: "hello", b: [1, 2, 3], c: null };
    const attr = computePayloadAttribution(obj);
    expect(attr.sizes.a).toBe(JSON.stringify("hello").length);
    expect(attr.sizes.b).toBe(JSON.stringify([1, 2, 3]).length);
    expect(attr.sizes.c).toBe(4); // "null"
  });

  it("per-field sizes reconcile to the serialized total within JSON-envelope overhead (SRV-68 missing_test)", () => {
    const obj = {
      handoff: "x".repeat(8000),
      index: Array.from({ length: 100 }, (_, i) => ({ id: i, t: "t" })),
      brief: "y".repeat(4000),
    };
    const attr = computePayloadAttribution(obj);
    const serialized = JSON.stringify(obj).length;
    // The only difference between Σ(value sizes) and the full serialization is
    // the JSON envelope (keys, quotes, colons, commas, braces) — a small,
    // positive overhead. The old source-size attribution OVERSHOT the real size;
    // the delivered attribution reconciles within that envelope.
    const envelopeOverhead = serialized - attr.total;
    expect(envelopeOverhead).toBeGreaterThan(0);
    expect(attr.total).toBeGreaterThan(serialized * 0.9);
    expect(attr.total).toBeLessThanOrEqual(serialized);
  });

  it("returns the top-N largest fields for the oversize diagnostic (SRV-39)", () => {
    const obj = { small: "a", big: "x".repeat(1000), medium: "y".repeat(100) };
    const attr = computePayloadAttribution(obj, 2);
    expect(attr.top.map((t) => t.field)).toEqual(["big", "medium"]);
    expect(attr.top[0].bytes).toBeGreaterThan(attr.top[1].bytes);
    expect(attr.top.length).toBe(2);
  });

  it("treats undefined-valued fields as zero bytes", () => {
    const obj = { present: "abc", absent: undefined };
    const attr = computePayloadAttribution(obj);
    expect(attr.sizes.absent).toBe(0);
    expect(attr.sizes.present).toBe(JSON.stringify("abc").length);
  });
});
