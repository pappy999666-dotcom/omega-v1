// ============================================================
// Anti System — AntiText Module
// Blocks plain text messages (no media).
//
// Classification rules (production-hardened):
//   • conversation                       → plain text
//   • extendedTextMessage (no link)      → plain text
//   • extendedTextMessage (canonicalUrl) → link → NOT plain text
//   • ephemeralMessage / viewOnceMessage / viewOnceMessageV2 → recurse
//   • protocolMessage / eventMessage / groupInviteMessage /
//     groupMentionMessage / system messages → NEVER plain text
//   • messages with media (image/video/audio/sticker/doc/poll/contact/
//     location/liveLocation/groupStatusMention/reaction) → NOT plain text
//   • bot command messages (see isBotCommandText) → NOT plain text
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

// Message fields that carry actual content and must exclude a message
// from the plain-text class even if a text-ish field also exists.
const NON_TEXT_KEYS = [
  'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage',
  'documentMessage', 'documentWithCaptionMessage', 'contactMessage',
  'contactsArrayMessage', 'locationMessage', 'liveLocationMessage',
  'pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3',
  'pollUpdateMessage', 'reactionMessage', 'groupStatusMentionMessage',
  'groupInviteMessage', 'buttonsMessage', 'listMessage', 'templateMessage',
  'interactiveMessage', 'orderMessage', 'productMessage', 'invoiceMessage',
  'protocolMessage', 'eventMessage', 'callLogMessage', 'callLogMessageV2',
  'callLogMessageV3', 'callLogMessageV4', 'keepInChatMessage',
  'pinInChatMessage', 'sharePhoneNumberMessage', 'encReactionMessage',
  'editedMessage', 'requestPaymentMessage', 'sendPaymentMessage',
  'cancelPaymentRequestMessage', 'declinePaymentRequestMessage',
  'groupMentionMessage', 'lottieStickerMessage', 'ptvMessage',
  'viewOnceMessage', 'viewOnceMessageV2', 'ephemeralMessage',
  'botInvokeMessage', 'msgRecurring', 'scheduledCallCreationMessage',
  'scheduledCallEditMessage', 'verificationCodeSyncMessage',
];

/**
 * True when the message carries a non-text content field.
 * Unwraps ephemeral/viewOnce containers before the check.
 */
function hasNonTextContent(m: AnyMsg): boolean {
  // Unwrap container wrappers first
  const wrapped = m['ephemeralMessage'] ?? m['viewOnceMessage'] ?? m['viewOnceMessageV2'] ?? m['documentWithCaptionMessage'];
  if (wrapped && typeof wrapped === 'object') {
    const inner = (wrapped as AnyMsg)['message'] as AnyMsg | undefined;
    if (inner && typeof inner === 'object') {
      if (hasNonTextContent(inner)) return true;
    }
  }
  for (const key of NON_TEXT_KEYS) {
    // These two are containers we already recursed into.
    if (key === 'ephemeralMessage' || key === 'viewOnceMessage' || key === 'viewOnceMessageV2' || key === 'documentWithCaptionMessage') continue;
    if (m[key] && typeof m[key] === 'object' && Object.keys(m[key] as AnyMsg).length > 0) return true;
  }
  return false;
}

/** True when the text is a bot command (prefix + known word). */
export function isBotCommandText(text: string, prefix: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!prefix || !prefix.trim()) return false;
  // Null-prefix mode is deliberately excluded — everything could be a command.
  const p = prefix.trim();
  if (!trimmed.startsWith(p)) return false;
  const rest = trimmed.slice(p.length).trimStart();
  const word = rest.split(/\s/)[0] ?? '';
  return /^[a-z][a-z0-9]{1,20}$/i.test(word);
}

/** Returns true if the message is a plain text message (no media). */
export function messageIsPlainText(
  msg: WebMessageInfo,
  opts?: { prefix?: string }
): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return messageIsPlainText({ ...msg, message: inner as WebMessageInfo['message'] }, opts);
  }
  if (m['viewOnceMessage']) {
    const inner = (m['viewOnceMessage'] as AnyMsg)['message'];
    if (inner) return messageIsPlainText({ ...msg, message: inner as WebMessageInfo['message'] }, opts);
  }
  if (m['viewOnceMessageV2']) {
    const inner = (m['viewOnceMessageV2'] as AnyMsg)['message'];
    if (inner) return messageIsPlainText({ ...msg, message: inner as WebMessageInfo['message'] }, opts);
  }

  // Any non-text content field → definitely not plain text.
  if (hasNonTextContent(m)) return false;

  const conversation = m['conversation'];
  if (typeof conversation === 'string' && conversation.length > 0) {
    // Bot commands (prefix + word) are excluded so AntiText never eats
    // command invocations that should reach the dispatcher.
    if (opts?.prefix && isBotCommandText(conversation, opts.prefix)) return false;
    return true;
  }

  const ext = m['extendedTextMessage'] as AnyMsg | undefined;
  if (ext?.['text'] && !ext?.['canonicalUrl']) {
    const text = String(ext['text']);
    if (opts?.prefix && isBotCommandText(text, opts.prefix)) return false;
    return true;
  }

  return false;
}
