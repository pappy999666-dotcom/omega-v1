// ============================================================
// Anti System — AntiText Module
// Blocks plain text messages.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

/** Returns true if the message is a plain text message (no media). */
export function messageIsPlainText(msg: WebMessageInfo): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return messageIsPlainText({ ...msg, message: inner as WebMessageInfo['message'] });
  }

  // Conversation is always plain text
  if (m['conversation']) return true;

  // ExtendedTextMessage without a URL preview = plain text
  const ext = m['extendedTextMessage'] as AnyMsg | undefined;
  if (ext?.['text'] && !ext?.['canonicalUrl']) return true;

  return false;
}
