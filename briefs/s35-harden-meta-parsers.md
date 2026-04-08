# Brief: Harden Handoff Meta Parsers

## Pre-Flight
- Read `src/validation/handoff.ts` — the three parse functions (`parseHandoffVersion`, `parseSessionCount`, `parseTemplateVersion`)
- Read `src/utils/summarizer.ts` — `extractSection` function
- Read existing tests: `grep -rn 'parseHandoffVersion\|parseSessionCount\|parseTemplateVersion' tests/`

## Problem
The three Meta parsers only handle list-format Meta sections:
```
## Meta
- **Handoff Version:** 40
- **Session Count:** 34
```

Two other formats exist in production:
1. **Table format** (OpenClaw had this): `| Handoff Version | v2 |` — regex `(\d+)` misses `v` prefix and pipe separators
2. **Missing Meta section** (PlatformForge-v2 had this): blockquote header `> **Handoff version:** 148` with no `## Meta`

Both cause `parseHandoffVersion` and `parseSessionCount` to return `null`, which falls back to `0` in bootstrap, making every session appear as "Session 1".

## Changes

### 1. Update `parseHandoffVersion` in `src/validation/handoff.ts`
Make the regex handle table format and `v` prefix:
```typescript
export function parseHandoffVersion(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    // Handle list format: "Handoff Version: 40" and table format: "| Handoff Version | v2 |"
    const listMatch = clean.match(/Handoff Version[:\s|]*v?(\d+)/i);
    if (listMatch) return parseInt(listMatch[1], 10);
  }
  
  // Fallback: search entire content for blockquote or inline format
  const fallback = stripBold(content).match(/Handoff Version[:\s|]*v?(\d+)/i);
  return fallback ? parseInt(fallback[1], 10) : null;
}
```

### 2. Update `parseSessionCount` in `src/validation/handoff.ts`
Same pattern, plus fallback to `Last updated: S{N}`:
```typescript
export function parseSessionCount(content: string): number | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    const listMatch = clean.match(/Session Count[:\s|]*v?(\d+)/i);
    if (listMatch) return parseInt(listMatch[1], 10);
  }
  
  // Fallback 1: search entire content
  const fallback1 = stripBold(content).match(/Session Count[:\s|]*v?(\d+)/i);
  if (fallback1) return parseInt(fallback1[1], 10);
  
  // Fallback 2: "Last updated: S134" pattern
  const fallback2 = content.match(/Last updated[:\s]*S(\d+)/i);
  return fallback2 ? parseInt(fallback2[1], 10) : null;
}
```

### 3. Update `parseTemplateVersion` in `src/validation/handoff.ts`
Same table/fallback pattern:
```typescript
export function parseTemplateVersion(content: string): string | null {
  const meta = extractSection(content, "Meta");
  if (meta) {
    const clean = stripBold(meta);
    const match = clean.match(/Template Version[:\s|]*(?:PRISM\s+)?v?([\d.]+)/i);
    if (match) return match[1];
  }
  
  const fallback = stripBold(content).match(/Template Version[:\s|]*(?:PRISM\s+)?v?([\d.]+)/i);
  return fallback ? fallback[1] : null;
}
```

### 4. Add tests in the appropriate test file
Add test cases for:
- List format (existing, should still pass)
- Table format: `| Handoff Version | v2 |`
- `v` prefix: `Handoff Version: v42`
- Missing `## Meta` with blockquote: `> **Handoff version:** 148`
- Missing `## Meta` with `Last updated: S134` fallback for session count
- Completely missing version info → returns `null`

## Verification
1. `npm test` — all existing tests pass
2. New test cases pass for all three format variants
3. No regressions in bootstrap, status, finalize, or analytics (all consumers of these functions)

## Post-Flight
1. Commit with message: `fix: harden meta parsers for table format, v-prefix, and missing Meta fallback`
2. Push to main

<!-- EOF: s35-harden-meta-parsers.md -->
