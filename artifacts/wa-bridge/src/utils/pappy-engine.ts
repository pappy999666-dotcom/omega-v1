// ============================================================
// WA-Bridge — PAPPY Response Engine v2
// High-tech, Cyberpunk, Gothic, and Premium styling for WhatsApp.
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

export const THEMES: Theme[] = [
  { name: 'Gothic Cathedral', header: '☩ GOTHIC CATHEDRAL ☩', border: '┃', divider: '── ⸸ ──', symbol: '✦', footer: '╰────── ⸸ ──────╯', layout: 'gothic' },
  { name: 'Omega Core', header: '⟦ ◈ OMEGA • CORE ◈ ⟧', border: '┃', divider: '━━━━━━━━━━━━', symbol: '⚡', footer: '╰─── OMEGA ───╯', layout: 'standard' },
  { name: 'Cyber Monastery', header: '☩ CYBER MONASTERY ☩', border: '┇', divider: '── ◈ ──', symbol: '❖', footer: '╰── DIGITAL ☩ ──╯', layout: 'gothic' },
  { name: 'Dark Terminal', header: '『 DARK TERMINAL 』', border: '▏', divider: '----------', symbol: '>', footer: '└───────────────┘', layout: 'compact' },
  { name: 'Matrix Console', header: '［ MATRIX CONSOLE ］', border: '║', divider: '══ ⚡ ══', symbol: '◈', footer: '［ SYSTEM OK ］', layout: 'matrix' },
  { name: 'Quantum Engine', header: '⚛ QUANTUM ENGINE ⚛', border: '┇', divider: '〰〰〰〰〰', symbol: '⌬', footer: '⚛ QUANTUM ⚛', layout: 'minimal' },
  { name: 'Royal Gothic', header: '⚜ ROYAL GOTHIC ⚜', border: '┃', divider: '── ⚜ ──', symbol: '◈', footer: '⚜ 𝕻𝕬𝕻𝕻𝖄 ⚜', layout: 'gothic' },
  { name: 'Neon Frame', header: '『 NEON FRAME 』', border: '┇', divider: '━━ ✦ ━━', symbol: '⚡', footer: '『 NEON ⚡ 』', layout: 'compact' },
  { name: 'Digital Scroll', header: '📜 DIGITAL SCROLL 📜', border: '│', divider: '┈┈┈┈┈┈', symbol: '🔹', footer: '📜 END SCROLL 📜', layout: 'minimal' },
  { name: 'Shadow Protocol', header: '👤 SHADOW PROTOCOL 👤', border: '▏', divider: '── 👤 ──', symbol: '✖', footer: '👤 SHADOW 👤', layout: 'compact' },
  { name: 'Inferno', header: '🔥 INFERNO 🔥', border: '┃', divider: '── 🔥 ──', symbol: '⚡', footer: '🔥 INFERNO 🔥', layout: 'standard' },
  { name: 'Obsidian', header: '🌑 OBSIDIAN 🌑', border: '┃', divider: '── 🌑 ──', symbol: '✦', footer: '🌑 OBSIDIAN 🌑', layout: 'standard' },
  { name: 'Phantom', header: '👻 PHANTOM 👻', border: '┇', divider: '── 👻 ──', symbol: '❖', footer: '👻 PHANTOM 👻', layout: 'minimal' },
  { name: 'Void Engine', header: '🌌 VOID ENGINE 🌌', border: '║', divider: '── 🌌 ──', symbol: '◈', footer: '🌌 VOID 🌌', layout: 'matrix' },
  { name: 'Black Archive', header: '🗄️ BLACK ARCHIVE 🗄️', border: '│', divider: '── 🗄️ ──', symbol: '🔹', footer: '🗄️ ARCHIVE 🗄️', layout: 'minimal' },
  { name: 'Frost', header: '❄️ FROST ❄️', border: '┃', divider: '── ❄️ ──', symbol: '✦', footer: '❄️ FROST ❄️', layout: 'standard' },
  { name: 'Crimson', header: '🩸 CRIMSON 🩸', border: '┃', divider: '── 🩸 ──', symbol: '⚡', footer: '🩸 CRIMSON 🩸', layout: 'standard' },
  { name: 'Sakura Noir', header: '🌸 SAKURA NOIR 🌸', border: '┇', divider: '── 🌸 ──', symbol: '❖', footer: '🌸 SAKURA 🌸', layout: 'minimal' },
  { name: 'Eclipse', header: '🌑 ECLIPSE 🌑', border: '║', divider: '── 🌑 ──', symbol: '◈', footer: '🌑 ECLIPSE 🌑', layout: 'matrix' },
  { name: 'Cyber Core', header: '🤖 CYBER CORE 🤖', border: '│', divider: '── 🤖 ──', symbol: '🔹', footer: '🤖 CYBER 🤖', layout: 'minimal' },
  { name: 'Blood Moon', header: '🌕 BLOOD MOON 🌕', border: '┃', divider: '── 🌕 ──', symbol: '✦', footer: '🌕 MOON 🌕', layout: 'standard' },
  { name: 'Iron Ghost', header: '⛓️ IRON GHOST ⛓️', border: '┃', divider: '── ⛓️ ──', symbol: '⚡', footer: '⛓️ IRON ⛓️', layout: 'standard' },
  { name: 'Neon Viper', header: '🐍 NEON VIPER 🐍', border: '┇', divider: '── 🐍 ──', symbol: '❖', footer: '🐍 VIPER 🐍', layout: 'minimal' },
  { name: 'Cyber Samurai', header: '⚔️ CYBER SAMURAI ⚔️', border: '║', divider: '── ⚔️ ──', symbol: '◈', footer: '⚔️ SAMURAI ⚔️', layout: 'matrix' },
  { name: 'Void Walker', header: '🚶 VOID WALKER 🚶', border: '│', divider: '── 🚶 ──', symbol: '🔹', footer: '🚶 WALKER 🚶', layout: 'minimal' },
  { name: 'Dark Nebula', header: '🌌 DARK NEBULA 🌌', border: '┃', divider: '── 🌌 ──', symbol: '✦', footer: '🌌 NEBULA 🌌', layout: 'standard' },
  { name: 'Cyber Punk', header: '🎸 CYBER PUNK 🎸', border: '┃', divider: '── 🎸 ──', symbol: '⚡', footer: '🎸 PUNK 🎸', layout: 'standard' },
  { name: 'Neon Dragon', header: '🐉 NEON DRAGON 🐉', border: '┇', divider: '── 🐉 ──', symbol: '❖', footer: '🐉 DRAGON 🐉', layout: 'minimal' },
  { name: 'Void Reaper', header: '💀 VOID REAPER 💀', border: '║', divider: '── 💀 ──', symbol: '◈', footer: '💀 REAPER 💀', layout: 'matrix' },
  { name: 'Cyber Shogun', header: '🏯 CYBER SHOGUN 🏯', border: '│', divider: '── 🏯 ──', symbol: '🔹', footer: '🏯 SHOGUN 🏯', layout: 'minimal' },
  { name: 'High-Tech', header: '📡 HIGH-TECH 📡', border: '▏', divider: '── 📡 ──', symbol: '⚡', footer: '📡 TECH 📡', layout: 'compact' },
  { name: 'Matrix v2', header: '⚡ MATRIX V2 ⚡', border: '║', divider: '══ ⚡ ══', symbol: '◈', footer: '⚡ MATRIX ⚡', layout: 'matrix' },
];

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
 * PAPPY Response Engine v2 — Structured Layout
 * Header → Title → Content → Information Panel → Footer
 */
