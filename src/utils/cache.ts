/**
 * Simple in-memory cache with TTL for reducing redundant GitHub fetches.
 * Used primarily for the behavioral rules template which changes rarely (~monthly).
 */

import { logger } from "./logger.js";

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
