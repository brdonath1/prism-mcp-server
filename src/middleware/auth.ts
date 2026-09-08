import type { Request, Response, NextFunction } from "express";
import {
  MCP_AUTH_TOKEN,
  ANTHROPIC_CIDRS,
  ALLOWED_CIDRS,
  ENABLE_IP_ALLOWLIST,
  resolveAuthRequireBearer,
} from "../config.js";
import { timingSafeEqual } from "node:crypto";
import { isIpInAnyCidr } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";

/**
 * Timing-safe string comparison — prevents character-by-character brute force.
 */
function safeTokenCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Trusted request context for privileged tools; IP fallback never grants this proof. */
export function isBearerAuthenticated(req: Pick<Request, "headers">): boolean {
  const header = req.headers.authorization;
  return Boolean(MCP_AUTH_TOKEN && typeof header === "string" &&
    header.startsWith("Bearer ") && safeTokenCompare(header.slice(7), MCP_AUTH_TOKEN));
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

  // Supabase credentials are also reachable through privileged legacy tools
  // such as railway_env. Protect the entire service when either credential is
  // present, even if Supabase configuration is malformed or its tools disabled.
  // This must fail closed if MCP_AUTH_TOKEN is missing; IP access is not proof.
  const hasSupabaseCredentials = Boolean(
    process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_PROJECT_CREDENTIALS_JSON,
  );
  if (hasSupabaseCredentials && !isBearerAuthenticated(req)) {
    const invalidToken = Boolean(MCP_AUTH_TOKEN && req.headers.authorization?.startsWith("Bearer "));
    logger.warn("Supabase credential protection rejected unauthenticated request", { path: req.path });
    res.status(invalidToken ? 403 : 401).json({ error: "A valid Bearer token is required" });
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

    // S208 PR-S3 / audit R20, GATED (default OFF). The reject for a MISSING or
    // non-Bearer Authorization header lives OUTSIDE the startsWith("Bearer ")
    // branch above, because that is exactly the case the branch cannot see: a
    // request with no credential at all skipped the token check entirely and
    // fell through to the IP allowlist below. With AUTH_REQUIRE_BEARER on, a
    // configured token is a REQUIRED token and the request stops here.
    //
    // 401 (not 403) is deliberate: the client is unauthenticated, not
    // forbidden, and the distinction is what tells an operator reading logs
    // that the connector never sent a credential. Default OFF keeps 4.13.2
    // behavior byte-identical -- see resolveAuthRequireBearer in config.ts for
    // why the flip is an operator action rather than a merge.
    if (resolveAuthRequireBearer()) {
      logger.warn("Missing Bearer token", { ip: getClientIp(req), path: req.path });
      res.status(401).json({ error: "Unauthorized: Bearer token required" });
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
