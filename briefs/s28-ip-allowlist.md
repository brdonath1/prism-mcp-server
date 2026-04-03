# Brief: MCP Endpoint IP Allowlist Middleware

**Session:** S28
**Target Repo:** prism-mcp-server (brdonath1/)
**Risk Level:** Medium — production middleware change, but additive (no existing behavior removed)
**Estimated Duration:** 10-15 minutes

---

## Pre-Flight

**Context:** The S28 mega audit remediation added Bearer token auth middleware (`src/middleware/auth.ts`). However, claude.ai custom connectors only support OAuth for authentication — they cannot send custom headers like `Authorization: Bearer <token>`. This means enabling `MCP_AUTH_TOKEN` in Railway would lock out the claude.ai connector.

The correct approach for a single-user personal MCP server: IP allowlisting using Anthropic's published outbound CIDR range (`160.79.104.0/21`). This blocks all non-Anthropic traffic without requiring any connector configuration changes.

**Source:** https://docs.anthropic.com/en/api/ip-addresses

**Design:**
The middleware checks three things in order:
1. Is the request to `/health`? → Allow (Railway healthcheck needs this)
2. Is `MCP_AUTH_TOKEN` set AND does the request have a matching Bearer token? → Allow (optional secondary path for scripts or future claude.ai custom header support)
3. Does the request IP fall within an allowed CIDR range? → Allow
4. None of the above → 403 Forbidden

The allowed CIDR ranges default to Anthropic's published range (`160.79.104.0/21`) but can be extended via the `ALLOWED_CIDRS` environment variable (comma-separated CIDR blocks) for adding personal IPs, VPN ranges, etc.

When NO security is configured (no `MCP_AUTH_TOKEN`, no `ALLOWED_CIDRS`, and the default Anthropic range is not explicitly disabled), the middleware allows all traffic — preserving current behavior for development.

**Important:** `MCP_AUTH_TOKEN` does NOT need to be set in Railway. The IP allowlist handles claude.ai security automatically. The Bearer token path is purely optional.

---

## Step 1: Read Current Auth Middleware

```bash
cat src/middleware/auth.ts
cat src/config.ts
cat src/index.ts
```

Understand the current Bearer token middleware structure before modifying.

## Step 2: Add CIDR Utility

Create `src/utils/cidr.ts`:

```typescript
/**
 * Lightweight CIDR range checker.
 * No external dependencies — pure bit math.
 */

function ipToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network = ipToLong(ip) & mask;
  return { network, mask };
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const ipLong = ipToLong(ip);
    const { network, mask } = parseCidr(cidr);
    return (ipLong & mask) === network;
  } catch {
    return false;
  }
}

export function isIpInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some(cidr => isIpInCidr(ip, cidr));
}
```

## Step 3: Add Config Constants

In `src/config.ts`, add:

```typescript
/**
 * Anthropic's published outbound IP range for MCP tool calls.
 * Source: https://docs.anthropic.com/en/api/ip-addresses
 * This range covers claude.ai and Claude Desktop outbound requests.
 * Anthropic commits to advance notice before changing these IPs.
 */
export const ANTHROPIC_CIDRS = ["160.79.104.0/21"];

/**
 * Additional allowed CIDR ranges (comma-separated).
 * Use to add personal IPs, VPN ranges, etc.
 * Example: "203.0.113.0/24,198.51.100.42/32"
 */
export const ALLOWED_CIDRS = process.env.ALLOWED_CIDRS
  ? process.env.ALLOWED_CIDRS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

/**
 * When true, IP allowlisting is active.
 * Defaults to true — set to "false" to disable (e.g., local development).
 */
export const ENABLE_IP_ALLOWLIST = process.env.ENABLE_IP_ALLOWLIST !== "false";
```

## Step 4: Rewrite Auth Middleware

Replace `src/middleware/auth.ts` with the combined middleware:

```typescript
import { type Request, type Response, type NextFunction } from "express";
import { MCP_AUTH_TOKEN, ANTHROPIC_CIDRS, ALLOWED_CIDRS, ENABLE_IP_ALLOWLIST } from "../config.js";
import { isIpInAnyCidr } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";

/**
 * Extract the real client IP from the request.
 * Railway (and most reverse proxies) set X-Forwarded-For.
 * The leftmost value is the original client IP.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "";
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 1. Always allow health checks (Railway needs this)
  if (req.path === "/health") {
    next();
    return;
  }

  // 2. If Bearer token is configured and provided, check it
  if (MCP_AUTH_TOKEN) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === MCP_AUTH_TOKEN) {
        next();
        return;
      }
      // Wrong token — don't fall through to IP check, reject immediately
      logger.warn("Invalid Bearer token", { ip: getClientIp(req), path: req.path });
      res.status(403).json({ error: "Forbidden — invalid token" });
      return;
    }
  }

  // 3. IP allowlist check
  if (ENABLE_IP_ALLOWLIST) {
    const clientIp = getClientIp(req);
    const allAllowedCidrs = [...ANTHROPIC_CIDRS, ...ALLOWED_CIDRS];

    if (isIpInAnyCidr(clientIp, allAllowedCidrs)) {
      next();
      return;
    }

    logger.warn("Request from non-allowed IP", { ip: clientIp, path: req.path });
    res.status(403).json({ error: "Forbidden — IP not in allowlist" });
    return;
  }

  // 4. No security configured — allow all (development mode)
  next();
}
```

## Step 5: Update .env.example

Add the new environment variables:

```
# IP Allowlisting (enabled by default)
# Anthropic's 160.79.104.0/21 is always allowed when IP allowlisting is active.
# Add additional CIDR ranges (comma-separated) for personal/VPN access:
# ALLOWED_CIDRS=203.0.113.0/24,198.51.100.42/32
# To disable IP allowlisting entirely (e.g., local development):
# ENABLE_IP_ALLOWLIST=false

# Optional Bearer token auth (secondary to IP allowlist)
# MCP_AUTH_TOKEN=your-secret-token-here
```

## Step 6: Add Tests

Create `tests/cidr.test.ts`:

```typescript
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
```

## Step 7: Build, Test, Commit, Push

```bash
cd /tmp/prism-mcp-server && git pull && npm run build && npm test && git add -A && git commit -m "fix: replace Bearer-only auth with IP allowlist + Bearer hybrid middleware" && git push
```

---

## Verification

- [ ] `npm run build` compiles with zero errors
- [ ] `npm test` passes all tests including new CIDR tests
- [ ] `src/utils/cidr.ts` exists with `isIpInCidr` and `isIpInAnyCidr` exports
- [ ] `src/middleware/auth.ts` checks: health bypass → Bearer token → IP allowlist → reject
- [ ] `src/config.ts` has `ANTHROPIC_CIDRS`, `ALLOWED_CIDRS`, `ENABLE_IP_ALLOWLIST`
- [ ] `.env.example` documents all three new env vars
- [ ] `tests/cidr.test.ts` covers /21, /32, /0 ranges plus edge cases
- [ ] No `MCP_AUTH_TOKEN` is required in Railway for normal operation
- [ ] GET /health is always allowed regardless of IP or token

## Post-Flight

After Railway deploys:
1. Verify the claude.ai connector still works (it should — Anthropic IPs are allowed by default)
2. No connector reconnection needed — tool surface hasn't changed
3. No new env vars need to be set in Railway — defaults are correct

If you ever need to add your personal IP for direct access (e.g., testing with MCP Inspector), set `ALLOWED_CIDRS=YOUR.IP.HERE/32` in Railway.

<!-- EOF: s28-ip-allowlist.md -->