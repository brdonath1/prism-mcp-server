/**
 * Bearer token authentication middleware (B.2).
 * Skips auth if MCP_AUTH_TOKEN is not configured (development mode).
 */

import { type Request, type Response, type NextFunction } from "express";
import { MCP_AUTH_TOKEN } from "../config.js";
import { logger } from "../utils/logger.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no token configured (development mode)
  if (!MCP_AUTH_TOKEN) {
    next();
    return;
  }

  // Skip auth for health check
  if (req.path === "/health") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Unauthorized request — missing or malformed Authorization header", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: "Unauthorized — Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== MCP_AUTH_TOKEN) {
    logger.warn("Unauthorized request — invalid token", {
      ip: req.ip,
      path: req.path,
    });
    res.status(403).json({ error: "Forbidden — invalid token" });
    return;
  }

  next();
}
