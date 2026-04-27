import type { Request, Response, NextFunction } from "express";
import { MCP_AUTH_TOKEN, ANTHROPIC_CIDRS, ALLOWED_CIDRS, ENABLE_IP_ALLOWLIST } from "../config.js";
import { timingSafeEqual } from "node:crypto";
import { isIpInAnyCidr } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";

/**
 * Timing-safe string comparison — prevents character-by-character brute force.
 */
function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Extract the real client IP from the request.
 * Railway (and most reverse proxies) set X-Forwarded-For.
 * The leftmost value is the original client IP.
 * Note: We parse X-Forwarded-For directly rather than using Express trust proxy
 * because Railway's proxy setup can return IPv6-mapped addresses via req.ip.
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
      if (safeTokenCompare(token, MCP_AUTH_TOKEN)) {
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
