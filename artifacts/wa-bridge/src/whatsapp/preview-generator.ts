// ============================================================
// WA-Bridge — Smart Link Preview Generator
// Passthrough if preview metadata exists, hydrate if raw URL
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import type { AnyMessageContent } from './baileys-types.js';
import { logger } from '../utils/logger.js';

const URL_REGEX =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export interface LinkMeta {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  thumbnail?: Uint8Array;
  canonicalUrl?: string;
  favicon?: string;
  linkPreviewMetadata?: unknown;
}

/**
 * Extract the first URL from a message text.
 */
export function extractFirstUrl(text: string): string | null {
  const match = URL_REGEX.exec(text);
  URL_REGEX.lastIndex = 0; // Reset regex state
  return match?.[0] ?? null;
}

/**
 * Fetch open-graph / link preview metadata for a URL.
 * Returns null on failure (never throws).
 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  try {
    const data = await getLinkPreview(url, {
      timeout: 5000,
      followRedirects: 'follow',
      handleRedirects: (baseURL, forwardedURL) => {
        const urlObj = new URL(baseURL);
        const forwardedURLObj = new URL(forwardedURL);
        return (
          forwardedURLObj.hostname === urlObj.hostname ||
          forwardedURLObj.hostname.endsWith(`.${urlObj.hostname}`)
        );
      },
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; WhatsApp/2.23; +https://www.whatsapp.com)',
      },
    });

    if (data.mediaType === 'website') {
      return {
        url,
        title: 'title' in data ? data.title : undefined,
        description: 'description' in data ? data.description : undefined,
        imageUrl: 'images' in data ? data.images?.[0] : undefined,
        siteName: 'siteName' in data ? data.siteName : undefined,
      };
    }

    return { url };
  } catch (err) {
    logger.debug('[Preview] Failed to fetch link meta', {
      url,
      err: String(err),
    });
    return null;
  }
}

/**
 * Build a message content object with proper link preview hydration.
 *
 * Strategy:
 * 1. If the message already has extendedTextMessage with matchedText,
 *    pass through as-is (Baileys will retain existing preview).
 * 2. If text contains a raw URL, fetch OG metadata and build a
 *    generateHighQualityLinkPreview-compatible message.
 */
export async function hydratedMessage(
  text: string,
  existingPreview?: Partial<LinkMeta>,
  options: { suppressPreview?: boolean } = {}
): Promise<AnyMessageContent> {
  const url = existingPreview?.url ?? extractFirstUrl(text);
  if (options.suppressPreview) return { text, linkPreview: null };
  if (!url) return { text };

  // Status and group-status messages do not reliably pass through Baileys'
  // native getUrlInfo pipeline. Hydrate raw text here instead of silently
  // falling back to a plain text message.
  const preview = existingPreview ?? await fetchLinkMeta(url);
  if (!preview) return { text };

  let thumbnail = preview.thumbnail;
  if (!thumbnail && preview.imageUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(preview.imageUrl, {
        signal: controller.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; WA-Bridge/1.0)' },
      }).finally(() => clearTimeout(timeout));
      if (response.ok) thumbnail = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      logger.debug('[Preview] Failed to download thumbnail', {
        url,
        imageUrl: preview.imageUrl,
        err: String(err),
      });
    }
  }

  return {
    text,
    linkPreview: {
      'matched-text': preview.url ?? url,
      'canonical-url': preview.canonicalUrl ?? preview.url ?? url,
      title: preview.title ?? '',
      description: preview.description ?? '',
      jpegThumbnail: thumbnail,
      linkPreviewMetadata: preview.linkPreviewMetadata,
    },
  } as AnyMessageContent;
}
