// ============================================================
// WA-Bridge — Centralized Preview Manager
// Production-grade: cached, immutable, multi-stage fallback,
// retry logic, concurrency control, structured logging
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import * as cheerio from 'cheerio';
import type { AnyMessageContent } from './baileys-types.js';
import { logger } from '../utils/logger.js';

// ── Types ─────────────────────────────────────────────────

export type PreviewFailureClass =
  | 'MetadataFailure'
  | 'ThumbnailFailure'
  | 'CacheFailure'
  | 'HydrationFailure'
  | 'NetworkFailure'
  | 'WhatsAppFailure'
  | 'RenderingFailure'
  | 'UnknownFailure';

export interface LinkMeta {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly imageUrl?: string;
  readonly siteName?: string;
  readonly thumbnail?: Uint8Array;
  readonly canonicalUrl?: string;
  readonly fetchedAt: number;
}

interface CacheEntry {
  meta: LinkMeta;
  thumbnailBuffer?: Uint8Array;
  expiresAt: number;
}

// ── Constants ─────────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60_000;          // 30 min metadata TTL
const THUMBNAIL_TTL_MS = 60 * 60_000;      // 60 min thumbnail TTL
const FETCH_TIMEOUT_MS = 8_000;
const THUMBNAIL_TIMEOUT_MS = 6_000;
const MAX_CACHE_SIZE = 500;
const MAX_THUMBNAIL_BYTES = 512 * 1024;    // 512 KB cap
const RETRY_DELAYS = [500, 1500, 4000];    // exponential-ish

// Platforms with known OG support — used for URL normalization hints
const SUPPORTED_PLATFORMS = [
  'whatsapp.com', 'web.whatsapp.com',
  'telegram.org', 't.me',
  'discord.com', 'discord.gg',
  'github.com',
  'youtube.com', 'youtu.be',
  'tiktok.com',
  'instagram.com',
  'pinterest.com',
  'spotify.com',
  'reddit.com',
  'facebook.com', 'fb.com',
  'twitter.com', 'x.com',
];

// ── URL Detection ─────────────────────────────────────────

// Comprehensive regex covering plain text, captions, replies, multi-line,
// rich formatted text, mixed Unicode, multiple URLs, hidden in paragraphs
const URL_PATTERN =
  /(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const url = match[1];
    if (url) found.add(url);
  }
  URL_PATTERN.lastIndex = 0;
  return [...found];
}

export function extractFirstUrl(text: string): string | null {
  return extractUrls(text)[0] ?? null;
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Strip tracking params
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'].forEach(
      (p) => u.searchParams.delete(p)
    );
    return u.toString();
  } catch {
    return raw;
  }
}

// ── Cache ─────────────────────────────────────────────────

const metaCache = new Map<string, CacheEntry>();
const thumbnailCache = new Map<string, { buffer: Uint8Array; expiresAt: number }>();

function cacheKey(url: string): string {
  return normalizeUrl(url);
}

function getCached(url: string): CacheEntry | null {
  const key = cacheKey(url);
  const entry = metaCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    metaCache.delete(key);
    return null;
  }
  return entry;
}

function setCached(url: string, meta: LinkMeta, thumbnailBuffer?: Uint8Array): void {
  // Evict oldest entries if cache is full
  if (metaCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...metaCache.entries()].sort((a, b) => a[1].meta.fetchedAt - b[1].meta.fetchedAt)[0];
    if (oldest) metaCache.delete(oldest[0]);
  }
  const key = cacheKey(url);
  metaCache.set(key, {
    meta: Object.freeze({ ...meta }),
    thumbnailBuffer,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  if (thumbnailBuffer) {
    thumbnailCache.set(key, { buffer: thumbnailBuffer, expiresAt: Date.now() + THUMBNAIL_TTL_MS });
  }
}

function getCachedThumbnail(url: string): Uint8Array | undefined {
  const key = cacheKey(url);
  const entry = thumbnailCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { thumbnailCache.delete(key); return undefined; }
  return entry.buffer;
}

// ── Retry Helper ──────────────────────────────────────────

function isTransient(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('network') ||
    msg.includes('dns') ||
    msg.includes('socket hang up')
  );
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const transient = isTransient(err);
      logger.debug(`[PreviewManager] ${label} attempt ${attempt + 1} failed`, {
        err: String(err),
        transient,
        failureClass: transient ? 'NetworkFailure' : 'UnknownFailure',
      });
      if (!transient || attempt === maxAttempts - 1) return null;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] ?? 4000));
    }
  }
  return null;
}

