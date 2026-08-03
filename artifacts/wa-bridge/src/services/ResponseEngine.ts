// ============================================================
// WA-Bridge — Centralized Response Theme Engine v2
// Formal entry point for all structured response rendering.
// ============================================================

import { pappyBox, PappyBoxOptions, Theme, THEMES, getRandomTheme } from '../utils/pappy-engine.js';
import { successCard, warningCard, errorCard, asciiBox } from '../utils/ascii-art.js';

export interface RenderableResponse {
  type: 'success' | 'warning' | 'error' | 'info' | 'result' | 'custom';
  title: string;
  message?: string;
  rows?: [string, string][];
  footer?: string;
  emoji?: string;
  module?: string;
  details?: string;
  theme?: string;
}

/**
 * The Central Renderer.
 * Converts structured response data into a formatted WhatsApp string.
 */
export function renderResponse(res: RenderableResponse): string {
  const theme = res.theme ? THEMES.find(t => t.name.toLowerCase() === res.theme?.toLowerCase()) : undefined;
  
  const emojiMap = {
    success: '✅',
    warning: '⚠️',
    error: '❌',
    info: 'ℹ️',
    result: '📊',
    custom: res.emoji || '◈'
  };

  return pappyBox({
    title: res.title,
    emoji: emojiMap[res.type] || res.emoji,
    rows: res.rows || [],
    footer: res.message || res.footer || res.details,
    moduleIdentity: res.module,
    theme
  });
}

export type { Theme, PappyBoxOptions };
export { THEMES, getRandomTheme, pappyBox };
