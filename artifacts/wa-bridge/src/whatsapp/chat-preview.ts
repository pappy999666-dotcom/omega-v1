// ============================================================
// WA-Bridge — Chat Preview Pipeline
// Compatibility shim — delegates to centralized PreviewManager.
//
// All chat send paths (tag, mtag, allchat, tochat, tochatx)
// now flow through the centralized PreviewManager.
// ============================================================

import type { AnyMessageContent } from './baileys-types.js';
import { PreviewManager } from '../preview-engine/index.js';
import type { PartialLinkMeta } from '../preview-engine/types.js';

type SocketLike = {
  groupGetInviteInfo: (code: string) => Promise<{ id: string; subject?: string; size?: number }>;
  profilePictureUrl: (jid: string, type: string) => Promise<string | null>;
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
  existingPreview?: PartialLinkMeta
): Promise<AnyMessageContent> {
  return PreviewManager.buildChatPreview(text, socket as never, existingPreview);
}

/**
 * Resolve preview once for a URL before a bulk loop (allstatus, allchat).
 * Avoids calling groupGetInviteInfo per-group for the same URL.
 */
export async function resolvePreviewOnce(
  url: string,
  socket: SocketLike
): Promise<PartialLinkMeta | undefined> {
  return PreviewManager.resolvePreviewOnce(url, socket as never);
}
