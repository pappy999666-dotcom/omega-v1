// ============================================================
// Preview Engine — Preview Validator
// Validates URLs, metadata, thumbnails, and payloads before
// they enter the send pipeline.
// ============================================================

import type { AnyMessageContent } from '../whatsapp/baileys-types.js';
import type { LinkMeta, PartialLinkMeta } from './types.js';

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '10.0.0.0', '172.16.0.0', '192.168.0.0',
]);

export class PreviewValidator {
  /**
   * Validate a URL string.
   */
  static isValidUrl(url: string): boolean {
    if (!url || !url.trim()) return false;
    try {
      const u = new URL(url);
      if (!ALLOWED_PROTOCOLS.has(u.protocol)) return false;
      if (!u.hostname || u.hostname.length > 256) return false;
      if (BLOCKED_HOSTNAMES.has(u.hostname)) return false;
      // Block private IP ranges
      if (/^127\./.test(u.hostname)) return false;
      if (/^10\./.test(u.hostname)) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return false;
      if (/^192\.168\./.test(u.hostname)) return false;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate a LinkMeta object.
   */
  static isValidMeta(meta: PartialLinkMeta | undefined): boolean {
    if (!meta) return false;
    if (!meta.url || !PreviewValidator.isValidUrl(meta.url)) return false;
    return true;
  }

  /**
   * Validate a thumbnail buffer.
   */
  static isValidThumbnail(buf: Uint8Array | undefined): boolean {
    if (!buf) return false;
    if (buf.length === 0) return false;
    if (buf.length > 512 * 1024) return false; // 512 KB max
    return true;
  }

  /**
   * Sanitize metadata for safe use — strip any dangerous fields.
   */
  static sanitizeMeta(meta: PartialLinkMeta): PartialLinkMeta {
    return {
      url: meta.url?.trim() ?? '',
      title: meta.title?.trim().slice(0, 500) ?? undefined,
      description: meta.description?.trim().slice(0, 2000) ?? undefined,
      imageUrl: meta.imageUrl?.trim() ?? undefined,
      siteName: meta.siteName?.trim() ?? undefined,
      canonicalUrl: meta.canonicalUrl?.trim() ?? undefined,
      favicon: meta.favicon?.trim() ?? undefined,
    };
  }

  /**
   * Validate that a message content object is safe to send.
   */
  static isValidContent(content: AnyMessageContent): boolean {
    if (!content) return false;
    // Must have at least text, image, video, audio, or document
    const c = content as Record<string, unknown>;
    if (c.text && typeof c.text !== 'string') return false;
    if (c.image && !(c.image instanceof Uint8Array || Buffer.isBuffer(c.image))) return false;
    if (c.video && !(c.video instanceof Uint8Array || Buffer.isBuffer(c.video))) return false;
    return true;
  }

  /**
   * Check if a URL is a WhatsApp group invite link.
   */
  static isGroupInviteLink(url: string): boolean {
    return /chat\.whatsapp\.com\/[A-Za-z0-9_-]+/i.test(url);
  }

  /**
   * Extract invite code from a WhatsApp group link.
   */
  static extractInviteCode(url: string): string | null {
    const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    return match?.[1] ?? null;
  }
}
