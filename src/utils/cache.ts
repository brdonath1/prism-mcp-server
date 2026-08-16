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
  private readonly maxEntries: number;

  /**
   * @param name - Human-readable cache name for logging
   * @param ttlMinutes - Time-to-live in minutes (default: 5)
   * @param maxEntries - Hard cap on retained entries (default: 200). Both a
   *   TTL and a size bound are house policy (S208 PR-S2a): the rule-source
   *   cache holds whole documents (prism standing-rules.md alone is ~320KB),
   *   so an unbounded map keyed by (repo, doc) is a slow memory leak on a
   *   fleet-wide server. Eviction is insertion-order (oldest first); `set` on
   *   an existing key refreshes its position, so hot keys survive.
   */
  constructor(name: string, ttlMinutes = 5, maxEntries = 200) {
    this.name = name;
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.maxEntries = Math.max(1, maxEntries);

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
    // Size bound (S208 PR-S2a). Re-setting an existing key must refresh its
    // insertion position, so delete-then-set; only a genuinely new key can
    // push the cache over the cap, and then the OLDEST entry is dropped.
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) {
        this.store.delete(oldest.value);
        logger.debug("cache evicted (size cap)", {
          cache: this.name,
          key: oldest.value,
          maxEntries: this.maxEntries,
        });
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
    logger.debug(`cache set`, { cache: this.name, key, ttlMinutes: this.ttlMs / 60000 });
  }

  /** Entry count (post-eviction is not forced) - test/observability helper. */
  get size(): number {
    return this.store.size;
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
 * One cached rule-source document (S208 PR-S2a / MCP-1).
 *
 * `etag` is the GitHub Contents-API validator for the EXACT `path` the entry
 * was resolved at. Every cache hit still round-trips to GitHub with
 * `If-None-Match: <etag>` -- the cache never serves a body without asking, so
 * a hit is byte-identical to a fresh fetch by construction. What it saves is
 * the ~320KB body on the (overwhelmingly common) unchanged case, which GitHub
 * answers with a bodiless 304 that does not even count against the rate limit.
 */
export interface RuleSourceCacheEntry {
  /** Resolved path the entry was fetched from (`.prism/x.md` or legacy `x.md`). */
  path: string;
  /** Full decoded document body. */
  content: string;
  /** Blob sha reported by the Contents API - the parse-cache key. */
  sha: string;
  /** ETag validator, or null when GitHub returned none (no conditional path). */
  etag: string | null;
  /** True when the entry resolved via the legacy repo-root fallback. */
  legacy: boolean;
}

/**
 * Rule-source document cache (S208 PR-S2a): standing-rules.md, insights.md and
 * standing-rules-archive.md, keyed `${repo}:${docName}`. TTL is a backstop
 * only -- correctness comes from the conditional request, not the clock.
 * Bounded at 60 entries (20 repos x 3 rule sources).
 */
export const ruleSourceCache = new MemoryCache<RuleSourceCacheEntry>("rule-source", 30, 60);

/**
 * Resolved boot-test push path per repo (S208 PR-S2a / MCP-16).
 *
 * `resolveDocPushPath` costs up to TWO existence probes before the push can
 * start; the answer is a property of the repo layout, not of the session, so
 * after the first boot the chain collapses to sha-read + PUT. Invalidated
 * whenever the push using the cached path fails, so a repo that migrates
 * boot-test.md re-probes on the next boot instead of writing to a stale path.
 * TTL 60 min / 100 repos bounds the staleness window either way.
 */
export const bootTestPathCache = new MemoryCache<string>("boot-test-path", 60, 100);

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
