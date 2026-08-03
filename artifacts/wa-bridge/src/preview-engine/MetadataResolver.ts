// ============================================================
// Preview Engine — Metadata Resolver
// Multi-stage metadata fetching with intelligent fallback:
// Stage 1: link-preview-js (full OG + Twitter cards)
// Stage 2: Cheerio raw HTML parse (OG / Twitter / title fallback)
// Stage 3: URL-only fallback (hostname as title)
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import * as cheerio from 'cheerio';
import type { FailureClass, LinkMeta, PreviewStage } from './types.js';
import { PreviewLogger } from './PreviewLogger.js';
import { UrlDetector } from './UrlDetector.js';
import { previewCache } from './PreviewCache.js';

const FETCH_TIMEOUT_MS = 8_000;
const RETRY_DELAYS = [400, 1200, 3500] as const;

// ── Transient Error Detection ───────────────────────────────

function isTransient(err: unknown): boolean {
  const s = String(err).toLowerCase();
  return s.includes('timeout') || s.includes('econnreset') || s.includes('enotfound') ||
    s.includes('econnrefused') || s.includes('429') || s.includes('503') ||
    s.includes('network') || s.includes('dns') || s.includes('socket hang up') ||
    s.includes('aborted') || s.includes('etimedout');
}

// ── Retry Helper ────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 3
): Promise<T | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      const transient = isTransient(err);
      PreviewLogger.retryAttempt(label, i + 1, maxAttempts);
      if (!transient || i === maxAttempts - 1) {
        PreviewLogger.retryExhausted(label, transient ? 'NetworkFailure' : 'MetadataFailure');
        return undefined;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[i] ?? 3500));
    }
  }
  return undefined;
}

// ── Stage 1: link-preview-js ────────────────────────────────

async function fetchStage1(url: string): Promise<LinkMeta | undefined> {
  PreviewLogger.fetchingMetadata(url, 'Stage3_LinkPreviewJs');
  const result = await withRetry(async () => {
    const data = await getLinkPreview(url, {
      timeout: FETCH_TIMEOUT_MS,
      followRedirects: 'follow',
      handleRedirects: (base, fwd) => {
        try {
          const b = new URL(base);
          const f = new URL(fwd);
          return f.hostname === b.hostname || f.hostname.endsWith(`.${b.hostname}`);
        } catch {
          return false;
        }
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
        favicon: 'favicons' in data ? (data.favicons?.[0] ?? undefined) : undefined,
        fetchedAt: Date.now(),
      };
    }
    return { url, fetchedAt: Date.now() };
  }, 'stage1-link-preview-js');

  if (result) {
    PreviewLogger.metadataFetched(url, Boolean(result.title), Boolean(result.description));
  }
  return result;
}

// ── Stage 2: Cheerio HTML Parse ─────────────────────────────

async function fetchStage2(url: string): Promise<LinkMeta | undefined> {
  PreviewLogger.fetchingMetadata(url, 'Stage4_HtmlParse');
  const result = await withRetry(async () => {
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
    } finally {
      clearTimeout(t);
    }

    const $ = cheerio.load(html);
    const og = (p: string) =>
      $(`meta[property="og:${p}"]`).attr('content') ??
      $(`meta[name="og:${p}"]`).attr('content');
    const tw = (p: string) =>
      $(`meta[name="twitter:${p}"]`).attr('content') ??
      $(`meta[property="twitter:${p}"]`).attr('content');

    return {
      url,
      title: og('title') ?? tw('title') ?? ($('title').first().text().trim() || undefined),
      description: og('description') ?? tw('description') ??
        $('meta[name="description"]').attr('content') ?? undefined,
      imageUrl: og('image') ?? tw('image') ?? undefined,
      siteName: og('site_name') ?? undefined,
      canonicalUrl: og('url') ?? $('link[rel="canonical"]').attr('href') ?? undefined,
      fetchedAt: Date.now(),
    };
  }, 'stage2-html-parse');

  if (result) {
    PreviewLogger.metadataFetched(url, Boolean(result.title), Boolean(result.description));
  }
  return result;
}

// ── Stage 3: URL-only Fallback ──────────────────────────────

function fetchStage3(url: string): LinkMeta {
  PreviewLogger.fetchingMetadata(url, 'Stage5_UrlOnly');
  try {
    const result = { url, title: new URL(url).hostname, fetchedAt: Date.now() };
    PreviewLogger.metadataFetched(url, true, false);
    return result;
  } catch {
    return { url, fetchedAt: Date.now() };
  }
}

// ── Main Resolver ───────────────────────────────────────────

export class MetadataResolver {
  /**
   * Resolve metadata for a URL with multi-stage fallback.
   * Never throws — always returns a LinkMeta.
   */
  static async resolve(url: string, forceStage?: PreviewStage): Promise<LinkMeta> {
    const normalized = UrlDetector.normalizeUrl(url);

    // Check cache first
    const cached = previewCache.getMeta(normalized);
    if (cached) return cached;

    // Force stage (used for testing or specific paths)
    if (forceStage === 'Stage3_LinkPreviewJs') {
      const meta = await fetchStage1(normalized);
      if (meta) { previewCache.setMeta(normalized, meta); return meta; }
      PreviewLogger.metadataFallback(normalized, 'Stage3_LinkPreviewJs', 'Stage4_HtmlParse');
    }

    // Normal flow: Stage 1 → Stage 2 → Stage 3
    let meta = await fetchStage1(normalized);

    if (!meta?.title && !meta?.description) {
      PreviewLogger.metadataFallback(normalized, 'Stage3_LinkPreviewJs', 'Stage4_HtmlParse');
      meta = await fetchStage2(normalized);
    }

    // Fall back to Stage 3 when:
    // - Stage 2 itself returned null (network failure), OR
    // - Stage 2 returned an object but couldn't extract any title or description
    //   (JS-rendered pages like WhatsApp channel pages, heavy SPAs, etc.)
    if (!meta || (!meta.title && !meta.description)) {
      PreviewLogger.metadataFallback(normalized, 'Stage4_HtmlParse', 'Stage5_UrlOnly');
      meta = fetchStage3(normalized);
    }

    // Cache the result
    previewCache.setMeta(normalized, meta);
    return meta;
  }

  /**
   * Extract the appropriate stage used for a given URL.
   */
  static getStageFromMeta(meta: LinkMeta): PreviewStage {
    if (!meta.title && !meta.description) return 'Stage5_UrlOnly';
    if (meta.canonicalUrl) return 'Stage4_HtmlParse';
    return 'Stage3_LinkPreviewJs';
  }
}
