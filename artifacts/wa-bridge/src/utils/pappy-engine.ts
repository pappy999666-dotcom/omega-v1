// ============================================================
// WA-Bridge — PAPPY Response Engine v3
// Compact Cyberpunk, Gothic, and Premium styling for WhatsApp.
// Optimized for WhatsApp mobile width (~35 chars per line).
// ============================================================

import { bold, italic } from './ascii-art.js';

export interface Theme {
  name: string;
  header: string;
  border: string;
  divider: string;
  symbol: string;
  footer: string;
  layout?: 'standard' | 'compact' | 'minimal' | 'matrix' | 'gothic';
}

// Compact themes — all optimized for WhatsApp mobile width
export const THEMES: Theme[] = [
  { name: 'Omega Core', header: '⟦ ◈ OMEGA • CORE ◈ ⟧', border: '│', divider: '────────', symbol: '⚡', footer: '╰─── OMEGA ───╯', layout: 'compact' },
  { name: 'Dark Terminal', header: '『 DARK TERMINAL 』', border: '│', divider: '----------', symbol: '>', footer: '└──────────────┘', layout: 'compact' },
  { name: 'Royal Gothic', header: '⚜ ROYAL GOTHIC ⚜', border: '│', divider: '── ⚜ ──', symbol: '◈', footer: '⚜ 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭 ⚜', layout: 'compact' },
  { name: 'Matrix Console', header: '［ MATRIX ］', border: '│', divider: '══ ⚡ ══', symbol: '◈', footer: '［ SYSTEM OK ］', layout: 'compact' },
  { name: 'Shadow Protocol', header: '👤 SHADOW PROTOCOL', border: '│', divider: '── 👤 ──', symbol: '✖', footer: '👤 SHADOW 👤', layout: 'compact' },
  { name: 'Obsidian', header: '🌑 OBSIDIAN 🌑', border: '│', divider: '── 🌑 ──', symbol: '✦', footer: '🌑 OBSIDIAN 🌑', layout: 'compact' },
  { name: 'Eclipse', header: '🌑 ECLIPSE 🌑', border: '│', divider: '── 🌑 ──', symbol: '◈', footer: '🌑 ECLIPSE 🌑', layout: 'compact' },
  { name: 'Blood Moon', header: '🌕 BLOOD MOON 🌕', border: '│', divider: '── 🌕 ──', symbol: '✦', footer: '🌕 MOON 🌕', layout: 'compact' },
  { name: 'Frost', header: '❄️ FROST ❄️', border: '│', divider: '── ❄️ ──', symbol: '✦', footer: '❄️ FROST ❄️', layout: 'compact' },
  { name: 'Crimson', header: '🩸 CRIMSON 🩸', border: '│', divider: '── 🩸 ──', symbol: '⚡', footer: '🩸 CRIMSON 🩸', layout: 'compact' },
];

/** Default to Omega Core — the PAPPY signature theme */
export function getRandomTheme(): Theme {
  return THEMES[Math.floor(Math.random() * THEMES.length)]!;
}

export interface PappyBoxOptions {
  title: string;
  rows: [string, string][];
  footer?: string;
  emoji?: string;
  theme?: Theme;
  moduleIdentity?: string;
}

/**
 * PAPPY Response Engine v3 — Compact Structured Layout
 * Header → Title → Content → Information Panel → Footer
 * All layouts fit within WhatsApp mobile width.
 */
export function pappyBox(opts: PappyBoxOptions): string {
  const theme = opts.theme || getRandomTheme();
  const { border, divider, symbol, footer: themeFooter, layout = 'compact' } = theme;

  const lines: string[] = [];

  // 1. Compact Box Header
  const boxTitle = opts.moduleIdentity
    ? `${opts.emoji || ''} ${opts.moduleIdentity.toUpperCase()}`
    : `${opts.emoji || ''} ${opts.title.toUpperCase()}`;

  lines.push(`╭─〔 ${boxTitle} 〕`);
  lines.push(border);

  // 2. Main Message / Description
  if (opts.footer && !opts.footer.includes('◈')) {
    lines.push(`${border} ${opts.footer}`);
    lines.push(border);
  }

  // 3. Information Panel (Rows) — compact layout
  if (opts.rows.length > 0) {
    for (const [label, value] of opts.rows) {
      lines.push(`${border} ${symbol} ${bold(label)}: ${value}`);
    }
  }

  // 4. Special Footer Content (e.g. Menu items)
  if (opts.footer && opts.footer.includes('◈')) {
    lines.push(opts.footer);
  }

  // 5. Compact Box Footer — unified OMEGA • V1 brand (replaces the legacy
  //    PAPPY ×͜× signature across every card/response in the system).
  lines.push(border);
  lines.push(`╰─ 𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭`);

  return lines.join('\n');
}