export function pappyBox(opts: PappyBoxOptions): string {
  const theme = opts.theme || getRandomTheme();
  const { header, border, divider, symbol, footer: themeFooter, layout = 'standard' } = theme;

  const lines: string[] = [];

  // 1. Header
  lines.push(header);
  lines.push('');

  // 2. Title / Module Identity
  if (opts.moduleIdentity) {
    lines.push(`☩ ${opts.moduleIdentity.toUpperCase()}`);
  } else {
    lines.push(`${opts.emoji ? `${opts.emoji} ` : ''}${bold(opts.title.toUpperCase())}`);
  }
  lines.push('');

  // 3. Information Panel (Rows)
  // Layout varies based on theme preference
  switch (layout) {
    case 'matrix':
      for (const [label, value] of opts.rows) {
        lines.push(`${border} ${symbol} ${label.toUpperCase()}`);
        lines.push(`${border} ┗▶ ${value}`);
        lines.push(border);
      }
      break;
    case 'compact':
      for (const [label, value] of opts.rows) {
        lines.push(`${border} ${bold(label)}: ${value}`);
      }
      break;
    case 'minimal':
      for (const [label, value] of opts.rows) {
        lines.push(`${symbol} ${label} → ${value}`);
      }
      break;
    case 'gothic':
      for (const [label, value] of opts.rows) {
        lines.push(`${border} ☩ ${label}`);
        lines.push(`${border}   ${italic(value)}`);
        lines.push(border);
      }
      break;
    case 'standard':
    default:
      for (const [label, value] of opts.rows) {
        lines.push(`${border} ${symbol} ${label}`);
        lines.push(`${border}   ${value}`);
        lines.push(border);
      }
      break;
  }

  // 4. Content (Footer text)
  if (opts.footer) {
    if (layout !== 'minimal') lines.push(divider);
    lines.push(opts.footer);
  }

  // 5. Footer
  lines.push('');
  lines.push(themeFooter);
  lines.push('');
  lines.push('𝕻𝕬𝕻𝕻𝖄 ×͜×');

  return lines.join('\n');
}
