// ============================================================
// Anti System — AntiGroupCall Module
// Detects WhatsApp group call events.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

/** Returns true if the message signals a group call event */
export function messageIsGroupCall(msg: WebMessageInfo): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  const callLog = m['callLogMessage'] as AnyMsg | undefined;
  if (callLog?.['isGroup']) return true;
  if (m['groupCallMessage']) return true;
  if (m['callInviteMessage']) return true;

  return false;
}
