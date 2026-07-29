// ============================================================
// Anti System — AntiForward Module
// Detects forwarded messages using WhatsApp forwarding metadata.
// ============================================================

import type { WebMessageInfo } from '../../baileys-types.js';

type AnyMsg = Record<string, unknown>;

function getContextInfo(msg: WebMessageInfo): AnyMsg | null {
  const m = msg.message as AnyMsg | null | undefined;
  if (!m) return null;

  // Unwrap ephemeral
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
    ((m['stickerMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null) ||
    ((m['audioMessage'] as AnyMsg | undefined)?.['contextInfo'] as AnyMsg | null ?? null) ||
    null;
}

/**
 * Returns true if the message carries forward metadata.
 */
export function messageIsForwarded(msg: WebMessageInfo): boolean {
  const ci = getContextInfo(msg);
  if (!ci) return false;
  return Boolean(ci['isForwarded'] || (ci['forwardingScore'] !== undefined && Number(ci['forwardingScore']) > 0));
}
