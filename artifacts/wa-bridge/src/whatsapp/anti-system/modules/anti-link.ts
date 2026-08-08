// ============================================================
// Anti System — AntiLink Module
// Detects user-visible URLs in group messages and configured containers.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';
import { logger } from '../../../utils/logger.js';

type AnyMessage = Record<string, unknown>;

/**
 * Candidate URL matcher. Validation is done with the platform URL parser below;
 * this pattern deliberately does not contain a hardcoded TLD allow-list.
 *
 * It accepts:
 *   - http(s)/ftp URLs
 *   - www-prefixed URLs
 *   - ordinary bare domains (including unknown/new TLDs)
 *
 * The matcher is only run over user-visible text fields, never over the raw
 * message object, so media CDN URLs cannot trigger AntiLink.
 */
const URL_CANDIDATE_RE =
  /(?:https?|ftp):\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+|(?<![\w@.-])(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z][a-z0-9_-]{1,62}(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/giu;

const TRAILING_PUNCTUATION = /[.,!?;:'"…。！？、，；：）】』》]$/u;
const CLOSING_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [')', '('],
  [']', '['],
  ['}', '{'],
];

/** Remove punctuation added by the sentence around a URL. */
function trimUrlPunctuation(raw: string): string {
  let value = raw;
  while (TRAILING_PUNCTUATION.test(value)) value = value.slice(0, -1);

  // Keep balanced parentheses/brackets in a URL path, but remove a closing
  // delimiter that belongs to surrounding prose: "https://x.test/path)."
  for (const [closing, opening] of CLOSING_PAIRS) {
    while (value.endsWith(closing)) {
      const openCount = [...value].filter((char) => char === opening).length;
      const closeCount = [...value].filter((char) => char === closing).length;
      if (closeCount <= openCount) break;
      value = value.slice(0, -1);
    }
  }
  return value;
}

/**
 * Parse and validate a candidate without requiring a scheme in the message.
 * Bare domains are parsed as HTTPS for validation, while the returned value
 * remains exactly as written by the user (apart from surrounding punctuation).
 */
function normalizeCandidate(raw: string): string | null {
  const candidate = trimUrlPunctuation(raw);
  if (!candidate) return null;

  const parseValue = /^(?:https?|ftp):\/\//iu.test(candidate)
    ? candidate
    : `https://${candidate}`;

  try {
    const parsed = new URL(parseValue);
    if (!['http:', 'https:', 'ftp:'].includes(parsed.protocol)) return null;

    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (!hostname || !hostname.includes('.')) return null;

    // URL() validates ports, forbidden whitespace, and malformed authority
    // syntax. Keep label validation here so prose such as "foo..bar" is not
    // treated as a link while still allowing valid underscore host labels.
    const labels = hostname.split('.');
    if (labels.some((label) => (
      !label ||
      label.length > 63 ||
      !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/iu.test(label)
    ))) {
      return null;
    }
    const tld = labels[labels.length - 1] ?? '';
    if (tld.length < 2 || tld.length > 63 || !/^[a-z][a-z0-9_-]*$/iu.test(tld)) return null;

    return candidate;
  } catch {
    return null;
  }
}

/** Extract every validated URL from text, preserving message order. */
export function extractUrls(text: string): string[] {
  if (!text) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  URL_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_CANDIDATE_RE.exec(text)) !== null) {
    const url = normalizeCandidate(match[0]);
    if (!url) {
      logger.debug('[AntiLink] URL candidate rejected', {
        candidate: trimUrlPunctuation(match[0]),
        reason: 'invalid URL or hostname',
      });
      continue;
    }
    // URL schemes/domains are case-insensitive for duplicate purposes, while
    // the first spelling is retained for diagnostics and future logging.
    const key = url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(url);
    }
  }
  URL_CANDIDATE_RE.lastIndex = 0;
  return found;
}

/** Check any user-visible text string for at least one valid URL. */
export function textContainsLink(text: string): boolean {
  return extractUrls(text).length > 0;
}

function addText(texts: string[], value: unknown): void {
  if (typeof value === 'string' && value.trim()) texts.push(value);
}

function addContextText(texts: string[], context: AnyMessage | null | undefined, seen: Set<object>, depth: number): void {
  if (!context || depth > 12) return;
  const quotedMessage = context['quotedMessage'];
  if (quotedMessage && typeof quotedMessage === 'object') {
    collectMessageText(quotedMessage as AnyMessage, texts, seen, depth + 1);
  }
}

function addListText(texts: string[], list: AnyMessage | null | undefined): void {
  if (!list) return;
  addText(texts, list['title']);
  addText(texts, list['description']);
  const sections = list['sections'];
  if (!Array.isArray(sections)) return;
  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const sectionRecord = section as AnyMessage;
    addText(texts, sectionRecord['title']);
    const rows = sectionRecord['rows'];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      addText(texts, (row as AnyMessage)['title']);
      addText(texts, (row as AnyMessage)['description']);
    }
  }
}

