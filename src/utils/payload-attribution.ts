/**
 * Per-field byte attribution for an assembled response object (SRV-39 / SRV-68).
 *
 * The pre-brief-465 bootstrap `componentSizes` log attributed SOURCE sizes
 * (handoff.size, decisions content.length, prefetch source bytes) and omitted
 * 30+ delivered fields, so its keys summed to ~157,495 B against a real 115,842 B
 * response — it actively misdirected the payload diet (the S167 audit had to
 * rebuild attribution from scratch). This helper attributes DELIVERED bytes:
 * each top-level field's serialized JSON length, which reconciles to the
 * measured response within the JSON envelope overhead (keys/quotes/commas).
 *
 * Used by prism_bootstrap to (a) log accurate per-section sizes and (b) attach
 * the top-N largest sections to the BOOTSTRAP_OVERSIZE diagnostic so an operator
 * who sees the tripwire fire knows WHICH section drove the size.
 */
export interface PayloadAttribution {
  /** field name -> serialized JSON byte length of that field's value. */
  sizes: Record<string, number>;
  /** Σ of all field sizes (≈ serialized response minus JSON-envelope overhead). */
  total: number;
  /** The topN largest fields, descending — for the oversize diagnostic context. */
  top: Array<{ field: string; bytes: number }>;
}

/**
 * Compute delivered-byte attribution for an assembled response object.
 *
 * @param obj   the response object (measured BEFORE post-measurement attachments
 *              so the per-field sizes reconcile to the tripwire's `measured`).
 * @param topN  how many of the largest fields to surface (default 5).
 */
export function computePayloadAttribution(
  obj: Record<string, unknown>,
  topN = 5,
): PayloadAttribution {
  const sizes: Record<string, number> = {};
  let total = 0;
  for (const [key, value] of Object.entries(obj)) {
    // JSON.stringify(undefined) === undefined (not a string); such fields are
    // also omitted from the serialized envelope, so 0 is the correct charge.
    const bytes = JSON.stringify(value)?.length ?? 0;
    sizes[key] = bytes;
    total += bytes;
  }
  const top = Object.entries(sizes)
    .map(([field, bytes]) => ({ field, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topN);
  return { sizes, total, top };
}