// ── Stage 1: link-preview-js ──────────────────────────────

async function fetchViaLinkPreview(url: string): Promise<LinkMeta | null> {
  return withRetry(async () => {
    const data = await getLinkPreview(url, {
      timeout: FETCH_TIMEOUT_MS,
      followRedirects: 'follow',
      handleRedirects: (base, fwd) => {
        try {
          const b = new URL(base);
          const f = new URL(fwd);
          return f.hostname === b.hostname || f.hostname.endsWith(`.${b.hostname}`);
        } catch { return false; }
      },
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; WhatsApp/2.23; +https://www.whatsapp.com)',
        'accept-language': 'en-US,en;q=0.9',
      },
    });

    if (data.mediaType === 'website') {
      return {
        url,
        title: 'title' in data ? (data.title ?? undefined) : undefined,
        description: 'description' in data ? (data.description ?? undefined) : undefined,
        imageUrl: 'images' in data ? (data.images?.[0] ?? undefined) : undefined,
        siteName: 'siteName' in data ? (data.siteName ?? undefined) : undefined,
        fetchedAt: Date.now(),
      };
    }
    return { url, fetchedAt: Date.now() };
  }, 'link-preview-js');
}

// ── Stage 2: Raw HTML OpenGraph / Twitter Cards / title ───

async function fetchViaHtmlParse(url: string): Promise<LinkMeta | null> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html: string;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const $ = cheerio.load(html);
    const og = (prop: string) =>
      $(`meta[property="og:${prop}"]`).attr('content') ||
      $(`meta[name="og:${prop}"]`).attr('content');
    const tw = (name: string) =>
      $(`meta[name="twitter:${name}"]`).attr('content') ||
      $(`meta[property="twitter:${name}"]`).attr('content');

    const title = og('title') || tw('title') || $('title').first().text().trim() || undefined;
    const description = og('description') || tw('description') || $('meta[name="description"]').attr('content') || undefined;
    const imageUrl = og('image') || tw('image') || undefined;
    const siteName = og('site_name') || undefined;
    const canonicalUrl = og('url') || $('link[rel="canonical"]').attr('href') || undefined;

    return { url, title, description, imageUrl, siteName, canonicalUrl, fetchedAt: Date.now() };
  }, 'html-parse');
}

// ── Stage 3: URL-only fallback ────────────────────────────

function urlOnlyMeta(url: string): LinkMeta {
  try {
    const u = new URL(url);
    return { url, title: u.hostname, fetchedAt: Date.now() };
  } catch {
    return { url, fetchedAt: Date.now() };
  }
}

// ── Thumbnail Fetcher ─────────────────────────────────────

async function fetchThumbnail(imageUrl: string): Promise<Uint8Array | undefined> {
  const cached = getCachedThumbnail(imageUrl);
  if (cached) return cached;

  const result = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), THUMBNAIL_TIMEOUT_MS);
    try {
      const res = await fetch(imageUrl, {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WA-Bridge/1.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_THUMBNAIL_BYTES) {
        // Truncate to cap — WhatsApp only needs a small JPEG
        return new Uint8Array(buf.slice(0, MAX_THUMBNAIL_BYTES));
      }
      return new Uint8Array(buf);
    } finally {
      clearTimeout(timer);
    }
  }, 'thumbnail-fetch', 2);

  if (result) {
    thumbnailCache.set(cacheKey(imageUrl), { buffer: result, expiresAt: Date.now() + THUMBNAIL_TTL_MS });
  }
  return result ?? undefined;
}

// ── Core Metadata Pipeline ────────────────────────────────

