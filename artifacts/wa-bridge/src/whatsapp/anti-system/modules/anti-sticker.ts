// ============================================================
// Anti System — AntiSticker Module
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

/** Returns true if the message is a sticker */
export function messageIsSticker(msg: WebMessageInfo): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;
  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return messageIsSticker({ ...msg, message: inner as WebMessageInfo['message'] });
  }
  return Boolean(m['stickerMessage']);
}
