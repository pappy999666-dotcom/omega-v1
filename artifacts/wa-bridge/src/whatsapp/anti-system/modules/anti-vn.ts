// ============================================================
// Anti System — AntiVN (Voice Note) Module
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

function unwrap(msg: WebMessageInfo): AnyMsg | null {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return null;
  return (
    ((m['viewOnceMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['viewOnceMessageV2'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    ((m['ephemeralMessage'] as AnyMsg | undefined)?.['message'] as AnyMsg | undefined) ??
    m
  );
}

/** Returns true if the message is a push-to-talk (voice note) audio */
export function messageIsVoiceNote(msg: WebMessageInfo): boolean {
  const m = unwrap(msg);
  if (!m) return false;
  const audio = m['audioMessage'] as AnyMsg | undefined;
  return Boolean(audio?.['ptt']);
}
