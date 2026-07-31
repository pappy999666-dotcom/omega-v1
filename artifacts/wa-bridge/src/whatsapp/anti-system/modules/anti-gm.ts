// ============================================================
// Anti System — AntiGM Module
// Detects WhatsApp Status group-mention notifications.
//
// Baileys delivers these as messages where:
//   msg.key.remoteJid = the group JID that was mentioned
//   msg.message.groupStatusMentionMessage = { message: { protocolMessage: ... } }
//
// The group JID is NOT inside groupStatusMentionMessage content —
// it IS the remoteJid of the message itself.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyRecord = Record<string, unknown>;

/** Returns true if this message is a status group mention for the given group. */
export function messageIsGroupStatusMention(msg: WebMessageInfo, groupJid: string): boolean {
  // The message must be delivered to this group (remoteJid = groupJid)
  if (msg.key.remoteJid !== groupJid) return false;

  const message = (msg as unknown as AnyRecord)['message'] as AnyRecord | undefined;
  if (!message) return false;

  // Primary: groupStatusMentionMessage key present in message
  if ('groupStatusMentionMessage' in message) return true;

  // Secondary: statusMentionMessage (non-group variant, shouldn't reach group chat but check anyway)
  if ('statusMentions' in message || 'statusMentionSources' in message) return true;

  // Also check top-level msg object (some Baileys versions hoist it)
  const topLevel = msg as unknown as AnyRecord;
  if ('groupStatusMentionMessage' in topLevel) return true;

  return false;
}
