// ============================================================
// Anti System — AntiGM Module (v2 — zero false positives)
//
// WHAT THIS MODULE PROTECTS AGAINST
//   WhatsApp's native "Status @Group" feature: a user posts a
//   Status that explicitly mentions a group. Every member of that
//   group receives a dedicated system-delivered message whose
//   top-level content type is `groupStatusMentionMessage`.
//
// ROOT CAUSE OF THE OLD FALSE-POSITIVE BUG
//   Baileys decodes WebMessageInfo through protobufjs. Absent
//   message fields are materialized as empty objects on the decoded
//   payload, so `'groupStatusMentionMessage' in message` is TRUE for
//   EVERY message in the chat. The old detector treated key presence
//   as the trigger and therefore deleted every message once the
//   module was enabled.
//
// CORRECT DETECTION RULES (all must hold):
//   1. remoteJid is a group AND is the group this message arrived in
//   2. The message is not from the bot itself
//   3. `message.groupStatusMentionMessage` exists AND is a real
//      object carrying an INNER message with an actual content type
//      (the inner wrapper is populated only for genuine mentions).
//      An empty wrapper ({}), a protocolMessage stub, or a message
//      with no content type is NOT a mention and is ignored.
//
// EVERYTHING ELSE IS IGNORED:
//   normal text, images, stickers, videos, voice notes, polls,
//   forwarded messages, quoted messages, statusMentionSources,
//   statusMentionReply, statusMentions, groupMentionedMessage —
//   none of those are the Status @Group event and none trigger.
//
// The detector logs WHY it did or did not trigger so every decision
// is observable in production.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';
import { logger } from '../../../utils/logger.js';

type AnyRecord = Record<string, unknown>;

/** Detect the primary content type key of a message payload. */
function detectContentType(inner: AnyRecord | null | undefined): string | null {
  if (!inner || typeof inner !== 'object') return null;
  const keys = Object.keys(inner);
  if (keys.length === 0) return null;
  // A real message has exactly one content-type key. Prefer the first known
  // content key; ignore metadata-only keys.
  const contentKeys = [
    'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage',
    'audioMessage', 'stickerMessage', 'documentMessage', 'contactMessage',
    'locationMessage', 'pollCreationMessage', 'pollCreationMessageV2',
    'pollCreationMessageV3', 'protocolMessage', 'reactionMessage',
    'buttonsMessage', 'buttonsResponseMessage', 'listMessage',
    'listResponseMessage', 'templateMessage', 'interactiveMessage',
    'groupStatusMessage', 'groupStatusMessageV2', 'editedMessage',
    'viewOnceMessage', 'ephemeralMessage',
  ];
  const found = contentKeys.find((k) => k in inner);
  return found ?? keys[0] ?? null;
}

/** A genuine Status @Group mention or null (never a guess). */
export function messageIsGroupStatusMention(
  msg: WebMessageInfo,
  groupJid: string
): boolean {
  const remoteJid = msg.key?.remoteJid ?? '';

  // Rule 1 — must be a group message delivered to THIS group.
  if (!remoteJid.endsWith('@g.us')) {
    return false;
  }
  if (remoteJid !== groupJid) {
    return false;
  }

  // Rule 2 — never punish the bot's own traffic.
  if (msg.key?.fromMe) {
    return false;
  }

  const message = (msg as unknown as AnyRecord)['message'] as AnyRecord | undefined;
  if (!message || typeof message !== 'object') {
    return false;
  }

  // Rule 3 — the ONLY valid trigger is a native groupStatusMentionMessage
  // wrapper that actually carries a real inner message.
  const gsm = message['groupStatusMentionMessage'];
  if (gsm && typeof gsm === 'object') {
    const inner = (gsm as AnyRecord)['message'] as AnyRecord | undefined;
    const innerType = detectContentType(inner);
    const isReal = Boolean(innerType && innerType !== 'protocolMessage');

    if (isReal) {
      logger.info('[AntiGM] Status @Group mention detected — triggering', {
        groupJid,
        innerType,
        messageId: msg.key?.id,
      });
      return true;
    }

    // Empty / stub wrapper — system noise, NOT a user mention.
    logger.debug('[AntiGM] groupStatusMentionMessage wrapper carries no real content — ignored', {
      groupJid,
      innerType: innerType ?? 'none',
      messageId: msg.key?.id,
    });
    return false;
  }

  // Everything else — text, media, stickers, forwards, quotes, status
  // mention sources/replies — is explicitly NOT this event.
  logger.debug('[AntiGM] No native Status @Group payload — ignored', {
    groupJid,
    hasGroupStatusMention: 'groupStatusMentionMessage' in message,
    messageId: msg.key?.id,
  });
  return false;
}
