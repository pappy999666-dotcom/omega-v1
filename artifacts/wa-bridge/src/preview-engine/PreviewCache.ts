// ============================================================
// Preview Engine — Cache
// Intelligent caching with TTL, LRU eviction, immutable entries,
// metadata cache, thumbnail cache, and URL cache.
// ============================================================

import type { CacheEntry, LinkMeta } from './types.js';
import { PreviewLogger } from './PreviewLogger.js';

// ── Configuration ───────────────────────────────────────────

const METADATA_TTL_MS = 30 * 60_000;     // 30 min
const THUMBNAIL_TTL_MS = 60 * 60_000;    // 60 min
const HQ_THUMBNAIL_TTL_MS = 2 * 60 * 60_000; // 2 hours
const MAX_META_ENTRIES = 500;
const MAX_THUMB_ENTRIES = 300;
const MAX_HQ_ENTRIES = 200;

// ── LRU Map Helper ──────────────────────────────────────────

function evictLRU<K>(map: Map<K, { expiresAt: number; insertedAt: number }>, maxSize: number): void {
  if (map.size < maxSize) return;
  // Remove oldest by insertedAt
  let oldestKey: K | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of map) {
    if (entry.insertedAt < oldestTime) {
      oldestTime = entry.insertedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    map.delete(oldestKey);
  }
}

// ── Preview Cache Class ─────────────────────────────────────

export class PreviewCache {
  private metaCache = new Map<string, { data: LinkMeta; expiresAt: number; insertedAt: number }>();
  private thumbCache = new Map<string, { buf: Uint8Array; expiresAt: number; insertedAt: number }>();
  private hqCache = new Map<string, { data: Record<string, unknown>; expiresAt: number; insertedAt: number }>();
  private urlCache = new Map<string, { normalized: string; expiresAt: number }>();

  // ── Normalization ─────────────────────────────────────────

  private normalizeKey(url: string): string {
    // Check URL cache first
    const cached = this.urlCache.get(url);
    if (cached && Date.now() < cached.expiresAt) return cached.normalized;
    try {
      const u = new URL(url);
      for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
        u.searchParams.delete(p);
      }
      const normalized = u.toString();
      this.urlCache.set(url, { normalized, expiresAt: Date.now() + METADATA_TTL_MS });
      return normalized;
    } catch {
      return url;
    }
  }

  // ── Metadata ──────────────────────────────────────────────

  getMeta(url: string): LinkMeta | null {
    const key = this.normalizeKey(url);
    const entry = this.metaCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.metaCache.delete(key);
      PreviewLogger.cacheMiss(url, 'meta');
      return null;
    }
    PreviewLogger.cacheHit(url, 'meta');
    return entry.data; // Already immutable (frozen)
  }

  setMeta(url: string, meta: LinkMeta): void {
    const key = this.normalizeKey(url);
    evictLRU(this.metaCache as unknown as Map<string, { expiresAt: number; insertedAt: number }>, MAX_META_ENTRIES);
    const frozen = Object.freeze({ ...meta }) as LinkMeta;
    const now = Date.now();
    this.metaCache.set(key, { data: frozen, expiresAt: now + METADATA_TTL_MS, insertedAt: now });
    PreviewLogger.cacheSet(url, 'meta');
  }

  // ── Thumbnail ─────────────────────────────────────────────

  getThumbnail(url: string): Uint8Array | undefined {
    const key = this.normalizeKey(url);
    const entry = this.thumbCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.thumbCache.delete(key);
      PreviewLogger.cacheMiss(url, 'thumbnail');
      return undefined;
    }
    PreviewLogger.cacheHit(url, 'thumbnail');
    return entry.buf;
  }

  setThumbnail(url: string, buf: Uint8Array): void {
    const key = this.normalizeKey(url);
    evictLRU(this.thumbCache as unknown as Map<string, { expiresAt: number; insertedAt: number }>, MAX_THUMB_ENTRIES);
    const frozen = Object.freeze(new Uint8Array(buf));
    const now = Date.now();
    this.thumbCache.set(key, { buf: frozen, expiresAt: now + THUMBNAIL_TTL_MS, insertedAt: now });
    PreviewLogger.cacheSet(url, 'thumbnail');
  }

  // ── HQ Thumbnail ──────────────────────────────────────────

  getHQ(url: string): Record<string, unknown> | undefined {
    const key = this.normalizeKey(url);
    const entry = this.hqCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.hqCache.delete(key);
      PreviewLogger.cacheMiss(url, 'hq');
      return undefined;
    }
    PreviewLogger.cacheHit(url, 'hq');
    return entry.data;
  }

  setHQ(url: string, data: Record<string, unknown>): void {
    const key = this.normalizeKey(url);
    evictLRU(this.hqCache as unknown as Map<string, { expiresAt: number; insertedAt: number }>, MAX_HQ_ENTRIES);
    const now = Date.now();
    // Deep freeze HQ data to prevent mutation
    const frozen = Object.freeze({
      ...data,
      ...(data['jpegThumbnail'] instanceof Uint8Array ? { jpegThumbnail: new Uint8Array(data['jpegThumbnail']) } : {}),
    });
    this.hqCache.set(key, { data: frozen, expiresAt: now + HQ_THUMBNAIL_TTL_MS, insertedAt: now });
    PreviewLogger.cacheSet(url, 'hq');
  }

  // ── Invalidation ──────────────────────────────────────────

  invalidate(url?: string): void {
    if (url) {
      const key = this.normalizeKey(url);
      this.metaCache.delete(key);
      this.thumbCache.delete(key);
      this.hqCache.delete(key);
      this.urlCache.delete(url);
    } else {
      this.metaCache.clear();
      this.thumbCache.clear();
      this.hqCache.clear();
      this.urlCache.clear();
    }
    PreviewLogger.cacheInvalidated(url);
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats(): {
    metaEntries: number;
    thumbnailEntries: number;
    hqEntries: number;
    urlEntries: number;
  } {
    return {
      metaEntries: this.metaCache.size,
      thumbnailEntries: this.thumbCache.size,
      hqEntries: this.hqCache.size,
      urlEntries: this.urlCache.size,
    };
  }

  /**
   * Deep-clone a thumbnail buffer to ensure immutability.
   */
  static cloneBuffer(buf: Uint8Array): Uint8Array {
    return new Uint8Array(buf);
  }
}

// ── Singleton ───────────────────────────────────────────────

export const previewCache = new PreviewCache();
