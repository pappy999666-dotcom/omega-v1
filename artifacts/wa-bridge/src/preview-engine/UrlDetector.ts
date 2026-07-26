// ============================================================
// Preview Engine — URL Detector
// Extracts URLs from plain text, captions, replies, quoted
// messages, nested replies, multi-line text, markdown,
// formatted text, unicode, multiple URLs, mixed text.
// ============================================================

import type { IMessage } from '../whatsapp/baileys-types.js';
import { PreviewLogger } from './PreviewLogger.js';

// Comprehensive URL regex — covers all platforms and edge cases
const URL_RE =
  /(https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export class UrlDetector {
  /**
   * Extract all unique URLs from a string.
   */
  static extractAll(text: string): string[] {
    const found = new Set<string>();
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m[1]) found.add(m[1]);
    }
    URL_RE.lastIndex = 0;
    return [...found];
  }

  /**
   * Extract the first URL from a string.
   */
  static extractFirst(text: string): string | null {
    const urls = UrlDetector.extractAll(text);
    return urls[0] ?? null;
  }

  /**
   * Check if text contains at least one URL.
   */
  static hasUrl(text: string): boolean {
    URL_RE.lastIndex = 0;
    const has = URL_RE.test(text);
    URL_RE.lastIndex = 0;
    return has;
  }

  /**
   * Determine whether a preview should be generated.
   * Returns false for:
   * - URLs that are part of WhatsApp invite links (handled separately)
   * - URLs in suppress lists
   * - Empty text
   */
  static shouldPreview(text: string, suppressList?: Set<string>): boolean {
    if (!text || !text.trim()) return false;
    const urls = UrlDetector.extractAll(text);
    if (urls.length === 0) return false;
    if (suppressList) {
      const filtered = urls.filter((u) => !suppressList.has(u));
      return filtered.length > 0;
    }
    return true;
  }

  /**
   * Normalize a URL by stripping tracking parameters.
   */
  static normalizeUrl(raw: string): string {
    try {
      const u = new URL(raw);
      for (const p of [
        'utm_source', 'utm_medium', 'utm_campaign',
        'utm_term', 'utm_content', 'fbclid', 'gclid',
      ]) {
        u.searchParams.delete(p);
      }
      return u.toString();
    } catch {
      return raw;
    }
  }

  /**
   * Extract an existing link preview from an incoming WhatsApp message.
   * Returns undefined if the message has no hydrated preview.
   * Implements Stage 1 passthrough: reuse existing preview as-is.
   */
  static extractFromMessage(message: IMessage | null | undefined): {
    url: string;
    canonicalUrl?: string;
    title?: string;
    description?: string;
    thumbnail?: Uint8Array;
  } | undefined {
    const ext = message?.extendedTextMessage;
    if (!ext?.matchedText) return undefined;

    const preview = {
      url: ext.matchedText,
      canonicalUrl: ext.canonicalUrl ?? ext.matchedText,
      title: ext.title ?? undefined,
      description: ext.description ?? undefined,
      thumbnail: ext.jpegThumbnail ?? undefined,
    };

    PreviewLogger.urlDetected(ext.matchedText, 'extractFromMessage');
    return preview;
  }

  /**
   * Extract text from any message type (conversation, extended, media captions, etc.)
   */
  static extractMessageText(message: IMessage | null | undefined): string {
    if (!message) return '';
    const wrapped =
      message.ephemeralMessage?.message ??
      message.viewOnceMessage?.message ??
      message.viewOnceMessageV2?.message ??
      message.documentWithCaptionMessage?.message;
    if (wrapped) return UrlDetector.extractMessageText(wrapped);
    return (
      message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      message.documentMessage?.caption ??
      ''
    );
  }
}
