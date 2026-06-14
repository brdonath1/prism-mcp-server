/**
 * Simple in-memory cache with TTL for reducing redundant GitHub fetches.
 * Used primarily for the behavioral rules template which changes rarely (~monthly).
 */

import { logger } from "./logger.js";
import { FRAMEWORK_REPO, MCP_TEMPLATE_PATH } from "../config.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly name: string;

  /**
   * @param name - Human-readable cache name for logging
   * @param ttlMinutes - Time-to-live in minutes (default: 5)
   */
  constructor(name: string, ttlMinutes = 5) {
    this.name = name;
    this.ttlMs = ttlMinutes * 60 * 1000;

    // Proactive eviction every 5 minutes — .unref() allows process to exit cleanly
    const interval = setInterval(() => this.evictExpired(), 5 * 60 * 1000);
    interval.unref();
  }

  /** Remove all expired entries */
  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.debug("cache eviction", { cache: this.name, evicted, remaining: this.store.size });
    }
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      logger.debug(`cache miss (expired)`, { cache: this.name, key });
      return null;
    }
    logger.debug(`cache hit`, { cache: this.name, key });
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    logger.debug(`cache set`, { cache: this.name, key, ttlMinutes: this.ttlMs / 60000 });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/** Shared cache for the behavioral rules template (D-31). 5-minute TTL. */
export const templateCache = new MemoryCache<{ content: string; size: number }>("behavioral-rules", 5);

/**
 * Invalidate the behavioral-rules template cache when a write lands on the core
 * template (SRV-86). Pre-brief-465 only prism_push invalidated, so a template
 * update via prism_patch / prism_finalize / gh tools / a Claude Code dispatch
 * served stale rules for up to the 5-minute TTL. Call this from EVERY write path
 * that can land MCP_TEMPLATE_PATH on the framework repo so invalidation is no
 * longer coupled to a single tool.
 *
 * @param repo          the repo the write targeted.
 * @param writtenPaths  paths that successfully landed in this write.
 * @returns true if the template cache was invalidated.
 */
export function invalidateTemplateCacheOnWrite(repo: string, writtenPaths: string[]): boolean {
  if (repo !== FRAMEWORK_REPO) return false;
  if (!writtenPaths.includes(MCP_TEMPLATE_PATH)) return false;
  templateCache.invalidate(MCP_TEMPLATE_PATH);
  logger.info("template cache invalidated", { reason: "core template write", repo });
  return true;
}
