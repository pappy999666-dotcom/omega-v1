// ============================================================
// WA-Bridge — Centralized Baileys URL Button Sender
// Attaches platform URL buttons to supported WhatsApp responses.
// ============================================================

import type { BridgeWASocket as WASocket } from '../baileys-types.js';
import { logger } from '../../utils/logger.js';

export interface UrlButton {
  text: string;
  url: string;
}

function cleanUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+$/u.test(trimmed)) return null;
  return trimmed.split('?')[0] ?? trimmed;
}

export function parseUrlButtons(input: string | string[] | null | undefined): UrlButton[] {
  const raw = Array.isArray(input) ? input : input ? input.split(/[\n,]+/u) : [];
  return raw.flatMap((entry, index) => {
    const [labelPart, ...urlParts] = entry.includes('|') ? entry.split('|') : ['', entry];
    const url = cleanUrl(urlParts.join('|') || labelPart);
    if (!url) return [];
    // Fallback label: use provided label if non-empty, otherwise derive from URL host
    let text: string;
    if (urlParts.length > 0 && labelPart.trim()) {
      text = labelPart.trim().slice(0, 25);
    } else {
      // Extract host from URL for a sensible default label
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        text = host.length <= 25 ? host : host.slice(0, 25);
      } catch {
        text = `Open ${index + 1}`;
      }
    }
    return [{ text, url }];
  });
}

export async function sendWithUrlButtons(
  socket: WASocket,
  jid: string,
  content: Record<string, unknown>,
  buttons: UrlButton[],
  options?: Record<string, unknown>
): Promise<boolean> {
  if (buttons.length === 0) return false;
  try {
    // Leverage Baileys nativeFlow message builder
    const message: any = {
      ...content,
      nativeFlow: {
        buttons: buttons.map((button) => ({
          text: button.text,
          url: button.url,
        })),
      },
    };

    // If there are too many buttons, Baileys will handle them according to its implementation.
    // The customized Baileys in this project supports nativeFlow property directly.
    await socket.sendMessage(jid, message, options);
    return true;
  } catch (err) {
    logger.warn('[UrlButtons] native URL button send failed', { err: String(err), count: buttons.length });
    return false;
  }
}
