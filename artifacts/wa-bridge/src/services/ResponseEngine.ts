// ============================================================
// WA-Bridge — Centralized Compact Response Renderer
// ============================================================

import { pappyBox as legacyPappyBox, THEMES, getRandomTheme, type Theme, type PappyBoxOptions } from '../utils/pappy-engine.js';

export type ResponseType = 'success' | 'warning' | 'error' | 'info' | 'result' | 'custom';

export interface RenderableResponse {
  type: ResponseType;
  title: string;
  message?: string;
  rows?: [string, string][];
  footer?: string;
  emoji?: string;
  module?: string;
  details?: string;
  theme?: string;
}

export interface CompactResponseOptions {
  title: string;
  detail?: string;
  rows?: [string, string][];
  emoji?: string;
}

function normalizeTitle(value: string): string {
  return value.replace(/^[\s✅❌⚠️ℹ️⚡️📊⚙️]+/u, '').trim();
}

function renderRows(rows: [string, string][] = []): string[] {
  return rows.map(([label, value]) => `└ ${label}: ${value}`);
}

/** The smallest useful response for a successful action. */
export function mini(title: string, detail?: string, emoji = '✅'): string {
  return [
    `${emoji} ${normalizeTitle(title)}`,
    detail ? `└ ${detail}` : '',
  ].filter(Boolean).join('\n');
}

export function success(title: string, detail?: string, rows: [string, string][] = []): string {
  return [mini(title, detail, '✅'), ...renderRows(rows)].filter(Boolean).join('\n');
}

export function error(title: string, detail?: string, rows: [string, string][] = []): string {
  return [mini(title, detail, '❌'), ...renderRows(rows)].filter(Boolean).join('\n');
}

export function warning(title: string, detail?: string, rows: [string, string][] = []): string {
  return [mini(title, detail, '⚠️'), ...renderRows(rows)].filter(Boolean).join('\n');
}

export function info(title: string, detail?: string, rows: [string, string][] = []): string {
  return [mini(title, detail, 'ℹ️'), ...renderRows(rows)].filter(Boolean).join('\n');
}

export function config(title: string, rows: [string, string][], detail?: string): string {
  return [mini(title, detail, '⚙️'), ...renderRows(rows)].filter(Boolean).join('\n');
}

/** Explicit help responses may use the larger branded layout. */
export function help(body: string): string {
  return body;
}

export function menu(body: string): string {
  return body;
}

export function category(body: string): string {
  return body;
}

export function renderResponse(res: RenderableResponse): string {
  const detail = res.message ?? res.footer ?? res.details;
  switch (res.type) {
    case 'success': return success(res.title, detail, res.rows);
    case 'warning': return warning(res.title, detail, res.rows);
    case 'error': return error(res.title, detail, res.rows);
    case 'info': return info(res.title, detail, res.rows);
    case 'result': return mini(res.title, detail, res.emoji ?? '📊');
    case 'custom': return mini(res.title, detail, res.emoji ?? '◈');
  }
}

// Compatibility exports: theme-aware callers retain the original renderer.
export { Theme, PappyBoxOptions, THEMES, getRandomTheme };
export function pappyBox(options: PappyBoxOptions): string {
  return legacyPappyBox(options);
}
