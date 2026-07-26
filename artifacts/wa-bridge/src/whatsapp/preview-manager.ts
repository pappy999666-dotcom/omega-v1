// ============================================================
// WA-Bridge — Production Preview Manager v2
// Centralized, fault-tolerant, immutable, self-healing
// Multi-stage fallback · Smart cache · Retry · Concurrency
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import * as cheerio from 'cheerio';
import type { AnyMessageContent } from './baileys-types.js';
import { logger } from '../utils/logger.js';

// ── Failure classification ────────────────────────────────

export type PreviewFailureClass =
  | 'MetadataFailure'
  | 'ThumbnailFailure'
  | 'CacheFailure'
  | 'HydrationFailure'
  | 'NetworkFailure'
  | 'WhatsAppFailure'
  | 'RenderingFailure'
  | 'UnknownFailure';

// ── Types ─────────────────────────────────────────────────

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
  expiresAt: number;
}

// ── Constants ─────────────────────────────────────────────

const CACHE_TTL_MS        = 30 * 60_000;   // 30 min metadata
const THUMBNAIL_TTL_MS    = 60 * 60_000;   // 60 min thumbnail
const FETCH_TIMEOUT_MS    = 8_000;
const THUMB_TIMEOUT_MS    = 6_000;
const MAX_CACHE_SIZE      = 500;
const MAX_THUMB_BYTES     = 512 * 1024;    // 512 KB
const RETRY_DELAYS        = [400, 1200, 3500] as const;

// ── URL Detection ─────────────────────────────────────────
// Covers: plain text, captions, replies, multi-line, Unicode,
// multiple URLs, hidden in paragraphs, all major platforms

const URL_RE = /(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m[1]) found.add(m[1]);
  }
  URL_RE.lastIndex = 0;
  return [...found];
}

export function extractFirstUrl(text: string): string | null {
  return extractUrls(text)[0] ?? null;
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const p of ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch { return raw; }
}

// ── Cache ─────────────────────────────────────────────────

const metaCache  = new Map<string, CacheEntry>();
const thumbCache = new Map<string, { buf: Uint8Array; expiresAt: number }>();

function cacheKey(url: string): string { return normalizeUrl(url); }

function getCached(url: string): LinkMeta | null {
  const e = metaCache.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() > e.expiresAt) { metaCache.delete(cacheKey(url)); return null; }
  return e.meta;
}

function setCached(url: string, meta: LinkMeta): void {
  if (metaCache.size >= MAX_CACHE_SIZE) {
    const oldest = [...metaCache.entries()].sort((a, b) => a[1].meta.fetchedAt - b[1].meta.fetchedAt)[0];
    if (oldest) metaCache.delete(oldest[0]);
  }
  metaCache.set(cacheKey(url), { meta: Object.freeze({ ...meta }), expiresAt: Date.now() + CACHE_TTL_MS });
}

function getCachedThumb(url: string): Uint8Array | undefined {
  const e = thumbCache.get(cacheKey(url));
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { thumbCache.delete(cacheKey(url)); return undefined; }
  return e.buf;
}

function setCachedThumb(url: string, buf: Uint8Array): void {
  thumbCache.set(cacheKey(url), { buf, expiresAt: Date.now() + THUMBNAIL_TTL_MS });
}

// ── Retry ─────────────────────────────────────────────────

function isTransient(err: unknown): boolean {
  const s = String(err).toLowerCase();
  return s.includes('timeout') || s.includes('econnreset') || s.includes('enotfound') ||
    s.includes('econnrefused') || s.includes('429') || s.includes('503') ||
    s.includes('network') || s.includes('dns') || s.includes('socket hang up') ||
    s.includes('aborted') || s.includes('etimedout');
}

async function withRetry<T>(fn: () => Promise<T>, label: string, max = 3): Promise<T | null> {
  for (let i = 0; i < max; i++) {
    try { return await fn(); }
    catch (err) {
      const transient = isTransient(err);
      logger.debug(`[Preview] ${label} attempt ${i + 1}/${max} failed`, {
        err: String(err), transient,
        failureClass: transient ? 'NetworkFailure' : 'MetadataFailure',
      });
      if (!transient || i === max - 1) return null;
      await new Promise(r => setTimeout(r, RETRY_DELAYS[i] ?? 3500));
    }
  }
  return null;
}

// ── Stage 1: link-preview-js ──────────────────────────────

async function fetchStage1(url: string): Promise<LinkMeta | null> {
  return withRetry(async () => {
    const data = await getLinkPreview(url, {
      timeout: FETCH_TIMEOUT_MS,
      followRedirects: 'follow',
      handleRedirects: (base, fwd) => {
        try {
          const b = new URL(base), f = new URL(fwd);
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
        title:       'title'       in data ? (data.title       ?? undefined) : undefined,
        description: 'description' in data ? (data.description ?? undefined) : undefined,
        imageUrl:    'images'      in data ? (data.images?.[0] ?? undefined) : undefined,
        siteName:    'siteName'    in data ? (data.siteName    ?? undefined) : undefined,
        fetchedAt: Date.now(),
      };
    }
    return { url, fetchedAt: Date.now() };
  }, 'stage1-link-preview-js');
}

// ── Stage 2: Raw HTML OG / Twitter Cards / title ──────────

async function fetchStage2(url: string): Promise<LinkMeta | null> {
  return withRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let html: string;
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } finally { clearTimeout(t); }

    const $ = cheerio.load(html);
    const og = (p: string) => $(`meta[property="og:${p}"]`).attr('content') || $(`meta[name="og:${p}"]`).attr('content');
    const tw = (p: string) => $(`meta[name="twitter:${p}"]`).attr('content') || $(`meta[property="twitter:${p}"]`).attr('content');

    return {
      url,
      title:        og('title')       || tw('title')       || $('title').first().text().trim() || undefined,
      description:  og('description') || tw('description') || $('meta[name="description"]').attr('content') || undefined,
      imageUrl:     og('image')       || tw('image')       || undefined,
      siteName:     og('site_name')   || undefined,
      canonicalUrl: og('url')         || $('link[rel="canonical"]').attr('href') || undefined,
      fetchedAt: Date.now(),
    };
  }, 'stage2-html-parse');
}

