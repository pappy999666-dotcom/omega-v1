// ============================================================
// WA-Bridge — Chat Preview Pipeline (SEPARATE from status)
// Handles all chat send paths: tag, mtag, allchat, tochat, tochatx
//
// KEY INSIGHT: Normal sendMessage() calls getUrlInfo() automatically
// when generateHighQualityLinkPreview:true is set in socket config.
// So for chat paths with NO existingPreview — just send { text } and
// Baileys handles everything including HQ thumbnail upload to WA servers.
//
// Only when existingPreview is set (passthrough from quoted message)
// do we need to intervene — and only for chat.whatsapp.com links
// where the quoted preview has a small 192px thumbnail.
// ============================================================

import type { AnyMessageContent } from './baileys-types.js';
import { resolveGroupPreview, hydratedMessage, extractFirstUrl, fetchLinkMeta, type LinkMeta } from './preview-generator.js';

type SocketLike = {
  groupGetInviteInfo: (code: string) => Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl: (jid: string, type: string) => Promise<string>;
};

/**
 * Build chat message content with proper preview.
 *
 * - No existingPreview → { text } only. Baileys calls getUrlInfo automatically
 *   with generateHighQualityLinkPreview:true → HQ thumbnail uploaded to WA servers.
 *
 * - existingPreview set + chat.whatsapp.com → fetch fresh group pic via socket
 *   (quoted previews are 192px small).
 *
 * - existingPreview set + other URL → passthrough as-is.
 */
export async function buildChatPreview(
  text: string,
  socket: SocketLike,
  existingPreview?: Partial<LinkMeta>
): Promise<AnyMessageContent> {
  // No existing preview — let Baileys handle getUrlInfo + HQ upload
  if (!existingPreview) return { text };

  const url = existingPreview.url ?? extractFirstUrl(text);
  if (!url) return { text };

  // WA group link with existing (small) preview — fetch fresh large group pic
  if (url.includes('chat.whatsapp.com')) {
    const groupPreview = await resolveGroupPreview(socket, url).catch(() => undefined);
    return hydratedMessage(text, groupPreview ?? existingPreview);
  }

  // Other URL with existing preview — passthrough
  return hydratedMessage(text, existingPreview);
}

/**
 * Resolve preview once for a URL before a bulk loop (allstatus, allchat).
 * Avoids calling groupGetInviteInfo per-group for the same URL.
 */
export async function resolvePreviewOnce(
  url: string,
  socket: SocketLike
): Promise<Partial<LinkMeta> | undefined> {
  if (!url) return undefined;
  if (url.includes('chat.whatsapp.com')) {
    return resolveGroupPreview(socket, url).catch(() => undefined);
  }
  // Non-WA URLs: fetch og:meta + normalize thumbnail once
  // So hydratedMessage reuses it 200 times without re-fetching or re-normalizing
  const meta = await fetchLinkMeta(url).catch(() => null);
  return meta ?? undefined;
}
