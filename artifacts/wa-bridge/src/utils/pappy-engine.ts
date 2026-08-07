// ============================================================
// WA-Bridge — PAPPY Response Engine v4
// Compact, consistent styling for WhatsApp responses.
// ============================================================

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

/** Kept for compatibility with theme-selection settings. */
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

const BOLD_UPPER = [...'𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭'];
const BOLD_DIGITS = [...'𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵'];

/** Convert a response title to the spaced bold Unicode style. */
function spacedBold(value: string): string {
  return value.trim().split(/\s+/u).filter(Boolean)
    .map((word) => [...word].map((char) => {
      const letterIndex = 'abcdefghijklmnopqrstuvwxyz'.indexOf(char.toLowerCase());
      if (letterIndex >= 0) return BOLD_UPPER[letterIndex] ?? char;
      const digitIndex = '0123456789'.indexOf(char);
      return digitIndex >= 0 ? BOLD_DIGITS[digitIndex] ?? char : char;
    }).join(' '))
    .join('  ');
}

function instructionLines(message: string): { instructions: string[]; usage: string[] } {
  const instructions: string[] = [];
  const usage: string[] = [];
  for (const line of message.split('\n')) {
    if (/^\s*usage\s*:/iu.test(line)) usage.push(line.replace(/^\s*usage\s*:/iu, '').trim());
    else if (line.trim()) instructions.push(line.trim());
  }
  return { instructions, usage };
}

function addSection(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`✦ ${title}`);
  for (const value of values) {
    for (const part of value.split('\n').map((line) => line.trim()).filter(Boolean)) {
      lines.push(`  └─ ${part}`);
    }
  }
}

/**
 * Shared WhatsApp response layout. All cards now use the same title,
 * Instructions/Usage sections, and PAPPY signature.
 */
export function pappyBox(opts: PappyBoxOptions): string {
  const title = opts.moduleIdentity || opts.title;
  const lines: string[] = [`${opts.emoji || ''} ${spacedBold(title)}`.trim(), ''];
  const { instructions, usage } = opts.footer
    ? instructionLines(opts.footer)
    : { instructions: [], usage: [] };

  addSection(lines, 'Instructions', instructions);
  for (const [label, value] of opts.rows) {
    if (lines[lines.length - 1] !== '') lines.push('');
    addSection(lines, label, [value]);
  }
  addSection(lines, 'Usage', usage);

  if (lines[lines.length - 1] !== '') lines.push('');
  lines.push('· · ——— 𝕻𝕬𝕻𝕻𝖞 ×͜× ——— · ·');
  return lines.join('\n');
}
