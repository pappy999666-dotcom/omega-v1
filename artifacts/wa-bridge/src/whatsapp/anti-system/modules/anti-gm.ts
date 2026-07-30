// ============================================================
// Anti System — AntiGM Module
// Detects real WhatsApp Status group-mention notifications exposed
// by @crysnovax/baileys WebMessageInfo metadata.
//
// Detection strategy (no recursive traversal — avoids false positives):
//  1. groupStatusMentionMessage — check its direct JID fields
//  2. statusMentions            — flat string / string-array membership
//  3. statusMentionSources      — flat string / string-array membership
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyRecord = Record<string, unknown>;

/** Check whether a flat string value or flat string-array contains groupJid. */
function flatContainsJid(value: unknown, groupJid: string): boolean {
  if (!value) return false;
  if (typeof value === 'string') return value === groupJid;
  // Only check one level of array — no recursive descent into nested objects.
  if (Array.isArray(value)) {
    return (value as unknown[]).some((item) => typeof item === 'string' && item === groupJid);
  }
  return false;
}

/** Returns true only for Baileys-exposed status mention metadata for this group. */
export function messageIsGroupStatusMention(msg: WebMessageInfo, groupJid: string): boolean {
  // Check both the top-level message object AND msg.message (Baileys wraps differently per version)
  const targets: unknown[] = [msg, (msg as unknown as AnyRecord)['message']];

  for (const target of targets) {
    if (!target || typeof target !== 'object') continue;
    const anyTarget = target as AnyRecord;

    // 1. groupStatusMentionMessage field
    const gmm = anyTarget['groupStatusMentionMessage'];
    if (gmm && typeof gmm === 'object' && !Array.isArray(gmm)) {
      const rec = gmm as AnyRecord;
      if (rec['groupJid'] === groupJid) return true;
      if (rec['jid'] === groupJid) return true;
      if (rec['id'] === groupJid) return true;
      // Also check if the message remoteJid matches — some builds omit the inner JID
      if (Object.keys(rec).length > 0) return true; // presence alone = this group was mentioned
    } else if (typeof gmm === 'string' && gmm === groupJid) {
      return true;
    }

    // 2. statusMentions
    if (flatContainsJid(anyTarget['statusMentions'], groupJid)) return true;

    // 3. statusMentionSources
    if (flatContainsJid(anyTarget['statusMentionSources'], groupJid)) return true;
  }

  // 4. The message remoteJid IS the group and message type is groupStatusMentionMessage
  //    — Baileys routes these directly to the group chat
  const msgObj = (msg as unknown as AnyRecord)['message'] as AnyRecord | undefined;
  if (msgObj && 'groupStatusMentionMessage' in msgObj) return true;

  return false;
}
