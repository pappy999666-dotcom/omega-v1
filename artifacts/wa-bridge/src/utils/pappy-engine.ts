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
}

export const THEMES: Theme[] = [
  { name: 'Gothic Cathedral', header: '☩ GOTHIC CATHEDRAL ☩', border: '┃', divider: '── ⸸ ──', symbol: '✦', footer: '╰────── ⸸ ──────╯' },
  { name: 'Omega Core', header: '⟦ ◈ OMEGA • CORE ◈ ⟧', border: '┃', divider: '━━━━━━━━━━━━', symbol: '⚡', footer: '╰─── OMEGA ───╯' },
  { name: 'Cyber Monastery', header: '☩ CYBER MONASTERY ☩', border: '┇', divider: '── ◈ ──', symbol: '❖', footer: '╰── DIGITAL ☩ ──╯' },
  { name: 'Dark Terminal', header: '『 DARK TERMINAL 』', border: '▏', divider: '----------', symbol: '>', footer: '└───────────────┘' },
  { name: 'Matrix Console', header: '［ MATRIX CONSOLE ］', border: '║', divider: '══ ⚡ ══', symbol: '◈', footer: '［ SYSTEM OK ］' },
  { name: 'Quantum Engine', header: '⚛ QUANTUM ENGINE ⚛', border: '┇', divider: '〰〰〰〰〰', symbol: '⌬', footer: '⚛ QUANTUM ⚛' },
  { name: 'Royal Gothic', header: '⚜ ROYAL GOTHIC ⚜', border: '┃', divider: '── ⚜ ──', symbol: '◈', footer: '⚜ 𝕻𝕬𝕻𝕻𝖄 ⚜' },
  { name: 'Neon Frame', header: '『 NEON FRAME 』', border: '┇', divider: '━━ ✦ ━━', symbol: '⚡', footer: '『 NEON ⚡ 』' },
  { name: 'Digital Scroll', header: '📜 DIGITAL SCROLL 📜', border: '│', divider: '┈┈┈┈┈┈', symbol: '🔹', footer: '📜 END SCROLL 📜' },
  { name: 'Shadow Protocol', header: '👤 SHADOW PROTOCOL 👤', border: '▏', divider: '── 👤 ──', symbol: '✖', footer: '👤 SHADOW 👤' },
  { name: 'Inferno', header: '🔥 INFERNO 🔥', border: '┃', divider: '── 🔥 ──', symbol: '⚡', footer: '🔥 INFERNO 🔥' },
  { name: 'Obsidian', header: '🌑 OBSIDIAN 🌑', border: '┃', divider: '── 🌑 ──', symbol: '✦', footer: '🌑 OBSIDIAN 🌑' },
  { name: 'Phantom', header: '👻 PHANTOM 👻', border: '┇', divider: '── 👻 ──', symbol: '❖', footer: '👻 PHANTOM 👻' },
  { name: 'Void Engine', header: '🌌 VOID ENGINE 🌌', border: '║', divider: '── 🌌 ──', symbol: '◈', footer: '🌌 VOID 🌌' },
  { name: 'Black Archive', header: '🗄️ BLACK ARCHIVE 🗄️', border: '│', divider: '── 🗄️ ──', symbol: '🔹', footer: '🗄️ ARCHIVE 🗄️' },
  { name: 'Frost', header: '❄️ FROST ❄️', border: '┃', divider: '── ❄️ ──', symbol: '✦', footer: '❄️ FROST ❄️' },
  { name: 'Crimson', header: '🩸 CRIMSON 🩸', border: '┃', divider: '── 🩸 ──', symbol: '⚡', footer: '🩸 CRIMSON 🩸' },
  { name: 'Sakura Noir', header: '🌸 SAKURA NOIR 🌸', border: '┇', divider: '── 🌸 ──', symbol: '❖', footer: '🌸 SAKURA 🌸' },
  { name: 'Eclipse', header: '🌑 ECLIPSE 🌑', border: '║', divider: '── 🌑 ──', symbol: '◈', footer: '🌑 ECLIPSE 🌑' },
  { name: 'Cyber Core', header: '🤖 CYBER CORE 🤖', border: '│', divider: '── 🤖 ──', symbol: '🔹', footer: '🤖 CYBER 🤖' },
  { name: 'Blood Moon', header: '🌕 BLOOD MOON 🌕', border: '┃', divider: '── 🌕 ──', symbol: '✦', footer: '🌕 MOON 🌕' },
  { name: 'Iron Ghost', header: '⛓️ IRON GHOST ⛓️', border: '┃', divider: '── ⛓️ ──', symbol: '⚡', footer: '⛓️ IRON ⛓️' },
  { name: 'Neon Viper', header: '🐍 NEON VIPER 🐍', border: '┇', divider: '── 🐍 ──', symbol: '❖', footer: '🐍 VIPER 🐍' },
  { name: 'Cyber Samurai', header: '⚔️ CYBER SAMURAI ⚔️', border: '║', divider: '── ⚔️ ──', symbol: '◈', footer: '⚔️ SAMURAI ⚔️' },
  { name: 'Void Walker', header: '🚶 VOID WALKER 🚶', border: '│', divider: '── 🚶 ──', symbol: '🔹', footer: '🚶 WALKER 🚶' },
  { name: 'Dark Nebula', header: '🌌 DARK NEBULA 🌌', border: '┃', divider: '── 🌌 ──', symbol: '✦', footer: '🌌 NEBULA 🌌' },
  { name: 'Cyber Punk', header: '🎸 CYBER PUNK 🎸', border: '┃', divider: '── 🎸 ──', symbol: '⚡', footer: '🎸 PUNK 🎸' },
  { name: 'Neon Dragon', header: '🐉 NEON DRAGON 🐉', border: '┇', divider: '── 🐉 ──', symbol: '❖', footer: '🐉 DRAGON 🐉' },
  { name: 'Void Reaper', header: '💀 VOID REAPER 💀', border: '║', divider: '── 💀 ──', symbol: '◈', footer: '💀 REAPER 💀' },
  { name: 'Cyber Shogun', header: '🏯 CYBER SHOGUN 🏯', border: '│', divider: '── 🏯 ──', symbol: '🔹', footer: '🏯 SHOGUN 🏯' },
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
  const { header, border, divider, symbol, footer: themeFooter } = theme;

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
  // Information must "breathe"
  for (const [label, value] of opts.rows) {
    lines.push(`${border} ${symbol} ${label}`);
    lines.push(`${border}     ${value}`);
    lines.push(border);
  }

  // 4. Content (Footer text)
  if (opts.footer) {
    lines.push(divider);
    lines.push(opts.footer);
  }

  // 5. Footer
  lines.push('');
  lines.push(themeFooter);
  lines.push('');
  lines.push('𝕻𝕬𝕻𝕻𝖄 ×͜×');

  return lines.join('\n').trim();
}
