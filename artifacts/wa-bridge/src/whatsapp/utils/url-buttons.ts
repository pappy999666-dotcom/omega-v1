// ============================================================
// WA-Bridge — Centralized Baileys URL Button Sender
// Attaches platform URL buttons to supported WhatsApp responses.
// ============================================================

import { logger } from '../../utils/logger.js';

export interface UrlButton {
  text: string;
  url: string;
}

function cleanUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+$/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse URL buttons from administrator configuration.
 * Format: "Label|https://url" or just "https://url"
 * Multiple entries separated by newlines or commas.
 */
export function parseUrlButtons(input: string | string[] | null | undefined): UrlButton[] {
  if (!input) return [];
  
  const raw = Array.isArray(input) ? input : input.split(/[\n,]+/u);
  const buttons: UrlButton[] = [];

  for (const entry of raw) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) continue;

    let text: string;
    let url: string | null;

    if (trimmedEntry.includes('|')) {
      const parts = trimmedEntry.split('|');
      text = parts[0]!.trim();
      url = cleanUrl(parts.slice(1).join('|'));
    } else {
      url = cleanUrl(trimmedEntry);
      try {
        text = url ? new URL(url).hostname.replace(/^www\./, '') : '';
      } catch {
        text = url || '';
      }
    }

    if (url && text) {
      buttons.push({
        text: text.slice(0, 40),
        url
      });
    }
  }

  return buttons;
}
