// ============================================================
// Preview Engine — Thumbnail Resolver
// Dedicated thumbnail manager: downloading, validating,
// converting, resizing, caching, buffer integrity, memory cleanup.
// ============================================================

import { createRequire } from 'module';
import type { FailureClass } from './types.js';
import { PreviewLogger } from './PreviewLogger.js';
import { previewCache } from './PreviewCache.js';

const require = createRequire(import.meta.url);

const THUMB_TIMEOUT_MS = 6_000;
const MAX_THUMB_BYTES = 512 * 1024; // 512 KB

// ── Thumbnail Validation ────────────────────────────────────

function isValidImageBuffer(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  if (buf.length > MAX_THUMB_BYTES) return false;
  // Check for valid image magic bytes
  const b = Buffer.from(buf);
  const magic = b.slice(0, 8);
  // JPEG: FF D8 FF
  if (magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47) return true;
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46) return true;
  // GIF: 47 49 46 38
  if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x38) return true;
  return false;
}

// ── Thumbnail Normalization (sharp) ─────────────────────────

async function normalizeThumbnail(input: Uint8Array): Promise<Buffer | undefined> {
  if (!input || input.length === 0) return undefined;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (!isValidImageBuffer(input)) {
    PreviewLogger.thumbnailFailed('normalize', 'ThumbnailFailure');
    return undefined;
  }

  try {
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;

    // Don't process tiny images (favicons etc) — they'll be blurry when upscaled
    if (w < 100 || h < 100) return undefined;

    const attempts = [
      { size: 1920, quality: 95 },
      { size: 1600, quality: 90 },
      { size: 1280, quality: 88 },
      { size: 1080, quality: 85 },
    ];

    for (const { size, quality } of attempts) {
      const resized: Buffer = await sharp(buf)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
        .jpeg({ quality, progressive: false, mozjpeg: true })
        .toBuffer();
      if (resized.length <= 512000) {
        PreviewLogger.thumbnailNormalized('normalize', buf.length, resized.length);
        return resized;
      }
    }
    return buf.length <= 512000 ? buf : undefined;
  } catch {
    return buf.length <= 512000 ? buf : undefined;
  }
}

// ── Thumbnail Resolver ──────────────────────────────────────

export class ThumbnailResolver {
  /**
   * Download and cache a thumbnail from a URL.
   * Returns undefined on failure (never throws).
   */
  static async download(imageUrl: string): Promise<Uint8Array | undefined> {
    // Check cache first
    const cached = previewCache.getThumbnail(imageUrl);
    if (cached) return cached;

    PreviewLogger.fetchingThumbnail(imageUrl);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), THUMB_TIMEOUT_MS);

    try {
      const res = await fetch(imageUrl, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WA-Bridge/2.0)' },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const rawBuf = await res.arrayBuffer();
      const buf = new Uint8Array(
        rawBuf.byteLength > MAX_THUMB_BYTES ? rawBuf.slice(0, MAX_THUMB_BYTES) : rawBuf
      );

      if (!isValidImageBuffer(buf)) {
        PreviewLogger.thumbnailFailed(imageUrl, 'ThumbnailFailure');
        return undefined;
      }

      PreviewLogger.thumbnailFetched(imageUrl, buf.length);
      previewCache.setThumbnail(imageUrl, buf);
      return buf;
    } catch (err) {
      PreviewLogger.thumbnailFailed(imageUrl, 'NetworkFailure');
      return undefined;
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Normalize a thumbnail buffer using sharp.
   * Only normalizes if needed (large images that need resizing).
   */
  static async normalize(buf: Uint8Array | undefined): Promise<Buffer | undefined> {
    if (!buf) return undefined;
    return normalizeThumbnail(buf);
  }

  /**
   * Get a thumbnail — try cache, then download, then return undefined.
   * Never blocks the preview pipeline.
   */
  static async resolve(imageUrl: string | undefined): Promise<Uint8Array | undefined> {
    if (!imageUrl) return undefined;

    const cached = previewCache.getThumbnail(imageUrl);
    if (cached) return cached;

    // Best-effort download — never blocks
    try {
      return await ThumbnailResolver.download(imageUrl);
    } catch {
      PreviewLogger.thumbnailFailed(imageUrl, 'ThumbnailFailure');
      return undefined;
    }
  }

  /**
   * Resolve thumbnail for a group invite link via socket.
   */
  static async resolveGroupThumbnail(
    socket: { profilePictureUrl(jid: string, type: string): Promise<string | null> },
    groupJid: string
  ): Promise<Uint8Array | undefined> {
    try {
      const ppUrl = await socket.profilePictureUrl(groupJid, 'image').catch(() => null);
      if (!ppUrl) return undefined;
      return ThumbnailResolver.download(ppUrl);
    } catch {
      return undefined;
    }
  }
}
