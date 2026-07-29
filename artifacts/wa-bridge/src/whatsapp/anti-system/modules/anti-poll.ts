// ============================================================
// Anti System — AntiPoll Module
// Detects poll creation messages.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

export function messageIsPoll(msg: WebMessageInfo): boolean {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return false;

  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return messageIsPoll({ ...msg, message: inner as WebMessageInfo['message'] });
  }

  return Boolean(
    m['pollCreationMessage'] ??
    m['pollCreationMessageV2'] ??
    m['pollCreationMessageV3']
  );
}
