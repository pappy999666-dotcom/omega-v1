// ============================================================
// WA-Bridge — Smart Link Preview Generator
// Passthrough if preview metadata exists, hydrate if raw URL
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import type { WASocket, AnyMessageContent } from '@crysnovax/baileys';
import { logger } from '../utils/logger.js';

const URL_REGEX =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

export interface LinkMeta {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
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

    const meta = data as { title?: string; description?: string; images?: string[]; favicons?: string[]; siteName?: string; url?: string };
    return {
      url: meta.url ?? url,
      title: meta.title,
      description: meta.description,
      imageUrl: meta.images?.[0] ?? meta.favicons?.[0],
      siteName: meta.siteName,
    };
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
  existingPreview?: { url?: string; title?: string; description?: string }
): Promise<AnyMessageContent> {
  const url = existingPreview?.url ?? extractFirstUrl(text);
  if (!url) return { text };

  const meta = existingPreview?.url ? existingPreview : await fetchLinkMeta(url);
  if (!meta) return { text, linkPreview: { 'matched-text': url } } as AnyMessageContent;

  return {
    text,
    linkPreview: {
      'matched-text': meta.url ?? url,
      canonicalUrl: meta.url ?? url,
      title: meta.title ?? '',
      description: meta.description ?? '',
      jpegThumbnail: undefined,
    },
  } as AnyMessageContent;
}
