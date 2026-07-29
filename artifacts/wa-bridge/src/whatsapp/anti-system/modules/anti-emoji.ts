// ============================================================
// Anti System — AntiEmoji Module
// Detects messages that contain Unicode emoji.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

// Match any Unicode emoji
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;

function extractText(msg: WebMessageInfo): string {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return '';
  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return extractText({ ...msg, message: inner as WebMessageInfo['message'] });
  }
  return (
    String(m['conversation'] ?? '') ||
    String((m['extendedTextMessage'] as AnyMsg | undefined)?.['text'] ?? '')
  );
}

/** Returns true if the message text contains emoji */
export function messageContainsEmoji(msg: WebMessageInfo): boolean {
  const text = extractText(msg);
  if (!text) return false;
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(text);
}
