/**
 * Express middleware for structured request logging with correlation IDs.
 * Logs method, path, status code, and response time for all requests.
 */

import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const { method, path } = req;
  const requestId = randomUUID();

  // Attach correlation ID to request for downstream use
  (req as Request & { requestId: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  // Log when response finishes
  res.on("finish", () => {
    const ms = Date.now() - start;
    const { statusCode } = res;

    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

    logger[level]("request", {
      requestId,
      method,
      path,
      status: statusCode,
      ms,
    });
  });

  next();
}
