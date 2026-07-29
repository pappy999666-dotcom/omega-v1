// ============================================================
// Anti System — AntiGroupMention Module
// Detects @group mention (status group mention) events.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

export function messageIsGroupMention(msg: WebMessageInfo): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  // Direct group mention message type
  if (m['groupMentionedMessage']) return true;

  // ExtendedTextMessage with group mentions in contextInfo
  const ext = m['extendedTextMessage'] as AnyMsg | undefined;
  if (ext?.['contextInfo']) {
    const ci = ext['contextInfo'] as AnyMsg;
    const gm = ci['groupMentions'] as unknown[] | undefined;
    if (gm && gm.length > 0) return true;
  }

  return false;
}
