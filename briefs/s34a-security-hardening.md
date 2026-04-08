# Brief S34a: Security Hardening

## Pre-Flight

- Repo: `prism-mcp-server`
- Branch: `main`
- `git pull origin main && npm install && npm run build && npm test`
- All 298+ tests must pass before starting
- Reference: `docs/audit-s33c.md` for full finding details

## Findings Addressed

| ID | Title | Severity | File(s) |
|----|-------|----------|--------|
| C-1 | Path traversal via URL-encoded input | CRITICAL | `src/validation/slug.ts:21-32` |
| C-2 | Bearer token comparison not timing-safe | CRITICAL | `src/middleware/auth.ts:34` |
| H-5 | X-Forwarded-For header spoofing | HIGH | `src/middleware/auth.ts:11-20` |
| M-1 | IPv6 not supported in CIDR validation | MEDIUM | `src/utils/cidr.ts:6-17` |
| M-2 | Null byte not checked in validateProjectSlug | MEDIUM | `src/validation/slug.ts:8-19` |
| M-3 | Zod schema permissiveness on decision/insight IDs | MEDIUM | `src/tools/log-decision.ts:18-26`, `src/tools/log-insight.ts` |
| M-6 | Error information leakage in synthesis logs | MEDIUM | `src/ai/client.ts:76-77` |

## Changes Required

### C-1: Path Traversal Fix (`src/validation/slug.ts`)

In `validateFilePath()`:
1. Call `decodeURIComponent(path)` before any validation checks
2. Add null byte check: reject if path contains `\x00`
3. After decoding, re-check for `..` traversal sequences
4. Reject any path where decoded form differs from raw form AND contains traversal patterns
5. Add test cases for: `%2e%2e/etc/passwd`, `..%2f`, `%00`, nested encoding `%252e%252e`

### C-2: Timing-Safe Token Comparison (`src/middleware/auth.ts`)

Replace the `===` token comparison with:
```typescript
import { timingSafeEqual } from "crypto";

// Timing-safe comparison — prevents character-by-character brute force
function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```
Use `safeTokenCompare(token, MCP_AUTH_TOKEN)` instead of `token === MCP_AUTH_TOKEN`.

### H-5: X-Forwarded-For Trust (`src/middleware/auth.ts`)

The current code trusts the leftmost IP from `X-Forwarded-For` without proxy verification. Fix:
1. Add `app.set('trust proxy', 1)` in `src/index.ts` (Railway runs behind 1 proxy)
2. In the auth middleware, use `req.ip` (which respects trust proxy) instead of manually parsing `X-Forwarded-For`
3. Keep the `X-Forwarded-For` parsing as a fallback only if `req.ip` is undefined

### M-1: IPv6 Awareness (`src/utils/cidr.ts`)

The `ipToLong()` function only handles IPv4. Fix:
1. Detect IPv6 addresses (contains `:`)
2. For IPv6: log a warning and return `false` from `isIpInCidr()` (don't crash)
3. Add a comment noting that full IPv6 CIDR support should be added if Anthropic publishes IPv6 ranges

### M-2: Null Byte in Slug Validation (`src/validation/slug.ts`)

In `validateProjectSlug()`, add before existing checks:
```typescript
if (slug.includes("\x00")) {
  return { valid: false, error: "Project slug contains null byte" };
}
```

### M-3: Zod Schema Tightening (`src/tools/log-decision.ts`, `src/tools/log-insight.ts`)

Add format validation to ID parameters:
- Decision IDs: `z.string().regex(/^D-\d{1,4}$/)` with descriptive error message
- Insight IDs: `z.string().regex(/^INS-\d{1,4}$/)` with descriptive error message
- Domain strings: `z.string().min(1).max(50)` to prevent oversized inputs

**IMPORTANT (INS-6):** Do NOT use `.default()` in Zod schemas. Use `.optional()` and handle defaults in the function body.

### M-6: Synthesis Log Sanitization (`src/ai/client.ts`)

In the catch block of `synthesize()`, sanitize the error message before logging:
```typescript
const sanitized = message.replace(/sk-[a-zA-Z0-9_-]+/g, "sk-***REDACTED***");
logger.error("Synthesis API call failed", { error: sanitized, ms: Date.now() - start });
```

## Tests Required

Create `tests/security.test.ts`:
- Path traversal: `%2e%2e/etc/passwd`, `..%2f`, null bytes, nested encoding
- Slug validation: null bytes, oversized slugs, special characters
- Decision ID format: valid `D-1` through `D-9999`, reject `D-99999`, `D-abc`, empty
- Insight ID format: valid `INS-1` through `INS-9999`, reject invalid formats

Verify existing tests still pass after auth changes.

## Verification

```bash
npm run build && npm test
# All tests pass

grep -rn "timingSafeEqual" src/middleware/auth.ts
# Expected: 1 match

grep -rn "decodeURIComponent" src/validation/slug.ts
# Expected: 1+ matches

grep -rn "\\\\x00" src/validation/slug.ts
# Expected: 1+ matches (null byte check)

grep -rn "heads/main" src/
# Expected: 0 matches (verify S33 fix preserved)
```

## Post-Flight

```bash
git add -A && git commit -m 'fix: security hardening — path traversal, timing-safe auth, input validation (S34a)' && git push origin main
```

<!-- EOF: s34a-security-hardening.md -->
