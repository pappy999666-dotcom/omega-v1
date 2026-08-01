// ============================================================
// Anti System — AntiLink Module
// Detects any link/URL in messages and configured containers.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

/**
 * Regex that matches virtually every link format WhatsApp supports.
 */
const LINK_RE =
  /(?:(?:https?|ftp):\/\/)?(?:www\.)?(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com|net|org|io|co|app|me|xyz|info|biz|us|uk|de|fr|ru|in|vn|id|ng|gh|za|ph|br|mx|ca|au|nz|chat\.whatsapp\.com|whatsapp\.com|t\.me|wa\.me|bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|buff\.ly|rb\.gy|is\.gd|short\.gy|cutt\.ly|dub\.sh)(?:\/[^\s]*)?/i;

/** Check any text string for link presence */
export function textContainsLink(text: string): boolean {
  return LINK_RE.test(text);
}

type AnyMsg = Record<string, unknown>;

/** Recursively extract all text content from a message */
function extractAllText(msg: WebMessageInfo): string[] {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return [];

  const texts: string[] = [];
  const add = (s: unknown) => { if (typeof s === 'string' && s) texts.push(s); };

  // Direct text
  add(m['conversation']);
  add((m['extendedTextMessage'] as AnyMsg | undefined)?.['text']);
  add((m['extendedTextMessage'] as AnyMsg | undefined)?.['canonicalUrl']);
  add((m['extendedTextMessage'] as AnyMsg | undefined)?.['matchedText']);

  // Media captions — only check user-visible text (captions), never CDN URLs.
  // audioMessage.url / videoMessage.url / imageMessage.url are CDN download URLs
  // (e.g. https://mmg.whatsapp.net/…) and must NOT be scanned for links — they
  // would trigger AntiLink for every voice note and media message.
  add((m['imageMessage'] as AnyMsg | undefined)?.['caption']);
  add((m['videoMessage'] as AnyMsg | undefined)?.['caption']);
  add((m['documentMessage'] as AnyMsg | undefined)?.['caption']);
  add(
    ((m['documentWithCaptionMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined)
      ?.['documentMessage'] as AnyMsg | undefined
  );

  // View-once containers
  for (const voKey of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    const vo = (m[voKey] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined;
    if (vo) {
      add((vo['imageMessage'] as AnyMsg | undefined)?.['caption']);
      add((vo['videoMessage'] as AnyMsg | undefined)?.['caption']);
    }
  }

  // Ephemeral messages — recurse
  const eph = (m['ephemeralMessage'] as AnyMsg | undefined)?.['message'];
  if (eph) {
    texts.push(...extractAllText({ ...msg, message: eph as WebMessageInfo['message'] }));
  }

  // Button messages
  const btn = m['buttonsMessage'] as AnyMsg | undefined;
  if (btn) {
    add(btn['contentText']);
  }

  // Poll name
  const poll = (m['pollCreationMessage'] ?? m['pollCreationMessageV2'] ?? m['pollCreationMessageV3']) as AnyMsg | undefined;
  if (poll) add(poll['name']);

  // List messages
  const list = m['listMessage'] as AnyMsg | undefined;
  if (list) {
    add(list['description']);
    add(list['title']);
    for (const section of (list['sections'] as AnyMsg[] | undefined) ?? []) {
      add(section['title']);
      for (const row of (section['rows'] as AnyMsg[] | undefined) ?? []) {
        add(row['title']);
        add(row['description']);
      }
    }
  }

  return texts;
}

/**
 * Returns true if the message contains any link/URL.
 */
export function messageContainsLink(msg: WebMessageInfo): boolean {
  const texts = extractAllText(msg);
  return texts.some(textContainsLink);
}
