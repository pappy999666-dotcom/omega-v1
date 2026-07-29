// ============================================================
// Anti System — AntiWords Module
// Blocks messages containing configured words/phrases.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

function extractText(msg: WebMessageInfo): string {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return '';
  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return extractText({ ...msg, message: inner as WebMessageInfo['message'] });
  }
  return (
    String(m['conversation'] ?? '') ||
    String((m['extendedTextMessage'] as AnyMsg | undefined)?.['text'] ?? '') ||
    String((m['imageMessage'] as AnyMsg | undefined)?.['caption'] ?? '') ||
    String((m['videoMessage'] as AnyMsg | undefined)?.['caption'] ?? '') ||
    String((m['documentMessage'] as AnyMsg | undefined)?.['caption'] ?? '')
  ).toLowerCase();
}

/** Returns the first matched blocked word, or null if none matched */
export function messageContainsBlockedWord(
  msg: WebMessageInfo,
  words: string[]
): string | null {
  if (!words.length) return null;
  const text = extractText(msg);
  for (const word of words) {
    if (text.includes(word.toLowerCase())) return word;
  }
  return null;
}
