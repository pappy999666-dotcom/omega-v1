// ============================================================
// Anti System — AntiChannel Module
// Detects messages forwarded from WhatsApp Channels (Newsletters).
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

function getContextInfo(msg: WebMessageInfo): AnyMsg | null {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return null;

  if (m['ephemeralMessage']) {
    const inner = (m['ephemeralMessage'] as AnyMsg)['message'];
    if (inner) return getContextInfo({ ...msg, message: inner as WebMessageInfo['message'] });
  }

  return (
    (m['extendedTextMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null
  ) ||
    ((m['imageMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null) ||
    ((m['videoMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null) ||
    ((m['documentMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null) ||
    null;
}

/**
 * Returns true if the message was forwarded from a WhatsApp Channel.
 */
export function messageIsFromChannel(msg: WebMessageInfo): boolean {
  const ci = getContextInfo(msg);
  if (!ci) return false;

  const remoteJid = String(ci['remoteJid'] ?? '');
  if (remoteJid.endsWith('@newsletter')) return true;

  if (ci['forwardedNewsletterMessageInfo']) return true;

  return false;
}