/** Collect only text-bearing fields from one Baileys message node. */
function collectMessageText(
  message: AnyMessage,
  texts: string[],
  seen: Set<object>,
  depth: number
): void {
  if (depth > 12 || seen.has(message)) return;
  seen.add(message);

  addText(texts, message['conversation']);

  const extended = message['extendedTextMessage'];
  if (extended && typeof extended === 'object') {
    const ext = extended as AnyMessage;
    addText(texts, ext['text']);
    // These are hydrated/user-visible link fields, unlike media download URLs.
    addText(texts, ext['matchedText']);
    addText(texts, ext['canonicalUrl']);
    addText(texts, ext['title']);
    addText(texts, ext['description']);
    addContextText(texts, ext['contextInfo'] as AnyMessage | undefined, seen, depth + 1);
  }

  for (const mediaKey of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
    const media = message[mediaKey];
    if (!media || typeof media !== 'object') continue;
    const mediaRecord = media as AnyMessage;
    addText(texts, mediaRecord['caption']);
    addContextText(texts, mediaRecord['contextInfo'] as AnyMessage | undefined, seen, depth + 1);
  }

  const documentWithCaption = message['documentWithCaptionMessage'];
  if (documentWithCaption && typeof documentWithCaption === 'object') {
    const inner = (documentWithCaption as AnyMessage)['message'];
    if (inner && typeof inner === 'object') collectMessageText(inner as AnyMessage, texts, seen, depth + 1);
  }

  for (const wrapperKey of [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'templateMessage',
    'editedMessage',
    'groupStatusMessage',
    'groupStatusMessageV2',
    'groupStatusMentionMessage',
  ]) {
    const wrapper = message[wrapperKey];
    if (!wrapper || typeof wrapper !== 'object') continue;
    const wrapperRecord = wrapper as AnyMessage;
    const inner = wrapperRecord['message'];
    if (inner && typeof inner === 'object') collectMessageText(inner as AnyMessage, texts, seen, depth + 1);
    const hydrated = wrapperRecord['hydratedTemplate'];
    if (hydrated && typeof hydrated === 'object') addText(texts, (hydrated as AnyMessage)['hydratedContentText']);
  }

  const buttons = message['buttonsMessage'];
  if (buttons && typeof buttons === 'object') {
    const buttonRecord = buttons as AnyMessage;
    addText(texts, buttonRecord['contentText']);
    addContextText(texts, buttonRecord['contextInfo'] as AnyMessage | undefined, seen, depth + 1);
  }

  const buttonResponse = message['buttonsResponseMessage'];
  if (buttonResponse && typeof buttonResponse === 'object') {
    addText(texts, (buttonResponse as AnyMessage)['selectedDisplayText']);
  }

  const list = message['listMessage'];
  if (list && typeof list === 'object') {
    addListText(texts, list as AnyMessage);
    addContextText(texts, (list as AnyMessage)['contextInfo'] as AnyMessage | undefined, seen, depth + 1);
  }

  const listResponse = message['listResponseMessage'];
  if (listResponse && typeof listResponse === 'object') {
    const reply = (listResponse as AnyMessage)['singleSelectReply'];
    if (reply && typeof reply === 'object') addText(texts, (reply as AnyMessage)['selectedDisplayText']);
  }

  const templateReply = message['templateButtonReplyMessage'];
  if (templateReply && typeof templateReply === 'object') {
    addText(texts, (templateReply as AnyMessage)['selectedDisplayText']);
  }

  const interactive = message['interactiveMessage'];
  if (interactive && typeof interactive === 'object') {
    const interactiveRecord = interactive as AnyMessage;
    for (const field of ['header', 'body', 'footer']) {
      const value = interactiveRecord[field];
      if (value && typeof value === 'object') addText(texts, (value as AnyMessage)['text'] ?? (value as AnyMessage)['title']);
    }
    addContextText(texts, interactiveRecord['contextInfo'] as AnyMessage | undefined, seen, depth + 1);
  }

  const interactiveResponse = message['interactiveResponseMessage'];
  if (interactiveResponse && typeof interactiveResponse === 'object') {
    const response = interactiveResponse as AnyMessage;
    const body = response['body'];
    if (body && typeof body === 'object') addText(texts, (body as AnyMessage)['text']);
  }

  for (const pollKey of ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3']) {
    const poll = message[pollKey];
    if (poll && typeof poll === 'object') addText(texts, (poll as AnyMessage)['name']);
  }
}

/** Recursively extract all user-visible text, including quoted messages. */
export function extractAllText(msg: WebMessageInfo): string[] {
  const texts: string[] = [];
  const message = msg.message as AnyMessage | null | undefined;
  if (message) collectMessageText(message, texts, new Set<object>(), 0);
  return texts;
}

/** Extract all links from a WhatsApp message, regardless of chat scope. */
export function messageLinks(msg: WebMessageInfo): string[] {
  return extractAllText(msg).flatMap(extractUrls);
}

/**
 * Returns true if the message contains any link/URL.
 * Early exits for non-group messages (links are only blocked in groups).
 */
export function messageContainsLink(msg: WebMessageInfo): boolean {
  if (!msg.key.remoteJid?.endsWith('@g.us')) return false;
  return messageLinks(msg).length > 0;
}
