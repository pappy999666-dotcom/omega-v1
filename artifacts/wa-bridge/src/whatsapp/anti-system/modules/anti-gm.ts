// ============================================================
// Anti System — AntiGM Module
// Detects real WhatsApp Status group-mention notifications exposed
// by @crysnovax/baileys WebMessageInfo metadata.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyRecord = Record<string, unknown>;

function hasGroupJid(value: unknown, groupJid: string): boolean {
  if (!value) return false;
  if (typeof value === 'string') return value === groupJid;
  if (Array.isArray(value)) return value.some((item) => hasGroupJid(item, groupJid));
  if (typeof value === 'object') {
    return Object.values(value as AnyRecord).some((item) => hasGroupJid(item, groupJid));
  }
  return false;
}

/** Returns true only for Baileys-exposed status mention metadata for this group. */
export function messageIsGroupStatusMention(msg: WebMessageInfo, groupJid: string): boolean {
  const anyMsg = msg as unknown as AnyRecord;
  if (hasGroupJid(anyMsg['statusMentions'], groupJid)) return true;
  if (hasGroupJid(anyMsg['statusMentionSources'], groupJid)) return true;
  if (hasGroupJid(anyMsg['statusMentionMessageInfo'], groupJid)) return true;
  return false;
}
