// ============================================================
// WA-Bridge — Smart Link Preview Generator
// Passthrough if preview metadata exists, hydrate if raw URL
// ============================================================

import { getLinkPreview } from 'link-preview-js';
import type { AnyMessageContent, IMessage } from './baileys-types.js';
import { logger } from '../utils/logger.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

type SocketLike = {
  groupGetInviteInfo: (code: string) => Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl: (jid: string, type: string) => Promise<string>;
};

async function normalizeThumbnail(input: Uint8Array | Buffer | undefined): Promise<Buffer | undefined> {
  if (!input || input.length === 0) return undefined;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
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
      if (resized.length <= 512000) return resized;
    }
    return buf.length <= 512000 ? buf : undefined;
  } catch {
    return buf.length <= 512000 ? buf : undefined;
  }
}

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
 * Extract an existing link preview from an incoming WhatsApp message.
 * Returns undefined if the message has no hydrated preview.
 * Used to implement Stage 1 (passthrough): callers pass this directly to
 * hydratedMessage so no network fetch is needed.
 */
export function extractIncomingPreview(message: IMessage | null | undefined): Partial<LinkMeta> | undefined {
  const ext = message?.extendedTextMessage;
  if (!ext?.matchedText) return undefined;
  return {
    url: ext.matchedText,
    canonicalUrl: ext.canonicalUrl ?? ext.matchedText,
    title: ext.title ?? undefined,
    description: ext.description ?? undefined,
    thumbnail: ext.jpegThumbnail ?? undefined,
  };
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
        'user-agent': 'Mozilla/5.0 (compatible; WhatsApp/2.23; +https://www.whatsapp.com)',
      },
    });

    if (data.mediaType === 'website') {
      const imageUrl = 'images' in data ? data.images?.[0] : undefined;

      // Download thumbnail so callers (externalAdReply, hydratedMessage) get a ready Buffer
      let thumbnail: Uint8Array | undefined;
      if (imageUrl) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(imageUrl, {
            signal: ctrl.signal,
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; WA-Bridge/1.0)' },
          }).finally(() => clearTimeout(t));
          if (res.ok) thumbnail = new Uint8Array(await res.arrayBuffer());
        } catch { /* non-critical */ }
      }

      const normalizedThumb = thumbnail ? await normalizeThumbnail(thumbnail) : undefined;
      return {
        url,
        title: 'title' in data ? data.title : undefined,
        description: 'description' in data ? data.description : undefined,
        imageUrl,
        siteName: 'siteName' in data ? data.siteName : undefined,
        favicon: 'favicons' in data ? data.favicons?.[0] : undefined,
        thumbnail: normalizedThumb ? new Uint8Array(normalizedThumb) : undefined,
      };
    }

    return { url };
  } catch (err) {
    logger.debug('[Preview] Failed to fetch link meta', { url, err: String(err) });
    return null;
  }
}


export interface BaileysLinkPreview {
  'matched-text': string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
  jpegThumbnail?: Buffer;
  linkPreviewMetadata?: unknown;
  highQualityThumbnail?: Record<string, unknown>;
  previewType?: number;
}

export function toBaileysLinkPreview(preview: Partial<LinkMeta>, fallbackUrl: string): BaileysLinkPreview {
  const matchedText = preview.url ?? preview.canonicalUrl ?? fallbackUrl;
  return {
    'matched-text': matchedText,
    canonicalUrl: preview.canonicalUrl ?? matchedText,
    title: preview.title ?? '',
    description: preview.description ?? '',
    jpegThumbnail: preview.thumbnail ? Buffer.from(preview.thumbnail) : undefined,
    linkPreviewMetadata: preview.linkPreviewMetadata,
  };
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
  // Only fetch/normalize thumbnail if not already provided by existingPreview
  // For allstatus with 200+ GCs, existingPreview.thumbnail is pre-normalized once
  // Running normalizeThumbnail 200 times on the same buffer saturates the event loop
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
      logger.debug('[Preview] Failed to download thumbnail', { url, imageUrl: preview.imageUrl, err: String(err) });
    }
  }

  // Only normalize if thumbnail came from a fresh fetch (not pre-normalized existingPreview)
  const needsNormalize = !existingPreview?.thumbnail && !!thumbnail;
  const normalizedThumb = needsNormalize ? await normalizeThumbnail(thumbnail) : undefined;
  const finalThumb = normalizedThumb ? new Uint8Array(normalizedThumb) : thumbnail;

  return {
    text,
    linkPreview: toBaileysLinkPreview({ ...preview, thumbnail: finalThumb }, url),
  } as AnyMessageContent;
}

/**
 * For chat.whatsapp.com links: fetch group profile pic via socket.
 * Returns a LinkMeta with large thumbnail, title, description.
 * Used by all send paths to get a large sharp thumbnail instead of the
 * small 192px one WhatsApp generates on the sender device.
 */
export async function resolveGroupPreview(
  socket: SocketLike,
  url: string
): Promise<Partial<LinkMeta> | undefined> {
  const match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (!match) return undefined;
  try {
    const code = match[1]!;
    const info = await socket.groupGetInviteInfo(code);
    if (!info?.id) return undefined;
    const ppUrl = await socket.profilePictureUrl(info.id, 'image').catch(() => null);
    let thumbnail: Uint8Array | undefined;
    if (ppUrl) {
      const r = await fetch(ppUrl).catch(() => null);
      if (r?.ok) {
        const raw = new Uint8Array(await r.arrayBuffer());
        const normalized = await normalizeThumbnail(raw);
        thumbnail = normalized ? new Uint8Array(normalized) : raw;
      }
    }
    return {
      url,
      title: info.subject ?? 'WhatsApp Group',
      description: `${info.size ?? 0} members`,
      thumbnail,
    };
  } catch {
    return undefined;
  }
}

/**
 * hydratedMessage with socket — always resolves preview properly.
 * For chat.whatsapp.com links: fetches group pic via socket for large thumbnail.
 * For all other URLs: uses fetchLinkMeta with normalizeThumbnail.
 * Same approach as status path — consistent everywhere.
 */
export async function hydratedMessageWithSocket(
  text: string,
  socket: SocketLike,
  existingPreview?: Partial<LinkMeta>
): Promise<AnyMessageContent> {
  const url = existingPreview?.url ?? extractFirstUrl(text);
  if (!url) return { text };

  // For WA group links: always fetch fresh group pic via socket (quoted previews are 192px)
  if (url.includes('chat.whatsapp.com')) {
    const groupPreview = await resolveGroupPreview(socket, url).catch(() => undefined);
    return hydratedMessage(text, groupPreview ?? existingPreview);
  }

  // All other URLs: use existingPreview if available, else fetch fresh
  return hydratedMessage(text, existingPreview);
}
