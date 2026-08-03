// ============================================================
// WA-Bridge — Help Auto-generator
// Platform-aware command documentation
// ============================================================

import { MENU_CATALOG } from '../whatsapp/menu-registry.js';
import { H, header, escape } from '../utils/formatter.js';
import { asciiBox } from '../utils/ascii-art.js';

export function generateTelegramHelp(isOwner: boolean): string {
  const sections: Record<string, string[]> = {};

  for (const [cmd, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    if (!sections[entry.section]) sections[entry.section] = [];
    sections[entry.section].push(`${H.bold('/' + cmd)} — ${escape(entry.desc)}`);
  }

  const text = [
    header('OMEGA HELP', '📖'),
    '',
    'Welcome to the official command guide. Tap a category below to see detailed syntax.',
    '',
    H.italic('Note: Telegram commands use / prefix, while WhatsApp uses . by default.'),
  ].join('\n');

  return text;
}

export function generateTelegramCategoryHelp(category: string): string {
  const entries = Object.entries(MENU_CATALOG).filter(([_, e]) => e.section.toLowerCase().includes(category.toLowerCase()) && !e.hidden);
  
  if (entries.length === 0) return 'No commands found in this category.';

  const sectionName = entries[0]![1].section;
  const text = [
    header(sectionName, '◈'),
    '',
    ...entries.map(([cmd, e]) => `${H.bold('/' + cmd)}\n${H.code(e.syntax)}\n${escape(e.desc)}\n`),
  ].join('\n');

  return text;
}

export function generateWhatsAppHelp(prefix: string, isGroup: boolean): string {
  const sections: Record<string, string[]> = {};

  for (const [cmd, entry] of Object.entries(MENU_CATALOG)) {
    if (entry.hidden) continue;
    if (isGroup && entry.target === 'main') continue;
    if (!isGroup && entry.target === 'group') continue;

    if (!sections[entry.section]) sections[entry.section] = [];
    sections[entry.section].push(`${prefix}${entry.syntax} - ${entry.desc}`);
  }

  let text = '🚀 *OMEGA COMMAND MENU*\n\n';
  
  for (const [section, lines] of Object.entries(sections)) {
    text += `*${section}*\n`;
    text += lines.map(l => `• ${l}`).join('\n');
    text += '\n\n';
  }

  text += '_Use .idea [msg] to send feedback._';
  return text;
}