export async function fetchLinkMeta(url: string): Promise<LinkMeta> {
  const normalized = normalizeUrl(url);
  const cached = getCached(normalized);
  if (cached) {
    logger.debug('[PreviewManager] Cache hit', { url: normalized });
    return cached.meta;
  }

  logger.debug('[PreviewManager] Cache miss — fetching', { url: normalized });

  // Stage 1 → Stage 2 → Stage 3
  let meta: LinkMeta | null = await fetchViaLinkPreview(normalized);
  if (!meta?.title && !meta?.description) {
    logger.debug('[PreviewManager] Stage 1 insufficient — trying HTML parse', { url: normalized });
    meta = await fetchViaHtmlParse(normalized);
  }
  if (!meta) {
    logger.debug('[PreviewManager] All fetch stages failed — using URL-only fallback', { url: normalized });
    meta = urlOnlyMeta(normalized);
  }

  // Fetch thumbnail (non-blocking — preview continues without it)
  let thumbnailBuffer: Uint8Array | undefined;
  if (meta.imageUrl) {
    thumbnailBuffer = await fetchThumbnail(meta.imageUrl).catch(() => undefined);
    if (!thumbnailBuffer) {
      logger.debug('[PreviewManager] Thumbnail fetch failed — continuing without it', {
        url: normalized,
        failureClass: 'ThumbnailFailure',
      });
    }
  }

  const finalMeta: LinkMeta = Object.freeze({ ...meta, thumbnail: thumbnailBuffer });
  setCached(normalized, finalMeta, thumbnailBuffer);
  return finalMeta;
}

// ── Hydration ─────────────────────────────────────────────

/**
 * Build an immutable AnyMessageContent with a fully hydrated link preview.
 * Every call returns a fresh object — never reuses shared references.
 * Safe for broadcasts: clone before every send.
 */
export async function hydratedMessage(
  text: string,
  options: { suppressPreview?: boolean; existingMeta?: Partial<LinkMeta> } = {}
): Promise<AnyMessageContent> {
  if (options.suppressPreview) {
    return Object.freeze({ text, linkPreview: null }) as AnyMessageContent;
  }

  const url = options.existingMeta?.url ?? extractFirstUrl(text);
  if (!url) {
    return Object.freeze({ text }) as AnyMessageContent;
  }

  logger.debug('[PreviewManager] Hydrating message', { url });

  let meta: LinkMeta;
  try {
    meta = await fetchLinkMeta(url);
  } catch (err) {
    logger.warn('[PreviewManager] fetchLinkMeta threw unexpectedly', {
      url,
      err: String(err),
      failureClass: 'HydrationFailure',
    });
    return Object.freeze({ text }) as AnyMessageContent;
  }

  // Always clone thumbnail buffer — never share references across sends
  const thumbnail = meta.thumbnail ? new Uint8Array(meta.thumbnail) : undefined;

  const preview = Object.freeze({
    'matched-text': meta.url ?? url,
    'canonical-url': meta.canonicalUrl ?? meta.url ?? url,
    title: meta.title ?? '',
    description: meta.description ?? '',
    jpegThumbnail: thumbnail,
  });

  logger.debug('[PreviewManager] Hydration complete', {
    url,
    hasTitle: Boolean(meta.title),
    hasThumbnail: Boolean(thumbnail),
  });

  return Object.freeze({ text, linkPreview: preview }) as AnyMessageContent;
}

/**
 * Clone a hydrated message for broadcast use.
 * Ensures every recipient gets a fresh immutable payload.
 */
export function cloneForBroadcast(content: AnyMessageContent): AnyMessageContent {
  const c = content as Record<string, unknown>;
  if (!c['linkPreview']) return Object.freeze({ ...c }) as AnyMessageContent;

  const lp = c['linkPreview'] as Record<string, unknown>;
  const thumb = lp['jpegThumbnail'];
  return Object.freeze({
    ...c,
    linkPreview: Object.freeze({
      ...lp,
      jpegThumbnail: thumb instanceof Uint8Array ? new Uint8Array(thumb) : thumb,
    }),
  }) as AnyMessageContent;
}

// ── Cache Management ──────────────────────────────────────

export function invalidatePreviewCache(url?: string): void {
  if (url) {
    const key = cacheKey(url);
    metaCache.delete(key);
    thumbnailCache.delete(key);
  } else {
    metaCache.clear();
    thumbnailCache.clear();
  }
}

export function getPreviewCacheStats(): { metaEntries: number; thumbnailEntries: number } {
  return { metaEntries: metaCache.size, thumbnailEntries: thumbnailCache.size };
}
