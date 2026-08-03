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
  
  switch (res.type) {
    case 'success':
      return successCard(res.title, res.message || '', res.rows || [], res.module);
    case 'warning':
      return warningCard(res.title, res.message || '', res.rows || [], res.module);
    case 'error':
      return errorCard(res.title, res.message || '', res.details, res.module);
    case 'info':
    case 'result':
    case 'custom':
    default:
      return asciiBox({
        title: res.title,
        rows: res.rows || [],
        footer: res.message || res.footer,
        emoji: res.emoji,
        moduleIdentity: res.module
      });
  }
}

export type { Theme, PappyBoxOptions };
export { THEMES, getRandomTheme, pappyBox };
