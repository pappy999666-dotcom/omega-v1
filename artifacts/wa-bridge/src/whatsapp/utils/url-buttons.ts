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
  // Preserve full URL including query params for accuracy
  return trimmed;
}

/**
 * Parse URL buttons from administrator configuration.
 * Format: "Label|https://url" or just "https://url"
 * Multiple entries separated by newlines or commas.
 */
export function parseUrlButtons(input: string | string[] | null | undefined): UrlButton[] {
  const raw = Array.isArray(input) ? input : input ? input.split(/[\n,]+/u) : [];
  return raw.flatMap((entry) => {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) return [];

    let text: string;
    let url: string | null;

    if (trimmedEntry.includes('|')) {
      const parts = trimmedEntry.split('|');
      text = parts[0].trim();
      url = cleanUrl(parts.slice(1).join('|'));
    } else {
      url = cleanUrl(trimmedEntry);
      // No "Open" fallback. If no label, use the domain or full URL.
      try {
        text = url ? new URL(url).hostname.replace(/^www\./, '') : '';
      } catch {
        text = url || '';
      }
    }

    if (!url || !text) return [];

    return [{ 
      text: text.slice(0, 40), // WhatsApp supports longer labels than 25, but let's be safe
      url 
    }];
  });
}