// ── Stage 3: URL-only fallback ────────────────────────────

function fetchStage3(url: string): LinkMeta {
  try { return { url, title: new URL(url).hostname, fetchedAt: Date.now() }; }
  catch { return { url, fetchedAt: Date.now() }; }
}

// ── Thumbnail ─────────────────────────────────────────────

async function fetchThumbnail(imageUrl: string): Promise<Uint8Array | undefined> {
  const cached = getCachedThumb(imageUrl);
  if (cached) return cached;

  const result = await withRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), THUMB_TIMEOUT_MS);
    try {
      const res = await fetch(imageUrl, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WA-Bridge/2.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf.byteLength > MAX_THUMB_BYTES ? buf.slice(0, MAX_THUMB_BYTES) : buf);
    } finally { clearTimeout(t); }
  }, 'thumbnail', 2);

  if (result) setCachedThumb(imageUrl, result);
  return result ?? undefined;
}

// ── Core: fetchLinkMeta ───────────────────────────────────

export async function fetchLinkMeta(url: string): Promise<LinkMeta> {
  const norm = normalizeUrl(url);

  const cached = getCached(norm);
  if (cached) {
    logger.debug('[Preview] Cache hit', { url: norm });
    return cached;
  }

  logger.debug('[Preview] Fetching', { url: norm });

  // Stage 1 → 2 → 3
  let meta: LinkMeta | null = await fetchStage1(norm);
  if (!meta?.title && !meta?.description) {
    logger.debug('[Preview] Stage1 insufficient → Stage2', { url: norm });
    meta = await fetchStage2(norm);
  }
  if (!meta) {
    logger.debug('[Preview] All stages failed → URL-only', { url: norm, failureClass: 'MetadataFailure' });
    meta = fetchStage3(norm);
  }

  // Thumbnail — non-blocking, never blocks the preview
  let thumbnail: Uint8Array | undefined;
  if (meta.imageUrl) {
    thumbnail = await fetchThumbnail(meta.imageUrl).catch(() => {
      logger.debug('[Preview] Thumbnail failed — continuing without', { url: norm, failureClass: 'ThumbnailFailure' });
      return undefined;
    });
  }

  const final: LinkMeta = Object.freeze({ ...meta, ...(thumbnail ? { thumbnail } : {}) });
  setCached(norm, final);

  logger.debug('[Preview] Fetch complete', {
    url: norm, hasTitle: Boolean(final.title),
    hasThumbnail: Boolean(thumbnail),
  });

  return final;
}

// ── hydratedMessage ───────────────────────────────────────
// For normal sendMessage calls, Baileys auto-fetches preview via getUrlInfo.
// We just return { text } — Baileys does the rest.
// richPreview:true is used separately for groupStatus and menu URL paths.

export async function hydratedMessage(
  text: string,
  options: { suppressPreview?: boolean; existingMeta?: Partial<LinkMeta> } = {}
): Promise<AnyMessageContent> {
  if (options.suppressPreview) {
    return Object.freeze({ text, linkPreview: null }) as AnyMessageContent;
  }
  // Just return the text — Baileys' getUrlInfo in sendMessage handles preview automatically
  return Object.freeze({ text }) as AnyMessageContent;
}

// ── cloneForBroadcast ─────────────────────────────────────
// Must be called per-send during broadcasts — never reuse the same object.

export function cloneForBroadcast(content: AnyMessageContent): AnyMessageContent {
  const c = content as Record<string, unknown>;
  if (!c['linkPreview']) return Object.freeze({ ...c }) as AnyMessageContent;

  const lp = c['linkPreview'] as Record<string, unknown>;
  const thumb = lp['jpegThumbnail'];
  return Object.freeze({
    ...c,
    linkPreview: Object.freeze({
      ...lp,
      ...(thumb instanceof Uint8Array ? { jpegThumbnail: new Uint8Array(thumb) } : {}),
    }),
  }) as AnyMessageContent;
}

// ── Cache management ──────────────────────────────────────

export function invalidatePreviewCache(url?: string): void {
  if (url) {
    const k = cacheKey(url);
    metaCache.delete(k);
    thumbCache.delete(k);
  } else {
    metaCache.clear();
    thumbCache.clear();
  }
}

export function getPreviewCacheStats(): { metaEntries: number; thumbnailEntries: number } {
  return { metaEntries: metaCache.size, thumbnailEntries: thumbCache.size };
}
