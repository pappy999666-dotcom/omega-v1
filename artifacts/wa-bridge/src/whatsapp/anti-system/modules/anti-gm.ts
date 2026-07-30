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
  const anyMsg = msg as unknown as AnyRecord;

  // 1. groupStatusMentionMessage — check direct JID fields only (no recursive scan).
  //    Its presence already signals a status-mention event; confirm it names this group.
  const gmm = anyMsg['groupStatusMentionMessage'];
  if (gmm && typeof gmm === 'object' && !Array.isArray(gmm)) {
    const rec = gmm as AnyRecord;
    if (rec['groupJid'] === groupJid) return true;
    if (rec['jid'] === groupJid) return true;
    if (rec['id'] === groupJid) return true;
  } else if (typeof gmm === 'string' && gmm === groupJid) {
    return true;
  }

  // 2. statusMentions — flat string array of mentioned group JIDs.
  if (flatContainsJid(anyMsg['statusMentions'], groupJid)) return true;

  // 3. statusMentionSources — flat string array of source group JIDs.
  if (flatContainsJid(anyMsg['statusMentionSources'], groupJid)) return true;

  return false;
}
